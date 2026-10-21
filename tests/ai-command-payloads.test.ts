import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAcceptProposalPayload,
  isAssistantInstanceState,
  isAssistantAutoMemoryCandidatesPayload,
  isAssistantContextModePayload,
  isComposerHeightPayload,
  isGenerationRecordPayload,
  isGenerationRetryPayload,
  isImportMemoryFilesPayload,
  isLinkMemoryDirectoryPayload,
  isMemoryCandidateCommitPayload,
  isMemoryIndexDraft,
  isPreparePayload,
  isPromptTemplateExportPayload,
  readAssistantView,
} from '../src/plugins/ai-assistant/command-payloads.ts';
import {
  AI_COMPOSER_HEIGHT_MAX,
  AI_COMPOSER_HEIGHT_MIN,
} from '../src/plugins/ai-assistant/types.ts';

test('AI preparation payloads enforce bounded prompts, memories and references', () => {
  const valid = {
    assistantId: 'assistant:1',
    sessionId: 'session:1',
    prompt: '整理当前资料',
    operation: 'general',
    memorySourceIds: ['memory:1'],
    references: [{ token: '@需求', sourceId: 'node:1' }],
  };

  assert.equal(isPreparePayload(valid), true);
  assert.equal(isPreparePayload({ ...valid, contextMode: 'explicit-only' }), true);
  assert.equal(isPreparePayload({ ...valid, contextMode: 'unbounded' }), false);
  assert.equal(isPreparePayload({ ...valid, prompt: '   ' }), false);
  assert.equal(isPreparePayload({ ...valid, prompt: '字'.repeat(20_001) }), false);
  assert.equal(isPreparePayload({ ...valid, memorySourceIds: Array.from({ length: 51 }, (_, index) => `memory:${index}`) }), false);
  assert.equal(isPreparePayload({ ...valid, references: [{ token: '', sourceId: 'node:1' }] }), false);
});

test('memory index drafts accept valid explicit claims and reject unsafe offsets', () => {
  const valid = {
    sourceRevision: 3,
    sourceLength: 120,
    summary: '用户确认了生产环境的超时时间。',
    keywords: ['生产环境', '超时'],
    anchors: [{ term: '超时', start: 20, length: 2 }],
    claims: [{
      id: 'claim:1',
      kind: 'confirm',
      status: 'current',
      subject: '超时时间',
      value: '30 秒',
      scope: '生产环境',
      start: 16,
      length: 12,
      authority: 'user-explicit',
    }],
    createdAt: 1,
  };

  assert.equal(isMemoryIndexDraft(valid), true);
  assert.equal(isMemoryIndexDraft({ ...valid, anchors: [{ term: '超时', start: -1, length: 2 }] }), false);
  assert.equal(isMemoryIndexDraft({
    ...valid,
    claims: [{ ...valid.claims[0], authority: 'assistant-inferred' }],
  }), false);
});

test('candidate memory commits require bounded, evidence-backed model output', () => {
  const valid = {
    sessionId: 'session:1',
    sourceId: 'ai-transcript:session:1',
    sourceRevision: 2,
    sourceStart: 40,
    sourceLength: 36,
    extractor: { provider: 'openai', model: 'small-model' },
    candidates: [{
      kind: 'confirm', subject: '发布频率', value: '每周一',
      evidence: '发布频率改为每周一。', confidence: 0.9,
    }],
  };
  assert.equal(isMemoryCandidateCommitPayload(valid), true);
  assert.equal(isMemoryCandidateCommitPayload({ ...valid, candidates: [{ ...valid.candidates[0], evidence: '' }] }), false);
  assert.equal(isMemoryCandidateCommitPayload({ ...valid, candidates: Array.from({ length: 9 }, () => valid.candidates[0]) }), false);
});

test('assistant workspace state and composer height validators preserve UI bounds', () => {
  const instance = {
    id: 'assistant:1',
    sessionId: 'session:1',
    rect: { x: 20, y: 64, width: 520, height: 720 },
    composerHeight: AI_COMPOSER_HEIGHT_MIN,
    view: 'chat',
    createdAt: 1,
  };

  assert.equal(isAssistantInstanceState(instance), true);
  assert.equal(isAssistantInstanceState({ ...instance, contextMode: 'explicit-only' }), true);
  assert.equal(isAssistantInstanceState({ ...instance, contextMode: 'unbounded' }), false);
  assert.equal(isAssistantContextModePayload({ assistantId: 'assistant:1', mode: 'explicit-only' }), true);
  assert.equal(isAssistantContextModePayload({ assistantId: 'assistant:1', mode: 'unbounded' }), false);
  assert.equal(isAssistantAutoMemoryCandidatesPayload({ assistantId: 'assistant:1', enabled: true }), true);
  assert.equal(isAssistantAutoMemoryCandidatesPayload({ assistantId: 'assistant:1', enabled: 'true' }), false);
  assert.equal(isAssistantInstanceState({ ...instance, view: 'unknown' }), false);
  assert.equal(isAssistantInstanceState({ ...instance, composerHeight: Number.NaN }), false);
  assert.equal(isComposerHeightPayload({ height: AI_COMPOSER_HEIGHT_MIN }), true);
  assert.equal(isComposerHeightPayload({ height: AI_COMPOSER_HEIGHT_MAX + 1 }), false);
  assert.equal(readAssistantView('memory'), 'memory');
  assert.equal(readAssistantView('unknown'), 'chat');
});

test('file payload validators require real handle capabilities, not lookalike labels', () => {
  const saveTarget = { name: '模板.txt', createWritable: async () => ({}) };
  const readWriteTarget = { ...saveTarget, getFile: async () => ({}) };
  const directory = { name: '记忆', getFileHandle: async () => ({}) };

  assert.equal(isPromptTemplateExportPayload({ templateId: 'template:1', destination: saveTarget }), true);
  assert.equal(isPromptTemplateExportPayload({ templateId: 'template:1', destination: { name: '模板.txt' } }), false);
  assert.equal(isImportMemoryFilesPayload({ sources: [readWriteTarget, readWriteTarget] }), true);
  assert.equal(isImportMemoryFilesPayload({ sources: [readWriteTarget] }), false);
  assert.equal(isLinkMemoryDirectoryPayload({ directory }), true);
  assert.equal(isLinkMemoryDirectoryPayload({ directory: { name: '记忆' } }), false);
});

test('generation and proposal payloads reject empty output and invalid replacement ranges', () => {
  assert.equal(isGenerationRetryPayload({ sessionId: 'session:1' }), true);
  assert.equal(isGenerationRetryPayload({ sessionId: '' }), false);
  assert.equal(isGenerationRecordPayload({
    preparationId: 'preparation:1',
    text: '处理结果',
    provider: 'provider',
    model: 'model',
  }), true);
  assert.equal(isGenerationRecordPayload({
    preparationId: 'preparation:1',
    text: '',
    provider: 'provider',
    model: 'model',
  }), false);
  assert.equal(isAcceptProposalPayload({
    proposalId: 'proposal:1',
    target: { mode: 'replace', nodeId: 'node:1', expectedRevision: 1, start: 2, end: 8 },
  }), true);
  assert.equal(isAcceptProposalPayload({
    proposalId: 'proposal:1',
    target: { mode: 'replace', nodeId: 'node:1', expectedRevision: 1, start: 8, end: 2 },
  }), false);
});
