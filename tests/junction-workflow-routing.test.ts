import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { connectionGraphPoints, connectionStrokeForEndpoints } from '../src/plugins/connections/routing.ts';
import { connectionCurvePath } from '../src/plugins/connections/rendering.ts';
import { connectionJunctionDragRequest, type ConnectionGraphSnapshot, type ConnectionNodeGeometry } from '../src/protocols/connections.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import { serializeProject, parseProject } from '../src/plugins/import-export/codec.ts';

const source = 'core.test';
const definitions = () => [textNodePlugin, createSelectionPlugin(), createConnectionsPlugin()];
function forward(path: string) {
  const p = path.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
  for (const coordinate of [0, 1]) {
    const delta = p.at(coordinate === 0 ? -2 : -1)! - p[coordinate], sign = delta >= 0 ? 1 : -1;
    for (let i = coordinate + 2; i < p.length; i += 2) assert.ok((p[i] - p[i - 2]) * sign >= -.003, `automatic curve turns back: ${path}`);
  }
}
async function paths(kernel: ApplicationKernel) {
  const graph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const summaries = await kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  const nodes = new Map<string, ConnectionNodeGeometry>(summaries.map(node => [node.id, node]));
  for (const point of graph.junctions) nodes.set(point.id, { ...point, width: 0, height: 0, kind: 'junction' });
  const points = connectionGraphPoints(graph.connections, nodes);
  return graph.connections.map(edge => {
    const pair = points.get(edge.id)!, path = connectionCurvePath(pair.from, pair.to); forward(path);
    for (const zoom of [.4, 1, 2.4]) forward(connectionStrokeForEndpoints(edge, pair, zoom).shaftPath);
    return [edge.id, path];
  }).sort(([a], [b]) => a.localeCompare(b));
}

test('split, delete a trunk or branch and reconnect have no stale direction through undo, movement and save/reopen', async () => {
  for (const title of [false, true]) for (const outgoing of [false, true]) for (const jx of [50, 530, 1200]) for (const removeTrunk of [false, true]) {
    const kernel = new ApplicationKernel(definitions()); await kernel.start();
    const ids: string[] = [];
    for (const [x, y] of [[80, 250], [900, 80], [900, 440], [80, 700]]) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title: String(y), x, y, width: 260, height: 146 }, source)).id);
    const originalIds: string[] = [];
    for (const index of [1, 2]) originalIds.push((await kernel.router.dispatch<{ id?: string }>('connection.create', {
      from: { nodeId: ids[outgoing ? 0 : index], side: title ? 'title' : 'right' }, to: { nodeId: ids[outgoing ? index : 0], side: title ? 'title' : 'left' },
    }, source)).id!);
    const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
    await kernel.router.dispatch('selection.set', { ids: originalIds }, source);
    const point = await kernel.router.dispatch<{ id?: string }>('connection.addJunctionFromContext', { point: { x: jx, y: 430 } }, source);
    const split = await graph(), vertex = split.junctions[0]; assert.equal(vertex.id, point.id); assert.equal(vertex.handleAngle, undefined);
    const removed = removeTrunk ? split.connections.find(edge => !originalIds.includes(edge.id))! : split.connections.find(edge => edge.id === originalIds[0])!;
    await kernel.router.dispatch('selection.set', { ids: [removed.id] }, source); await kernel.router.dispatch('selection.delete', undefined, source);
    assert.deepEqual((await graph()).junctions[0], vertex, 'deleting a line never writes a stale handle angle');
    await paths(kernel);
    const target = (await kernel.capabilities.request<ContentSummary[]>('content.summaries@1')).find(node => node.id === ids[3])!;
    const from = { nodeId: vertex.id, kind: 'junction' as const, side: 'right' as const }, to = { nodeId: target.id, side: title ? 'title' as const : 'left' as const };
    const before = await paths(kernel), history = kernel.history.getState().undoCount;
    await kernel.router.dispatch('connection.create', connectionJunctionDragRequest({ from, to }, { ...vertex, width: 0, height: 0 }, target, { x: target.x, y: target.y + target.height / 2 }), source);
    assert.equal(kernel.history.getState().undoCount, history + 1); const connected = await paths(kernel);
    await kernel.transactions.undo(); assert.deepEqual(await paths(kernel), before);
    await kernel.transactions.redo(); assert.deepEqual(await paths(kernel), connected);
    const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, source);
    const reopened = new ApplicationKernel(definitions()); await reopened.start();
    await reopened.router.dispatch('system.document.replace', await parseProject(await serializeProject(project)), source);
    assert.deepEqual(await paths(reopened), connected, 'reopening computes the same safe route without ephemeral caches');
    await kernel.router.dispatch('connection.moveJunction', { id: vertex.id, x: jx < 530 ? 1300 : 30, y: 430, expectedRevision: vertex.revision }, source);
    await paths(kernel); await kernel.transactions.undo(); assert.deepEqual(await paths(kernel), connected);
  }
});
