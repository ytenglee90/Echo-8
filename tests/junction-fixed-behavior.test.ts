import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createClipboardPlugin } from '../src/plugins/clipboard/model.ts';
import { isTitleConnection, type ConnectionGraphSnapshot, type ConnectionEndpoint } from '../src/protocols/connections.ts';
const source = 'core.test';
async function setup(title = false) {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin(), createGroupsPlugin(), createClipboardPlugin()]);
  await kernel.start(); const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title: String(i), x: i * 400, y: 80 }, source)).id);
  const initial = (await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[0], side: title ? 'title' : 'right' }, to: { nodeId: ids[1], side: title ? 'title' : 'left' } }, source)).id;
  const junction = (await kernel.router.dispatch<{ id: string }>('connection.addJunction', { x: 340, y: 300, connections: [{ id: initial, revision: 1 }] }, source)).id;
  await kernel.router.dispatch('selection.set', { ids: ids.slice(2, 4) }, source);
  const group = (await kernel.router.dispatch<{ id: string }>('group.create', undefined, source)).id;
  await kernel.router.dispatch('node.presentation.set', { id: ids[4], presentation: 'text-box' }, source);
  return { kernel, ids, group, junction, graph: async () => { const graph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1'); return { ...graph, connections: graph.connections.sort((a, b) => a.id.localeCompare(b.id)) }; } };
}
for (const box of [false, true]) test(`one ${box ? 'box' : 'card'} pair keeps title and body edges independently, including toggle commands`, async () => {
  const { kernel, ids, graph } = await setup();
  if (box) for (const id of ids.slice(2, 4)) await kernel.router.dispatch('node.presentation.set', { id, presentation: 'text-box' }, source);
  const create = (title: boolean) => kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[2], side: title ? 'title' : 'right' }, to: { nodeId: ids[3], side: title ? 'title' : 'left' } }, source);
  const body = await create(false), title = await create(true);
  assert.notEqual(body.id, title.id); assert.equal((await create(false)).id, body.id); assert.equal((await create(true)).id, title.id);
  const before = await graph(); await kernel.router.dispatch('selection.set', { ids: ids.slice(2, 4) }, source);
  await kernel.router.dispatch('connection.toggleSelected', undefined, source);
  assert.ok(!(await graph()).connections.some(edge => edge.id === body.id)); assert.ok((await graph()).connections.some(edge => edge.id === title.id));
  await kernel.transactions.undo(); assert.deepEqual(await graph(), before);
  await kernel.router.dispatch('connection.toggleTitleSelected', undefined, source);
  assert.ok((await graph()).connections.some(edge => edge.id === body.id)); assert.ok(!(await graph()).connections.some(edge => edge.id === title.id));
});
for (const title of [false, true]) for (const kind of ['group', 'box'] as const) test(`${kind} requests automatically inherit ${title ? 'dashed' : 'solid'} junction style in both directions and reconnection`, async () => {
  const { kernel, ids, group, junction, graph } = await setup(title);
  const other: ConnectionEndpoint = kind === 'group' ? { nodeId: group, kind: 'group', side: 'right' } : { nodeId: ids[4], side: title ? 'left' : 'title' };
  const point: ConnectionEndpoint = { nodeId: junction, kind: 'junction', side: 'left' };
  for (const reversed of [false, true]) {
    const before = await graph();
    const result = await kernel.router.dispatch<{ id: string }>('connection.create', { from: reversed ? point : other, to: reversed ? other : point }, source);
    const record = (await graph()).connections.find(edge => edge.id === result.id)!; assert.equal(isTitleConnection(record), title);
    await kernel.router.dispatch('connection.reconnect', { id: record.id, expectedRevision: record.revision, from: record.from, to: { ...record.to, side: title ? 'left' : 'title' } }, source);
    assert.equal(isTitleConnection((await graph()).connections.find(edge => edge.id === record.id)!), title);
    await kernel.transactions.undo(); await kernel.transactions.undo(); assert.deepEqual(await graph(), before);
  }
});
for (const duplicate of [false, true]) test(`content ${duplicate ? 'duplication' : 'copy/paste'} never pulls its routed vertices or segments into the copy`, async () => {
  const { kernel, ids, graph } = await setup(); const before = await graph();
  const nodeCount = (await kernel.capabilities.request<Array<{ id: string }>>('content.summaries@1')).length;
  await kernel.router.dispatch('selection.set', { ids: ids.slice(0, 2) }, source);
  if (duplicate) await kernel.router.dispatch('clipboard.duplicateSelectionAt', { offset: { x: 60, y: 60 } }, source);
  else { await kernel.router.dispatch('clipboard.copy', undefined, source); await kernel.router.dispatch('clipboard.paste', undefined, source); }
  assert.deepEqual(await graph(), before);
  const nodes = await kernel.capabilities.request<Array<{ id: string }>>('content.summaries@1'); assert.equal(nodes.length, nodeCount + 2);
  await kernel.transactions.undo(); assert.deepEqual(await graph(), before);
});
test('moving group members and a box never moves attached routing vertices or revisions', async () => {
  const { kernel, ids, group, junction, graph } = await setup();
  await kernel.router.dispatch('connection.create', { from: { nodeId: group, kind: 'group', side: 'right' }, to: { nodeId: junction, kind: 'junction', side: 'left' } }, source);
  await kernel.router.dispatch('connection.create', { from: { nodeId: ids[4], side: 'left' }, to: { nodeId: junction, kind: 'junction', side: 'left' } }, source);
  const before = (await graph()).junctions;
  await kernel.router.dispatch('node.moveMany', { positions: ids.slice(2).map((id, i) => ({ id, x: 1500 + i * 300, y: 600 })) }, source);
  assert.deepEqual((await graph()).junctions, before); await kernel.transactions.undo(); assert.deepEqual((await graph()).junctions, before);
});

test('reconnecting the last group edge on a junction retains its existing dashed component style', async () => {
  const { kernel, group, junction, graph } = await setup(true);
  const original = await graph();
  const created = await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: junction, kind: 'junction', side: 'right' }, to: { nodeId: group, kind: 'group', side: 'left' } }, source);
  await kernel.router.dispatch('selection.set', { ids: original.connections.map(edge => edge.id) }, source);
  await kernel.router.dispatch('selection.delete', undefined, source);
  const before = await graph(); assert.equal(before.connections.length, 1);
  const edge = before.connections[0]; assert.equal(isTitleConnection(edge), true);
  await kernel.router.dispatch('connection.reconnect', { id: created.id, expectedRevision: edge.revision, from: edge.from, to: edge.to }, source);
  assert.equal(isTitleConnection((await graph()).connections[0]), true);
  await kernel.transactions.undo(); assert.deepEqual(await graph(), before);
});
