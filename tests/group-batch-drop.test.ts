import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { GroupDropTarget, GroupRecord } from '../src/protocols/groups.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';

async function setup() {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createGroupsPlugin(), createConnectionsPlugin()]);
  await kernel.start(); const ids: string[] = [], groups: string[] = [];
  for (let index = 0; index < 8; index += 1) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', {
    title: `批量${index}`, x: index < 3 ? 100 : 900, y: index % 3 * 250 + 100, width: 220, height: 130,
  }, 'core.test')).id);
  await kernel.router.dispatch('node.presentation.set', { id: ids[7], presentation: 'text-box' }, 'core.test');
  for (const members of [ids.slice(0, 3), ids.slice(3, 6)]) {
    await kernel.router.dispatch('selection.set', { ids: members }, 'core.test');
    groups.push((await kernel.router.dispatch<{ id: string }>('group.create', undefined, 'core.test')).id);
  }
  const readGroups = () => kernel.capabilities.request<GroupRecord[]>('groups.list@1');
  const nodes = () => kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  return { kernel, ids, groups, readGroups, nodes };
}

test('batch Ctrl-drop adds every dragged node and text box in one transaction and retains legacy single requests', async () => {
  const { kernel, ids, groups, readGroups, nodes } = await setup();
  const requested = ids.slice(6), pointer = { x: 200, y: 300 };
  const target = await kernel.capabilities.request<GroupDropTarget>('group.dropTarget@1', { nodeId: ids[6], nodeIds: requested, pointer });
  assert.deepEqual(target, { action: 'add', groupId: groups[0] });
  const before = await nodes(), history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('group.membership.drop', {
    nodeId: ids[6], nodeIds: requested, pointer, target,
    positions: requested.map((id, index) => ({ id, x: 180, y: 250 + index * 170 })),
  }, 'core.test');
  assert.deepEqual((await readGroups()).find(group => group.id === groups[0])!.memberIds, [...ids.slice(0, 3), ...requested]);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.transactions.undo();
  assert.equal((await readGroups()).find(group => group.id === groups[0])!.memberIds.length, 3);
  for (const id of requested) assert.equal((await nodes()).find(node => node.id === id)!.x, before.find(node => node.id === id)!.x);
  await kernel.transactions.redo();
  assert.equal((await readGroups()).find(group => group.id === groups[0])!.memberIds.length, 5);
  const legacy = await kernel.capabilities.request<GroupDropTarget>('group.dropTarget@1', { nodeId: ids[6], pointer });
  await kernel.router.dispatch('group.membership.drop', { nodeId: ids[6], pointer, target: legacy, positions: [{ id: ids[6], x: 600, y: 100 }] }, 'core.test');
  assert.equal((await readGroups()).find(group => group.id === groups[0])!.memberIds.includes(ids[7]), true);
});

test('batch removal spans source groups and atomically restores dissolved groups, connections and positions on undo', async () => {
  const { kernel, ids, groups, readGroups, nodes } = await setup();
  await kernel.router.dispatch('connection.create', { from: { nodeId: groups[0], kind: 'group', side: 'right' }, to: { nodeId: groups[1], kind: 'group', side: 'left' } }, 'core.test');
  const requested = [ids[0], ids[1], ids[3], ids[4], ids[7]], pointer = { x: 3000, y: 3000 };
  const target = await kernel.capabilities.request<GroupDropTarget>('group.dropTarget@1', { nodeId: ids[7], nodeIds: requested, pointer });
  assert.equal(target.action, 'remove');
  const before = await nodes(), history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('group.membership.drop', { nodeId: ids[7], nodeIds: requested, pointer, target,
    positions: requested.map((id, index) => ({ id, x: 3000, y: 3000 + index * 200 })),
  }, 'core.test');
  assert.equal((await readGroups()).length, 0);
  assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.length, 0);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.transactions.undo();
  assert.equal((await readGroups()).length, 2);
  assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.length, 1);
  for (const id of requested) assert.equal((await nodes()).find(node => node.id === id)!.x, before.find(node => node.id === id)!.x);
});

test('invalid batches and stale targets cannot partly move nodes or change membership', async () => {
  const { kernel, ids, groups, nodes, readGroups } = await setup();
  const before = await nodes(), history = kernel.history.getState().undoCount;
  for (const requested of [[ids[6], 'missing'], [ids[6], ids[6]], [ids[7]]]) {
    await assert.rejects(kernel.router.dispatch('group.membership.drop', { nodeId: ids[6], nodeIds: requested,
      pointer: { x: 200, y: 300 }, target: { action: 'add', groupId: groups[0] }, positions: [{ id: ids[6], x: 200, y: 200 }],
    }, 'core.test'));
  }
  await assert.rejects(kernel.router.dispatch('group.membership.drop', { nodeId: ids[6], nodeIds: [ids[6], ids[7]],
    pointer: { x: 200, y: 300 }, target: { action: 'add', groupId: groups[1] }, positions: [{ id: ids[6], x: 200, y: 200 }, { id: ids[7], x: 200, y: 400 }],
  }, 'core.test'));
  assert.equal(kernel.history.getState().undoCount, history); assert.deepEqual(await nodes(), before);
  assert.equal((await readGroups())[0].memberIds.length, 3);
});
