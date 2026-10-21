import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveAIChatScrollMetrics,
  resolveAIChatScrollTopFromThumb,
} from '../src/plugins/ai-assistant/chat-scroll.ts';

test('AI chat scrollbar maps the visible conversation window onto a bounded thumb', () => {
  const metrics = resolveAIChatScrollMetrics({
    clientHeight: 400,
    scrollHeight: 1_600,
    scrollTop: 600,
    trackHeight: 388,
  });
  assert.equal(metrics.canScroll, true);
  assert.equal(metrics.maxScrollTop, 1_200);
  assert.equal(metrics.thumbHeight, 97);
  assert.equal(metrics.maxThumbTop, 291);
  assert.equal(metrics.thumbTop, 145.5);
});

test('AI chat scrollbar stays hidden when the transcript fits and clamps thumb drags', () => {
  assert.equal(resolveAIChatScrollMetrics({
    clientHeight: 400,
    scrollHeight: 400,
    scrollTop: 0,
    trackHeight: 388,
  }).canScroll, false);

  const metrics = resolveAIChatScrollMetrics({
    clientHeight: 400,
    scrollHeight: 2_000,
    scrollTop: 0,
    trackHeight: 300,
  });
  assert.equal(resolveAIChatScrollTopFromThumb(10_000, metrics), metrics.maxScrollTop);
  assert.equal(resolveAIChatScrollTopFromThumb(-20, metrics), 0);
});
