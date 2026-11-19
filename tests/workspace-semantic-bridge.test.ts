import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import type { PluginContext } from '../src/core/contracts.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createEditorPlugin } from '../src/plugins/editor/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import { createAIAssistantPlugin } from '../src/plugins/ai-assistant/model.ts';
import { workspaceActionsPlugin } from '../src/plugins/workspace-actions/model.ts';
import { classifyAITurn } from '../src/plugins/ai-assistant/turn-route.ts';
import { planWorkspaceWithModel } from '../src/plugins/ai-assistant/workspace-model-planner.ts';
import { compileWorkspaceLanguage } from '../src/services/workspace-language.ts';
import type { AIGenerateRequest, AIPreparedContext } from '../src/protocols/ai.ts';
import type { KnownCapabilityType } from '../src/protocols/messages.ts';
import type { CanvasControlState } from '../src/protocols/canvas-control.ts';
import type { WorkspacePlan } from '../src/protocols/workspace-actions.ts';

const preparation = (prompt: string): AIPreparedContext => ({ id: 'bridge', sessionId: 'bridge-session', prompt, providerProfileId: 'selected',
  operation: 'canvas-control', sources: [], totalCharacters: prompt.length, estimatedTokens: 0, createdAt: Date.now(), expiresAt: Date.now() + 60000 });

test('unknown application imperatives and weak title matches enter operation parsing while questions remain chat', () => {
  for (const prompt of ['把分组的那个管理窗口叫出来', '让我看看能调模型的那个页面', '找到选中连线的另一个端点', '查一下原点附近那几张卡片的连接情况']) {
    assert.equal(classifyAITurn(prompt).operation, 'canvas-control', prompt);
  }
  assert.equal(classifyAITurn('找到选中连线的另一个端点').semanticFallback, true);
  assert.equal(classifyAITurn('找到「选中连线的另一个端点」').semanticFallback, false);
  for (const prompt of ['怎么打开模型配置页？', '如果把模型切换会怎样', '帮我写一个关于窗口的故事', '为什么需要群组管理', '看看为什么模型没有回答']) {
    assert.equal(classifyAITurn(prompt).category, 'chat', prompt);
  }
});

test('expanded local controls accept independent polite, reveal, state and numeric expressions', () => {
  for (const [name, action] of [['插件面板', 'settings.plugins.open'], ['索引设置', 'settings.retrieval.open'], ['群组管理', 'group.management.open'],
    ['模型连接页面', 'settings.models.open'], ['指令与偏好', 'settings.personal.open'], ['快捷键设置', 'settings.keys.open']] as const) {
    for (const prompt of [`能不能帮我把${name}调出来？`, `劳驾调出${name}`, `替我唤出${name}`, `请帮我呼出${name}`, `把${name}给我叫出来`]) {
      assert.equal(compileWorkspaceLanguage(prompt)?.[0]?.action, action, prompt);
    }
  }
  for (const [prompt, action, args] of [
    ['把吸附状态设为开启', 'layout.snap.toggle', { enabled: true }],
    ['把本地纠错开关设为停用', 'correction.toggle', { enabled: false }],
    ['把自动补全功能关掉', 'completion.toggle', { enabled: false }],
    ['画布缩放到八成', 'viewport.set', { zoom: 0.8 }],
    ['画布缩放为一点五倍', 'viewport.set', { zoom: 1.5 }],
    ['画布缩放为 一点五倍', 'viewport.set', { zoom: 1.5 }],
    ['自动保存关掉', 'persistence.enabled', { enabled: false }],
    ['小地图打开', 'minimap.open', undefined],
    ['画布缩放调整至百分之七十', 'viewport.set', { zoom: 0.7 }],
    ['让空白11进入沉浸写作', 'editor.immersive.enter', { target: { title: '空白11' } }],
    ['把空白11的正文打开', 'editor.open', { target: { title: '空白11' } }],
  ] as const) {
    const step = compileWorkspaceLanguage(prompt)?.[0];
    assert.equal(step?.action, action, prompt); assert.deepEqual(step?.arguments, args, prompt);
  }
});

test('endpoint and history variants stay on existing local owners', () => {
  for (const prompt of ['告诉我选中的线两头是谁', '这条连线两端分别是什么？', '查看当前选中的连接线首尾']) assert.equal(classifyAITurn(prompt).native?.kind, 'connection-inspect', prompt);
  for (const prompt of ['上一步撤销', '撤回上一步']) assert.equal(compileWorkspaceLanguage(prompt)?.[0]?.action, 'history.undo');
  assert.equal(compileWorkspaceLanguage('上一步重做')?.[0]?.action, 'history.redo');
});

