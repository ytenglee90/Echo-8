import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { groupMembershipSelection } from '../src/plugins/groups/membership-selection.ts';
import { connectionToolbarSelection } from '../src/plugins/connections/toolbar-selection.ts';
import { isTitleConnection, type ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { GroupRecord } from '../src/protocols/groups.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import { parseProject, serializeProject } from '../src/plugins/import-export/codec.ts';

const source = 'core.test';
async function setup(count = 3) {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createGroupsPlugin(), createConnectionsPlugin()]);
  await kernel.start();
  const ids: string[] = [];
  for (let index = 0; index < count; index++) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title: `工具栏${index}`, x: index * 400, y: 100 }, source)).id);
  const select = (selected: string[]) => kernel.router.dispatch('selection.set', { ids: selected, mode: 'replace' }, source);
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const groups = () => kernel.capabilities.request<GroupRecord[]>('groups.list@1');
  const nodes = () => kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  return { kernel, ids, select, graph, groups, nodes };
}

test('toolbar body/title operations toggle only their own type and selected edges disconnect without deleting endpoints', async () => {
  const { kernel, ids, select, graph } = await setup();
  const initialNodeCount = Object.keys(kernel.store.readNamespace('document', 'textNode')).length;
  await select(ids.slice(0, 2));
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'body' }, source);
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'title' }, source);
  assert.equal((await graph()).connections.length, 2);
  const history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'body' }, source);
  assert.equal((await graph()).connections.length, 1);
  assert.equal(isTitleConnection((await graph()).connections[0]), true);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.transactions.undo();
  await select((await graph()).connections.map(edge => edge.id));
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'disconnect' }, source);
  assert.equal((await graph()).connections.length, 0);
  assert.equal(Object.keys(kernel.store.readNamespace('document', 'textNode')).length, initialNodeCount);
  await kernel.transactions.undo();
  assert.equal((await graph()).connections.length, 2);
});

test('toolbar junction splits selected edges, selects the point for repeat removal and survives file roundtrip and hot stop undo', async () => {
  const { kernel, ids, select, graph } = await setup();
  await select(ids.slice(0, 2));
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'body' }, source);
  const edge = (await graph()).connections[0];
  await select([edge.id]);
  const history = kernel.history.getState().undoCount;
  const created = await kernel.router.dispatch<{ id: string }>('connection.toolbarToggle@1', { kind: 'junction' }, source);
  assert.equal((await graph()).junctions.length, 1);
  assert.equal((await graph()).connections.length, 2);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  // The new point remains selected after queued follow-ups settle.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual((await kernel.capabilities.request<{ ids: string[] }>('selection.read@1')).ids, [created.id]);
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, source);
  const reopened = await parseProject(await serializeProject(project));
  assert.ok(reopened.document.namespaces.connectionJunction[created.id]);
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'junction' }, source);
  assert.equal((await graph()).junctions.length, 0);
  assert.equal((await graph()).connections.length, 1);
  await kernel.plugins.stop('connections');
  await kernel.transactions.undo();
  assert.ok(kernel.store.readValue('document', 'connectionJunction', created.id));
});

test('junction action rejects nodes and invalid payloads but splits same-endpoint mixed line types separately', async () => {
  const { kernel, ids, select, graph } = await setup();
  await select(ids.slice(0, 2));
  const before = kernel.history.getState().undoCount;
  await assert.rejects(kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'junction' }, source), /连接线/u);
  await assert.rejects(kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'invalid' }, source), /Invalid command payload/u);
  assert.equal(kernel.history.getState().undoCount, before);
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'body' }, source);
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'title' }, source);
  await select((await graph()).connections.map(edge => edge.id));
  const history = kernel.history.getState().undoCount;
  assert.equal(connectionToolbarSelection((await graph()).connections.map(edge => edge.id), await graph(), []).junction, true);
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'junction' }, source);
  const split = await graph();
  assert.equal(split.junctions.length, 2);
  assert.equal(split.connections.length, 4);
  for (const point of split.junctions) assert.equal(new Set(split.connections.filter(edge => edge.from.nodeId === point.id || edge.to.nodeId === point.id).map(isTitleConnection)).size, 1);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.transactions.undo();
  assert.equal((await graph()).junctions.length, 0);
  assert.equal((await graph()).connections.length, 2);
});

test('unrelated selected lines get separate points atomically while selected nodes and unselected lines are untouched', async () => {
  const { kernel, ids, select, graph, nodes } = await setup(5);
  for (const pair of [[0, 1], [2, 3], [3, 4]]) {
    await select(pair.map(index => ids[index]));
    await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'body' }, source);
  }
  const before = await graph(), originalNodes = await nodes();
  const selected = [...before.connections.slice(0, 2).map(edge => edge.id), ids[4]];
  await select(selected);
  assert.equal(connectionToolbarSelection(selected, before, originalNodes).junction, true);
  const history = kernel.history.getState().undoCount;
  const result = await kernel.router.dispatch<{ ids: string[] }>('connection.toolbarToggle@1', { kind: 'junction' }, source);
  assert.equal(result.ids.length, 2);
  assert.deepEqual((await kernel.capabilities.request<{ ids: string[] }>('selection.read@1')).ids, result.ids);
  assert.equal((await graph()).connections.length, 5);
  assert.deepEqual((await graph()).connections.find(edge => edge.id === before.connections[2].id), before.connections[2]);
  assert.deepEqual(await nodes(), originalNodes);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, source);
  const reopened = await parseProject(await serializeProject(project));
  assert.equal(Object.keys(reopened.document.namespaces.connectionJunction).length, 2);
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'junction' }, source);
  assert.equal((await graph()).junctions.length, 0);
  assert.equal((await graph()).connections.length, 3);
  await kernel.transactions.undo();
  assert.equal((await graph()).junctions.length, 2);
  await kernel.transactions.undo();
  assert.deepEqual(await graph(), before);
});

