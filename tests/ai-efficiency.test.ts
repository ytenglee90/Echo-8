import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { AIGenerateRequest, AIGenerateStreamEvent } from '../src/protocols/ai.ts';
import { AIUsageLedger } from '../src/plugins/ai-provider/usage-ledger.ts';
import { observeProviderUsage } from '../src/plugins/ai-provider/usage-observer.ts';
import { buildProviderRequest, fetchWithInitialRetry, providerTokenUsage } from '../src/plugins/ai-provider/provider-transport.ts';
import { buildGenerateRequest } from '../src/plugins/ai-assistant/generation-request.ts';
import { evidenceBodies, nativeConversation } from '../src/plugins/ai-assistant/request-evidence.ts';
import { localOperation } from '../src/plugins/canvas-control/local-operations.ts';
import { efficiencyContext, efficiencyScenarios } from './fixtures/ai-efficiency-scenarios.ts';
import { estimateAITokens } from '../src/services/ai-token-estimate.ts';
import { readParagraphTarget } from '../src/plugins/ai-assistant/paragraph-target.ts';
import type { PluginContext } from '../src/core/contracts.ts';

const request = (): AIGenerateRequest => ({ messages: [{ role: 'user', content: '生成一个角色' }], temperature: 0.7, maxOutputTokens: 1024,
  usageContext: { taskId: 'task:1', sessionId: 'session:1', purpose: 'answer', inputBreakdown: { userRequest: 10 } } });

test('task totals preserve paid usage, estimated supplements and unknown failed attempts independently across evictions', () => {
  const ledger = new AIUsageLedger(undefined, 2);
  ledger.finish(ledger.begin(request(), 'p', 'm'), 'complete', { inputTokens: 100, outputTokens: 30, reasoningTokens: 10, cachedInputTokens: 60 }, '回答');
  ledger.finish(ledger.begin(request(), 'p', 'm', true), 'failed');
  ledger.finish(ledger.begin(request(), 'p', 'm'), 'complete', { inputTokens: 50 }, '补充');
  const snapshot = ledger.read('task:1');
  assert.equal(snapshot.totals.calls, 3); assert.equal(snapshot.totals.retries, 1);
  assert.equal(snapshot.totals.actualInput, 150); assert.equal(snapshot.totals.actualOutput, 30);
  assert.equal(snapshot.totals.estimatedOutput, 2); assert.equal(snapshot.totals.unknownInput, 1); assert.equal(snapshot.totals.unknownOutput, 1);
  assert.equal(snapshot.totals.reasoning, 10); assert.equal(snapshot.totals.cachedInput, 60);
  assert.equal(snapshot.omittedAttempts, 1); assert.equal(snapshot.attempts.length, 2);
  ledger.finish(snapshot.attempts[0], 'complete', { inputTokens: 999 }); // cloned record cannot mutate or double-count
  assert.equal(ledger.read('task:1').totals.actualInput, 150);
  ledger.clear(); assert.equal(ledger.read('task:1').totals.calls, 0);
});

test('HTTP retries are distinct attempts and a missing-usage failure never becomes a zero bill', async () => {
  const ledger = new AIUsageLedger(); let calls = 0;
  const observed = observeProviderUsage(ledger, request(), 'p', 'm', async () => ++calls === 1
    ? new Response('{"error":{"message":"unsupported stream_options"}}', { status: 400 }) : new Response('{}'));
  await fetchWithInitialRetry(observed.fetch, 'https://fixture.test/v1/chat/completions', { body: JSON.stringify({ stream: true, stream_options: { include_usage: true } }) }, new AbortController().signal);
  observed.finish('complete', { inputTokens: 20, outputTokens: 5 }, '回答');
  await new Promise(resolve => setTimeout(resolve, 0));
  const totals = ledger.read('task:1').totals;
  assert.equal(totals.calls, 2); assert.equal(totals.retries, 1);
  assert.equal(totals.actualInput, 20); assert.equal(totals.unknownInput, 1);
});

test('stream cumulative usage snapshots count once and interrupted streams preserve known usage with unknown missing directions', async () => {
  const ledger = new AIUsageLedger();
  const observed = observeProviderUsage(ledger, request(), 'p', 'm', async () => new Response(''));
  await observed.fetch('https://fixture.test');
  const source = (async function* (): AsyncIterable<AIGenerateStreamEvent> {
    yield { type: 'delta', delta: '回答' };
    yield { type: 'complete', usage: { inputTokens: 10, outputTokens: 2 } };
    yield { type: 'complete', usage: { inputTokens: 10, outputTokens: 2 } };
  })();
  for await (const event of observed.events(source)) void event;
  assert.equal(ledger.read('task:1').totals.actualInput, 10);
  const failed = observeProviderUsage(ledger, request(), 'p', 'm', async () => new Response(''));
  await failed.fetch('https://fixture.test');
  const interrupted = (async function* (): AsyncIterable<AIGenerateStreamEvent> { yield { type: 'complete', usage: { inputTokens: 7 } }; throw new Error('interrupted'); })();
  await assert.rejects(async () => { for await (const event of failed.events(interrupted)) void event; }, /interrupted/u);
  assert.equal(ledger.read('task:1').totals.actualInput, 17);
  assert.equal(ledger.read('task:1').totals.unknownOutput, 1);
});

