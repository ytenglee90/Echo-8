import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { connectionStrokeGeometry } from '../src/plugins/connections/rendering.ts';
import { connectionGraphPoints } from '../src/plugins/connections/routing.ts';
import { updateConnectionSession } from '../src/plugins/canvas/surface-geometry.ts';
import { mergeContentCatalogDeltas } from '../src/ui/runtime-hooks.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import { isTitleConnection, connectionHorizontalSides, type ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import { parseProject, serializeProject } from '../src/plugins/import-export/codec.ts';

test('junction branches meet left and right ports with a horizontal shaft and arrow at every zoom', () => {
  for (const side of ['left', 'right'] as const) for (const zoom of [.4, .5, 1, 2.4]) {
    const tip = { x: side === 'left' ? 340 : -340, y: 500, side };
    const geometry = connectionStrokeGeometry({ x: 0, y: 0, tangent: { x: .1, y: .995 } }, tip, zoom);
    const shaft = geometry.shaftPath.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    const arrow = geometry.arrowPath.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    assert.equal(shaft[5], shaft[7]); assert.equal(shaft[7], tip.y);
    assert.deepEqual(arrow.slice(2, 4), [tip.x, tip.y]);
    assert.equal(arrow[0], arrow[4]); assert.equal(arrow[0], shaft[6]);
    assert.equal((arrow[1] + arrow[5]) / 2, shaft[7]);
    assert.ok((shaft[6] - shaft[4]) * (side === 'left' ? 1 : -1) > 0);
    assert.ok((tip.x - shaft[6]) * (side === 'left' ? 1 : -1) > 0);
  }
});

test('a text box recognizes either title port and leaving the port restores the original solid gesture', () => {
  const summary = (id: string, x: number): ContentSummary => ({ id, title: id, preview: '', x, y: 100, width: 280, height: 160, titleColor: '#202124', textColor: '#202124', revision: 1, length: 0 });
  const box = { ...summary('box', 0), presentation: 'text-box' as const }, card = summary('card', 600);
  for (const x of [600, 880]) {
    const session = updateConnectionSession({ from: { nodeId: box.id, side: 'right' }, pointer: { x: 280, y: 180 }, pointerId: 1,
      startClientX: 280, startClientY: 180, moved: false }, { x, y: 121 }, x, 121, [box, card], {}, {}, 1);
    assert.equal(session.from.side, 'title'); assert.equal(session.to?.side, 'title');
    const body = updateConnectionSession(session, { x: 600, y: 200 }, 600, 200, [box, card], {}, {}, 1);
    assert.notEqual(body.from.side, 'title'); assert.notEqual(body.to?.side, 'title');
  }
  assert.equal(mergeContentCatalogDeltas(new Map([[card.id, card]]), [{ version: 2, reset: false, removedIds: [],
    summaries: [{ ...card, presentation: 'text-box' }] }]).geometryChanged, true);
});

test('only title-to-title cards use same sides and both switch automatically when their order reverses', () => {
  const a = { id: 'a', x: 0, y: 0, width: 280, height: 160 }, b = { ...a, id: 'b', x: 700 };
  const titles = { from: { nodeId: 'a', side: 'title' as const }, to: { nodeId: 'b', side: 'title' as const } };
  assert.deepEqual(Object.values(connectionHorizontalSides(titles, a, b)).map(endpoint => endpoint.side), ['right', 'right']);
  assert.deepEqual(Object.values(connectionHorizontalSides(titles, { ...a, x: 1000 }, b)).map(endpoint => endpoint.side), ['left', 'left']);
  assert.deepEqual(Object.values(connectionHorizontalSides(titles, { ...a, presentation: 'text-box' }, b)).map(endpoint => endpoint.side), ['right', 'left']);
  assert.deepEqual(Object.values(connectionHorizontalSides({ from: { nodeId: 'a', side: 'right' }, to: { nodeId: 'b', side: 'left' } }, a, b)).map(endpoint => endpoint.side), ['right', 'left']);
  assert.deepEqual(Object.values(connectionHorizontalSides({ ...titles, from: { ...titles.from, kind: 'group' } }, { ...a, kind: 'group' }, b)).map(endpoint => endpoint.side), ['right', 'left']);
});

test('same-size presentation conversions preserve line attributes, project the correct anchors and survive undo and file reload', async () => {
  const definitions = () => [textNodePlugin, createSelectionPlugin(), createConnectionsPlugin()];
  const kernel = new ApplicationKernel(definitions()); await kernel.start();
  const ids: string[] = [];
  for (const [title, x, y] of [['文本框', 0, 100], ['正文来源', 0, 400], ['目标', 700, 100]] as const) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title, x, y, width: 280, height: 160 }, 'core.test')).id);
  await kernel.router.dispatch('node.presentation.set', { id: ids[0], presentation: 'text-box' }, 'core.test');
  await kernel.router.dispatch('node.resize', { id: ids[0], width: 280, height: 160 }, 'core.test');
  await kernel.router.dispatch('connection.create', { from: { nodeId: ids[0], side: 'title' }, to: { nodeId: ids[2], side: 'title' } }, 'core.test');
  await kernel.router.dispatch('connection.create', { from: { nodeId: ids[1], side: 'right' }, to: { nodeId: ids[2], side: 'left' } }, 'core.test');
  const graph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const dashed = graph.connections.find(isTitleConnection)!, solid = graph.connections.find(edge => !isTitleConnection(edge))!;
  const points = async (app = kernel) => {
    const nodes = await app.capabilities.request<ContentSummary[]>('content.summaries@1');
    return connectionGraphPoints(graph.connections, new Map(nodes.map(node => [node.id, node])), []);
  };
  assert.equal((await points()).get(dashed.id)!.from.y, 180);
  assert.equal((await points()).get(dashed.id)!.to.y, 121);
  await kernel.router.dispatch('node.presentation.set', { id: ids[2], presentation: 'text-box' }, 'core.test');
  await kernel.router.dispatch('node.resize', { id: ids[2], width: 280, height: 160 }, 'core.test');
  assert.equal((await points()).get(dashed.id)!.to.y, 180);
  const history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('node.presentation.set', { id: ids[2], presentation: 'card' }, 'core.test');
  assert.equal(kernel.history.getState().undoCount, history + 1);
  assert.equal((await points()).get(dashed.id)!.to.y, 121);
  assert.equal((await points()).get(solid.id)!.to.y, 180);
  assert.deepEqual(await kernel.capabilities.request('connections.graph@1'), graph);
  await kernel.transactions.undo(); assert.equal((await points()).get(dashed.id)!.to.y, 180);
  await kernel.transactions.redo(); assert.equal((await points()).get(dashed.id)!.to.y, 121);
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  const reopened = new ApplicationKernel(definitions()); await reopened.start();
  await reopened.router.dispatch('system.document.replace', await parseProject(await serializeProject(project)), 'core.test');
  assert.equal((await points(reopened)).get(dashed.id)!.to.y, 121);
});
