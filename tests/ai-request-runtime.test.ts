import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIPreparedContext } from '../src/protocols/ai.ts';
import type { PluginContext } from '../src/core/contracts.ts';
import type { PreparePayload } from '../src/plugins/ai-assistant/command-payloads.ts';
import {
  prunePreparedContexts,
  requirePreparedContext,
  type PreparedGeneration,
  registerAIRequestRuntime,
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

test('a cancelled old preparation cannot replace the new turn or report a late error', async () => {
  let prepare: ((payload: PreparePayload) => unknown) | undefined;
  const jobs: Array<{ resolve(value: AIPreparedContext): void; reject(error: Error): void }> = [];
  const signals: Array<{ name: string; value?: unknown }> = [];
  const context = {
    commands: { register(input: { type: string; handle: typeof prepare }) { if (input.type === 'ai.context.prepare') prepare = input.handle; } },
    signals: { subscribe() {}, emit(name: string, value?: unknown) { signals.push({ name, value }); } },
    tasks: { schedule() {
      const result = new Promise<AIPreparedContext>((resolve, reject) => jobs.push({ resolve, reject }));
      return { id: 'job:' + jobs.length, result, cancel() {} };
    } },
  } as unknown as PluginContext;
  const runtime = {
    preparations: new Map(), preparationTasks: new Map(), generationTasks: new Map(),
    generationStateBySession: new Map(), generationActionBySession: new Map(), lastPrepareRequestBySession: new Map(),
    lastMemoryUseBySession: new Map(),
    readSessions: () => ({ 'session:1': { id: 'session:1', title: '测试', turns: 0, revision: 1, createdAt: 1, updatedAt: 1 } }),
    readMemoryIndexes: () => ({}), readAssistantInstances: () => [],
  };
  registerAIRequestRuntime(context, runtime);
  const input: PreparePayload = { sessionId: 'session:1', prompt: '你好', operation: 'general' };
  prepare!(input);
  prepare!({ ...input, prompt: '人物卡怎么设计？' });
  jobs[0]!.reject(new Error('旧任务迟到的失败'));
  const next = prepared('new', Date.now() + 60_000);
  jobs[1]!.resolve(next);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runtime.preparations.get(next.id), next);
  assert.equal(runtime.generationActionBySession.size, 0);
  assert.ok(!JSON.stringify(signals).includes('旧任务迟到的失败'));
});
