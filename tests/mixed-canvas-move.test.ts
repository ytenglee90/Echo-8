import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
const source = 'core.test';
async function setup() {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin(), createGroupsPlugin()]); await kernel.start();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title: String(i), x: i * 300, y: 80 }, source)).id);
  await kernel.router.dispatch('node.presentation.set', { id: ids[3], presentation: 'text-box' }, source);
  await kernel.router.dispatch('selection.set', { ids: ids.slice(0, 2) }, source);
  const group = (await kernel.router.dispatch<{ id: string }>('group.create', undefined, source)).id;
  const line = (await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[2], side: 'right' }, to: { nodeId: ids[3], side: 'left' } }, source)).id;
  await kernel.router.dispatch('connection.addJunction', { x: 700, y: 300, connections: [{ id: line, revision: 1 }] }, source);
  return { kernel, ids, group, graph: () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1'), nodes: () => kernel.capabilities.request<ContentSummary[]>('content.summaries@1') };
}
test('mixed content and junction moves commit and undo atomically, including owner hot stop', async () => {
  const { kernel, ids, graph, nodes } = await setup(); const initial = await graph(), point = initial.junctions[0];
  const before = await nodes(), selected = before.filter(node => ids.includes(node.id));
  const history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('selection.moveEntities', { positions: [...selected.map(node => ({ id: node.id, x: node.x + 120, y: node.y + 70 })),
    { id: point.id, x: point.x + 120, y: point.y + 70, expectedRevision: point.revision }] }, source);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  assert.equal((await graph()).junctions[0].x, point.x + 120);
  for (const node of (await nodes()).filter(node => ids.includes(node.id))) assert.equal(node.x, before.find(old => old.id === node.id)!.x + 120);
  await kernel.plugins.stop('connections'); await kernel.transactions.undo(); await kernel.plugins.start('connections');
  assert.deepEqual(await graph(), initial); assert.deepEqual(await nodes(), before);
});
test('stale or unavailable junction plans reject before any content is moved', async () => {
  const { kernel, ids, graph, nodes } = await setup(); const point = (await graph()).junctions[0], before = await nodes();
  const history = kernel.history.getState().undoCount;
  for (const input of [{ id: point.id, expectedRevision: point.revision + 1 }, { id: 'missing', expectedRevision: 1 }]) {
    await assert.rejects(kernel.router.dispatch('selection.moveEntities', { positions: [{ id: ids[2], x: 2000, y: 2000 }, { ...input, x: 2000, y: 2000 }] }, source));
    assert.deepEqual(await nodes(), before); assert.equal(kernel.history.getState().undoCount, history);
  }
});
test('junction arrow keys expand selected groups once, moving explicit nodes and boxes with the same delta', async () => {
  const { kernel, ids, group, graph, nodes } = await setup(); const before = await nodes(), point = (await graph()).junctions[0];
  await kernel.router.dispatch('selection.set', { ids: [group, ...ids, point.id] }, source);
  const history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('connection.nudgeJunction', { id: point.id, dx: 10, dy: -1 }, source);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  for (const node of (await nodes()).filter(node => ids.includes(node.id))) { const old = before.find(item => item.id === node.id)!; assert.equal(node.x, old.x + 10); assert.equal(node.y, old.y - 1); }
  assert.equal((await graph()).junctions[0].x, point.x + 10);
  await kernel.transactions.undo(); assert.deepEqual(await nodes(), before);
  await kernel.router.dispatch('node.move', { id: ids[2], x: 2000, y: 2000 }, source);
  assert.deepEqual((await graph()).junctions[0], point, 'an unselected routing point still does not follow content');
});
