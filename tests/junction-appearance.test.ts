import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createPalettePlugin, LIGHT_THEME, DARK_THEME } from '../src/plugins/palette/model.ts';
import { PALETTE_PRESETS } from '../src/plugins/palette/presets.ts';
import type { AppearanceTarget } from '../src/protocols/appearance.ts';
import type { ConnectionAppearanceSnapshot } from '../src/protocols/connections.ts';
import { colorContrastRatio, ensureCanvasColorContrast } from '../src/ui/canvas-contrast.ts';
import { parseProject, serializeProject } from '../src/plugins/import-export/codec.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
const source = 'core.test', definitions = () => [textNodePlugin, createSelectionPlugin(), createConnectionsPlugin(), createPalettePlugin()];

test('global junction color has independent revision checks, undo, file round-trip and reset', async () => {
  const kernel = new ApplicationKernel(definitions()); await kernel.start();
  const target = (await kernel.capabilities.request<AppearanceTarget[]>('palette.targets@1')).find(t => t.kind === 'connection-junction')!;
  assert.ok(target); const request = { kind: target.kind, color: '#5577aa', entities: target.entities };
  const history = kernel.history.getState().undoCount;
  await kernel.router.dispatch('palette.applyAppearance', request, source);
  assert.deepEqual(await kernel.capabilities.request<ConnectionAppearanceSnapshot>('connections.appearance@1'), { revision: 0, junctionColor: '#5577aa', junctionRevision: 1 });
  assert.equal(kernel.history.getState().undoCount, history + 1);
  await assert.rejects(kernel.router.dispatch('palette.applyAppearance', request, source), /已经变化/u);
  await kernel.transactions.undo(); assert.deepEqual(await kernel.capabilities.request('connections.appearance@1'), { revision: 0 });
  await kernel.transactions.redo();
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, source), restored = new ApplicationKernel(definitions()); await restored.start();
  await restored.router.dispatch('system.document.replace', await parseProject(await serializeProject(project)), source);
  assert.deepEqual(await restored.capabilities.request('connections.appearance@1'), { revision: 0, junctionColor: '#5577aa', junctionRevision: 1 });
  await restored.router.dispatch('palette.resetAppearance', undefined, source);
  assert.deepEqual(await restored.capabilities.request('connections.appearance@1'), { revision: 0 });
  await restored.transactions.undo(); assert.equal((await restored.capabilities.request<ConnectionAppearanceSnapshot>('connections.appearance@1')).junctionColor, '#5577aa');
});

test('each matching preset updates line and junction appearance in one document transaction with readable colors', async () => {
  const kernel = new ApplicationKernel(definitions()); await kernel.start();
  for (const preset of PALETTE_PRESETS) {
    const before = await kernel.capabilities.request('connections.appearance@1'), history = kernel.history.getState().undoCount;
    const preferences = await kernel.router.dispatch('palette.applyPresetColors@1', { id: preset.id }, source);
    assert.deepEqual(preferences, preset.preferences);
    const appearance = await kernel.capabilities.request<ConnectionAppearanceSnapshot>('connections.appearance@1');
    assert.equal(appearance.color, preset.connectionColor); assert.equal(appearance.junctionColor, preset.junctionColor);
    assert.equal(kernel.history.getState().undoCount, history + 1);
    for (const color of [preset.connectionColor, preset.junctionColor]) assert.ok(colorContrastRatio(ensureCanvasColorContrast(color, preset.canvasBackground), preset.canvasBackground) >= 3);
    const theme = preset.preferences.themeId === 'dark' ? DARK_THEME : LIGHT_THEME;
    const body = preset.preferences.themeId === 'dark' ? theme.tokens.nodeSurface : '#ffffff';
    assert.ok(colorContrastRatio(theme.tokens.muted, body) >= 4.5);
    await kernel.transactions.undo(); assert.deepEqual(await kernel.capabilities.request('connections.appearance@1'), before);
    await kernel.transactions.redo();
  }
});
