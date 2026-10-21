import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIMemoryIndexDraft } from '../src/protocols/ai.ts';
import type { FileReadWriteTarget } from '../src/protocols/files.ts';
import {
  AI_MEMORY_FILE_INDEX_SUFFIX,
  AI_MEMORY_FILE_ORIGINAL_SUFFIX,
  countTranscriptTurns,
  createMemoryFileStem,
  formatMemoryIndexText,
  memoryIndexTitle,
  pairMemoryFiles,
  parseImportedMemoryIndex,
  parseImportedMemoryTitle,
} from '../src/plugins/ai-assistant/memory-artifacts.ts';

function file(name: string): FileReadWriteTarget {
  return {
    name,
    createWritable: async () => ({
      write: async () => undefined,
      close: async () => undefined,
    }),
    getFile: async () => new File([], name),
  };
}

test('AI memory files pair only matching original and index stems', () => {
  const firstOriginal = file(`项目甲${AI_MEMORY_FILE_ORIGINAL_SUFFIX}`);
  const firstIndex = file(`项目甲${AI_MEMORY_FILE_INDEX_SUFFIX}`);
  const incomplete = file(`项目乙${AI_MEMORY_FILE_ORIGINAL_SUFFIX}`);
  const unrelated = file('说明.txt');

  const pairs = pairMemoryFiles([firstOriginal, incomplete, unrelated, firstIndex]);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.stem, '项目甲');
  assert.equal(pairs[0]?.original, firstOriginal);
  assert.equal(pairs[0]?.index, firstIndex);
});

test('AI memory index TXT round-trip keeps a readable title, keywords, summary and anchors', () => {
  const draft: AIMemoryIndexDraft = {
    sourceRevision: 7,
    sourceLength: 28,
    summary: '确定了极光项目的发布窗口。',
    keywords: ['极光项目', '发布窗口'],
    anchors: [],
    claims: [{
      id: 'claim:1',
      kind: 'confirm',
      status: 'current',
      subject: '发布窗口',
      value: '九月',
      start: 8,
      length: 10,
      authority: 'user-explicit',
    }],
    createdAt: 100,
  };
  const text = formatMemoryIndexText(draft, {
    archiveNodeId: 'node:memory',
    archiveTitle: '极光项目讨论',
    savedAt: 100,
  });
  const original = '用户确认极光项目的发布窗口安排在九月。';
  const parsed = parseImportedMemoryIndex(text, original, 9, 200);

  assert.equal(parseImportedMemoryTitle(text, 'fallback-memory01'), '极光项目讨论');
  assert.deepEqual(parsed.keywords, ['极光项目', '发布窗口']);
  assert.equal(parsed.summary, draft.summary);
  assert.equal(parsed.sourceRevision, 9);
  assert.equal(parsed.sourceLength, original.length);
  assert.deepEqual(parsed.anchors, [
    { term: '极光项目', start: 4, length: 4 },
    { term: '发布窗口', start: 9, length: 4 },
  ]);
  assert.match(text, /\[确认\] 发布窗口：九月/u);
  assert.match(text, /本节点只是目录，回答必须回到原文记忆节点取证/u);
});

test('AI memory artifact names remain bounded and filesystem-safe', () => {
  const stem = createMemoryFileStem(' 计划：A/B*版. ', 'memory:abcdef123456');

  assert.equal(stem, '计划：A_B_版-cdef123456');
  assert.equal(/[<>:"/\\|?*]/u.test(stem), false);
  assert.equal(memoryIndexTitle('标题'.repeat(100)).length <= 120, true);
});

test('AI transcript turn counting ignores system and body lines', () => {
  assert.equal(countTranscriptTurns([
    '[用户 · 通用]',
    '第一个问题',
    '[助手 · 通用]',
    '第一个回答',
    '[系统 · 内部]',
    '[这只是正文]',
  ].join('\n')), 2);
});
