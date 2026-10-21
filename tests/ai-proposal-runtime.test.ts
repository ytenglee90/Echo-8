import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import type {
  AIContextReadRequest,
  AIContextSource,
  AIPreparedContext,
} from '../src/protocols/ai.ts';
import { resolveProposalTarget } from '../src/plugins/ai-assistant/proposal-runtime.ts';
import { formatAITranscriptEntry } from '../src/plugins/ai-assistant/transcript-storage.ts';

function prepared(operation: AIPreparedContext['operation'], sourceIds = ['node:1']): AIPreparedContext {
  return {
    id: 'prepared:1',
    sessionId: 'session:1',
    prompt: '处理正文',
    operation,
    createdAt: 1,
    expiresAt: 2,
    totalCharacters: 8,
    estimatedTokens: 4,
    sources: sourceIds.map((sourceId) => ({
      sourceId,
      provider: 'text-node',
      kind: 'text',
      title: `目标${sourceId}`,
      revision: 2,
      start: 0,
      length: 10,
      text: '准备阶段正文',
      reason: 'explicit-reference',
    })),
  };
}

function contextFor(current: AIContextSource): PluginContext {
  return {
    capabilities: {
      requestAll: async (key: string, request: AIContextReadRequest) => {
        assert.equal(key, 'context.read@1');
        assert.equal(request.sourceId, current.sourceId);
        return [{ handled: true, source: current, start: request.start, text: '' }];
      },
    },
  } as unknown as PluginContext;
}

test('AI proposal target refreshes the current content revision before offering write-back', async () => {
  const current: AIContextSource = {
    sourceId: 'node:1',
    provider: 'text-node',
    kind: 'text',
    title: '当前标题',
    revision: 7,
    length: 42,
  };

  assert.deepEqual(await resolveProposalTarget(contextFor(current), prepared('rewrite')), {
    nodeId: 'node:1',
    title: '当前标题',
    expectedRevision: 7,
    length: 42,
  });
});

test('ordinary answers and ambiguous multi-node edits do not manufacture a write-back proposal', async () => {
  const unusedContext = {} as PluginContext;
  assert.equal(await resolveProposalTarget(unusedContext, prepared('general')), undefined);
  assert.equal(await resolveProposalTarget(unusedContext, prepared('rewrite', ['node:1', 'node:2'])), undefined);
});

test('AI transcript entries preserve role, operation label and verbatim text', () => {
  const entry = formatAITranscriptEntry('助手', '第一行\n第二行', 'summarize', 0);

  assert.match(entry, /^\n\[助手 ·/u);
  assert.match(entry, /· 总结\]\n第一行\n第二行\n$/u);
});
