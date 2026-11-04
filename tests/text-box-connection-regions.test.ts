import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { connectionEndpointPoint, connectionTargetSide, isTitleConnection, type ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import { updateConnectionSession } from '../src/plugins/canvas/surface-geometry.ts';
import type { ContentSummary } from '../src/protocols/content.ts';

const box = (id: string, x: number): ContentSummary => ({ id, title: id, preview: '', presentation: 'text-box', x, y: 200, width: 280, height: 160, titleColor: '#202124', textColor: '#202124', revision: 1, length: 0 });
test('only the target text-box half chooses line type, while every anchor stays centred', () => {
  const source = box('source', 0), target = box('target', 600);
  for (const sourceSide of ['title', 'right'] as const) for (const y of [200, 279.99, 280, 360]) {
    const session = updateConnectionSession({ from: { nodeId: source.id, side: sourceSide }, sourceSide, pointerId: 1, startClientX: 0, startClientY: 0, pointer: { x: 280, y: 280 }, moved: false }, { x: 600, y }, 600, y, [source, target], {}, {}, 1);
    assert.equal(isTitleConnection({ from: session.from, to: session.to! }), y < 280);
    assert.deepEqual(connectionEndpointPoint(session.from, source, 'right'), { x: 280, y: 280, side: 'right' });
    assert.deepEqual(connectionEndpointPoint(session.to!, target, 'left'), { x: 600, y: 280, side: 'left' });
  }
  assert.equal(connectionTargetSide(target, { x: 600, y: 220 }, false, { ...source, presentation: 'card' }), 'left');
  assert.equal(connectionTargetSide(target, { x: 600, y: 220 }, false, source), 'title');
  for (const kind of ['group', 'junction'] as const) {
    assert.equal(connectionTargetSide(target, { x: 880, y: 220 }, false, { ...source, kind }), 'title');
    assert.equal(connectionTargetSide(target, { x: 880, y: 280 }, true, { ...source, kind }), 'right');
  }
});

test('text-box pair creation and reconnection canonicalize from the target, keep one undo and preserve identity', async () => {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin()]); await kernel.start();
  const ids: string[] = [];
  for (const x of [0, 600]) {
    const created = await kernel.router.dispatch<{ id: string }>('node.create', { title: String(x), x, y: 100 }, 'core.test');
    ids.push(created.id); await kernel.router.dispatch('node.presentation.set', { id: created.id, presentation: 'text-box' }, 'core.test');
  }
  const created = await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[0], side: 'right' }, to: { nodeId: ids[1], side: 'title' } }, 'core.test');
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const initial = (await graph()).connections[0]; assert.equal(isTitleConnection(initial), true);
  const history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('connection.reconnect', { id: created.id, expectedRevision: 1, from: initial.from, to: { nodeId: ids[1], side: 'left' } }, 'core.test');
  const changed = (await graph()).connections[0]; assert.equal(changed.id, initial.id); assert.equal(isTitleConnection(changed), false);
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await kernel.transactions.undo(); assert.deepEqual((await graph()).connections[0], initial);
});
