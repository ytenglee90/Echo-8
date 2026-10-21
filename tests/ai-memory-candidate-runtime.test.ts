import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import type { AIMemoryCandidateRecord, AISessionRecord } from '../src/protocols/ai.ts';
import {
  AI_MEMORY_CANDIDATE_NAMESPACE,
  isCandidateAlreadyIndexed,
  registerAIMemoryCandidateRuntime,
} from '../src/plugins/ai-assistant/memory-candidate-runtime.ts';
import { parseMemoryCandidateResponse } from '../src/plugins/ai-assistant/memory-candidate-runtime.ts';
import {
  AI_SESSION_NAMESPACE,
  AI_TRANSCRIPT_NAMESPACE,
  internalTranscriptSourceId,
  type AITranscriptChunkRecord,
} from '../src/plugins/ai-assistant/transcript-storage.ts';

const transcript = `
[用户 · 2026/9/14 10:00 · 通用]
发布频率改为每周一，海外版暂不发布。

[助手 · 2026/9/14 10:00 · 通用]
我会按这个节奏安排。
`;

test('candidate extraction keeps only model JSON backed by an exact user quote', () => {
  const candidates = parseMemoryCandidateResponse(JSON.stringify({
    candidates: [{
      kind: 'confirm',
      subject: '发布频率',
      value: '每周一',
      evidence: '发布频率改为每周一，海外版暂不发布。',
      confidence: 0.92,
    }],
  }), transcript);

  assert.deepEqual(candidates, [{
    kind: 'confirm',
    subject: '发布频率',
    value: '每周一',
    evidence: '发布频率改为每周一，海外版暂不发布。',
    confidence: 0.92,
  }]);
});

test('candidate extraction discards assistant-only, unquoted and structurally incomplete facts', () => {
  const candidates = parseMemoryCandidateResponse(`\`\`\`json
    {"candidates":[
      {"kind":"confirm","subject":"安排","value":"每周一","evidence":"我会按这个节奏安排。"},
      {"kind":"confirm","subject":"预算","value":"十万","evidence":"用户决定预算十万。"},
      {"kind":"modify","subject":"发布频率","value":"每周一","evidence":"发布频率改为每周一，海外版暂不发布。"}
    ]}
    \`\`\``, transcript);

  assert.deepEqual(candidates, []);
});

test('candidate extraction also accepts a JSON array response from compatible providers', () => {
  const candidates = parseMemoryCandidateResponse(JSON.stringify([{
    kind: 'deprecate',
    subject: '海外版发布',
    value: '暂不发布',
    evidence: '发布频率改为每周一，海外版暂不发布。',
  }]), transcript);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.kind, 'deprecate');
});

test('candidate extraction suppresses only an equivalent user-confirmed indexed claim', () => {
  const indexes = {
    'memory:1': {
      sessionId: 'session:old', sourceId: 'memory:1', title: '已确认设定', sourceRevision: 1, sourceLength: 10,
      summary: '', keywords: [], anchors: [], createdAt: 1,
      claims: [{
        id: 'claim:1', kind: 'confirm' as const, status: 'current' as const, subject: '发布频率', value: '每周一',
        start: 0, length: 10, authority: 'user-explicit' as const,
      }],
    },
  };
  assert.equal(isCandidateAlreadyIndexed({ kind: 'confirm', subject: '发布 频率', value: '每周一' }, indexes), true);
  assert.equal(isCandidateAlreadyIndexed({ kind: 'confirm', subject: '发布频率', value: '每周二' }, indexes), false);
  assert.equal(isCandidateAlreadyIndexed({ kind: 'modify', subject: '发布频率', previousValue: '每周一', value: '每周二' }, indexes), false);
});

test('accepting a candidate appends an explicit user directive after re-reading its quoted evidence', async () => {
  const body = '\n[用户 · 2026/9/14 10:00 · 通用]\n发布频率改为每周一。\n';
  const session: AISessionRecord = {
    id: 'session:1', title: '当前对话', transcriptRevision: 1, transcriptLength: body.length,
    transcriptEntries: 1, revision: 1, turns: 1, createdAt: 1, updatedAt: 1,
  };
  const quote = '发布频率改为每周一。';
  const candidate: AIMemoryCandidateRecord = {
    id: 'candidate:1', sessionId: session.id, sourceId: internalTranscriptSourceId(session.id),
    sourceRevision: 1, sourceStart: body.indexOf(quote), sourceLength: quote.length, sourceQuote: quote,
    kind: 'confirm', subject: '发布频率', value: '每周一', confidence: 0.9, status: 'pending',
    extractor: { provider: 'test', model: 'test-model' }, createdAt: 1, updatedAt: 1,
  };
  const handlers = new Map<string, { handle(payload: unknown): Promise<unknown> | unknown }>();
  const chunk: AITranscriptChunkRecord = {
    id: 'chunk:1', sessionId: session.id, sequence: 0, start: 0, text: body,
  };
  const context = {
    commands: { register(definition: { type: string; handle(payload: unknown): Promise<unknown> | unknown }) {
      handlers.set(definition.type, definition);
    } },
    store: {
      readValue: <T,>(namespace: string, key: string): T | undefined =>
        namespace === AI_SESSION_NAMESPACE && key === session.id ? session as T : undefined,
      readKeyRange: <T,>(): T => ({ chunk } as T),
    },
  } as unknown as PluginContext;
  registerAIMemoryCandidateRuntime(context, {
    tasks: new Map(),
    readSessions: () => ({ [session.id]: session }),
    readCandidates: () => ({ [candidate.id]: candidate }),
    readMemoryIndexes: () => ({}),
    readAssistantInstances: () => [],
  });

  const result = await handlers.get('ai.memory.candidate.accept')!.handle({ candidateId: candidate.id }) as {
    transaction: { patches: Array<{ namespace: string; value?: unknown }> };
  };
  const accepted = result.transaction.patches.find((patch) =>
    patch.namespace === AI_MEMORY_CANDIDATE_NAMESPACE)?.value as AIMemoryCandidateRecord;
  const appended = result.transaction.patches.find((patch) => patch.namespace === AI_TRANSCRIPT_NAMESPACE)?.value as AITranscriptChunkRecord;
  assert.equal(accepted.status, 'accepted');
  assert.match(appended.text, /@确认 发布频率: 每周一/u);
});
