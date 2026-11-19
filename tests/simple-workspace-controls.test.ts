import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAITurn } from '../src/plugins/ai-assistant/turn-route.ts';
import { localActions } from '../src/plugins/workspace-actions/actions.ts';
import { compileWorkspaceLanguage } from '../src/services/workspace-language.ts';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { createCloudSyncPlugin } from '../src/plugins/cloud-sync/model.ts';
import { createShortcutCenterPlugin } from '../src/plugins/shortcut-center/model.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createEditorPlugin } from '../src/plugins/editor/model.ts';
import { workspaceActionsPlugin } from '../src/plugins/workspace-actions/model.ts';
import type { WorkspacePlanStep, WorkspacePlanReceipt } from '../src/protocols/workspace-actions.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import { prepareCatalogIntent } from '../src/plugins/ai-assistant/workspace-language-runtime.ts';
import type { PluginContext } from '../src/core/contracts.ts';

// Acceptance vocabulary is intentionally independent of the parser's aliases and regexes.
const panels = [
  ['插件管理', 'settings.plugins'], ['检索设置', 'settings.retrieval'], ['AI模型连接', 'settings.models'],
  ['云同步', 'settings.cloud'], ['个人用语与偏好', 'settings.personal'], ['快捷键面板', 'settings.keys'],
  ['群组管理', 'group.management'], ['小地图', 'minimap'], ['查找替换面板', 'search'],
  ['外观设置', 'palette'], ['设置中心', 'settings'],
] as const;

function routed(prompt: string): WorkspacePlanStep[] | undefined {
  const route = classifyAITurn(prompt);
  if (route.native?.kind === 'view' && route.native.action.startsWith('minimap-')) {
    return [{ id: 'native', action: route.native.action.replace('minimap-', 'minimap.') }];
  }
  return route.workspaceSteps ?? route.catalogIntent?.steps;
}

test('surface operations and common verb orders are completely routed without model planning', () => {
  let cases = 0;
  for (const [name, prefix] of panels) {
    for (const prompt of [`打开${name}`, `请帮我开启${name}吧`, `切换到${name}`, `切到${name}`, `进入${name}`, `把${name}展开`]) {
      assert.equal(routed(prompt)?.[0]?.action, prefix + '.open', prompt);
      cases++;
    }
    for (const prompt of [`关闭${name}`, `把${name}关掉`, `请收起${name}一下`, `隐藏${name}`, `退出${name}`]) {
      assert.equal(routed(prompt)?.[0]?.action, prefix + '.close', prompt);
      cases++;
    }
  }
  assert.equal(cases, 121);
  for (const [prompt, action] of [
    ['打开书籍与恢复', 'file.panel'], ['关闭书籍与恢复', 'file.panel.close'],
    ['打开实时操作日志', 'diagnostics.log'], ['关闭内核与诊断', 'diagnostics.close'],
    ['打开本地校对规则', 'correction.rules'], ['切到书库', 'library.show'], ['返回当前画布', 'library.canvas'],
    ['关闭当前编辑器', 'editor.closeActive'], ['关掉所有编辑窗格', 'editor.closeAll'],
    ['切到下个编辑器', 'editor.next'], ['切回上一个编辑页', 'editor.previous'],
    ['退出沉浸写作模式', 'editor.immersive.exit'], ['关闭全屏写作模式', 'editor.immersive.exit'],
    ['进入沉浸写作模式', 'editor.immersive.current'], ['切换沉浸写作模式', 'editor.immersive.toggle'],
  ]) assert.equal(routed(prompt!)?.[0]?.action, action, prompt);
});

test('every currently registered payload-free open/close/switch adapter has a local route', () => {
  const controls = localActions.filter(({ descriptor }) => /^(?:打开|关闭|切换|进入|退出|启用|停用)/u.test(descriptor.label) &&
    !(descriptor.inputSchema?.required as unknown[] | undefined)?.length);
  assert.ok(controls.length >= 40);
  for (const { descriptor } of controls) {
    const route = classifyAITurn(descriptor.label);
    assert.ok(route.workspaceSteps || route.catalogIntent || route.native, descriptor.id + ': ' + descriptor.label);
    assert.equal(route.operation, 'canvas-control', descriptor.label);
  }
});

test('switches preserve explicit on/off/toggle, tool choice and the sending assistant binding', () => {
  for (const [name, action] of [
    ['智能参考线', 'layout.guides.toggle'], ['吸附', 'layout.snap.toggle'], ['本地纠错', 'correction.toggle'],
    ['自动补全', 'completion.toggle'], ['自动保存', 'persistence.enabled'],
  ]) for (const [verb, enabled] of [['打开', true], ['关闭', false], ['切换', undefined]] as const) {
    const step = routed(verb + name)?.[0];
    assert.equal(step?.action, action);
    assert.equal(step?.arguments?.enabled, enabled);
  }
  for (const [prompt, tool] of [['切到选择工具', 'select'], ['把当前工具换成手形工具', 'hand'], ['使用框选模式', 'select']]) {
    assert.deepEqual(routed(prompt!)?.[0]?.arguments, { tool });
  }
  for (const [prompt, action, args] of [
    ['打开记忆中心', 'assistant.view', { view: 'memory' }], ['关闭记忆中心', 'assistant.view', { view: 'chat' }],
    ['打开Prompt模板中心', 'assistant.view', { view: 'prompt' }], ['切回AI对话', 'assistant.view', { view: 'chat' }],
    ['打开联网搜索', 'assistant.web', { enabled: true }], ['关闭联网', 'assistant.web', { enabled: false }],
    ['切换自动记忆候选', 'assistant.autoMemory', undefined],
    ['打开自动取材', 'assistant.context', { mode: 'automatic' }], ['关闭自动取材', 'assistant.context', { mode: 'explicit-only' }],
    ['关闭当前助手窗口', 'assistant.closeCurrent', undefined],
  ] as const) {
    const route = classifyAITurn(prompt);
    assert.equal(route.catalogIntent?.binding, 'assistant', prompt);
    assert.equal(route.catalogIntent?.steps[0]?.action, action, prompt);
    assert.deepEqual(route.catalogIntent?.steps[0]?.arguments, args, prompt);
  }
});

