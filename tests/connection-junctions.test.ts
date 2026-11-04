import assert from 'node:assert/strict';
import { connectionGraphPoints } from '../src/plugins/connections/routing.ts';
import { connectionCurvePath, distanceToConnectionCurve } from '../src/plugins/connections/rendering.ts';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createClipboardPlugin } from '../src/plugins/clipboard/model.ts';
import { createSmartLayoutPlugin } from '../src/plugins/smart-layout/model.ts';
import { parseProject, serializeProject } from '../src/plugins/import-export/codec.ts';
import { splitConnectionsAtJunction } from '../src/plugins/connections/junctions.ts';
import { isTitleConnection, type ConnectionGraphSnapshot, type ConnectionRecord } from '../src/protocols/connections.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import type { SelectionCatalogContribution } from '../src/protocols/selection.ts';
import type { SmartSnapResult } from '../src/protocols/layout.ts';

const source = 'core.test';
async function setup(outputs = false) {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin(), createClipboardPlugin(), createSmartLayoutPlugin()]);
  await kernel.start();
  const ids: string[] = [];
  for (const [title, x, y] of [['甲', 0, 0], ['乙', 0, 300], ['丙', 800, 150]] as const) {
    ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title, x, y }, source)).id);
  }
  for (const [index, [from, to]] of (outputs ? [[0, 1], [0, 2]] : [[0, 2], [1, 2]]).entries()) {
    const result = await kernel.router.dispatch<{ id?: string }>('connection.create', {
      from: { nodeId: ids[from], side: 'right' }, to: { nodeId: ids[to], side: 'left' },
    }, source);
    await kernel.router.dispatch('connection.setLabel', { id: result.id!, label: `分支${index}`, expectedRevision: 1 }, source);
  }
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const add = async () => kernel.router.dispatch<{ id: string }>('connection.addJunction', {
    x: 500, y: 240, connections: (await graph()).connections.map(({ id, revision }) => ({ id, revision })),
  }, source);
  return { kernel, ids, graph, add };
}

function normalized(graph: ConnectionGraphSnapshot) {
  return { ...graph,
    connections: [...graph.connections].sort((a, b) => a.id.localeCompare(b.id)),
    junctions: [...graph.junctions].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

test('junction insertion rejects unrelated directions and keeps labelled branches on the non-shared side', () => {
  const edge = (id: string, from: string, to: string): ConnectionRecord => ({
    id, from: { nodeId: from, side: 'right' }, to: { nodeId: to, side: 'left' },
    label: id, labelWidth: 200, labelHeight: 50, revision: 2, createdAt: 1,
  });
  assert.throws(() => splitConnectionsAtJunction([edge('a', 'A', 'B'), edge('b', 'B', 'C')], { x: 20, y: 30 }), /同一节点/u);
  for (const records of [[edge('a', 'A', 'C'), edge('b', 'B', 'C')], [edge('a', 'A', 'B'), edge('b', 'A', 'C')]]) {
    const original = structuredClone(records);
    const result = splitConnectionsAtJunction(records, { x: 20, y: 30 });
    assert.equal(result.connections.length, 3);
    assert.deepEqual(result.connections.slice(0, 2).map((item) => item.label), ['a', 'b']);
    assert.equal(result.connections[2].label, undefined);
    assert.deepEqual(records, original);
    assert.equal(result.junction.x, 20);
  }
});

test('a shared junction moves once, participates in snapping and deletes through one undoable bypass', async () => {
  const { kernel, graph, add } = await setup();
  const original = await graph();
  const history = kernel.history.getState().undoCount;
  const { id } = await add();
  let current = await graph();
  assert.equal(current.junctions.length, 1);
  assert.equal(current.connections.length, 3);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  assert.deepEqual(current.connections.filter((edge) => edge.label).map((edge) => edge.to), [
    { nodeId: id, side: 'left', kind: 'junction' }, { nodeId: id, side: 'left', kind: 'junction' },
  ]);
  const routed = current;
  await assert.rejects(kernel.router.dispatch('connection.moveJunction', { id, x: 1, y: 1, expectedRevision: 99 }, source), /已变化/u);
  await kernel.router.dispatch('connection.moveJunction', { id, x: 570, y: 270, expectedRevision: 1 }, source);
  current = await graph();
  assert.deepEqual(current.connections, routed.connections);
  assert.deepEqual([current.junctions[0].x, current.junctions[0].y], [570, 270]);
  const catalogs = await kernel.capabilities.requestAll<SelectionCatalogContribution>('selection.entities@1');
  assert.ok(catalogs.flatMap((catalog) => catalog.entities).some((item) => item.id === id && item.kind === 'connection-junction'));
  // Committed invalidation rebuilds the optional snap provider asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const snap = kernel.capabilities.requestSync<SmartSnapResult>('layout.snap@1', {
    dragged: { x: 568, y: 269, width: 0, height: 0 }, movingIds: [], mode: 'nodes', threshold: 3,
  });
  assert.equal(snap.offsetX, 2);
  assert.equal(snap.offsetY, 1);
  await kernel.router.dispatch('selection.set', { ids: [id] }, source);
  const beforeDelete = kernel.history.getState().undoCount;
  const beforeRemoval = current;
  await kernel.router.dispatch('selection.delete', undefined, source);
  current = await graph();
  assert.equal(current.junctions.length, 0);
  assert.deepEqual(current.connections.map((edge) => [edge.id, edge.from.nodeId, edge.to.nodeId, edge.label]),
    original.connections.map((edge) => [edge.id, edge.from.nodeId, edge.to.nodeId, edge.label]));
  assert.equal(kernel.history.getState().undoCount, beforeDelete + 1);
  await kernel.transactions.undo();
  assert.deepEqual(normalized(await graph()), normalized(beforeRemoval));
  await kernel.transactions.redo();
  assert.equal((await graph()).junctions.length, 0);
});

