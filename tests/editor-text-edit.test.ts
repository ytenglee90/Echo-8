import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countGraphemes,
  countNonWhitespaceGraphemes,
} from '../src/services/text-metrics.ts';
import {
  calculateTextDelta,
  classifyWritingInput,
  rebaseTextDelta,
  planTextRangeMove,
} from '../src/plugins/editor/text-edit.ts';
import {
  collectAnnotationClipboardItems,
  decodeAnnotationClipboard,
  encodeAnnotationClipboard,
  moveEditorAnnotationRecords,
  rebaseEditorAnnotationRecords,
} from '../src/plugins/editor/annotation-clipboard.ts';
import type { AnnotationRecord } from '../src/protocols/annotations.ts';
import { editorDocumentTextColor } from '../src/plugins/editor/formatted-text-dom.ts';

test('editor default writing ink follows the paper contrast token without overriding chosen colors', () => {
  assert.equal(editorDocumentTextColor('#2f3035'), 'var(--editor-paper-ink)');
  assert.equal(editorDocumentTextColor(' #2F3035 '), 'var(--editor-paper-ink)');
  assert.equal(editorDocumentTextColor('#c42a2a'), '#c42a2a');
});

test('editor text delta keeps the unchanged prefix and suffix outside one replacement', () => {
  const previous = '开头旧内容结尾';
  const next = '开头新的内容结尾';
  const delta = calculateTextDelta(previous, next);

  assert.deepEqual(delta, {
    start: 2,
    deleteCount: 1,
    deletedText: '旧',
    insert: '新的',
  });
  assert.equal(
    `${previous.slice(0, delta.start)}${delta.insert}${previous.slice(delta.start + delta.deleteCount)}`,
    next,
  );
});

test('editor writing classification distinguishes typing, replacement, deletion, paste, and drop', () => {
  assert.equal(classifyWritingInput('insertText', calculateTextDelta('甲', '甲乙')), 'insert');
  assert.equal(classifyWritingInput('insertReplacementText', calculateTextDelta('甲', '乙')), 'replace');
  assert.equal(classifyWritingInput('deleteContentBackward', calculateTextDelta('甲乙', '甲')), 'delete');
  assert.equal(classifyWritingInput('insertFromPaste', calculateTextDelta('', '正文')), 'paste');
  assert.equal(classifyWritingInput('insertFromDrop', calculateTextDelta('', '正文')), 'paste');
});

test('editor character counting treats emoji sequences as user-visible graphemes', () => {
  assert.equal(countGraphemes('中文A'), 3);
  assert.equal(countGraphemes('👨‍👩‍👧‍👦'), 1);
  assert.equal(countGraphemes('e\u0301'), 1);
  assert.equal(countNonWhitespaceGraphemes('你 好\t👨‍👩‍👧‍👦\nA'), 4);
  assert.equal(countNonWhitespaceGraphemes('你好，世界！'), 6);
});

test('same-editor text drag moves the selected range before or after its source', () => {
  assert.deepEqual(planTextRangeMove('甲乙丙丁戊', 1, 3, 5), {
    next: '甲丁戊乙丙',
    cursor: 5,
    delta: { start: 1, deleteCount: 4, deletedText: '乙丙丁戊', insert: '丁戊乙丙' },
    move: { start: 1, end: 3, target: 5 },
  });
  assert.deepEqual(planTextRangeMove('甲乙丙丁戊', 2, 4, 0), {
    next: '丙丁甲乙戊',
    cursor: 2,
    delta: { start: 0, deleteCount: 4, deletedText: '甲乙丙丁', insert: '丙丁甲乙' },
    move: { start: 2, end: 4, target: 0 },
  });
});

test('same-editor text drag is a no-op when dropped inside its original selection', () => {
  assert.equal(planTextRangeMove('甲乙丙丁', 1, 3, 2), undefined);
  assert.equal(planTextRangeMove('甲乙丙丁', 1, 3, 3), undefined);
});

test('editor input rebases onto authoritative undo and redo text', () => {
  assert.deepEqual(
    rebaseTextDelta('旧内容', '', calculateTextDelta('旧内容', '旧内容新')),
    { start: 0, deleteCount: 0, deletedText: '', insert: '新' },
  );
  assert.deepEqual(
    rebaseTextDelta('', '恢复内容', calculateTextDelta('', '新')),
    { start: 4, deleteCount: 0, deletedText: '', insert: '新' },
  );
  assert.deepEqual(
    rebaseTextDelta('前旧后', '前后', calculateTextDelta('前旧后', '前旧X后')),
    { start: 1, deleteCount: 0, deletedText: '', insert: 'X' },
  );
});

test('editor annotation clipboard owns the right boundary of copied characters', () => {
  const records = [1, 3, 4].map((offset, index) => ({
    id: `annotation:${index}`,
    target: { kind: 'text-range' as const, targetId: 'node:1', offset },
    body: `注释 ${offset}`,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  } satisfies AnnotationRecord));

  const items = collectAnnotationClipboardItems(records, 'node:1', 1, 3);
  assert.deepEqual(items, [{ relativeOffset: 2, body: '注释 3' }]);
  const encoded = encodeAnnotationClipboard('乙丙', items);
  assert.ok(encoded);
  assert.deepEqual(decodeAnnotationClipboard(encoded, '乙丙'), items);
  assert.deepEqual(decodeAnnotationClipboard(encoded, '不匹配'), []);

  const insertedAtAnchor = rebaseEditorAnnotationRecords(records, 'node:1', 3, 0, 1);
  assert.equal(insertedAtAnchor[1]?.target.kind === 'text-range'
    ? insertedAtAnchor[1].target.offset
    : undefined, 3);
  const moved = moveEditorAnnotationRecords(records, 'node:1', 1, 3, 0);
  assert.equal(moved[1]?.target.kind === 'text-range' ? moved[1].target.offset : undefined, 2);
});
