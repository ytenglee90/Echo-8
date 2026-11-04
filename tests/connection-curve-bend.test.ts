import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createClipboardPlugin } from '../src/plugins/clipboard/model.ts';
import { connectionGraphPoints } from '../src/plugins/connections/routing.ts';
import { connectionCurvePath } from '../src/plugins/connections/rendering.ts';
import { serializeProject, parseProject } from '../src/plugins/import-export/codec.ts';
import { isConnectionCurveBend, type ConnectionGraphSnapshot, type ConnectionNodeGeometry, type ConnectionRecord } from '../src/protocols/connections.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import { assertSmoothRoute, assertNoSelfIntersection } from './helpers/route-assertions.ts';

const source = 'core.test', definitions = () => [textNodePlugin, createSelectionPlugin(), createConnectionsPlugin(), createClipboardPlugin()];
async function setup() {
  const kernel = new ApplicationKernel(definitions()); await kernel.start();
  const ids: string[] = [];
  for (const [x, y] of [[0, 80], [900, 80], [900, 500]]) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { x, y }, source)).id);
  const edges: string[] = [];
  for (const id of ids.slice(1)) edges.push((await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[0], side: 'right' }, to: { nodeId: id, side: 'left' } }, source)).id);
  await kernel.router.dispatch('connection.addJunction', { x: 550, y: 350, connections: edges.map(id => ({ id, revision: 1 })) }, source);
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  return { kernel, ids, graph, edge: (await graph()).connections.find(edge => edge.id === edges[0])! };
}

test('steering one curve changes one edge only, checks revisions and creates a single undoable transaction', async () => {
  const { kernel, graph, edge } = await setup(), before = await graph(), history = kernel.history.getState().undoCount;
  const request = { id: edge.id, end: 'from', angle: 45, expectedRevision: edge.revision };
  await kernel.router.dispatch('connection.setCurveBend@1', request, source);
  const after = await graph(), changed = after.connections.find(e => e.id === edge.id)!;
  assert.deepEqual(after.junctions, before.junctions);
  assert.deepEqual(after.connections.filter(e => e.id !== edge.id), before.connections.filter(e => e.id !== edge.id));
  assert.deepEqual(changed, { ...edge, curveBend: { from: 45 }, revision: edge.revision + 1 });
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await assert.rejects(kernel.router.dispatch('connection.setCurveBend@1', request, source), /已变化/u);
  for (const angle of [-90, 1, 90, NaN, Infinity]) await assert.rejects(kernel.router.dispatch('connection.setCurveBend@1', { ...request, angle, expectedRevision: changed.revision }, source));
  await kernel.router.dispatch('connection.setCurveBend@1', { ...request, expectedRevision: changed.revision }, source);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.plugins.stop('connections'); await kernel.transactions.undo(); await kernel.plugins.start('connections'); assert.deepEqual(await graph(), before);
  await kernel.transactions.redo(); assert.deepEqual(await graph(), after);
});

test('per-curve bends survive version twelve files and clipboard seven, while reconnection drops the replaced endpoint bend', async () => {
  const { kernel, graph, edge, ids } = await setup();
  await kernel.router.dispatch('connection.setCurveBend@1', { id: edge.id, end: 'from', angle: -30, expectedRevision: edge.revision }, source);
  const before = await graph(), project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, source);
  assert.equal(project.plugins.find(p => p.id === 'connections')?.dataVersion, 12);
  const restored = new ApplicationKernel(definitions()); await restored.start();
  await restored.router.dispatch('system.document.replace', await parseProject(await serializeProject(project)), source);
  const reopened = await restored.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  assert.deepEqual({ ...reopened, connections: reopened.connections.sort((a, b) => a.id.localeCompare(b.id)) },
    { ...before, connections: [...before.connections].sort((a, b) => a.id.localeCompare(b.id)) });
  const fragment = await kernel.capabilities.request<{ payload: { schemaVersion: number } }>('clipboard.serialize@1', { ids: [...ids, ...before.junctions.map(p => p.id)] });
  assert.equal(fragment.payload.schemaVersion, 7);
  await kernel.router.dispatch('selection.set', { ids: [...ids, ...before.junctions.map(p => p.id)] }, source);
  await kernel.router.dispatch('clipboard.copy', undefined, source); await kernel.router.dispatch('clipboard.paste', undefined, source);
  assert.equal((await graph()).connections.filter(e => e.curveBend?.from === -30).length, 2);
  const changed = (await graph()).connections.find(e => e.id === edge.id)!;
  await kernel.router.dispatch('connection.reconnect', { id: edge.id, expectedRevision: changed.revision, from: { nodeId: ids[0], side: 'right' }, to: changed.to }, source);
  assert.equal((await graph()).connections.find(e => e.id === edge.id)!.curveBend, undefined);
  const migration = createConnectionsPlugin().migrations!.find(m => m.from === 11)!;
  const legacy = { connections: { e: { future: 'retained' } }, connectionJunction: { j: { handleAngle: 30 } }, opaque: { anything: true } };
  assert.deepEqual(await migration.migrate(legacy), legacy);
  for (const value of [{ from: 45.2 }, { from: Infinity }, { bad: 30 }, null]) assert.equal(isConnectionCurveBend(value), false);
});

test('single-curve steering preserves shared tangents and sibling plans through mirrored ports and dense boundary layouts', () => {
  for (const x of [-300, -100, 0, 1, 100, 300]) for (const y of [-300, -24, 0, 24, 300]) for (const angle of [-75, -30, 30, 75]) {
    const nodes = new Map<string, ConnectionNodeGeometry>([
      ['j', { id: 'j', kind: 'junction', x: 0, y: 0, width: 0, height: 0 }],
      ['a', { id: 'a', x, y: y - 73, width: 260, height: 146 }], ['b', { id: 'b', x: 900, y: 400, width: 260, height: 146 }],
    ]);
    const edges: ConnectionRecord[] = ['a', 'b'].map(id => ({ id, from: { nodeId: 'j', kind: 'junction', side: 'right' }, to: { nodeId: id, side: 'left' }, labelWidth: 0, labelHeight: 0, revision: 1, createdAt: 1 }));
    const before = connectionGraphPoints(edges, nodes), after = connectionGraphPoints([{ ...edges[0], curveBend: { from: angle } }, edges[1]], nodes);
    assert.deepEqual(after.get('b'), before.get('b'));
    assert.deepEqual(after.get('a')!.from.tangent, before.get('a')!.from.tangent);
    const plan = after.get('a')!.from.route!; assertSmoothRoute(plan); assertNoSelfIntersection(plan);
    assert.ok(!/NaN|Infinity/u.test(connectionCurvePath(after.get('a')!.from, after.get('a')!.to)));
  }
});
