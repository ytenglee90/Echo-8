import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';

async function setup() {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin()]); await kernel.start();
  const a = (await kernel.router.dispatch<{ id: string }>('node.create', { title: '甲', x: 0, y: 0 }, 'core.test')).id;
  const b = (await kernel.router.dispatch<{ id: string }>('node.create', { title: '乙', x: 1000, y: 0 }, 'core.test')).id;
  const edge = (await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: a, side: 'right' }, to: { nodeId: b, side: 'left' } }, 'core.test')).id;
  await kernel.router.dispatch('connection.addJunction', { x: 500, y: 100, connections: [{ id: edge, revision: 1 }] }, 'core.test');
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const trunk = (await graph()).connections.find(item => item.from.kind === 'junction')!;
  await kernel.router.dispatch('connection.addJunction', { x: 700, y: 100, connections: [{ id: trunk.id, revision: trunk.revision }] }, 'core.test');
  return { kernel, a, b, graph };
}
test('junction batches validate every revision before one atomic move, and arrow keys move the selected batch', async () => {
  const { kernel, graph } = await setup(); const original = await graph(), history = kernel.history.getState().undoCount;
  await assert.rejects(kernel.router.dispatch('connection.moveJunctions', { positions: original.junctions.map((point, index) => ({ id: point.id, x: point.x + 50, y: point.y, expectedRevision: point.revision + index })) }, 'core.test'));
  assert.deepEqual(await graph(), original); assert.equal(kernel.history.getState().undoCount, history);
  await kernel.router.dispatch('selection.set', { ids: original.junctions.map(point => point.id) }, 'core.test');
  await kernel.router.dispatch('connection.nudgeJunction', { id: original.junctions[0].id, dx: 10, dy: 1 }, 'core.test');
  for (const point of (await graph()).junctions) { const before = original.junctions.find(item => item.id === point.id)!; assert.equal(point.x, before.x + 10); assert.equal(point.y, before.y + 1); }
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.transactions.undo(); assert.deepEqual(await graph(), original);
});
test('junction components follow mean endpoint motion in the same transaction and undo even after the owner stops', async () => {
  const { kernel, a, b, graph } = await setup(); const original = await graph(), history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('node.move', { id: a, x: 200, y: 100 }, 'core.test');
  for (const point of (await graph()).junctions) { const before = original.junctions.find(item => item.id === point.id)!; assert.equal(point.x, before.x + 100); assert.equal(point.y, before.y + 50); }
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.transactions.undo(); assert.deepEqual(await graph(), original);
  await kernel.router.dispatch('node.moveMany', { positions: [{ id: a, x: 100, y: 40 }, { id: b, x: 1100, y: 40 }] }, 'core.test');
  for (const point of (await graph()).junctions) { const before = original.junctions.find(item => item.id === point.id)!; assert.equal(point.x, before.x + 100); assert.equal(point.y, before.y + 40); }
  await kernel.plugins.stop('connections'); await kernel.transactions.undo(); await kernel.plugins.start('connections');
  assert.deepEqual(await graph(), original);
});
