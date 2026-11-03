import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { assertJunctionLineTypes, splitConnectionsAtJunction } from '../src/plugins/connections/junctions.ts';
import type { ConnectionGraphSnapshot, ConnectionRecord } from '../src/protocols/connections.ts';
const source = 'core.test';
const edge = (id: string, from: ConnectionRecord['from'], to: ConnectionRecord['to'], titleRoute?: boolean): ConnectionRecord => ({ id, from, to, labelWidth: 180, labelHeight: 48, revision: 1, createdAt: 1, ...(titleRoute ? { titleRoute } : {}) });

test('mixed styles cannot be merged or connected through a chain of junctions', () => {
  const solid = edge('solid', { nodeId: 'a', side: 'right' }, { nodeId: 'c', side: 'left' });
  const dashed = edge('title', { nodeId: 'b', side: 'title' }, { nodeId: 'c', side: 'title' });
  assert.throws(() => splitConnectionsAtJunction([solid, dashed], { x: 200, y: 200 }), /虚线与实线不能共用/u);
  const records = [edge('in', solid.from, { nodeId: 'j', kind: 'junction', side: 'left' }),
    edge('chain', { nodeId: 'j', kind: 'junction', side: 'right' }, { nodeId: 'k', kind: 'junction', side: 'left' }),
    edge('out', { nodeId: 'k', kind: 'junction', side: 'right' }, dashed.to)];
  assert.throws(() => assertJunctionLineTypes(records), /虚线与实线不能共用/u);
  assert.doesNotThrow(() => assertJunctionLineTypes(records, new Set(['unrelated'])), 'unrelated legacy data stays editable');
});

async function setup() {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin()]); await kernel.start();
  const ids: string[] = [];
  for (const x of [0, 500, 1000, 1500]) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title: String(x), x, y: 100 }, source)).id);
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const created = await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[0], side: 'right' }, to: { nodeId: ids[1], side: 'left' } }, source);
  const point = await kernel.router.dispatch<{ id: string }>('connection.addJunction', { x: 300, y: 200, connections: [{ id: created.id, revision: 1 }] }, source);
  return { kernel, ids, created, point, graph };
}

test('creating and reconnecting mismatched branches fail atomically, while matching branches still work', async () => {
  const { kernel, ids, point, graph } = await setup();
  const original = await graph(), history = kernel.history.getState().undoCount;
  for (const payload of [
    { from: { nodeId: ids[2], side: 'title' as const }, to: { nodeId: point.id, kind: 'junction' as const, side: 'left' as const } },
    { from: { nodeId: point.id, kind: 'junction' as const, side: 'right' as const }, to: { nodeId: ids[2], side: 'title' as const } },
  ]) await assert.rejects(kernel.router.dispatch('connection.create', payload, source), /虚线与实线不能共用/u);
  const branch = original.connections.find(e => e.to.kind !== 'junction')!;
  await assert.rejects(kernel.router.dispatch('connection.reconnect', { id: branch.id, expectedRevision: branch.revision, from: branch.from, to: { nodeId: ids[2], side: 'title' } }, source), /虚线与实线不能共用/u);
  assert.deepEqual(await graph(), original); assert.equal(kernel.history.getState().undoCount, history);
  await kernel.router.dispatch('connection.create', { from: { nodeId: point.id, kind: 'junction', side: 'right' }, to: { nodeId: ids[2], side: 'left' } }, source);
  assert.equal((await graph()).connections.length, original.connections.length + 1);
});

test('a complete single-route component can switch style but separate styled components cannot be joined', async () => {
  const { kernel, ids, point, graph } = await setup();
  await kernel.router.dispatch('selection.set', { ids: ids.slice(0, 2) }, source);
  await kernel.router.dispatch('connection.toggleTitleSelected', undefined, source);
  const converted = await graph();
  assert.doesNotThrow(() => assertJunctionLineTypes(converted.connections));
  const second = await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[2], side: 'right' }, to: { nodeId: ids[3], side: 'left' } }, source);
  const other = await kernel.router.dispatch<{ id: string }>('connection.addJunction', { x: 1200, y: 200, connections: [{ id: second.id, revision: 1 }] }, source);
  const before = await graph();
  await assert.rejects(kernel.router.dispatch('connection.create', { from: { nodeId: other.id, kind: 'junction', side: 'right' }, to: { nodeId: point.id, kind: 'junction', side: 'left' } }, source), /虚线与实线不能共用/u);
  assert.deepEqual(await graph(), before);
});
