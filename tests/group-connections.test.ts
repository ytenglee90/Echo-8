import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createClipboardPlugin } from '../src/plugins/clipboard/model.ts';
import { connectionEndpointPoint, isTitleConnection, type ConnectionGraphSnapshot, type ConnectionRecord, type ConnectionTarget } from '../src/protocols/connections.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import { serializeProject, parseProject } from '../src/plugins/import-export/codec.ts';

const source = 'core.test';
const definitions = () => [textNodePlugin, createSelectionPlugin(), createConnectionsPlugin(), createGroupsPlugin(), createClipboardPlugin()];
async function setup() {
  const kernel = new ApplicationKernel(definitions()); await kernel.start();
  const ids: string[] = [], groups: string[] = [];
  for (let index = 0; index < 5; index += 1) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', {
    title: `节点${index}`, x: index < 2 ? 80 : 800, y: index % 2 * 250 + 80,
  }, source)).id);
  for (const pair of [[ids[0], ids[1]], [ids[2], ids[3]]]) {
    await kernel.router.dispatch('selection.set', { ids: pair }, source);
    groups.push((await kernel.router.dispatch<{ id: string }>('group.create', undefined, source)).id);
  }
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const targets = () => kernel.capabilities.request<ConnectionTarget[]>('connections.targets@1');
  return { kernel, ids, groups, graph, targets };
}

test('group endpoints stay at the derived side midpoint, preserve line kinds and follow resize and preview geometry', async () => {
  const { kernel, ids, groups, graph, targets } = await setup();
  const from = { nodeId: groups[0], kind: 'group' as const, side: 'right' as const };
  for (const to of [{ nodeId: groups[1], kind: 'group', side: 'left' }, { nodeId: ids[4], side: 'left' }, { nodeId: ids[4], side: 'title' }] as const) {
    // Title and ordinary pairs are intentionally independent test executions.
    const result = await kernel.router.dispatch<{ id: string }>('connection.create', { from, to }, source);
    const record = (await graph()).connections.find(edge => edge.id === result.id)!;
    assert.equal(record.from.kind, 'group');
    assert.equal(record.to.kind, to.kind);
    assert.equal(isTitleConnection(record), to.side === 'title');
    assert.ok(record.from.side === 'left' || record.from.side === 'right');
    await kernel.router.dispatch('history.undo', undefined, source);
  }
  const before = (await targets())[0];
  const point = connectionEndpointPoint(from, before);
  assert.equal(point.y, before.y + before.height / 2);
  await kernel.router.dispatch('node.resize', { id: ids[1], width: 500, height: 600 }, source);
  const after = (await targets())[0];
  assert.ok(after.height > before.height);
  assert.equal(connectionEndpointPoint(from, after).y, after.y + after.height / 2);
  const nodes = await kernel.capabilities.request<import('../src/protocols/content.ts').ContentSummary[]>('content.summaries@1');
  const preview = kernel.capabilities.requestSync<ConnectionTarget[]>('connections.targets@1', { nodes: nodes.map(node => node.id === ids[1] ? { ...node, y: node.y + 600 } : node) });
  assert.ok(preview[0].height > after.height);
  assert.deepEqual((await targets())[0], after);
});

test('routed group links survive file reload and version-seven compatibility but stay out of group clipboard copies', async () => {
  const { kernel, groups, graph } = await setup();
  const created = await kernel.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: groups[0], kind: 'group', side: 'right' }, to: { nodeId: groups[1], kind: 'group', side: 'left' },
  }, source);
  await kernel.router.dispatch('connection.setLabel', { id: created.id, label: '群组路线', expectedRevision: 1 }, source);
  const junction = await kernel.router.dispatch<{ id: string }>('connection.addJunction', { x: 500, y: 300, connections: [{ id: created.id, revision: 2 }] }, source);
  const original = await graph();
  await kernel.router.dispatch('selection.set', { ids: groups }, source);
  await kernel.router.dispatch('clipboard.copy', undefined, source);
  await kernel.router.dispatch('clipboard.paste', undefined, source);
  const pasted = await graph();
  assert.equal(pasted.junctions.length, 1); assert.equal(pasted.connections.length, 2);
  const copied = pasted.connections.filter(edge => !original.connections.some(old => old.id === edge.id));
  assert.deepEqual(copied, [], 'group copies exclude every junction and routed segment');
  await kernel.router.dispatch('history.undo', undefined, source);
  assert.deepEqual(await graph(), original);
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, source);
  assert.equal(project.plugins.find(plugin => plugin.id === 'connections')!.dataVersion, 11);
  const reopened = new ApplicationKernel(definitions()); await reopened.start();
  const parsed = await parseProject(await serializeProject(project));
  await reopened.router.dispatch('system.document.replace', parsed, source);
  const reloaded = await reopened.capabilities.request<import('../src/protocols/connections.ts').ConnectionGraphSnapshot>('connections.graph@1');
  assert.deepEqual([...reloaded.connections].sort((a, b) => a.id.localeCompare(b.id)), [...original.connections].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(reloaded.junctions, original.junctions);
  await kernel.router.dispatch('selection.set', { ids: [junction.id] }, source);
  await kernel.router.dispatch('selection.delete', undefined, source);
  const restored = (await graph()).connections[0];
  assert.equal(restored.from.kind, 'group'); assert.equal(restored.to.kind, 'group');
  const migration = createConnectionsPlugin().migrations!.find(step => step.from === 7)!;
  assert.deepEqual(await migration.migrate({ connections: { old: { future: true } } }), { connections: { old: { future: true } } });
});

