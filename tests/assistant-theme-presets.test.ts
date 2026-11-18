import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import type { PluginContext } from '../src/core/contracts.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createPalettePlugin } from '../src/plugins/palette/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import { PALETTE_PRESETS } from '../src/plugins/palette/presets.ts';
import { prepareNativeCanvasAction } from '../src/plugins/canvas-control/native-actions.ts';
import { classifyAITurn } from '../src/plugins/ai-assistant/turn-route.ts';
import { nativeCanvasIntent } from '../src/services/native-canvas-intent.ts';
import { workspaceCatalogIntent } from '../src/services/workspace-catalog-intent.ts';
import type { PalettePanelState, PalettePresetId } from '../src/protocols/appearance.ts';
import type { ConnectionAppearanceSnapshot } from '../src/protocols/connections.ts';
import type { CanvasControlState } from '../src/protocols/canvas-control.ts';

const variants: Array<[PalettePresetId, string[]]> = [
  ['bright', ['切换到明调主题', '恢复明调', '主题改成明调', '请把主题设置为明调', '换成明亮配色', '切换到浅色主题', '我想要明调主题']],
  ['dark', ['切换到暗调主题', '帮我换成暗调', '我想换成暗调', '用暗调吧', '切换主题到深色', '打开夜间模式', '把界面切成暗调']],
  ['eye-care', ['切换到护眼主题', '换成护眼模式', '应用护眼配色', '请把主题换成护眼', '换个护眼的主题吧', '能不能帮我把主题换成护眼？', '我想要护眼主题']],
];

test('the real preset names and conversational variants agree across native and workspace routing', () => {
  for (const [id, phrases] of variants) for (const phrase of phrases) {
    const route = classifyAITurn(phrase);
    assert.equal(route.category, 'operation', phrase);
    assert.deepEqual(route.native, { kind: 'preset', id }, phrase);
    assert.equal(workspaceCatalogIntent(phrase)?.steps[0]?.action, 'appearance.preset.apply', phrase);
    assert.deepEqual(workspaceCatalogIntent(phrase)?.steps[0]?.arguments, { id }, phrase);
  }
  for (const text of ['不要换成暗调', '先别切换到护眼主题', '如果切换到明调会怎么样', '暗调和护眼有什么区别', '怎么切换到护眼主题？',
    '切换到暗调主题，先别执行', '只解释一下明调主题', '把「明调」节点改名为「暗调」', '换成暗调主题，然后删除所有卡片']) {
    assert.equal(nativeCanvasIntent(text), undefined, text);
    assert.notEqual(workspaceCatalogIntent(text)?.steps.some(step => step.action === 'appearance.preset.apply'), true, text);
  }
});

test('assistant preset execution applies the complete palette and keeps personal colors outside document undo', async () => {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createConnectionsPlugin(), createPalettePlugin()]);
  await kernel.start();
  assert.equal(kernel.plugins.isActive('palette'), true);
  const context = { commands: { invoke: (type: string, payload: unknown) => kernel.router.dispatch(type, payload, 'core.test') } } as unknown as PluginContext;
  for (const preset of PALETTE_PRESETS) {
    const before = await kernel.capabilities.request<ConnectionAppearanceSnapshot>('connections.appearance@1');
    const count = kernel.history.getState().undoCount;
    const prompt = `切换到${preset.label}主题`;
    const action = await prepareNativeCanvasAction(context, { sessionId: 'theme', preparationId: 'theme-' + preset.id, prompt }, nativeCanvasIntent(prompt)!);
    assert.match(await action.apply(), new RegExp(`已切换为${preset.label}主题`, 'u'));
    const state = await kernel.capabilities.request<PalettePanelState>('palette.state@1');
    assert.deepEqual(state.preferences, preset.preferences);
    const lines = await kernel.capabilities.request<ConnectionAppearanceSnapshot>('connections.appearance@1');
    assert.equal(lines.color, preset.connectionColor); assert.equal(lines.junctionColor, preset.junctionColor);
    assert.equal(kernel.history.getState().undoCount, count + 1);
    await kernel.transactions.undo();
    assert.deepEqual(await kernel.capabilities.request('connections.appearance@1'), before);
    assert.deepEqual((await kernel.capabilities.request<PalettePanelState>('palette.state@1')).preferences, preset.preferences);
    await kernel.transactions.redo();
  }
  const preferences = (await kernel.capabilities.request<PalettePanelState>('palette.state@1')).preferences;
  await kernel.router.dispatch('palette.applyPresetColors@1', { id: 'dark' }, 'core.test');
  assert.deepEqual((await kernel.capabilities.request<PalettePanelState>('palette.state@1')).preferences, preferences, 'legacy document-only contract stays unchanged');
  const count = kernel.history.getState().undoCount;
  await assert.rejects(kernel.router.dispatch('palette.applyPreset@1', { id: 'unknown' }, 'core.test'));
  assert.equal(kernel.history.getState().undoCount, count);
  await kernel.plugins.stop('palette');
  await assert.rejects(kernel.router.dispatch('palette.applyPreset@1', { id: 'dark' }, 'core.test'));
});

test('the theme chooser offers all three real presets and applies the chosen full palette', async () => {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createConnectionsPlugin(), createPalettePlugin(), createCanvasControlPlugin()]);
  await kernel.start();
  const input = { sessionId: 'choose-theme', preparationId: 'choose-theme-1', prompt: '切换主题' };
  const local = await kernel.capabilities.request<{ text: string }>('canvasControl.localPlan@1', input);
  await kernel.router.dispatch('canvasControl.offer@1', { ...input, text: local.text, complete: true }, 'core.test');
  const state = await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test');
  assert.deepEqual(state.navigation?.items.map(item => item.label), ['明调', '暗调', '护眼']);
  await kernel.router.dispatch('canvasControl.navigate@1', { id: 'eye-care' }, 'core.test');
  assert.deepEqual((await kernel.capabilities.request<PalettePanelState>('palette.state@1')).preferences, PALETTE_PRESETS[2]!.preferences);
});
