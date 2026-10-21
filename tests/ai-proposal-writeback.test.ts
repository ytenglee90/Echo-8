import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIContextSource, AIProposalRecord } from '../src/protocols/ai.ts';
import { resolveAIWritebackTarget } from '../src/plugins/ai-assistant/proposal-writeback.ts';

const proposal: AIProposalRecord = {
  id: 'proposal-1',
  sessionId: 'session-1',
  operation: 'rewrite',
  text: '新正文',
  provider: 'provider',
  model: 'model',
  sourceRefs: [],
  status: 'pending',
  createdAt: 1,
  suggestedTarget: {
    nodeId: 'node-1',
    title: '目标',
    expectedRevision: 2,
    length: 10,
  },
};

test('AI writeback resolves the latest catalog revision before dispatch', () => {
  const sources: AIContextSource[] = [{
    sourceId: 'node-1',
    provider: 'text-node',
    kind: 'text',
    title: '目标',
    revision: 4,
    length: 24,
  }];

  assert.deepEqual(resolveAIWritebackTarget(proposal, sources, 'replace', 'node-1'), {
    mode: 'replace',
    nodeId: 'node-1',
    expectedRevision: 4,
    start: 0,
    end: 24,
  });
  assert.deepEqual(resolveAIWritebackTarget(proposal, sources, 'append', 'node-1'), {
    mode: 'append',
    nodeId: 'node-1',
    expectedRevision: 4,
  });
});

test('AI writeback falls back to the prepared target and rejects a missing target', () => {
  assert.deepEqual(resolveAIWritebackTarget(proposal, [], 'replace', 'node-1'), {
    mode: 'replace',
    nodeId: 'node-1',
    expectedRevision: 2,
    start: 0,
    end: 10,
  });
  assert.equal(resolveAIWritebackTarget(proposal, [], 'replace', 'missing'), undefined);
});
