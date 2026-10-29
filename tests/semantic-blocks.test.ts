import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FULL_SEMANTIC_COVERAGE_LENGTH,
  MAX_SEMANTIC_BLOCKS_PER_SOURCE,
  partitionSemanticText,
  semanticBlockAround,
  stratifiedSemanticAnchors,
} from '../src/services/semantic-blocks.ts';

test('semantic text blocks prefer complete paragraph boundaries and retain absolute offsets', () => {
  const first = '第一段说明。'.repeat(120);
  const second = '第二段记录。'.repeat(120);
  const text = `${first}\n\n${second}`;
  const blocks = partitionSemanticText(text, 500);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.text, first);
  assert.equal(blocks[0]?.start, 500);
  assert.equal(blocks[1]?.text, second);
  assert.equal(blocks[1]?.start, 500 + first.length + 2);
  assert.equal(blocks.every((block) => block.text.length <= 1_200), true);
});

test('semantic blocks bound long paragraphs without splitting a surrogate pair', () => {
  const text = `${'甲'.repeat(1_199)}😀${'乙'.repeat(1_200)}`;
  const blocks = partitionSemanticText(text);
  assert.equal(blocks.map((block) => block.text).join(''), text);
  assert.equal(blocks.every((block) => !block.text.endsWith('\ud83d')), true);
  assert.equal(blocks.every((block) => !block.text.startsWith('\ude00')), true);
});

test('very large semantic sources use deterministic stratified anchors and paragraph-local probes', () => {
  const anchors = stratifiedSemanticAnchors(FULL_SEMANTIC_COVERAGE_LENGTH * 20);
  assert.equal(anchors.length, MAX_SEMANTIC_BLOCKS_PER_SOURCE);
  assert.equal(anchors[0], 0);
  assert.equal(anchors.at(-1), FULL_SEMANTIC_COVERAGE_LENGTH * 20 - 1);
  assert.equal(new Set(anchors).size, anchors.length);

  const probe = `忽略开头\n\n${'目标段落。'.repeat(60)}\n\n忽略结尾`;
  const anchor = probe.indexOf('目标段落') + 40;
  const block = semanticBlockAround(probe, 10_000, 10_000 + anchor);
  assert.ok(block);
  assert.equal(block.text.startsWith('目标段落'), true);
  assert.equal(block.text.endsWith('目标段落。'), true);
  assert.equal(block.start, 10_000 + probe.indexOf('目标段落'));
});