async function harness(t: { after(callback: () => Promise<void>): void }) {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createGroupsPlugin(), createConnectionsPlugin(),
    createEditorPlugin(), createCanvasControlPlugin(), createAIAssistantPlugin(), workspaceActionsPlugin]);
  t.after(async () => { for (const plugin of kernel.plugins.list().reverse()) if (plugin.status === 'active') await kernel.plugins.stop(plugin.id); });
  await kernel.start();
  const dispatch = <T = unknown>(type: string, payload?: unknown) => kernel.router.dispatch<T>(type, payload, 'core.test');
  let calls = 0; let recorded: AIGenerateRequest | undefined;
  let output: unknown; let duringResponse: (() => Promise<void>) | undefined;
  const context = {
    capabilities: { request: async (key: string, input?: unknown, signal?: AbortSignal) => {
      if (key === 'ai.provider.catalog@1') return { activeId: 'selected', options: [{ id: 'selected', configured: true }] };
      if (key === 'ai.generate@1') {
        calls++; recorded = input as AIGenerateRequest; await duringResponse?.();
        return { provider: 'fixture', model: 'selected', text: JSON.stringify(output), usage: { inputTokens: 20, outputTokens: 10 } };
      }
      return kernel.capabilities.request(key as KnownCapabilityType, input, signal);
    }, requestAll: (key: string, input?: unknown, signal?: AbortSignal) => kernel.capabilities.requestAll(key, input, signal) },
    queries: { ask: (key: string, input?: unknown) => kernel.router.ask(key, input, 'core.test') },
    commands: { dispatch, invoke: dispatch }, signals: { emit() {} },
  } as unknown as PluginContext;
  return { kernel, dispatch, context, setOutput: (value: unknown) => { output = value; },
    setDuringResponse: (callback: () => Promise<void>) => { duringResponse = callback; }, calls: () => calls, request: () => recorded };
}

test('model workspace plans execute actual editors and ignore unrelated document changes while protecting referenced objects', async t => {
  const h = await harness(t);
  const target = await h.dispatch<{ id: string }>('node.create', { title: '目标卡', body: '私有正文不应发送给解析器' });
  const other = await h.dispatch<{ id: string }>('node.create', { title: '无关卡' });
  h.setOutput({ steps: [{ action: 'editor.open', arguments: { target: { id: target.id } } }], clarification: '' });
  h.setDuringResponse(async () => { await h.dispatch('node.rename', { id: other.id, title: '无关修改不会使目标过期' }); });
  const reply = await planWorkspaceWithModel(h.context, preparation('把目标卡放到右侧编辑器'), new AbortController().signal);
  assert.match(reply.text, /模型解析已完成/u);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), [target.id]);
  assert.equal(h.calls(), 1); assert.doesNotMatch(JSON.stringify(h.request()), /私有正文不应发送/u);
  h.setDuringResponse(async () => { await h.dispatch('node.rename', { id: target.id, title: '真正改变的目标' }); });
  await assert.rejects(planWorkspaceWithModel(h.context, preparation('把目标卡放到右侧编辑器'), new AbortController().signal), /解析期间文档已变化/u);
});

test('model interface plans bind only the sender and expose no document directory or assistant ids', async t => {
  const h = await harness(t);
  const first = await h.dispatch<{ assistantId: string; sessionId: string }>('ai.assistant.openNew');
  const second = await h.dispatch<{ assistantId: string }>('ai.assistant.openNew');
  await h.dispatch('node.create', { title: '不得发送的标题', body: '不得发送的正文' });
  h.setOutput({ steps: [{ action: 'assistant.view', arguments: { view: 'memory' } }], clarification: '' });
  await planWorkspaceWithModel(h.context, { ...preparation('调出记忆管理的那个界面'), assistantId: first.assistantId, sessionId: first.sessionId }, new AbortController().signal);
  const state = await h.kernel.router.ask<{ assistants: Array<{ id: string; view: string }> }>('ai.state', undefined, 'core.test');
  assert.equal(state.assistants.find(a => a.id === first.assistantId)?.view, 'memory');
  assert.equal(state.assistants.find(a => a.id === second.assistantId)?.view, 'chat');
  const payload = JSON.parse(h.request()!.messages[1]!.content);
  assert.deepEqual(payload.directory, {}); assert.deepEqual(payload.selectedIds, []);
  assert.doesNotMatch(JSON.stringify(payload), /不得发送|assistantId|sessionId/u);
  h.setOutput({ steps: [{ action: 'assistant.view', arguments: { view: 'chat', assistantId: second.assistantId } }], clarification: '' });
  await assert.rejects(planWorkspaceWithModel(h.context, { ...preparation('调出对话界面'), assistantId: first.assistantId }, new AbortController().signal), /不能更改发送窗口/u);
});

