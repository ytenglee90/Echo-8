import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { StateStore } from '../src/core/store.ts';
import { HistoryService } from '../src/core/history.ts';
import { TransactionManager } from '../src/core/transaction-manager.ts';
import type { MessageEnvelope, PatchOperation, PluginDefinition } from '../src/core/contracts.ts';
import { defineManifest } from '../src/plugins/manifest.ts';
import { serializeProject, parseProject } from '../src/plugins/import-export/codec.ts';
import { createSearchIndexPlugin } from '../src/plugins/search-index/model.ts';
import { abortableDelay } from '../src/services/async-control.ts';

const envelope: MessageEnvelope = {
  id: 'audit', type: 'audit', sourcePlugin: 'core.test', schemaVersion: 1,
  correlationId: 'audit', timestamp: 0, priority: 1, depth: 0, payload: undefined,
};
const patch = (value: unknown): PatchOperation => ({
  op: 'set', domain: 'document', namespace: 'data', key: 'x', value,
});

test('project imports preserve special keys and never modify object prototypes', async () => {
  const source = { document: { revision: 0, namespaces: JSON.parse(
    '{"__proto__":{"echo8AuditMarker":true},"extension":{"__proto__":{"sentinel":1},"constructor":2,"toString":3}}',
  ) }, plugins: [] };
  try {
    const restored = await parseProject(await serializeProject(source));
    assert.equal(Object.hasOwn(Object.prototype, 'echo8AuditMarker'), false);
    assert.deepEqual(restored.document, source.document);
    const token = Symbol('write');
    const store = new StateStore(token);
    store.replaceDocument(restored.document, token);
    store.apply([{ op: 'set', domain: 'document', namespace: '__proto__', key: '__proto__', value: 4 }], token);
    assert.equal(store.readValue('document', '__proto__', '__proto__'), 4);
    assert.equal(store.readValue('document', 'missing', 'constructor'), undefined);
    assert.deepEqual((await store.snapshotAsync()).document, store.snapshot().document);
  } finally {
    Reflect.deleteProperty(Object.prototype, 'echo8AuditMarker');
  }
});

test('observer failures do not split state, history, persistence or other notifications', async () => {
  const token = Symbol('write');
  const errors: unknown[] = [];
  const store = new StateStore(token, error => errors.push(error));
  const history = new HistoryService();
  const tx = new TransactionManager(store, history, token);
  let notifications = 0, persisted = 0;
  store.subscribe(() => { throw Error('observer'); });
  store.subscribe(() => { notifications++; assert.equal(history.getState().undoCount, 1); });
  tx.setPersistenceSink(() => { persisted++; });
  await tx.commit({ label: 'write', patches: [patch(1)] }, envelope, 'core.test');
  assert.equal(store.readValue('document', 'data', 'x'), 1);
  assert.equal(history.getState().undoCount, 1);
  assert.equal(notifications, 1);
  assert.equal(persisted, 1);
  assert.equal(errors.length, 1);
});

