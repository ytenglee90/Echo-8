import assert from 'node:assert/strict';
import test from 'node:test';

import {
  externalizeContentChunks,
  validateChunkExternalizedApplication,
  validateExternalizedCheckpoint,
} from '../src/core/checkpoint-preparation.ts';
import { CheckpointPerformanceMonitor } from '../src/core/checkpoint-performance.ts';
import {
  scrubRetiredHistoryInPlace,
  scrubRetiredStore,
  scrubRetiredStoreInPlace,
} from '../src/core/legacy-migrations.ts';
import {
  prepareCheckpointWorkerRequest,
} from '../src/core/persistence-worker-jobs.ts';
import {
  hydrateExternalizedContentChunks,
  type PersistedApplication,
} from '../src/core/persistence.ts';
import { HistoryService } from '../src/core/history.ts';
import { StateStore } from '../src/core/store.ts';

function application(): PersistedApplication {
  return {
    formatVersion: 1,
    savedAt: 123,
    store: {
      formatVersion: 1,
      document: {
        revision: 2,
        namespaces: {
          textContentChunk: {
            'chunk:a': { id: 'chunk:a', text: 'alpha' },
            'chunk:b': { id: 'chunk:b', text: 'beta' },
          },
          textNode: { node: { id: 'node', chunkIds: ['chunk:a', 'chunk:b'] } },
        },
      },
      workspace: { revision: 0, namespaces: {} },
    },
    history: {
      undo: [{
        id: 'edit:1', label: '编辑', timestamp: 120,
        forward: [{
          op: 'set', domain: 'document', namespace: 'textContentChunk', key: 'chunk:b',
          value: { id: 'chunk:b', text: 'beta' },
        }],
        inverse: [{
          op: 'set', domain: 'document', namespace: 'textContentChunk', key: 'chunk:old',
          value: { id: 'chunk:old', text: 'before' },
        }],
      }],
      redo: [],
    },
  };
}

test('checkpoint worker preparation externalizes active and historical chunks without changing recovery', () => {
  const externalized = externalizeContentChunks(application());
  const stored = prepareCheckpointWorkerRequest(externalized.stored);
  validateChunkExternalizedApplication(stored);
  const prepared = { stored, chunks: externalized.chunks };
  validateExternalizedCheckpoint(prepared);
  assert.deepEqual([...prepared.chunks.keys()].sort(), ['chunk:a', 'chunk:b', 'chunk:old']);
  assert.deepEqual(prepared.stored.activeContentChunkIds.sort(), ['chunk:a', 'chunk:b']);
  const restored = hydrateExternalizedContentChunks(prepared.stored, prepared.chunks);
  assert.deepEqual(restored, application());
});

test('checkpoint validation rejects an injected partial worker result before it can replace the good snapshot', () => {
  const stable = externalizeContentChunks(application());
  const injected = structuredClone(stable);
  injected.chunks.delete('chunk:b');
  assert.throws(() => validateExternalizedCheckpoint(injected), /omitted content chunk chunk:b/);
  validateExternalizedCheckpoint(stable);
  assert.equal(hydrateExternalizedContentChunks(stable.stored, stable.chunks).store.document.revision, 2);
  assert.throws(() => prepareCheckpointWorkerRequest({ formatVersion: 1 }), /structure is invalid/);
});

test('checkpoint performance monitor reports injected long tasks and worker use', () => {
  let now = 10;
  let disconnected = false;
  const monitor = new CheckpointPerformanceMonitor({
    now: () => now,
    createLongTaskObserver: (listener) => {
      listener([{ duration: 67.25 }]);
      return {
        observe() {},
        takeRecords: () => [{ duration: 54.5 }],
        disconnect: () => { disconnected = true; },
      };
    },
  });
  monitor.recordSynchronousPhase(31);
  now = 94.4;
  const result = monitor.finish(72.234, true);
  assert.deepEqual(result, {
    measuredAt: result.measuredAt,
    durationMs: 84.4,
    prepareMs: 72.2,
    longestMainThreadBlockMs: 67.3,
    usedWorker: true,
  });
  assert.equal(disconnected, true);
});

test('checkpoint scrubbing reuses an isolated snapshot without cloning unchanged large records again', () => {
  const snapshot = application().store;
  const activeChunk = snapshot.document.namespaces.textContentChunk['chunk:a'];
  const original = structuredClone(snapshot);
  original.document.namespaces.textNode.node = { id: 'node', private: true };
  const publicResult = scrubRetiredStore(original);
  assert.equal(Object.prototype.hasOwnProperty.call(
    original.document.namespaces.textNode.node as object,
    'private',
  ), true);
  assert.equal(Object.prototype.hasOwnProperty.call(
    publicResult.value.document.namespaces.textNode.node as object,
    'private',
  ), false);

  snapshot.document.namespaces.textNode.node = { id: 'node', private: true };
  assert.equal(scrubRetiredStoreInPlace(snapshot), true);
  assert.equal(snapshot.document.namespaces.textContentChunk['chunk:a'], activeChunk);
  assert.equal(Object.prototype.hasOwnProperty.call(
    snapshot.document.namespaces.textNode.node as object,
    'private',
  ), false);

  const history = application().history;
  const unchangedPatchValue = history.undo[0].forward[0].value;
  assert.equal(scrubRetiredHistoryInPlace(history), false);
  assert.equal(history.undo[0].forward[0].value, unchangedPatchValue);
});

test('persistence snapshots preserve only explicitly declared immutable chunk values', async () => {
  const token = Symbol('write');
  const store = new StateStore(token);
  const chunk = { id: 'chunk:a', text: 'large immutable text' };
  const metadata = { id: 'content:a', revision: 1 };
  store.apply([
    { op: 'set', domain: 'document', namespace: 'textContentChunk', key: 'chunk:a', value: chunk },
    { op: 'set', domain: 'document', namespace: 'textContent', key: 'content:a', value: metadata },
  ], token);
  const internalChunk = store.readValue('document', 'textContentChunk', 'chunk:a');
  const ordinary = await store.snapshotAsync();
  const preserved = await store.snapshotAsync(undefined, {
    preserveImmutableNamespaces: new Set(['textContentChunk']),
  });
  const preservedAgain = await store.snapshotAsync(undefined, {
    preserveImmutableNamespaces: new Set(['textContentChunk']),
  });
  assert.notEqual(ordinary.document.namespaces.textContentChunk['chunk:a'], internalChunk);
  assert.equal(
    preserved.document.namespaces.textContentChunk['chunk:a'],
    preservedAgain.document.namespaces.textContentChunk['chunk:a'],
  );
  assert.notEqual(
    preserved.document.namespaces.textContent['content:a'],
    preservedAgain.document.namespaces.textContent['content:a'],
  );

  const history = new HistoryService();
  history.record({
    id: 'edit', label: '编辑', timestamp: 1,
    forward: [{ op: 'set', domain: 'document', namespace: 'textContentChunk', key: 'chunk:a', value: chunk }],
    inverse: [{ op: 'delete', domain: 'document', namespace: 'textContentChunk', key: 'chunk:a' }],
  });
  const internalHistoryValue = history.peekUndo()!.forward[0].value;
  const exported = await history.exportAsync(undefined, {
    preserveImmutableNamespaces: new Set(['textContentChunk']),
  });
  assert.equal(exported.undo[0].forward[0].value, internalHistoryValue);
});