test('ungrouping, member dissolution and deletion remove attached group links atomically with undo', async () => {
  for (const action of ['ungroup', 'toggle', 'remove', 'delete-member', 'delete-group']) {
    const { kernel, ids, groups, graph } = await setup();
    await kernel.router.dispatch('connection.create', { from: { nodeId: groups[0], kind: 'group', side: 'right' }, to: { nodeId: ids[4], side: 'left' } }, source);
    const original = await graph(), before = kernel.history.getState().undoCount;
    if (action === 'ungroup') await kernel.router.dispatch('group.ungroup', { id: groups[0] }, source);
    else if (action === 'remove') await kernel.router.dispatch('group.membership.remove', { groupId: groups[0], nodeIds: [ids[0]] }, source);
    else {
      await kernel.router.dispatch('selection.set', { ids: [action === 'delete-member' ? ids[0] : groups[0]] }, source);
      await kernel.router.dispatch(action === 'toggle' ? 'group.toggleSelection' : 'selection.delete', undefined, source);
    }
    assert.equal((await graph()).connections.length, 0, action);
    assert.equal(kernel.history.getState().undoCount, before + 1);
    await kernel.router.dispatch('history.undo', undefined, source);
    assert.deepEqual(await graph(), original, action);
  }
});

test('membership previews project remaining group bounds without writing or following the expelled node', async () => {
  const { kernel, ids, groups, targets } = await setup();
  const initial = (await targets()).find(group => group.id === groups[0])!;
  await kernel.router.dispatch('group.membership.add', { groupId: groups[0], nodeIds: [ids[4]] }, source);
  const nodes = await kernel.capabilities.request<import('../src/protocols/content.ts').ContentSummary[]>('content.summaries@1');
  const before = kernel.store.snapshot().document, history = kernel.history.getState().undoCount;
  const projected = kernel.capabilities.requestSync<ConnectionTarget[]>('connections.targets@1', {
    nodes: nodes.map(node => node.id === ids[4] ? { ...node, x: 1800, y: 1800 } : node),
    membership: { nodeId: ids[4], nodeIds: [ids[4]], pointer: { x: 1800, y: 1800 } },
  });
  assert.deepEqual(projected.find(group => group.id === groups[0]), initial);
  assert.deepEqual(kernel.store.snapshot().document, before); assert.equal(kernel.history.getState().undoCount, history);
});

test('group selections use ordinary and title shortcuts in order, with stale endpoint rejection', async () => {
  const { kernel, groups, ids, graph } = await setup();
  await kernel.router.dispatch('selection.set', { ids: [groups[0], groups[1]] }, source);
  await kernel.router.dispatch('connection.toggleSelected', undefined, source);
  assert.equal((await graph()).connections[0].from.nodeId, groups[0]);
  assert.equal((await graph()).connections[0].to.nodeId, groups[1]);
  assert.equal(isTitleConnection((await graph()).connections[0]), false);
  await kernel.router.dispatch('connection.toggleSelected', undefined, source);
  await kernel.router.dispatch('selection.set', { ids: [groups[0], ids[4]] }, source);
  await kernel.router.dispatch('connection.toggleTitleSelected', undefined, source);
  const edge: ConnectionRecord = (await graph()).connections[0];
  assert.equal(edge.from.kind, 'group'); assert.equal(edge.to.side, 'title');
  assert.equal(isTitleConnection(edge), true);
  await assert.rejects(kernel.router.dispatch('connection.create', { from: { nodeId: 'missing', kind: 'group', side: 'right' }, to: edge.to }, source), /不存在/u);
});

for (const duplicate of [false, true]) test(`group ${duplicate ? 'Alt duplication' : 'copy/paste'} excludes routed edges and points while copying ordinary internal edges`, async () => {
  const { kernel, ids, groups, graph } = await setup();
  const refs: Array<{ id: string; revision: number }> = [];
  for (const from of ids.slice(0, 2)) refs.push({ ...(await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: from, side: 'right' }, to: { nodeId: ids[4], side: 'left' } }, source)), revision: 1 });
  await kernel.router.dispatch('connection.addJunction', { x: 500, y: 250, connections: refs }, source);
  await kernel.router.dispatch('connection.create', { from: { nodeId: ids[0], side: 'right' }, to: { nodeId: ids[1], side: 'left' } }, source);
  const original = await graph();
  await kernel.router.dispatch('selection.set', { items: [{ id: groups[0], kind: 'group' }] }, source);
  const history = kernel.history.getState().undoCount;
  if (duplicate) await kernel.router.dispatch('clipboard.duplicateSelectionAt', { offset: { x: 350, y: 80 } }, source);
  else { await kernel.router.dispatch('clipboard.copy', undefined, source); await kernel.router.dispatch('clipboard.paste', undefined, source); }
  const copied = await graph();
  assert.equal(copied.junctions.length, 1); assert.equal(copied.connections.length, 5);
  const added = copied.connections.filter(e => !original.connections.some(old => old.id === e.id));
  assert.equal(added.length, 1); assert.equal(added[0].from.kind, undefined); assert.equal(added[0].to.kind, undefined);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.transactions.undo(); assert.deepEqual(await graph(), original);
});
