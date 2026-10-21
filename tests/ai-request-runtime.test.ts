import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIPreparedContext } from '../src/protocols/ai.ts';
import {
  prunePreparedContexts,
  requirePreparedContext,
  type PreparedGeneration,
} from '../src/plugins/ai-assistant/request-runtime.ts';

function prepared(id: string, expiresAt: number): AIPreparedContext {
  return {
    id,
    sessionId: 'session:1',
    prompt: '测试要求',
    operation: 'general',
    createdAt: 1,
    expiresAt,
    totalCharacters: 0,
    estimatedTokens: 0,
    sources: [],
  };
}

test('AI request preparation lookup rejects missing and expired work before generation starts', () => {
  const preparations = new Map<string, PreparedGeneration>();
  assert.throws(() => requirePreparedContext(preparations, 'missing'), /已经不存在/u);

  const expired = prepared('expired', Date.now() - 1);
  preparations.set(expired.id, expired);
  assert.throws(() => requirePreparedContext(preparations, expired.id), /已经过期/u);
  assert.equal(preparations.has(expired.id), false);
});

test('AI request preparation lookup returns the same live revision-tagged object', () => {
  const live = prepared('live', Date.now() + 60_000);
  const preparations = new Map<string, PreparedGeneration>([[live.id, live]]);

  assert.equal(requirePreparedContext(preparations, live.id), live);
});

test('AI request preparation pruning removes expired work and bounds retained previews deterministically', () => {
  const now = 10_000;
  const preparations = new Map<string, PreparedGeneration>([
    ['expired', prepared('expired', now - 1)],
    ['first', prepared('first', now + 1_000)],
    ['second', prepared('second', now + 1_000)],
    ['third', prepared('third', now + 1_000)],
  ]);

  prunePreparedContexts(preparations, 2, now);

  assert.deepEqual([...preparations.keys()], ['second', 'third']);
});