test('deleting one routed segment preserves its junction and every other branch', async () => {
  const { kernel, graph, add } = await setup(true);
  const { id } = await add();
  const before = await graph();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const trunk = before.connections.find((edge) => !edge.label)!;
  await kernel.router.dispatch('selection.set', { ids: [trunk.id] }, source);
  await kernel.router.dispatch('selection.delete', undefined, source);
  assert.deepEqual((await graph()).junctions, before.junctions);
  assert.deepEqual((await graph()).connections, before.connections.filter((edge) => edge.id !== trunk.id));
  await kernel.transactions.undo();
  const branch = before.connections.find((edge) => edge.label)!;
  await kernel.router.dispatch('selection.set', { ids: [branch.id] }, source);
  await kernel.router.dispatch('selection.delete', undefined, source);
  assert.equal((await graph()).junctions[0].id, id);
  assert.deepEqual((await graph()).connections, before.connections.filter((edge) => edge.id !== branch.id));
  await kernel.router.dispatch('selection.set', { ids: [id] }, source);
  await kernel.router.dispatch('connection.removeSelectedJunctions', undefined, source);
  const remaining = (await graph()).connections;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, before.connections.find((edge) => edge.label && edge.id !== branch.id)!.id);
});

test('junction graphs survive clipboard remapping, file reload and plugin hot-stop history', async () => {
  const { kernel, graph, add, ids } = await setup();
  const point = await add();
  await kernel.router.dispatch('selection.set', { ids: [...ids, point.id] }, source);
  await kernel.router.dispatch('clipboard.copy', undefined, source);
  await kernel.router.dispatch('clipboard.paste', undefined, source);
  const copied = await graph();
  assert.equal(copied.connections.length, 6);
  assert.equal(copied.junctions.length, 2);
  assert.deepEqual(copied.junctions.slice(1).map((point) => [point.x, point.y]), [[536, 276]]);
  const nodeIds = new Set((await kernel.capabilities.request<Array<{ id: string }>>('content.summaries@1')).map((node) => node.id));
  const pointIds = new Set(copied.junctions.map((point) => point.id));
  for (const edge of copied.connections) for (const endpoint of [edge.from, edge.to]) {
    assert.ok((endpoint.kind === 'junction' ? pointIds : nodeIds).has(endpoint.nodeId));
  }
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, source);
  assert.equal(project.plugins.find((item) => item.id === 'connections')?.dataVersion, 12);
  const reopened = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin()]);
  await reopened.start();
  await reopened.router.dispatch('system.document.replace', await parseProject(await serializeProject(project)), source);
  assert.deepEqual(normalized(await reopened.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')), normalized(copied));
  await kernel.plugins.stop('connections');
  await kernel.transactions.undo();
  assert.equal(Object.keys(kernel.store.readNamespace('document', 'connectionJunction')).length, 1);
  await kernel.plugins.start('connections');
  assert.equal((await graph()).junctions.length, 1);
});

