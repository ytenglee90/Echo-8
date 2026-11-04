import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createClipboardPlugin } from '../src/plugins/clipboard/model.ts';
import { isJunction } from '../src/plugins/connections/junctions.ts';
import { connectionGraphPoints } from '../src/plugins/connections/routing.ts';
import { connectionCurvePath } from '../src/plugins/connections/rendering.ts';
import { serializeProject, parseProject } from '../src/plugins/import-export/codec.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
const source = 'core.test';
const definitions = () => [textNodePlugin, createSelectionPlugin(), createConnectionsPlugin(), createClipboardPlugin()];
async function setup() {
  const kernel = new ApplicationKernel(definitions()); await kernel.start(); const ids: string[] = [];
  for (const x of [0, 800]) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title: String(x), x, y: 80 }, source)).id);
  const line = (await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[0], side: 'right' }, to: { nodeId: ids[1], side: 'left' } }, source)).id;
  const { id } = await kernel.router.dispatch<{ id: string }>('connection.addJunction', { x: 500, y: 300, connections: [{ id: line, revision: 1 }] }, source);
  return { kernel, ids, id, graph: () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1') };
}
test('each rotation advances 15 degrees, wraps after 24 steps, never moves the point and is undoable', async () => {
  const { kernel, id, graph } = await setup(); const original = (await graph()).junctions[0], history = kernel.history.getState().undoCount;
  for (let i = 1; i <= 24; i++) {
    await kernel.router.dispatch('connection.rotateJunctionHandle', { id }, source);
    const point = (await graph()).junctions[0]; assert.equal(point.handleAngle ?? 0, i * 15 % 360);
    assert.equal(point.x, original.x); assert.equal(point.y, original.y); assert.equal(point.revision, original.revision + i);
  }
  assert.equal(kernel.history.getState().undoCount, history + 24);
  await kernel.transactions.undo(); assert.equal((await graph()).junctions[0].handleAngle, 345);
  await kernel.transactions.redo(); assert.equal((await graph()).junctions[0].handleAngle, undefined);
  await kernel.plugins.stop('connections'); for (let i = 0; i < 24; i++) await kernel.transactions.undo(); await kernel.plugins.start('connections');
  assert.deepEqual((await graph()).junctions[0], original);
});
test('handle rotation applies to both incident tangent roles while node anchors remain unchanged', () => {
  const edge = { id: 'e', from: { nodeId: 'j', kind: 'junction' as const, side: 'right' as const }, to: { nodeId: 'a', side: 'left' as const }, labelWidth: 180, labelHeight: 48, revision: 1, createdAt: 1 };
  for (let angle = 0; angle < 360; angle += 15) {
    for (const reverse of [false, true]) {
      const record = reverse ? { ...edge, from: edge.to, to: edge.from } : edge;
      const point = connectionGraphPoints([record], new Map([['j', { id: 'j', kind: 'junction' as const, x: 500, y: 300, width: 0, height: 0, handleAngle: angle }],
        ['a', { id: 'a', x: 800, y: 80, width: 280, height: 158 }]])).get('e')!;
      const routed = reverse ? point.to : point.from, node = reverse ? point.from : point.to;
      assert.equal(node.x, 800); assert.equal(node.y, 159);
      const sign = reverse ? -1 : 1;
      assert.ok(Math.abs(routed.tangent!.x - sign * Math.cos(angle * Math.PI / 180)) < 1e-9);
      assert.ok(Math.abs(routed.tangent!.y - sign * Math.sin(angle * Math.PI / 180)) < 1e-9);
      assert.ok(!/NaN|Infinity/u.test(connectionCurvePath(point.from, point.to)));
    }
  }
});
test('angles survive file and clipboard round trips; version ten migration preserves old horizontal points and unknown data', async () => {
  const { kernel, ids, id, graph } = await setup();
  await kernel.router.dispatch('connection.rotateJunctionHandle', { id }, source); await kernel.router.dispatch('connection.rotateJunctionHandle', { id }, source);
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, source);
  assert.equal(project.plugins.find(plugin => plugin.id === 'connections')?.dataVersion, 11);
  const restored = new ApplicationKernel(definitions()); await restored.start();
  await restored.router.dispatch('system.document.replace', await parseProject(await serializeProject(project)), source);
  const reopened = await restored.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1'), current = await graph();
  assert.deepEqual({ ...reopened, connections: reopened.connections.sort((a, b) => a.id.localeCompare(b.id)) }, { ...current, connections: current.connections.sort((a, b) => a.id.localeCompare(b.id)) });
  await kernel.router.dispatch('selection.set', { ids: [...ids, id] }, source); await kernel.router.dispatch('clipboard.copy', undefined, source); await kernel.router.dispatch('clipboard.paste', undefined, source);
  const copy = (await graph()).junctions.find(point => point.id !== id)!; assert.equal(copy.handleAngle, 30); assert.equal(copy.x, 536); assert.equal(copy.y, 336);
  const migration = createConnectionsPlugin().migrations!.find(step => step.from === 10)!;
  const old = { connectionJunction: { point: { id: 'point', x: 0, y: 0, revision: 1, future: 'kept' } }, futureNamespace: { opaque: true } };
  assert.deepEqual(await migration.migrate(old), old);
  assert.ok(isJunction(old.connectionJunction.point));
  for (const angle of [-15, 1, 360, Infinity, NaN]) assert.equal(isJunction({ ...old.connectionJunction.point, handleAngle: angle }), false);
});
