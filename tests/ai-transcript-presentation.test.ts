import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextSourceReasonText,
  collectAIResponseCitations,
  evidenceBoundaryText,
  parseTranscriptMessages,
  splitAIResponseCitations,
} from '../src/plugins/ai-assistant/transcript-presentation.ts';

test('AI transcript presentation preserves roles, metadata, and assistant reasoning', () => {
  const transcript = [
    '[用户 · 2026/9/9 10:00:00]',
    '请检查这段内容。',
    '',
    '[助手 · 2026/9/9 10:00:02]',
    '检查完成。',
  ].join('\n');
  const messages = parseTranscriptMessages(transcript, 2, new Map([[2, {
    reasoning: '先核对事实，再检查表达。',
  }]]));

  assert.deepEqual(messages.map(({ role, text, meta, reasoning }) => ({ role, text, meta, reasoning })), [
    {
      role: 'user',
      text: '请检查这段内容。',
      meta: '2026/9/9 10:00:00',
      reasoning: undefined,
    },
    {
      role: 'assistant',
      text: '检查完成。',
      meta: '2026/9/9 10:00:02',
      reasoning: '先核对事实，再检查表达。',
    },
  ]);
});

test('AI transcript presentation maps a partial read window back to absolute turn details', () => {
  const recentTranscript = '[用户]\n后续问题\n\n[助手]\n后续回答';
  const messages = parseTranscriptMessages(recentTranscript, 8, new Map([[8, { reasoning: '第八轮推理' }]]));

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.reasoning, undefined);
  assert.equal(messages[1]?.reasoning, '第八轮推理');
});

test('AI response citations keep stable node IDs while presenting current node titles', () => {
  const sources = [{
    sourceId: 'node:plan',
    provider: 'text-node',
    kind: 'text',
    title: '旧计划',
    revision: 3,
    start: 0,
    length: 12,
    text: '发布窗口是十月。',
    reason: 'explicit-reference' as const,
  }];
  const citations = collectAIResponseCitations('十月发布。[来源 1] [来源 99]', sources);
  assert.deepEqual(citations, [{
    ordinal: 1,
    sourceId: 'node:plan',
    title: '旧计划',
    kind: 'text',
    revision: 3,
  }]);

  const segments = splitAIResponseCitations('十月发布。[来源 1] [来源 99]', citations, [{
    sourceId: 'node:plan',
    provider: 'text-node',
    kind: 'text',
    title: '发布计划',
    revision: 4,
    length: 16,
  }]);
  assert.deepEqual(segments, [
    { kind: 'text', text: '十月发布。' },
    {
      kind: 'citation',
      key: '5:1:node:plan',
      ordinal: 1,
      sourceId: 'node:plan',
      label: '发布计划',
      clickable: true,
      missing: false,
    },
    { kind: 'text', text: ' ' },
    { kind: 'text', text: '[来源 99]' },
  ]);

  assert.deepEqual(splitAIResponseCitations('[来源 1]', citations, []), [{
    kind: 'citation',
    key: '0:1:node:plan',
    ordinal: 1,
    sourceId: 'node:plan',
    label: '旧计划',
    clickable: false,
    missing: true,
  }]);
});

test('AI context labels stay readable and hide internal enum names', () => {
  assert.equal(contextSourceReasonText('explicit-reference'), '明确 @ 引用');
  assert.equal(contextSourceReasonText('conversation-memory'), '历史对话索引命中');
  assert.equal(evidenceBoundaryText('markdown-table'), '完整 Markdown 表格');
  assert.equal(evidenceBoundaryText(undefined), '连续范围');
});
