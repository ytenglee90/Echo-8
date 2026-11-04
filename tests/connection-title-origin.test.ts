import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createClipboardPlugin } from '../src/plugins/clipboard/model.ts';
import { connectionHorizontalSides, type ConnectionGraphSnapshot, type ConnectionRecord } from '../src/protocols/connections.ts';
import { parseProject, serializeProject } from '../src/plugins/import-export/codec.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

test('chosen title departure side persists until horizontal ordering reverses, including box conversion', () => {
  const from = { id: 'a', x: 0, y: 0, width: 200, height: 100 };
  const to = { id: 'b', x: 600, y: 0, width: 200, height: 100 };
  for (const side of ['left', 'right'] as const) {
    const edge: Pick<ConnectionRecord, 'from' | 'to' | 'titleOrigin'> = { from: { nodeId: 'a', side: 'title' }, to: { nodeId: 'b', side: 'title' }, titleOrigin: { side, sourceIsLeft: true } };
    const initial = connectionHorizontalSides(edge, from, to);
    assert.equal(initial.from.side, side); assert.equal(initial.to.side, side);
    const reversed = connectionHorizontalSides(edge, { ...from, x: 900 }, to);
    assert.equal(reversed.from.side, side === 'left' ? 'right' : 'left'); assert.equal(reversed.to.side, reversed.from.side);
    const converted = connectionHorizontalSides(edge, { ...from, presentation: 'text-box' }, to);
    assert.equal(converted.from.side, side); assert.equal(converted.to.side, side);
    assert.equal(edge.titleOrigin?.side, side);
    // Box title targets share the chosen title side; group/point inputs retain automatic facing.
    for (const target of [{ ...to, presentation: 'text-box' as const }, { ...to, kind: 'group' as const }, { ...to, kind: 'junction' as const }]) {
      const mixed = connectionHorizontalSides({ ...edge, to: { ...edge.to, kind: 'kind' in target ? target.kind : undefined } }, from, target);
      assert.equal(mixed.from.side, 'kind' in target ? 'right' : side); assert.equal(mixed.to.side, 'kind' in target ? 'left' : side);
    }
  }
});

test('title origin survives create, reconnect undo, file migration and clipboard copy', async () => {
  const definitions = () => [textNodePlugin, createSelectionPlugin(), createConnectionsPlugin(), createClipboardPlugin()];
  const kernel = new ApplicationKernel(definitions()); await kernel.start();
  const ids: string[] = [];
  for (const x of [0, 600, 1200]) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title: String(x), x, y: 100 }, 'core.test')).id);
  const origin = { side: 'right' as const, sourceIsLeft: true };
  const created = await kernel.router.dispatch<{ id: string }>('connection.create', { from: { nodeId: ids[0], side: 'title' }, to: { nodeId: ids[1], side: 'title' }, titleOrigin: origin }, 'core.test');
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  const initial = (await graph()).connections[0]; assert.deepEqual(initial.titleOrigin, origin);
  await kernel.router.dispatch('connection.reconnect', { id: created.id, expectedRevision: 1, from: initial.from, to: { nodeId: ids[2], side: 'title' } }, 'core.test');
  assert.deepEqual((await graph()).connections[0].titleOrigin, origin);
  await kernel.transactions.undo(); assert.deepEqual((await graph()).connections[0], initial);
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  assert.equal(project.plugins.find(p => p.id === 'connections')?.dataVersion, 9);
  const oldProject = { ...project, plugins: project.plugins.map(p => p.id === 'connections' ? { ...p, dataVersion: 8 } : p) };
  const reopened = new ApplicationKernel(definitions()); await reopened.start();
  await reopened.router.dispatch('system.document.replace', await parseProject(await serializeProject(oldProject)), 'core.test');
  assert.deepEqual((await reopened.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0], initial);
  await kernel.router.dispatch('selection.set', { ids: ids.slice(0, 2) }, 'core.test');
  await kernel.router.dispatch('clipboard.copy', undefined, 'core.test'); await kernel.router.dispatch('clipboard.paste', undefined, 'core.test');
  assert.equal((await graph()).connections.length, 2); assert.deepEqual((await graph()).connections[1].titleOrigin, origin);
  const migration = createConnectionsPlugin().migrations!.find(m => m.from === 8)!;
  const unknown = { connections: { legacy: { future: { kept: true } } } };
  assert.deepEqual(await migration.migrate(unknown), unknown);
});

test('a text-box title connection stores its operation side in the existing origin field', async () => {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createConnectionsPlugin()]); await kernel.start();
  const ids: string[] = [];
  for (const y of [0, 500]) {
    const { id } = await kernel.router.dispatch<{ id: string }>('node.create', { title: String(y), x: 100, y }, 'core.test');
    ids.push(id); await kernel.router.dispatch('node.presentation.set', { id, presentation: 'text-box' }, 'core.test');
  }
  await kernel.router.dispatch('connection.create', { from: { nodeId: ids[0], side: 'title' }, to: { nodeId: ids[1], side: 'title' }, titleOrigin: { side: 'right', sourceIsLeft: true } }, 'core.test');
  const graph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  assert.deepEqual(graph.connections[0].titleOrigin, { side: 'right', sourceIsLeft: true });
  await kernel.transactions.undo(); assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.length, 0);
});