test('failed HTTP response usage can replace unknown counters without duplicating requests or blocking the transport', async () => {
  const ledger = new AIUsageLedger();
  const observed = observeProviderUsage(ledger, request(), 'p', 'm', async () => new Response(JSON.stringify({ error: { message: 'failure' }, usage: { prompt_tokens: 13, completion_tokens: 2 } }), { status: 400 }));
  await assert.rejects(() => fetchWithInitialRetry(observed.fetch, 'https://fixture.test', {}, new AbortController().signal), /HTTP 400/u);
  observed.finish('failed');
  await new Promise(resolve => setTimeout(resolve, 0));
  const snapshot = ledger.read('task:1');
  assert.equal(snapshot.totals.calls, 1); assert.equal(snapshot.totals.actualInput, 13); assert.equal(snapshot.totals.actualOutput, 2);
  assert.equal(snapshot.totals.unknownInput, 0); assert.equal(snapshot.totals.unknownOutput, 0);
});

test('provider reasoning/cache counts are subsets and schemas/accounting stay correctly separated on the wire', () => {
  assert.deepEqual(providerTokenUsage({ usage: { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, completion_tokens_details: { reasoning_tokens: 12 } } }),
    { inputTokens: 100, outputTokens: 40, cachedInputTokens: 70, cacheMissInputTokens: 30, reasoningTokens: 12 });
  const input = { ...request(), responseSchema: { type: 'object', properties: { answer: { type: 'string' } } } };
  const wire = buildProviderRequest({ id: 'g', label: 'g', platform: 'g', apiStyle: 'gemini', authentication: 'none', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'fixture' }, '', input, false);
  const body = JSON.parse(wire.init.body as string);
  assert.deepEqual(body.generationConfig.responseJsonSchema, input.responseSchema);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.doesNotMatch(wire.init.body as string, /usageContext|task:1|inputBreakdown/u);
});

test('fixed inputs improve without deleting evidence or adding classifier calls; numbers remain local estimates', async () => {
  const before = JSON.parse(readFileSync(new URL('./fixtures/ai-efficiency-before.json', import.meta.url), 'utf8')) as { scenarios: Array<{ estimatedInput: number }> };
  let previous = 0, current = 0;
  for (const [index, scenario] of efficiencyScenarios.entries()) {
    let input = 0;
    for (const prepared of scenario.rounds) {
      const generated = await buildGenerateRequest(efficiencyContext, prepared, { templates: [] });
      const full = generated.messages.map(message => message.content).join('\n');
      for (const source of prepared.sources) {
        if (source.reason !== 'recent-conversation') assert.ok(full.includes(source.text));
      }
      assert.ok(full.includes(prepared.prompt));
      input += 3 + generated.messages.reduce((sum, message) => sum + 4 + estimateAITokens(message.content), 0);
      if (prepared.contextIntent === 'conversation') assert.doesNotMatch(full, /记忆执行协议|记忆检索覆盖报告|可能为空/u);
    }
    previous += before.scenarios[index]!.estimatedInput; current += input;
    assert.ok(input < before.scenarios[index]!.estimatedInput, scenario.name);
  }
  assert.ok(current < previous * 0.5);
});

test('native role history retains explicit constraints and evidence dedup preserves source identity and revisions', () => {
  const text = '[用户 · 1]\n禁止复活。\n\n[助手 · 1]\n已记住。';
  assert.deepEqual(nativeConversation(text, '继续'), [{ role: 'user', content: '禁止复活。' }, { role: 'assistant', content: '已记住。' }]);
  const staleCapability = text + '\n\n[助手 · 2]\n我这轮没有画布写入能力，请自行粘贴。\n\n[用户 · 3]\n在角色卡节点里设计人物';
  assert.doesNotMatch(JSON.stringify(nativeConversation(staleCapability, '设计人物', true)), /没有画布写入能力/u);
  assert.match(JSON.stringify(nativeConversation(staleCapability, '设计人物', false)), /没有画布写入能力/u);
  const first = efficiencyScenarios[4]!.rounds[0]!.sources[0]!;
  const sources = [first, { ...first, sourceId: 'other' }, { ...first, revision: 2 }];
  const bodies = evidenceBodies(sources, -1);
  assert.match(bodies[1]!, /来源 1|独立/u); assert.ok(bodies[2]!.includes(first.text));
});

test('local routes only accept explicit deterministic commands and leave creative/ambiguous language to the model', () => {
  assert.deepEqual(localOperation('@画布操作 把选中节点设为 #336699。'), { color: '#336699' });
  assert.deepEqual(localOperation('将选中节点向左移动 100'), { axis: 'x', delta: -100 });
  assert.deepEqual(localOperation('选中节点移动到 x=100, y=-20'), { x: 100, y: -20 });
  assert.equal(localOperation('设计一个与主题协调的配色方案'), undefined);
  assert.equal(localOperation('如果合适，把选中节点设为 #336699'), undefined);
  assert.equal(localOperation('把选中节点设为 #336699 并删除旧内容'), undefined);
});

test('paragraph targeting reads bounded original chunks with revision checks and exact UTF-16 offsets', async () => {
  const text = '第一段🙂。\n\n第二段必须保留限制。\n\n第三段。';
  const source = { sourceId: 'node:1', provider: 'text-node', kind: 'text', title: '原文', revision: 4, length: text.length };
  let stale = false;
  const context = { capabilities: { requestAll: async (_key: string, input: { start: number; length: number }) => [{ handled: true, source: { ...source, revision: stale ? 5 : 4 }, text: text.slice(input.start, input.start + input.length) }] } } as unknown as PluginContext;
  const target = await readParagraphTarget(context, source, 2);
  assert.equal(text.slice(target.start, target.end), '第二段必须保留限制。');
  stale = true; await assert.rejects(() => readParagraphTarget(context, source, 2), /已经变化/u);
});