test('captured selection changes and cancellation reject model plans before execution; document edits still require review', async t => {
  const h = await harness(t);
  const target = await h.dispatch<{ id: string }>('node.create', { title: '可供解析的目标卡' });
  await h.dispatch('selection.set', { ids: [target.id] });
  h.setOutput({ steps: [{ action: 'editor.open', arguments: { target: { id: target.id } } }], clarification: '' });
  h.setDuringResponse(async () => { await h.dispatch('selection.set', { ids: [] }); });
  for (const prompt of ['打开选中的卡片', '打开选中卡片']) {
    await h.dispatch('selection.set', { ids: [target.id] });
    await assert.rejects(planWorkspaceWithModel(h.context, { ...preparation(prompt), selectionAtSend: [target.id] }, new AbortController().signal), /选区已变化/u);
  }
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
  h.setDuringResponse(async () => {});
  h.setOutput({ steps: [{ action: 'node.color', arguments: { target: { id: target.id }, color: '#3568a8' } }], clarification: '' });
  const reply = await planWorkspaceWithModel(h.context, preparation('修改目标卡颜色'), new AbortController().signal);
  assert.match(reply.text, /尚未执行/u);
  const review = (await h.kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)!;
  assert.equal(review.status, 'pending');
  const controller = new AbortController();
  h.setDuringResponse(async () => { controller.abort(); });
  await assert.rejects(planWorkspaceWithModel(h.context, preparation('修改目标卡颜色'), controller.signal), { name: 'AbortError' });
});

test('membership-only model parsing tolerates concurrent body updates and retains the original body on apply', async t => {
  const h = await harness(t);
  const first = await h.dispatch<{ id: string }>('node.create', { title: '成员甲', body: '保留正文' });
  const second = await h.dispatch<{ id: string }>('node.create', { title: '成员乙' });
  const third = await h.dispatch<{ id: string }>('node.create', { title: '成员丙' });
  await h.dispatch('selection.set', { ids: [first.id, second.id, third.id] });
  await h.dispatch('group.create', { title: '真实群组' });
  const groups = await h.kernel.capabilities.request<Array<{ id: string; memberIds: string[] }>>('groups.list@1');
  h.setOutput({ steps: [{ action: 'group.remove', arguments: { groupId: groups[0]!.id, nodeIds: [first.id] } }], clarification: '' });
  h.setDuringResponse(async () => { await h.dispatch('content.applyDelta', { nodeId: first.id, start: 0, deleteCount: 0, insert: '并发写入，' }); });
  const reply = await planWorkspaceWithModel(h.context, preparation('把成员甲移出真实群组'), new AbortController().signal);
  assert.match(reply.text, /尚未执行/u);
  const review = (await h.kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)!;
  await h.dispatch('canvasControl.apply@1', { id: review.id });
  assert.deepEqual((await h.kernel.capabilities.request<Array<{ memberIds: string[] }>>('groups.list@1'))[0]!.memberIds, [second.id, third.id]);
  const body = await h.kernel.capabilities.request<{ text: string }>('content.read@1', { nodeId: first.id, start: 0, length: 100 });
  assert.equal(body.text, '并发写入，保留正文');
});

test('model auto-execution exposes a stable receipt before dispatch so recovery does not repeat a toggle', async t => {
  const h = await harness(t);
  const sender = await h.dispatch<{ assistantId: string; sessionId: string }>('ai.assistant.openNew');
  h.setOutput({ steps: [{ action: 'assistant.web', arguments: {} }], clarification: '' });
  let captured: WorkspacePlan | undefined;
  await planWorkspaceWithModel(h.context, { ...preparation('把联网的那个开关换一下'), ...sender }, new AbortController().signal, plan => { captured = plan; });
  assert.ok(captured);
  const receipt = await h.kernel.router.ask<{ status: string }>('workspace.plan.receipt@1', { id: captured.id }, 'core.test');
  assert.equal(receipt.status, 'completed');
  await h.dispatch('workspace.plan.run@1', captured);
  const state = await h.kernel.router.ask<{ assistants: Array<{ id: string; webSearchEnabled?: boolean }> }>('ai.state', undefined, 'core.test');
  assert.equal(state.assistants.find(a => a.id === sender.assistantId)?.webSearchEnabled, true);
  assert.equal(h.calls(), 1);
});