test('named editors stay literal and incomplete or non-executing requests cannot become partial controls', () => {
  assert.deepEqual(routed('打开「关闭小地图」的编辑器')?.[0]?.arguments, { target: { title: '关闭小地图' } });
  for (const prompt of ['打开空白11', '打开未命名节点', '打开「人物」']) assert.equal(routed(prompt)?.[0]?.action, 'editor.open', prompt);
  assert.equal(routed('关闭空白11')?.[0]?.action, 'editor.close');
  assert.deepEqual(routed('切到空白11的编辑器')?.[0]?.arguments, { target: { title: '空白11' } });
  assert.ok(classifyAITurn('切换主题').local, 'retain the existing zero-model theme chooser');
  for (const prompt of ['切换画布工具', '打开节点', '不要关闭小地图', '先别打开群组管理']) {
    assert.ok(classifyAITurn(prompt).clarification, prompt);
  }
  for (const prompt of ['如何打开群组管理？', '如果关闭设置中心会怎样？', '打开群组管理，然后执行未定义操作', '打开插件管理并把正文改写一遍', '打开小地图，飞起来']) {
    const route = classifyAITurn(prompt);
    assert.equal(route.workspaceSteps, undefined, prompt);
    assert.equal(route.catalogIntent, undefined, prompt);
  }
});

test('closing settings invokes only the active settings owner and preserves unrelated surfaces and history', async t => {
  const kernel = new ApplicationKernel([createCloudSyncPlugin(), createShortcutCenterPlugin()]);
  t.after(async () => { for (const id of ['cloud-sync', 'shortcut-center']) await kernel.plugins.stop(id); });
  await kernel.start();
  for (const command of ['cloudSync.open', 'shortcuts.open'] as const) {
    await kernel.router.dispatch(command, undefined, 'core.test');
    assert.deepEqual(await kernel.router.dispatch('system.ui.closeSettings@1', undefined, 'core.test'), { closed: true });
    assert.equal(kernel.ui.topSurface(['right.primary']), undefined);
  }
  assert.deepEqual(await kernel.router.dispatch('system.ui.closeSettings@1', undefined, 'core.test'), { closed: false });
  await assert.rejects(kernel.router.dispatch('system.ui.closeSettings@1', { invalid: true }, 'core.test'), /payload/iu);
  assert.equal(kernel.history.getState().undoCount, 0);
});

test('current-editor controls run through actual owners and return the real immersive state', async t => {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createEditorPlugin(), workspaceActionsPlugin]);
  t.after(async () => { for (const id of ['workspace-actions', 'editor', 'text-node']) await kernel.plugins.stop(id); });
  await kernel.start();
  const node = (await kernel.capabilities.request<ContentSummary[]>('content.summaries@1'))[0]!;
  await kernel.router.dispatch('editor.open', { id: node.id }, 'core.test');
  let serial = 0;
  const run = (prompt: string) => kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.run@1', {
    version: 1, id: 'local-controls-' + serial++, steps: compileWorkspaceLanguage(prompt), constraints: { effectScope: 'workspace' },
  }, 'core.test');
  assert.equal((await run('进入沉浸写作模式')).status, 'completed');
  assert.equal((await kernel.router.ask<{ immersivePane?: string }>('editor.state', undefined, 'core.test')).immersivePane, node.id);
  assert.equal((await run('退出沉浸写作模式')).status, 'completed');
  assert.equal((await kernel.router.ask<{ immersivePane?: string }>('editor.state', undefined, 'core.test')).immersivePane, undefined);
  assert.equal((await run('关闭当前编辑器')).status, 'completed');
  assert.deepEqual(await kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
  assert.equal((await run('进入沉浸写作模式')).status, 'failed');
});

test('model selection binds only an exact configured unique option to the sending assistant', async () => {
  let options = [{ id: 'one', label: 'Provider · model-one', model: 'model-one', configured: true },
    { id: 'two', label: 'Provider · model-two', model: 'model-two', configured: true }];
  const context = {
    queries: { ask: async () => ({ actions: [{ id: 'assistant.provider', status: 'available' }] }) },
    capabilities: { request: async (key: string) => { assert.equal(key, 'ai.provider.catalog@1'); return { options }; } },
  } as unknown as PluginContext;
  const intent = classifyAITurn('切换模型为model-one').catalogIntent!;
  const bind = () => prepareCatalogIntent(context, intent, 'session', 'sending-window', [], new AbortController().signal);
  assert.deepEqual((await bind()).steps?.[0]?.arguments, { assistantId: 'sending-window', resourceId: 'one' });
  options = [{ ...options[0]!, configured: false }];
  assert.match((await bind()).clarify!, /已配置的唯一模型/u);
  options = [{ ...options[0]!, configured: true }, { ...options[0]!, id: 'duplicate', configured: true }];
  assert.match((await bind()).clarify!, /已配置的唯一模型/u);
});
