import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import type { AISessionRecord } from '../src/protocols/ai.ts';
import {
  AI_SESSION_NAMESPACE,
  AI_TRANSCRIPT_NAMESPACE,
  chunkImportedTranscript,
  internalTranscriptSessionId,
  internalTranscriptSourceId,
  planTranscriptAppend,
  readInternalTranscript,
  sessionTranscriptSourceId,
  type AITranscriptChunkRecord,
} from '../src/plugins/ai-assistant/transcript-storage.ts';

function session(overrides: Partial<AISessionRecord> = {}): AISessionRecord {
  return {
    id: 'session:1',
    title: '测试对话',
    transcriptRevision: 1,
    transcriptLength: 0,
    transcriptEntries: 0,
    revision: 1,
    turns: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function readContext(
  currentSession: AISessionRecord,
  records: Record<string, AITranscriptChunkRecord>,
): PluginContext {
  return {
    store: {
      readValue: (namespace: string, key: string) =>
        namespace === AI_SESSION_NAMESPACE && key === currentSession.id ? currentSession : undefined,
      readKeyRange: (
        namespace: string,
        startInclusive: string,
        endExclusive: string,
        includePrevious = false,
      ) => {
        assert.equal(namespace, AI_TRANSCRIPT_NAMESPACE);
        const selected: Record<string, AITranscriptChunkRecord> = {};
        let previousKey: string | undefined;
        for (const key of Object.keys(records)) {
          if (key < startInclusive) {
            if (includePrevious && (!previousKey || key > previousKey)) previousKey = key;
          } else if (key < endExclusive) {
            selected[key] = records[key]!;
          }
        }
        if (previousKey) selected[previousKey] = records[previousKey]!;
        return selected;
      },
    },
  } as unknown as PluginContext;
}

test('internal transcript source IDs round-trip and saved transcript nodes take precedence', () => {
  const sourceId = internalTranscriptSourceId('session:alpha');

  assert.equal(sourceId, 'ai-transcript:session:alpha');
  assert.equal(internalTranscriptSessionId(sourceId), 'session:alpha');
  assert.equal(internalTranscriptSessionId('node:1'), undefined);
  assert.equal(sessionTranscriptSourceId(session()), 'ai-transcript:session:1');
  assert.equal(sessionTranscriptSourceId(session({ transcriptSourceId: 'node:archive' })), 'node:archive');
});

test('imported transcripts split into ordered bounded chunks', () => {
  const text = `${'甲'.repeat(64 * 1024)}乙`;
  const chunks = chunkImportedTranscript('session:1', text);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.chunk.start, 0);
  assert.equal(chunks[0]?.chunk.text.length, 64 * 1024);
  assert.equal(chunks[1]?.chunk.start, 64 * 1024);
  assert.equal(chunks[1]?.chunk.text, '乙');
  assert.equal(chunks[0]!.key < chunks[1]!.key, true);
  assert.equal(chunks.map((item) => item.chunk.text).join(''), text);
});

test('internal transcript range reads retain the preceding intersecting chunk', () => {
  const imported = chunkImportedTranscript('session:1', `${'甲'.repeat(64 * 1024)}乙丙丁`);
  const records = Object.fromEntries(imported.map((item) => [item.key, item.chunk]));
  const current = session({
    transcriptLength: 64 * 1024 + 3,
    transcriptEntries: imported.length,
    transcriptRevision: 4,
  });
  const result = readInternalTranscript(readContext(current, records), current.id, {
    sourceId: internalTranscriptSourceId(current.id),
    start: 64 * 1024 - 2,
    length: 5,
  });

  assert.equal(result.text, '甲甲乙丙丁');
  assert.equal(result.start, 64 * 1024 - 2);
  assert.equal(result.source?.revision, 4);
});

test('internal transcript appends return one standard patch and reject stale revisions', async () => {
  const current = session({ transcriptLength: 12, transcriptEntries: 2, transcriptRevision: 3 });
  const plan = await planTranscriptAppend({} as PluginContext, current, '新增内容', 3);

  assert.equal(plan.sourceId, internalTranscriptSourceId(current.id));
  assert.equal(plan.revision, 4);
  assert.equal(plan.start, 12);
  assert.equal(plan.length, 16);
  assert.equal(plan.entries, 3);
  assert.equal(plan.patches.length, 1);
  assert.equal(plan.patches[0]?.namespace, AI_TRANSCRIPT_NAMESPACE);
  assert.deepEqual(plan.events, [{
    type: 'ai.transcript.changed',
    payload: { sessionId: current.id, revision: 4 },
  }]);
  await assert.rejects(() => planTranscriptAppend({} as PluginContext, current, '过期内容', 2), /版本已经变化/u);
});