test('legacy data version six gains an empty junction namespace without changing existing connections', async () => {
  const plugin = createConnectionsPlugin();
  const migrate = plugin.migrations!.find((item) => item.from === 6)!;
  const original = { connections: { legacy: { id: 'legacy', opaque: 'preserved' } }, connectionAppearance: {} };
  assert.deepEqual(await migrate.migrate(structuredClone(original)), { ...original, connectionJunction: {} });
});

test('subdividing an outgoing branch keeps its text adjacent to its real node', () => {
  const edge: ConnectionRecord = {
    id: 'branch', from: { nodeId: 'old-junction', side: 'right', kind: 'junction' },
    to: { nodeId: 'node', side: 'left' }, label: '保留分支文字',
    labelWidth: 180, labelHeight: 48, revision: 1, createdAt: 1,
  };
  const split = splitConnectionsAtJunction([edge], { x: 300, y: 200 });
  assert.equal(split.connections[0].to.nodeId, 'node');
  assert.equal(split.connections[0].from.nodeId, split.junction.id);
  assert.equal(split.connections[1].label, undefined);
});

test('legacy logical endpoints remain compatible and existing link commands operate on routed branches', async () => {
  const { kernel, graph, add, ids } = await setup();
  const original = await graph();
  await add();
  const legacy = await kernel.capabilities.request<ConnectionRecord[]>('connections.list@1');
  assert.deepEqual(legacy.map((edge) => [edge.id, edge.from.nodeId, edge.to.nodeId, edge.label]),
    original.connections.map((edge) => [edge.id, edge.from.nodeId, edge.to.nodeId, edge.label]));
  const duplicate = await kernel.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: ids[0], side: 'right' }, to: { nodeId: ids[2], side: 'left' },
  }, source);
  assert.equal(duplicate.id, original.connections[0].id);
  assert.equal((await graph()).connections.length, 3);
  await kernel.router.dispatch('selection.set', { ids: [ids[0], ids[2]] }, source);
  const beforeConversion = await graph();
  await kernel.router.dispatch('connection.toggleTitleSelected', undefined, source);
  assert.equal((await graph()).connections.length, beforeConversion.connections.length + 1);
  assert.deepEqual((await graph()).junctions, beforeConversion.junctions);
  await kernel.transactions.undo();
  await kernel.router.dispatch('connection.toggleSelected', undefined, source);
  assert.equal((await graph()).connections.length, 2);
  assert.ok((await graph()).connections.some((edge) => edge.label === '分支1'));
});

test('title styling survives subdivision of junction-to-junction trunks', () => {
  const original: ConnectionRecord = {
    id: 'title', from: { nodeId: 'a', side: 'title' }, to: { nodeId: 'b', side: 'title' },
    labelWidth: 180, labelHeight: 48, revision: 1, createdAt: 1,
  };
  const first = splitConnectionsAtJunction([original], { x: 300, y: 200 });
  const second = splitConnectionsAtJunction([first.connections[1]], { x: 400, y: 200 });
  assert.ok([...first.connections, ...second.connections].every(isTitleConnection));
  assert.ok(second.connections.some((edge) => edge.from.kind === 'junction' && edge.to.kind === 'junction'));
});

test('context gestures remain distinct queued transactions and stale multi-line requests change nothing', { timeout: 2000 }, async () => {
  const { kernel, graph } = await setup();
  const before = await graph();
  await assert.rejects(kernel.router.dispatch('connection.addJunction', {
    x: 500, y: 200, connections: before.connections.map((edge) => ({ id: edge.id, revision: edge.revision + 1 })),
  }, source), /变化/u);
  assert.deepEqual(await graph(), before);
  await kernel.router.dispatch('selection.set', { ids: [before.connections[0].id] }, source);
  const history = kernel.history.getState().undoCount;
  await Promise.all([
    kernel.router.dispatch('connection.addJunctionFromContext', { point: { x: 400, y: 200 } }, source),
    kernel.router.dispatch('connection.addJunctionFromContext', { point: { x: 500, y: 200 } }, source),
  ]);
  assert.equal((await graph()).junctions.length, 2);
  assert.equal(kernel.history.getState().undoCount, history + 2);
  const point = (await graph()).junctions[0];
  await Promise.all(Array.from({ length: 10 }, () => kernel.router.dispatch('connection.nudgeJunction', { id: point.id, dx: 1, dy: 0 }, source)));
  assert.equal((await graph()).junctions.find((item) => item.id === point.id)!.x, point.x + 10);
});


