import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { createMinimapPlugin } from '../src/plugins/minimap/model.ts';
import { MAP_HEIGHT, MAP_WIDTH, mapPoint, mapProjection } from '../src/plugins/minimap/geometry.ts';
import { defineManifest } from '../src/plugins/manifest.ts';
import { mergeContentCatalogDeltas } from '../src/ui/runtime-hooks.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { MinimapState } from '../src/protocols/minimap.ts';
import type { CanvasOverviewEntity } from '../src/protocols/canvas.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import { parseProject, serializeProject } from '../src/plugins/import-export/codec.ts';

test('minimap visibility is workspace-only, retained on restart and removes all owned contributions on stop', async () => {
  const provider = { manifest: defineManifest('navigation-fixture', '导航环境', {
    providesCapabilities: ['content.catalog@2', 'canvas.camera@1', 'canvas.viewport@1'],
  }), start(context: import('../src/core/contracts.ts').PluginContext) {
    context.capabilities.provide({ key: 'content.catalog@2', invoke: () => ({ version: 1, reset: true, summaries: [], removedIds: [] }) });
    context.capabilities.provide({ key: 'canvas.camera@1', invoke: () => ({ x: 0, y: 0, zoom: 1 }) });
    context.capabilities.provide({ key: 'canvas.viewport@1', invoke: () => ({ width: 1000, height: 700 }) });
  } };
  const kernel = new ApplicationKernel([provider, createMinimapPlugin()]);
  await kernel.start();
  const state = () => kernel.capabilities.request<MinimapState>('minimap.state@1');
  const document = kernel.store.snapshot().document;
  const history = kernel.history.getState();
  assert.equal((await state()).open, false);
  await kernel.router.dispatch('minimap.open', undefined, 'core.test');
  assert.equal((await state()).open, true);
  await kernel.router.dispatch('minimap.toggle', undefined, 'core.test');
  assert.equal((await state()).open, false);
  await kernel.router.dispatch('minimap.toggle', undefined, 'core.test');
  assert.deepEqual(kernel.store.snapshot().document, document);
  assert.deepEqual(kernel.history.getState(), history);
  assert.equal(kernel.ui.listShortcuts().filter((item) => item.owner === 'minimap').length, 1);
  assert.equal(kernel.listUI('canvas.navigation').length, 1);
  await kernel.plugins.stop('minimap');
  assert.equal(kernel.listUI('canvas.navigation').length, 0);
  assert.equal(kernel.ui.listShortcuts().filter((item) => item.owner === 'minimap').length, 0);
  assert.equal(kernel.resources.count('minimap'), 0);
  await kernel.plugins.start('minimap');
  assert.equal((await state()).open, true);
  await kernel.plugins.stop('minimap');
  await kernel.plugins.stop('navigation-fixture');
});

test('map projection contains distant, negative and large node collections and inverts navigation positions', () => {
  for (const nodes of [[], [{ x: -9e8, y: -5e8, width: 400, height: 200 }],
    Array.from({ length: 2000 }, (_, index) => ({ x: index * 400 - 400000, y: index % 50 * 250 - 5000, width: 280, height: 158 }))]) {
    const projection = mapProjection(nodes);
    assert.ok(Number.isFinite(projection.scale) && projection.scale > 0);
    for (const node of nodes) {
      const left = node.x * projection.scale + projection.x;
      const top = node.y * projection.scale + projection.y;
      assert.ok(left >= 0 && top >= 0);
      assert.ok(left + node.width * projection.scale <= MAP_WIDTH);
      assert.ok(top + node.height * projection.scale <= MAP_HEIGHT);
      const world = mapPoint(projection, { x: left, y: top });
      assert.ok(Math.abs(world.x - node.x) < .001 && Math.abs(world.y - node.y) < .001);
    }
  }
});

test('visual catalog invalidation ignores text-only edits but includes recoloring, resize, conversion and deletion', () => {
  const node: ContentSummary = { id: 'a', title: '标题', preview: '正文', x: 0, y: 0, width: 280, height: 158,
    titleColor: '#ff0000', textColor: '#000000', revision: 1, length: 2 };
  const current = new Map([[node.id, node]]);
  const delta = (changed: Partial<ContentSummary>) => mergeContentCatalogDeltas(current, [{
    version: 2, reset: false, summaries: [{ ...node, ...changed }], removedIds: [],
  }]);
  assert.equal(delta({ preview: '新正文', revision: 2, length: 3 }).visualChanged, false);
  assert.equal(mergeContentCatalogDeltas(current, [{ version: 3, reset: true,
    summaries: [{ ...node, preview: '新正文', revision: 2 }], removedIds: [] }]).visualChanged, false);
  for (const changed of [{ titleColor: '#00ff00' }, { width: 300 }, { presentation: 'text-box' as const }]) {
    assert.equal(delta(changed).visualChanged, true);
  }
  assert.equal(mergeContentCatalogDeltas(current, [{ version: 3, reset: false, summaries: [], removedIds: ['a'] }]).visualChanged, true);
});

test('group overview geometry is owner-projected, color-preserving and removable with its provider', async () => {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createGroupsPlugin()]);
  await kernel.start(); const ids: string[] = [];
  for (const x of [100, 700]) ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title: `概览${x}`, x, y: 100, width: 220, height: 130 }, 'core.test')).id);
  await kernel.router.dispatch('selection.set', { ids }, 'core.test');
  const { id } = await kernel.router.dispatch<{ id: string }>('group.create', undefined, 'core.test');
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  project.document.namespaces.groups[id] = { ...project.document.namespaces.groups[id] as object, color: '#b65fcf' };
  await kernel.router.dispatch('system.document.replace', await parseProject(await serializeProject(project)), 'core.test');
  const nodes = await kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  const before = kernel.store.snapshot().document;
  const [group] = kernel.capabilities.requestSync<CanvasOverviewEntity[]>('canvas.overview@1', { nodes });
  assert.deepEqual(group, { id, kind: 'group', x: 75, y: 75, width: 870, height: 180, color: '#b65fcf' });
  assert.deepEqual(kernel.store.snapshot().document, before);
  const [preview] = kernel.capabilities.requestSync<CanvasOverviewEntity[]>('canvas.overview@1', { nodes: nodes.map(node => node.id === ids[1] ? { ...node, width: 1200 } : node) });
  assert.equal(preview.width, 1850);
  assert.deepEqual(kernel.store.snapshot().document, before);
  await kernel.plugins.stop('groups');
  assert.deepEqual(await kernel.capabilities.requestAll('canvas.overview@1', { nodes }), []);
  await kernel.plugins.start('groups');
  assert.equal(kernel.capabilities.requestSync<CanvasOverviewEntity[]>('canvas.overview@1', { nodes })[0].color, '#b65fcf');
  await new Promise(resolve => setTimeout(resolve, 10));
  let invalidations = 0;
  const unsubscribe = kernel.router.subscribeSignal('core.test', 'canvas.overview.invalidated', () => { invalidations += 1; });
  await kernel.router.dispatch('content.applyDelta', { nodeId: ids[0], start: 0, deleteCount: 0, insert: '正文输入' }, 'core.test');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(invalidations, 0, 'text-only history must not redraw the overview');
  unsubscribe();
});