test('junction batch validates all revisions and duplicate references before a single commit', async () => {
  const { kernel, ids, select, graph } = await setup();
  await select(ids.slice(0, 2));
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'body' }, source);
  const before = await graph(), history = kernel.history.getState().undoCount;
  const reference = { id: before.connections[0].id, revision: before.connections[0].revision };
  await assert.rejects(kernel.router.dispatch('connection.addJunctionBatch@1', { junctions: [
    { x: 100, y: 100, connections: [reference] }, { x: 200, y: 100, connections: [reference] },
  ] }, source), /重复/u);
  await assert.rejects(kernel.router.dispatch('connection.addJunctionBatch@1', { junctions: [
    { x: 100, y: 100, connections: [reference] }, { x: 200, y: 100, connections: [{ id: 'missing', revision: 1 }] },
  ] }, source), /变化/u);
  await assert.rejects(kernel.router.dispatch('connection.addJunctionBatch@1', { junctions: [] }, source), /Invalid command payload/u);
  assert.deepEqual(await graph(), before);
  assert.equal(kernel.history.getState().undoCount, history);
});

test('new junction can be selected before frame-coalesced catalog invalidation is delivered', async () => {
  const { kernel, ids, select, graph } = await setup();
  await select(ids.slice(0, 2));
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'body' }, source);
  await select([(await graph()).connections[0].id]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const frames: FrameRequestCallback[] = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => frames.push(callback) });
  try {
    const point = await kernel.router.dispatch<{ id: string }>('connection.toolbarToggle@1', { kind: 'junction' }, source);
    assert.deepEqual((await kernel.capabilities.request<{ ids: string[] }>('selection.read@1')).ids, [point.id]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', descriptor);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    for (const frame of frames) frame(0);
  }
});

test('ordered membership adds a batch without moving it, then selected members leave directly with single-step undo', async () => {
  const { kernel, ids, select, groups, nodes } = await setup(5);
  await select(ids.slice(0, 3));
  const group = await kernel.router.dispatch<{ id: string }>('group.create', undefined, source);
  await kernel.router.dispatch('node.presentation.set', { id: ids[4], presentation: 'text-box' }, source);
  const original = await nodes();
  await select([group.id, ...ids.slice(3)]);
  await assert.rejects(kernel.router.dispatch('group.membership.applySelected@1', { action: 'add' }, source), /最后/u);
  await select([...ids.slice(3), group.id]);
  const history = kernel.history.getState().undoCount;
  assert.deepEqual(await kernel.router.dispatch('group.membership.applySelected@1', { action: 'add' }, source), { changed: 2 });
  assert.equal((await groups())[0].memberIds.length, 5);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await select(ids.slice(3));
  assert.deepEqual(await kernel.router.dispatch('group.membership.applySelected@1', { action: 'remove' }, source), { changed: 2 });
  assert.equal((await groups())[0].memberIds.length, 3);
  for (const node of await nodes()) assert.equal(node.x, original.find(item => item.id === node.id)!.x);
  await kernel.transactions.undo();
  assert.equal((await groups())[0].memberIds.length, 5);
});

test('batch kick spans groups and atomically restores dissolved group connections on undo', async () => {
  const { kernel, ids, select, groups, graph } = await setup(6);
  const groupIds: string[] = [];
  for (const members of [ids.slice(0, 3), ids.slice(3)]) {
    await select(members);
    groupIds.push((await kernel.router.dispatch<{ id: string }>('group.create', undefined, source)).id);
  }
  await kernel.router.dispatch('connection.create', { from: { nodeId: groupIds[0], kind: 'group', side: 'right' }, to: { nodeId: groupIds[1], kind: 'group', side: 'left' } }, source);
  await select([ids[0], ids[1], ids[3], ids[4]]);
  const history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('group.membership.applySelected@1', { action: 'remove' }, source);
  assert.equal((await groups()).length, 0);
  assert.equal((await graph()).connections.length, 0);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.transactions.undo();
  assert.equal((await groups()).length, 2);
  assert.equal((await graph()).connections.length, 1);
});

test('toolbar projections show only contextual actions and keep title/body and ordered group targets distinct', async () => {
  const { kernel, ids, select, graph, groups, nodes } = await setup();
  await select(ids.slice(0, 2));
  await kernel.router.dispatch('connection.toolbarToggle@1', { kind: 'title' }, source);
  const edge = (await graph()).connections[0];
  const state = connectionToolbarSelection([edge.id], await graph(), await nodes());
  assert.equal(state.body, false); assert.equal(state.title, true); assert.equal(state.junction, true);
  assert.equal(state.primary, 'disconnect');
  const group = await kernel.router.dispatch<{ id: string }>('group.create', undefined, source);
  const selection = (selected: string[]) => ({ ids: selected, items: selected.map(id => ({ id, kind: id === group.id ? 'group' : 'text-node' })) });
  assert.equal(groupMembershipSelection(await groups(), selection([ids[0]]), ids).canRemove, true);
  assert.equal(groupMembershipSelection(await groups(), selection([ids[2], group.id]), ids).canAdd, true);
  assert.equal(groupMembershipSelection(await groups(), selection([group.id, ids[2]]), ids).canAdd, false);
  assert.equal(groupMembershipSelection(await groups(), selection([group.id]), ids).canRemove, false);
});
