import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { isTitleConnection, type ConnectionGraphSnapshot } from '../src/protocols/connections.ts';

test('title toggle connects either selection order to a dashed junction, keeps solid links and supports undo', async () => {
  const source = 'core.test', kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin()]); await kernel.start();
  const ids: string[] = [];
  for (const x of [0, 600, 1000]) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { x, y: 100 }, source)).id);
  const line = (await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[0], side: 'title' }, to: { nodeId: ids[1], side: 'title' } }, source)).id;
  const point = (await kernel.router.dispatch<{ id: string }>('connection.addJunction', { x: 400, y: 400, connections: [{ id: line, revision: 1 }] }, source)).id;
  await kernel.router.dispatch('connection.create', { from: { nodeId: ids[0], side: 'right' }, to: { nodeId: ids[2], side: 'left' } }, source);
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  for (const selection of [[ids[2], point], [point, ids[2]]]) {
    if (selection[0] === point) await kernel.router.dispatch('node.presentation.set', { id: ids[2], presentation: 'text-box' }, source);
    await kernel.router.dispatch('selection.set', { ids: selection }, source);
    const before = await graph(), history = kernel.history.getState().undoCount;
    const created = await kernel.router.dispatch<{ id: string }>('connection.toggleTitleSelected', undefined, source);
    const edge = (await graph()).connections.find(e => e.id === created.id)!;
    assert.ok(edge && isTitleConnection(edge)); assert.equal(edge.from.nodeId, selection[0]); assert.equal(edge.to.nodeId, selection[1]);
    assert.equal(kernel.history.getState().undoCount, history + 1);
    await kernel.transactions.undo(); assert.deepEqual(await graph(), before); await kernel.transactions.redo();
    assert.deepEqual(await kernel.router.dispatch('connection.toggleTitleSelected', undefined, source), { removed: 1 });
    assert.deepEqual((await graph()).connections, before.connections);
  }
});
