import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countGraphemes,
  countNonWhitespaceGraphemes,
  countWritingUnits,
  StreamingGraphemeCounter,
  updateWritingUnitCount,
} from '../src/services/text-metrics.ts';

test('one Unicode character definition is shared by whole text and chunked text', () => {
  const text = '你 e\u0301\t👨‍👩‍👧‍👦\nA';
  assert.equal(countGraphemes(text), 7);
  assert.equal(countNonWhitespaceGraphemes(text), 4);

  const counter = new StreamingGraphemeCounter();
  for (const chunk of ['你 e', '\u0301\t👨‍', '👩‍👧', '‍👦\nA']) counter.push(chunk);
  assert.deepEqual(counter.finish(), {
    graphemes: countGraphemes(text),
    nonWhitespaceGraphemes: countNonWhitespaceGraphemes(text),
  });
});

test('writing count follows a stable Chinese writing-software style rule', () => {
  assert.equal(countWritingUnits('你好，world 2026！👨‍👩‍👧‍👦'), 4);
  assert.equal(countWritingUnits('中文\nかな カナ 한글'), 8);
  assert.equal(countWritingUnits('DeepSeek-v4-pro 3.14 don\'t'), 3);
  assert.equal(countWritingUnits('　，。！？—… 👨‍👩‍👧‍👦'), 0);
});

test('incremental writing count rescans the changed lexical run', () => {
  assertIncrementalCount('foobar', 'foo bar', { start: 3, deleteCount: 0, insert: ' ' });
  assertIncrementalCount('foo bar', 'foobar', { start: 3, deleteCount: 1, insert: '' });
  assertIncrementalCount('foobar', 'foo中bar', { start: 3, deleteCount: 0, insert: '中' });
  assertIncrementalCount('甲 foo 乙', '甲 foo-v4 乙', { start: 5, deleteCount: 0, insert: '-v4' });
});

function assertIncrementalCount(
  previous: string,
  next: string,
  delta: { start: number; deleteCount: number; insert: string },
): void {
  assert.equal(
    updateWritingUnitCount(countWritingUnits(previous), previous, next, delta),
    countWritingUnits(next),
  );
}
