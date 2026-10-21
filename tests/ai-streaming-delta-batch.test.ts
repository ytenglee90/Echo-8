import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAIStreamingDeltaBatch } from '../src/plugins/ai-assistant/streaming-delta-batch.ts';

test('streaming AI deltas are coalesced once per visual frame without losing channel order', () => {
  const deltas = Array.from({ length: 1_000 }, (_, index) => ({
    sessionId: 'session-1',
    preparationId: 'preparation-1',
    sequence: index + 1,
    channel: index % 4 === 0 ? 'reasoning' as const : 'answer' as const,
    delta: String(index % 10),
  }));
  const result = applyAIStreamingDeltaBatch(undefined, deltas, 'session-1');
  assert.equal(result?.sequence, 1_000);
  assert.equal(result?.text.length, 750);
  assert.equal(result?.reasoning.length, 250);
  assert.equal(result?.text, deltas.filter((item) => item.channel === 'answer').map((item) => item.delta).join(''));
  assert.equal(result?.reasoning, deltas.filter((item) => item.channel === 'reasoning').map((item) => item.delta).join(''));
});

test('streaming AI delta batching ignores stale sequences and other sessions', () => {
  const current = {
    preparationId: 'preparation-1',
    sequence: 4,
    text: '答',
    reasoning: '想',
  };
  const result = applyAIStreamingDeltaBatch(current, [
    { sessionId: 'other', preparationId: 'preparation-1', sequence: 5, delta: '错' },
    { sessionId: 'session-1', preparationId: 'preparation-1', sequence: 4, delta: '旧' },
    { sessionId: 'session-1', preparationId: 'preparation-1', sequence: 5, delta: '案' },
    { sessionId: 'session-1', preparationId: 'preparation-1', sequence: 6, channel: 'reasoning', delta: '法' },
  ], 'session-1');
  assert.deepEqual(result, {
    preparationId: 'preparation-1',
    sequence: 6,
    text: '答案',
    reasoning: '想法',
  });
});
