import assert from 'node:assert/strict';
import test from 'node:test';
import { AIRequestTraceBuffer } from '../src/plugins/ai-provider/request-trace.ts';
import { buildProviderRequest } from '../src/plugins/ai-provider/provider-transport.ts';
import { applyAIProviderPreset } from '../src/plugins/ai-provider/presets.ts';

test('actual request snapshots keep exact JSON while hiding URL, header and configured credentials', () => {
  const buffer = new AIRequestTraceBuffer();
  const identity = { sessionId: 'session:1', userTurn: 3 };
  const body = JSON.stringify({ messages: [{ role: 'user', content: '正文\n<b>字面文本</b>🧭' }], temperature: 0.2 });
  buffer.capture(identity, 'https://user:password@example.test/v1/chat?key=secret&alt=sse', { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body }, 'secret');
  const [snapshot] = buffer.read(identity);
  assert.equal(snapshot.body, body);
  assert.equal(snapshot.endpoint, 'https://REDACTED:REDACTED@example.test/v1/chat?key=REDACTED&alt=sse');
  assert.equal(snapshot.headers.authorization, '[密钥已隐藏]');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|password/u);
  snapshot.headers.authorization = 'mutated';
  assert.equal(buffer.read(identity)[0].headers.authorization, '[密钥已隐藏]');
  assert.equal(buffer.read({ ...identity, userTurn: 4 }).length, 0);
  assert.equal(buffer.read({ ...identity, sessionId: 'other-session' }).length, 0);
  buffer.clear(); assert.equal(buffer.read(identity).length, 0);
});

test('request snapshots are bounded and never pretend an omitted large request is a complete body', () => {
  const buffer = new AIRequestTraceBuffer(), identity = { sessionId: 's', userTurn: 1 };
  buffer.capture(identity, 'https://model.test', { method: 'POST', body: 'x'.repeat(1_000_001) }, '');
  assert.equal(buffer.read(identity)[0].body, undefined);
  assert.equal(buffer.read(identity)[0].omitted, true);
  for (let userTurn = 2; userTurn <= 130; userTurn += 1) buffer.capture({ sessionId: 's', userTurn }, 'https://model.test', { body: '{}' }, '');
  assert.equal(buffer.read(identity).length, 0);
  assert.equal(buffer.read({ sessionId: 's', userTurn: 130 }).length, 1);
});

test('local inspection identity is never part of the model API body', () => {
  for (const preset of ['openai', 'gemini']) {
    const request = buildProviderRequest({ ...applyAIProviderPreset(preset)!, id: preset }, 'test-secret', {
      inspection: { sessionId: 'private-session-id', userTurn: 7 }, messages: [{ role: 'user', content: '问题' }], temperature: 0.2, maxOutputTokens: 1024,
    }, true);
    assert.doesNotMatch(request.init.body as string, /inspection|private-session-id|userTurn/u);
  }
});