test('failed persistence admission restores record, revisions and merged undo/redo history', async () => {
  const token = Symbol('write'), store = new StateStore(token), history = new HistoryService();
  const tx = new TransactionManager(store, history, token);
  await tx.commit({ label: 'first', patches: [patch(1)], mergeKey: 'typing' }, envelope, 'core.test');
  const before = store.snapshot(), oldHistory = history.export(), version = store.getVersion();
  tx.setPersistenceSink(() => { throw Error('persistence'); });
  await assert.rejects(tx.commit({ label: 'second', patches: [patch(2)], mergeKey: 'typing' }, envelope, 'core.test'), /persistence/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(history.export(), oldHistory);
  assert.equal(store.getVersion(), version);
  await assert.rejects(tx.undo(), /persistence/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(history.export(), oldHistory);
  await assert.rejects(tx.replaceDocument({ revision: 0, namespaces: {} }, { undo: [], redo: [] }, envelope), /persistence/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(history.export(), oldHistory);
  tx.setPersistenceSink(() => undefined);
  await tx.undo();
  const undone = store.snapshot(), undoHistory = history.export();
  tx.setPersistenceSink(() => { throw Error('persistence'); });
  await assert.rejects(tx.redo(), /persistence/);
  assert.deepEqual(store.snapshot(), undone);
  assert.deepEqual(history.export(), undoHistory);
});

test('only unchanged owner-produced capability plans authorize cross-plugin writes, once', async () => {
  let planned: PatchOperation[] = [];
  const owner: PluginDefinition = {
    manifest: defineManifest('owner-a', 'A', {
      namespaces: ['data'], namespaceDomains: { data: 'document' }, permissions: ['store.own.write'],
      providesCapabilities: ['appearance.updatePlan@1'],
    }),
    start(c) { c.capabilities.provide({ key: 'appearance.updatePlan@1', invoke: () => ({ patches: [patch(7)] }) }); },
  };
  const consumer: PluginDefinition = {
    manifest: defineManifest('consumer', 'consumer', {
      commands: ['audit.spoof', 'audit.plan', 'audit.replay', 'audit.modified'], optionalCapabilities: ['appearance.updatePlan@1'],
    }),
    start(c) {
      c.commands.register({ type: 'audit.spoof', handle: () => ({ transaction: { label: 'spoof', patches: [{ ...patch(42), schemaOwner: 'owner-a' }] } }) });
      c.commands.register({ type: 'audit.plan', handle: async () => {
        planned = (await c.capabilities.request<{ patches: PatchOperation[] }>('appearance.updatePlan@1')).patches;
        return { transaction: { label: 'plan', patches: planned } };
      } });
      c.commands.register({ type: 'audit.replay', handle: () => ({ transaction: { label: 'replay', patches: planned } }) });
      c.commands.register({ type: 'audit.modified', handle: async () => {
        const plan = await c.capabilities.request<{ patches: PatchOperation[] }>('appearance.updatePlan@1');
        plan.patches[0].value = 99;
        return { transaction: { label: 'modified', patches: plan.patches } };
      } });
    },
  };
  const kernel = new ApplicationKernel([owner, consumer], { persistenceLaunchPolicy: 'memory-only' });
  await kernel.start();
  try {
    await assert.rejects(kernel.router.dispatch('audit.spoof', undefined, 'core.test'), /Unverified/);
    await kernel.router.dispatch('audit.plan', undefined, 'core.test');
    assert.equal(kernel.store.readValue('document', 'data', 'x'), 7);
    await assert.rejects(kernel.router.dispatch('audit.replay', undefined, 'core.test'), /Unverified/);
    await assert.rejects(kernel.router.dispatch('audit.modified', undefined, 'core.test'), /Unverified/);
    assert.equal(kernel.store.readValue('document', 'data', 'x'), 7);
    planned = (await kernel.capabilities.request<{ patches: PatchOperation[] }>('appearance.updatePlan@1')).patches;
    await kernel.plugins.stop('owner-a');
    await assert.rejects(kernel.router.dispatch('audit.replay', undefined, 'core.test'), /Unverified/);
    await kernel.transactions.undo();
    assert.equal(kernel.store.readValue('document', 'data', 'x'), undefined);
  } finally { await kernel.plugins.stop('consumer'); await kernel.plugins.stop('owner-a'); }
});

test('ordinary plugins cannot claim a reserved kernel identity', async () => {
  const kernel = new ApplicationKernel([], { persistenceLaunchPolicy: 'memory-only' });
  assert.throws(() => kernel.plugins.register({ manifest: defineManifest('core-addon', 'feature'), start() {} }), /Reserved kernel identity/);
});

test('stopping an index cancels owned work before waiting for an in-flight search', async () => {
  let entered!: () => void;
  const readStarted = new Promise<void>(resolve => { entered = resolve; });
  const source: PluginDefinition = {
    manifest: defineManifest('source', 'source', { providesCapabilities: ['context.catalog@1', 'context.read@1'] }),
    start(c) {
      c.capabilities.provide({ key: 'context.catalog@1', invoke: () => ({ provider: 'source', sources: [
        { sourceId: 'x', provider: 'source', kind: 'text', title: 'x', revision: 1, length: 1 },
      ] }) });
      c.capabilities.provide({ key: 'context.read@1', invoke: async (_, signal) => {
        entered(); await abortableDelay(10_000, signal!); return { handled: true, text: 'x' };
      } });
    },
  };
  const kernel = new ApplicationKernel([source, createSearchIndexPlugin()], { persistenceLaunchPolicy: 'memory-only' });
  await kernel.start(); await readStarted;
  const search = kernel.capabilities.request('context.search@3', { terms: ['x'], maxResults: 1 });
  const rejected = assert.rejects(search, { name: 'AbortError' });
  await Promise.resolve();
  try {
    await Promise.race([kernel.plugins.stop('search-index'), abortableDelay(1_000, new AbortController().signal).then(() => { throw Error('stop timed out'); })]);
    await rejected;
    assert.equal(kernel.tasks.snapshot().tasks.some(task => task.owner === 'search-index'), false);
  } finally { kernel.tasks.cancelOwner('search-index'); await kernel.plugins.stop('source'); }
});
