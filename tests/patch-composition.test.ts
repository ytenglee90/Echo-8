import assert from 'node:assert/strict';
import test from 'node:test';

import type { PatchOperation } from '../src/core/contracts.ts';
import { HistoryService } from '../src/core/history.ts';
import { composePatchPairs } from '../src/core/patch-composition.ts';
import { mergePendingJournalRecords } from '../src/core/persistence.ts';
import type { TransactionCommitRecord } from '../src/core/transaction-manager.ts';

const target = (key: string, op: PatchOperation['op'], value?: unknown): PatchOperation => ({
  op,
  domain: 'document',
  namespace: key.startsWith('chunk:') ? 'textContentChunk' : 'textContent',
  key,
  ...(op === 'set' ? { value } : {}),
});

test('composing adjacent edits retains only the initial undo and final redo state', () => {
  const first = composePatchPairs(
    [target('chunk:a', 'delete'), target('chunk:b', 'set', { text: 'one' }), target('content', 'set', { chunk: 'b' })],
    [target('content', 'set', { chunk: 'a' }), target('chunk:b', 'delete'), target('chunk:a', 'set', { text: 'zero' })],
    [target('chunk:b', 'delete'), target('chunk:c', 'set', { text: 'two' }), target('content', 'set', { chunk: 'c' })],
    [target('content', 'set', { chunk: 'b' }), target('chunk:c', 'delete'), target('chunk:b', 'set', { text: 'one' })],
  );

  assert.deepEqual(first.forward, [
    target('chunk:a', 'delete'),
    target('content', 'set', { chunk: 'c' }),
    target('chunk:c', 'set', { text: 'two' }),
  ]);
  assert.deepEqual(first.inverse, [
    target('chunk:c', 'delete'),
    target('content', 'set', { chunk: 'a' }),
    target('chunk:a', 'set', { text: 'zero' }),
  ]);
});

test('continuous history replaces intermediate chunk versions instead of retaining them', () => {
  const history = new HistoryService();
  history.record({
    id: 'edit:1', label: '编辑正文', timestamp: 100,
    mergeKey: 'typing:node:session', mergeWindowMs: 1_400,
    forward: [target('chunk:a', 'delete'), target('chunk:b', 'set', { text: 'one' })],
    inverse: [target('chunk:b', 'delete'), target('chunk:a', 'set', { text: 'zero' })],
  });
  history.record({
    id: 'edit:2', label: '编辑正文', timestamp: 200,
    mergeKey: 'typing:node:session', mergeWindowMs: 1_400,
    forward: [target('chunk:b', 'delete'), target('chunk:c', 'set', { text: 'two' })],
    inverse: [target('chunk:c', 'delete'), target('chunk:b', 'set', { text: 'one' })],
  });

  const snapshot = history.export();
  assert.equal(snapshot.undo.length, 1);
  assert.deepEqual(snapshot.undo[0].forward, [
    target('chunk:a', 'delete'),
    target('chunk:c', 'set', { text: 'two' }),
  ]);
  assert.deepEqual(snapshot.undo[0].inverse, [
    target('chunk:c', 'delete'),
    target('chunk:a', 'set', { text: 'zero' }),
  ]);
});

test('pending recovery journal compacts only adjacent records from the same typing session', () => {
  const record = (
    id: string,
    timestamp: number,
    forward: PatchOperation[],
    inverse: PatchOperation[],
    mergeKey = 'typing:node:session',
  ): TransactionCommitRecord => ({
    id,
    label: '编辑正文',
    timestamp,
    forward,
    inverse,
    sourceMessageId: `message:${id}`,
    historyAction: 'record',
    mergeKey,
    mergeWindowMs: 1_400,
  });
  const first = record(
    'edit:1', 100,
    [target('chunk:a', 'delete'), target('chunk:b', 'set', { text: 'one' })],
    [target('chunk:b', 'delete'), target('chunk:a', 'set', { text: 'zero' })],
  );
  const second = record(
    'edit:2', 200,
    [target('chunk:b', 'delete'), target('chunk:c', 'set', { text: 'two' })],
    [target('chunk:c', 'delete'), target('chunk:b', 'set', { text: 'one' })],
  );
  const merged = mergePendingJournalRecords(first, second);
  assert.ok(merged);
  assert.equal(merged.id, first.id);
  assert.equal(merged.timestamp, second.timestamp);
  assert.deepEqual(merged.forward, [
    target('chunk:a', 'delete'),
    target('chunk:c', 'set', { text: 'two' }),
  ]);
  assert.equal(mergePendingJournalRecords(merged, record(
    'edit:3', 250,
    [target('other', 'set', { value: 1 })],
    [target('other', 'delete')],
    'typing:other:session',
  )), undefined);
});