test('contradictory junction roles keep node-facing ports and collinear handles without routing backwards', () => {
  const edges: ConnectionRecord[] = ([
    { id: 'a', from: { nodeId: 'a', side: 'title' }, to: { nodeId: 'j', kind: 'junction', side: 'left' } },
    { id: 'b', from: { nodeId: 'b', side: 'title' }, to: { nodeId: 'j', kind: 'junction', side: 'left' } },
    { id: 'trunk', from: { nodeId: 'j', kind: 'junction', side: 'right' }, to: { nodeId: 'c', side: 'title' } },
  ] as const).map(edge => ({ ...edge, revision: 1, labelWidth: 100, labelHeight: 40, createdAt: 1 }));
  const nodes = new Map([
    ['a', { id: 'a', x: 440, y: 80, width: 280, height: 158 }],
    ['b', { id: 'b', x: 460, y: 340, width: 280, height: 158 }],
    ['c', { id: 'c', x: 800, y: 210, width: 280, height: 158 }],
    ['j', { id: 'j', x: 260, y: 180, width: 0, height: 0 }],
  ]);
  const points = connectionGraphPoints(edges, nodes);
  for (const id of ['a', 'b']) {
    const incoming = points.get(id)!, outgoing = points.get('trunk')!;
    assert.ok(Math.abs(incoming.to.tangent!.x * outgoing.from.tangent!.y - incoming.to.tangent!.y * outgoing.from.tangent!.x) < 1e-9);
    assert.ok(incoming.to.tangent!.x < 0, 'a right-hand incoming node must not force its handle onto the back of the point');
    assert.ok(outgoing.from.tangent!.x > 0, 'the common axis points from incoming anchors to the outgoing anchor');
    const path = connectionCurvePath(incoming.from, incoming.to).match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    assert.ok(path[2] < path[0], 'title source leaves its actual left edge');
    const tail = connectionCurvePath(outgoing.from, outgoing.to).match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    assert.ok(tail[2] > tail[0], 'trunk continues toward the target instead of turning left');
    assert.ok(tail.at(-4)! < tail.at(-2)!, 'arrow approaches the target title from outside');
    assert.ok(distanceToConnectionCurve(incoming.to, incoming.from, incoming.to) < .01);
  }
});

test('junctions accept incoming, outgoing and point-to-point edges, with undo and cycle validation', async () => {
  const { kernel, graph, add } = await setup();
  const point = await add();
  const extra = await kernel.router.dispatch<{ id: string }>('node.create', { title: '新分支', x: 1100, y: 600 }, source);
  const before = kernel.history.getState().undoCount;
  const endpoint = { nodeId: point.id, kind: 'junction' as const, side: 'right' as const };
  const output = await kernel.router.dispatch<{ id: string }>('connection.create', { from: endpoint, to: { nodeId: extra.id, side: 'left' } }, source);
  assert.equal((await graph()).connections.find(edge => edge.id === output.id)!.from.kind, 'junction');
  const duplicate = await kernel.router.dispatch<{ id: string }>('connection.create', { from: endpoint, to: { nodeId: extra.id, side: 'left' } }, source);
  assert.equal(duplicate.id, output.id);
  assert.equal(kernel.history.getState().undoCount, before + 1);
  const input = await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: extra.id, side: 'left' }, to: endpoint }, source);
  assert.equal((await graph()).connections.find(edge => edge.id === input.id)!.to.kind, 'junction');
  const target = kernel.capabilities.requestSync<import('../src/protocols/connections.ts').ConnectionEndpoint>('connections.targetAt@1', { point: { x: 504, y: 240 }, excludeId: extra.id, radius: 10 });
  assert.equal(target.nodeId, point.id);
  const split = await kernel.router.dispatch<{ id: string }>('connection.addJunction', { x: 700, y: 500, connections: [{ id: output.id, revision: 1 }] }, source);
  const beforeCycle = await graph();
  await assert.rejects(kernel.router.dispatch('connection.create', { from: { nodeId: split.id, kind: 'junction', side: 'left' }, to: endpoint }, source), /循环/u);
  assert.deepEqual(await graph(), beforeCycle);
  await assert.rejects(kernel.router.dispatch('connection.create', { from: { nodeId: 'missing', kind: 'junction', side: 'right' }, to: endpoint }, source), /不存在/u);
  await kernel.router.dispatch('history.undo', undefined, source);
  assert.equal((await graph()).junctions.length, 1);
  await kernel.router.dispatch('selection.set', { ids: [extra.id, point.id] }, source);
  const selected = await kernel.router.dispatch<{ id: string }>('connection.connectSelectedEndpoints', undefined, source);
  assert.equal(selected.id, input.id);
});
