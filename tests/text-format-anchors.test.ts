import assert from 'node:assert/strict';
import test from 'node:test';
import type { TextFormatMark } from '../src/protocols/formatting.ts';
import { transformTextFormatMarks } from '../src/services/text-format-anchors.ts';

const mark: TextFormatMark = {
  id: 'style', nodeId: 'node', scope: 'selection', revision: 1,
  start: { offset: 5, bias: 'after' }, end: { offset: 9, bias: 'before' },
  format: { fontSize: 24, fontWeight: 900 },
};

test('format ranges follow rapid preceding edits, exclude boundary insertions and retain interior typing', () => {
  let marks = [mark];
  let body = '前段\n空行格式保持尾';
  for (const edit of [
    { start: 0, deleteCount: 0, insert: '😀' },
    { start: 3, deleteCount: 0, insert: '\n新增段落\n' },
    { start: 1, deleteCount: 2, insert: '' },
  ]) {
    marks = transformTextFormatMarks(marks, { ...edit, insertLength: edit.insert.length });
    body = body.slice(0, edit.start) + edit.insert + body.slice(edit.start + edit.deleteCount);
    assert.equal(body.slice(marks[0].start.offset, marks[0].end.offset), '格式保持');
  }
  const start = marks[0].start.offset;
  marks = transformTextFormatMarks(marks, { start, deleteCount: 0, insertLength: 2 });
  assert.equal(marks[0].start.offset, start + 2);
  const end = marks[0].end.offset;
  marks = transformTextFormatMarks(marks, { start: end, deleteCount: 0, insertLength: 3 });
  assert.equal(marks[0].end.offset, end);
  marks = transformTextFormatMarks(marks, { start: start + 3, deleteCount: 0, insertLength: 1 });
  assert.equal(marks[0].end.offset, end + 1);
  assert.deepEqual(mark.start, { offset: 5, bias: 'after' });
  assert.equal(mark.revision, 1);
});

test('deleting all formatted characters removes the mark instead of styling adjacent text', () => {
  assert.deepEqual(transformTextFormatMarks([mark], { start: 3, deleteCount: 7, insertLength: 0 }), []);
});
