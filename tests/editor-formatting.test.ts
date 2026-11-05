import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TEXT_DOCUMENT_FORMAT as defaults, type TextFormatMark } from '../src/protocols/formatting.ts';
import { inferFormatTarget, resolveActiveFormat, resolveFormatRange, resolveMixedFormatFields } from '../src/plugins/editor/format-target.ts';
import { transformTextFormatMarks } from '../src/services/text-format-anchors.ts';

const mark = (start: number, end: number, format: TextFormatMark['format'], scope: TextFormatMark['scope'] = 'paragraph'): TextFormatMark => ({
  id: `${start}:${end}`, nodeId: 'node', revision: 1, scope, format,
  start: { offset: start, bias: 'before' }, end: { offset: end, bias: 'after' },
});
const doc = (body: string, marks: TextFormatMark[] = [], windowStart = 0) => ({
  body, length: windowStart + body.length, windowStart, format: { ...defaults }, marks,
});

test('paragraph targeting handles blank lines, trailing blank paragraphs and exact newline boundaries', () => {
  const document = doc('\n甲乙\n丙丁\n');
  assert.deepEqual(resolveFormatRange(document, 'paragraph', { start: 0, end: 0 }), { start: 0, end: 1 });
  assert.deepEqual(resolveFormatRange(document, 'paragraph', { start: 2, end: 4 }), { start: 1, end: 4 });
  assert.deepEqual(resolveFormatRange(document, 'paragraph', { start: 7, end: 7 }), { start: 7, end: 7 });
  assert.equal(inferFormatTarget(document, { start: 0, end: 7 }), 'selection');
  assert.deepEqual(resolveFormatRange(doc('甲乙\n丙丁', [], 100), 'paragraph', { start: 104, end: 104 }), { start: 103, end: 105 });
});

test('caret reports current paragraph and inline styles without leaking from the preceding paragraph', () => {
  const document = doc('甲乙\n丙丁\n', [mark(0, 3, { fontSize: 24, lineHeight: 2.6 }), mark(1, 2, { fontWeight: 900 }, 'selection')]);
  assert.equal(resolveActiveFormat(document, { start: 1, end: 1 }).fontWeight, 900);
  assert.equal(resolveActiveFormat(document, { start: 2, end: 2 }).fontWeight, 900);
  assert.equal(resolveActiveFormat(document, { start: 3, end: 3 }).fontSize, 15);
  assert.equal(resolveActiveFormat(document, { start: 6, end: 6 }).lineHeight, defaults.lineHeight);
});

test('mixed format detection resolves overlapping marks in durable order and ignores overridden values', () => {
  const document = doc('甲乙\n丙丁', [mark(0, 3, { fontSize: 24, lineHeight: 1.2 }), mark(3, 5, { fontSize: 36, lineHeight: 2.6 })]);
  assert.deepEqual(resolveMixedFormatFields(document, { start: 0, end: 5 }), ['fontSize', 'lineHeight']);
  document.marks.push(mark(0, 5, { fontSize: 15 }));
  assert.deepEqual(resolveMixedFormatFields(document, { start: 0, end: 5 }), ['lineHeight']);
  assert.deepEqual(resolveMixedFormatFields(document, { start: 4, end: 4 }), []);
  assert.deepEqual(resolveMixedFormatFields(doc('甲乙丙', [mark(1, 2, { fontWeight: 900 }, 'selection')]), { start: 0, end: 3 }), ['fontWeight']);
});

test('a styled terminal blank paragraph accepts input and keeps its independent style', () => {
  const blank = mark(3, 3, { fontSize: 36, firstLineIndent: 2 });
  const document = doc('甲乙\n', [blank]);
  assert.equal(resolveActiveFormat(document, { start: 3, end: 3 }).fontSize, 36);
  const transformed = transformTextFormatMarks([blank], { start: 3, deleteCount: 0, insertLength: 2 });
  assert.deepEqual([transformed[0].start.offset, transformed[0].end.offset], [3, 5]);
  assert.equal(resolveActiveFormat(doc('甲乙\n丙丁', transformed), { start: 4, end: 4 }).fontSize, 36);
  assert.equal(resolveActiveFormat(document, { start: 1, end: 1 }).fontSize, 15);
});

test('mixed formatting remains bounded with ten thousand marks in one long paragraph', () => {
  const body = '文'.repeat(256 * 1024);
  const marks = Array.from({ length: 10_000 }, (_, index) => mark(index * 20, index * 20 + 10, {
    lineHeight: index % 2 ? 1.2 : 2.6, firstLineIndent: 2,
  }, 'selection'));
  const started = performance.now();
  assert.deepEqual(resolveMixedFormatFields(doc(body, marks), { start: 0, end: body.length }), []);
  assert.ok(performance.now() - started < 1_000, 'do not rescan a 256 KiB paragraph for each mark');
});
