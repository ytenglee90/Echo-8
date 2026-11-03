import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createPalettePlugin } from '../src/plugins/palette/model.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import type { ColorPickerState, AppearanceReadContribution } from '../src/protocols/appearance.ts';

const source = 'core.test';
async function setup() {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin(), createPalettePlugin()]);
  await kernel.start();
  const ids: string[] = [];
  for (const x of [0, 600, 1000]) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title: String(x), x, y: 100 }, source)).id);
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const edge = await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[0], side: 'right' }, to: { nodeId: ids[1], side: 'left' } }, source);
  await kernel.router.dispatch('connection.setLabel', { id: edge.id, expectedRevision: 1, label: '保留文字' }, source);
  return { kernel, graph, ids, edge };
}

test('reconnecting an arrow retains identity and label, validates revisions and undoes after hot-stop', async () => {
  const { kernel, graph, ids, edge } = await setup();
  const original = (await graph()).connections[0], count = kernel.history.getState().undoCount;
  const request = { id: edge.id, expectedRevision: 2, from: original.from, to: { nodeId: ids[2], side: 'title' as const } };
  await kernel.router.dispatch('connection.reconnect', request, source);
  const changed = (await graph()).connections[0];
  assert.equal(changed.id, original.id); assert.equal(changed.label, original.label); assert.equal(changed.createdAt, original.createdAt);
  assert.equal(changed.to.nodeId, ids[2]); assert.equal(changed.to.side, 'title'); assert.equal(changed.from.side, 'title');
  assert.equal(changed.revision, 3); assert.equal(kernel.history.getState().undoCount, count + 1);
  await assert.rejects(kernel.router.dispatch('connection.reconnect', request, source), /已经变化/u);
  assert.deepEqual((await graph()).connections, [changed]);
  await kernel.plugins.stop('connections'); await kernel.transactions.undo(); await kernel.plugins.start('connections');
  assert.deepEqual((await graph()).connections, [original]); await kernel.transactions.redo(); assert.deepEqual((await graph()).connections, [changed]);
});

test('reconnect rejects duplicates and invalid endpoint types without changing the graph', async () => {
  const { kernel, graph, ids, edge } = await setup();
  await kernel.router.dispatch('connection.create', { from: { nodeId: ids[0], side: 'right' }, to: { nodeId: ids[2], side: 'left' } }, source);
  const original = await graph();
  for (const to of [{ nodeId: ids[2], side: 'left' as const }, { nodeId: ids[1], side: 'left' as const, kind: 'group' as const }, { nodeId: 'missing', side: 'left' as const }]) {
    await assert.rejects(kernel.router.dispatch('connection.reconnect', { id: edge.id, expectedRevision: 2, from: original.connections[0].from, to }, source));
    assert.deepEqual(await graph(), original);
  }
});

test('used colors exclude theme settings and legacy label backgrounds; background selection edits the line', async () => {
  const { kernel, graph, edge } = await setup();
  await kernel.router.dispatch('palette.setPreferences', { editorBackground: '#123456', editorChromeBackground: '#654321', toolbarBackground: '#abcdef', groupBackground: '#112233', annotationColor: '#445566' }, source);
  const current = (await graph()).connections[0];
  await kernel.router.dispatch('selection.set', { items: [{ id: edge.id, kind: 'connection', part: 'label-background' }] }, source);
  const contributions = await kernel.capabilities.requestAll<AppearanceReadContribution>('appearance.read@1', { mode: 'selection', selectedItems: [{ id: edge.id, kind: 'connection', part: 'label-background' }] });
  assert.deepEqual(contributions.flatMap(c => c.targets).filter(t => t.kind.startsWith('connection')).map(t => t.kind), ['connection-line']);
  await kernel.router.dispatch('palette.colorPicker.open', { sessionId: 'used-colors', color: '#123456', anchor: { x: 0, y: 0, width: 1, height: 1 } }, source);
  const picker = await kernel.router.ask<ColorPickerState>('palette.colorPicker.state', undefined, source);
  assert.ok(picker.colors.length > 0);
  for (const color of ['#123456', '#654321', '#abcdef', '#112233', '#445566']) assert.ok(!picker.colors.some(c => c.color === color));
  await kernel.router.dispatch('palette.applyAppearance', { kind: 'connection-label-background', color: '#ff0000', entities: [{ id: edge.id, revision: current.revision, expectedColor: '#efefec' }] }, source);
  assert.deepEqual((await graph()).connections[0], current);
});