test('a long typing session keeps one bounded chunk generation in serialized history', () => {
  const history = new HistoryService();
  let previousId = 'chunk:0000';
  for (let index = 1; index <= 500; index += 1) {
    const nextId = `chunk:${String(index).padStart(4, '0')}`;
    history.record({
      id: `edit:${index}`,
      label: '编辑正文',
      timestamp: index * 10,
      mergeKey: 'typing:large-node:session',
      mergeWindowMs: 1_400,
      forward: [
        target(previousId, 'delete'),
        target(nextId, 'set', { id: nextId, text: `${String(index).padStart(4, '0')}${'字'.repeat(64 * 1024 - 4)}` }),
        target('content', 'set', { chunkId: nextId, revision: index }),
      ],
      inverse: [
        target('content', 'set', { chunkId: previousId, revision: index - 1 }),
        target(nextId, 'delete'),
        target(previousId, 'set', {
          id: previousId,
          text: `${String(index - 1).padStart(4, '0')}${'字'.repeat(64 * 1024 - 4)}`,
        }),
      ],
    });
    previousId = nextId;
  }

  const snapshot = history.export();
  assert.equal(snapshot.undo.length, 1);
  assert.equal(snapshot.undo[0].forward.length, 3);
  assert.equal(snapshot.undo[0].inverse.length, 3);
  assert.ok(JSON.stringify(snapshot.undo[0]).length < 270_000);
});

test('composed patch pairs replay the same randomized final and initial states', () => {
  let randomState = 0x5eed1234;
  const random = () => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  const apply = (state: Map<string, unknown>, patches: PatchOperation[]) => {
    for (const patch of patches) {
      if (patch.op === 'set') state.set(patch.key, structuredClone(patch.value));
      else state.delete(patch.key);
    }
  };
  const inverseFor = (state: Map<string, unknown>, forward: PatchOperation[]) => forward.map((patch) =>
    state.has(patch.key)
      ? target(patch.key, 'set', structuredClone(state.get(patch.key)))
      : target(patch.key, 'delete')).reverse();

  for (let scenario = 0; scenario < 100; scenario += 1) {
    const initial = new Map<string, unknown>([
      ['value:0', { version: 0 }],
      ['value:1', { version: 0 }],
    ]);
    const expected = new Map(initial);
    let composed = { forward: [] as PatchOperation[], inverse: [] as PatchOperation[] };
    for (let step = 0; step < 40; step += 1) {
      const keys = [...new Set(Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
        `value:${Math.floor(random() * 8)}`))];
      const forward = keys.map((key) => random() < 0.3
        ? target(key, 'delete')
        : target(key, 'set', { scenario, step, salt: Math.floor(random() * 10_000) }));
      const inverse = inverseFor(expected, forward);
      apply(expected, forward);
      composed = step === 0
        ? { forward, inverse }
        : composePatchPairs(composed.forward, composed.inverse, forward, inverse);
    }
    const redone = new Map(initial);
    apply(redone, composed.forward);
    assert.deepEqual([...redone.entries()].sort(), [...expected.entries()].sort());
    apply(redone, composed.inverse);
    assert.deepEqual([...redone.entries()].sort(), [...initial.entries()].sort());
  }
});
