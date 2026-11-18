import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import type { PluginContext } from '../src/core/contracts.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import { createPalettePlugin } from '../src/plugins/palette/model.ts';
import { createEditorPlugin } from '../src/plugins/editor/model.ts';
import { workspaceActionsPlugin } from '../src/plugins/workspace-actions/model.ts';
import { prepareNativeCanvasAction } from '../src/plugins/canvas-control/native-actions.ts';
import { nativeCanvasIntent } from '../src/services/native-canvas-intent.ts';
import { classifyAITurn } from '../src/plugins/ai-assistant/turn-route.ts';
import { compileLocalInstructions } from '../src/plugins/ai-assistant/local-turn-routing.ts';
import { parseCanvasControlPlan } from '../src/services/canvas-control-validation.ts';
import { planWorkspaceWithModel } from '../src/plugins/ai-assistant/workspace-model-planner.ts';
import type { CanvasControlState } from '../src/protocols/canvas-control.ts';
import type { GroupRecord } from '../src/protocols/groups.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import type { AIGenerateRequest, AIPreparedContext } from '../src/protocols/ai.ts';
import type { KnownCapabilityType } from '../src/protocols/messages.ts';

async function harness() {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createGroupsPlugin(), createConnectionsPlugin(),
    createCanvasControlPlugin(), createPalettePlugin(), createEditorPlugin(), workspaceActionsPlugin]);
  await kernel.start();
  const dispatch = <T = unknown>(key: string, input?: unknown) => kernel.router.dispatch<T>(key, input, 'core.test');
  const context = { capabilities: { request: (key: string, input?: unknown, signal?: AbortSignal) => kernel.capabilities.request(key, input, signal),
    requestAll: (key: string, input?: unknown, signal?: AbortSignal) => kernel.capabilities.requestAll(key, input, signal) },
  queries: { ask: (key: string, input?: unknown) => kernel.router.ask(key, input, 'core.test') },
  commands: { invoke: dispatch, dispatch }, signals: { emit() {} } } as unknown as PluginContext;
  const nodes = () => kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  return { kernel, dispatch, context, nodes };
}

test('reported phrases distinguish connections, zoom, settings, ambiguous insertion and destructive scope', () => {
  for (const phrase of ['连接线改为蓝色', '把连线的颜色改成蓝色', '全部连接线改为蓝色']) assert.equal(classifyAITurn(phrase).native?.kind, 'connection-color', phrase);
  for (const phrase of ['我现在选中的连接线分别连接了什么', '当前选中的连线连接了哪些节点？']) assert.equal(classifyAITurn(phrase).native?.kind, 'connection-inspect', phrase);
  for (const phrase of ['画布缩放80%', '缩放到80%', '放大到120%']) assert.equal(classifyAITurn(phrase).workspaceSteps?.[0]?.action, 'viewport.set', phrase);
  assert.equal(classifyAITurn('设置自动保存时间为1分钟').catalogIntent?.steps[0]?.arguments?.intervalMs, 60000);
  assert.equal(classifyAITurn('设置放大画布的快捷键为：ctrl+]').catalogIntent?.steps[0]?.action, 'shortcuts.set');
  assert.match(classifyAITurn('人物2插入人物1中').clarification ?? '', /插入/u);
  assert.match(classifyAITurn('删除所有内容').clarification ?? '', /清空.*正文.*删除.*全部对象/u);
  assert.equal(classifyAITurn('人物2加入群组').local?.kind, 'group-add');
  for (const phrase of ['不要把连接线改为蓝色', '如果画布缩放80%会怎么样', '怎么设置自动保存？']) assert.equal(classifyAITurn(phrase).native, undefined);
});

test('repeating the real 69-action creation skips existing names while groups and directed edges refer only to new nodes', async () => {
  const { kernel, dispatch, nodes } = await harness();
  const prompt = '生成60张空白，三张人物，两张角色，一张势力，一张地图，地图连接势力实线。60张空白打一个组';
  const instructions = compileLocalInstructions(prompt, classifyAITurn(prompt))!.instructions!;
  const initial = (await nodes()).length;
  const oldIds = new Set<string>();
  for (let i = 1; i <= 2; i++) {
    const admission = { preparationId: `repeat-${i}`, sessionId: 'repeat', prompt };
    const local = await kernel.capabilities.request<{ text: string }>('canvasControl.localPlan@2', { ...admission, instructions });
    const parsed = parseCanvasControlPlan(local.text);
    assert.equal(parsed.actions.length, 69);
    const offered = await dispatch<{ directPlanId: string }>('canvasControl.offer@1', { ...admission, text: local.text, complete: true });
    await dispatch('canvasControl.generate@1', { id: offered.directPlanId });
    const current = await nodes();
    assert.equal(current.length, initial + 67 * i);
    assert.equal(new Set(current.map(node => node.title)).size, current.length);
    const groups = await kernel.capabilities.request<GroupRecord[]>('groups.list@1');
    assert.equal(groups.length, i);
    assert.equal(groups[i - 1]!.memberIds.length, 60);
    assert.ok(groups[i - 1]!.memberIds.every(id => !oldIds.has(id)));
    const edge = (await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.at(-1)!;
    assert.ok(!oldIds.has(edge.from.nodeId) && !oldIds.has(edge.to.nodeId));
    current.forEach(node => oldIds.add(node.id));
  }
  await dispatch('history.undo');
  assert.equal((await nodes()).length, initial + 67);
  await dispatch('history.redo');
  assert.equal((await nodes()).length, initial + 134);
});

test('selected line color and endpoint reading use the connection owner and one undo restores the color', async () => {
  const { kernel, dispatch, context, nodes } = await harness();
  for (const title of ['端点甲', '端点乙']) await dispatch('node.create', { title });
  const all = await nodes(); const a = all.find(node => node.title === '端点甲')!; const b = all.find(node => node.title === '端点乙')!;
  await dispatch('connection.create', { from: { nodeId: a.id, side: 'right' }, to: { nodeId: b.id, side: 'left' } });
  const edge = (await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0]!;
  await dispatch('selection.set', { ids: [edge.id], mode: 'replace' });
  const input = { preparationId: 'line', sessionId: 'line', prompt: '连接线改为蓝色', selectedIds: [edge.id] };
  const action = await prepareNativeCanvasAction(context, input, nativeCanvasIntent(input.prompt)!);
  await action.apply();
  assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0]!.lineColor, '#3568a8');
  const query = await prepareNativeCanvasAction(context, { ...input, prompt: '我现在选中的连接线分别连接了什么' }, { kind: 'connection-inspect' });
  assert.match(await query.apply(), /端点甲 → 端点乙/u);
  await dispatch('history.undo');
  assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0]!.lineColor, edge.lineColor);
});

test('version 3 creates a 400-member group atomically while older plan limits and dependency checks remain intact', async () => {
  const { kernel, dispatch, nodes } = await harness();
  const before = (await nodes()).length;
  const prompt = '新建400张空白，400张空白打一个组';
  const instructions = compileLocalInstructions(prompt, classifyAITurn(prompt))!.instructions!;
  assert.equal(instructions.length, 401);
  const admission = { preparationId: 'large-400', sessionId: 'large-400', prompt };
  const local = await kernel.capabilities.request<{ text: string }>('canvasControl.localCreationPlan@1', { ...admission, instructions });
  const plan = parseCanvasControlPlan(local.text);
  assert.equal(plan.version, 3);
  assert.throws(() => parseCanvasControlPlan(JSON.stringify({ ...plan, version: 2 })), /上限/u);
  assert.throws(() => parseCanvasControlPlan(JSON.stringify({ version: 3, actions: [{ type: 'update-node', id: 'existing', title: '不能修改旧对象' }] })), /只允许创建/u);
  assert.throws(() => parseCanvasControlPlan(JSON.stringify({ version: 3, actions: [{ type: 'create-group', ref: 'g', title: '不能引用旧对象', members: ['existing'] }] })), /依赖/u);
  await dispatch('canvasControl.execution@1', { execution: 'review' });
  await dispatch('canvasControl.offer@1', { ...admission, text: local.text, complete: true });
  const review = (await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)!;
  await assert.rejects(dispatch('canvasControl.applyItems@2', { id: review.id, items: [401] }), /依赖/u);
  assert.equal((await nodes()).length, before);
  await dispatch('canvasControl.apply@1', { id: review.id });
  assert.equal((await nodes()).length, before + 400);
  assert.equal((await kernel.capabilities.request<GroupRecord[]>('groups.list@1'))[0]?.memberIds.length, 400);
  await dispatch('history.undo');
  assert.equal((await nodes()).length, before);
  await dispatch('history.redo');
  assert.equal((await nodes()).length, before + 400);
});

test('model fallback uses current provider metadata and registered actions, requires preview, opens immersive editor and rejects invented actions', async () => {
  const { kernel, dispatch, context } = await harness();
  await dispatch('node.create', { title: '空白 31', body: '正文不应发送给解析器' });
  let request: AIGenerateRequest | undefined;
  let output: { steps: Array<{ action: string; arguments: Record<string, unknown> }>; clarification: string } =
    { steps: [{ action: 'editor.immersive.enter', arguments: { target: { title: '空白31' } } }], clarification: '' };
  const planner = { ...context, capabilities: { ...context.capabilities, request: async (key: string, input: unknown, signal?: AbortSignal) => {
    if (key === 'ai.provider.catalog@1') return { activeId: 'chosen', options: [{ id: 'chosen', configured: true }] };
    if (key === 'ai.generate@1') { request = input as AIGenerateRequest; return { text: JSON.stringify(output), provider: 'fixture', model: 'chosen', usage: { inputTokens: 42, outputTokens: 12 } }; }
    return context.capabilities.request(key as KnownCapabilityType, input, signal);
  } } } as PluginContext;
  const prepared: AIPreparedContext = { id: 'semantic-turn', sessionId: 'semantic-session', prompt: '请带我进入空白31的沉浸编辑', providerProfileId: 'chosen',
    operation: 'canvas-control', sources: [], totalCharacters: 0, estimatedTokens: 0, createdAt: Date.now(), expiresAt: Date.now() + 60000 };
  const response = await planWorkspaceWithModel(planner, prepared, new AbortController().signal);
  assert.match(response.text, /尚未执行/u);
  assert.equal(request?.providerId, 'chosen');
  assert.ok(!JSON.stringify(request).includes('正文不应发送给解析器'));
  assert.deepEqual(await kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
  const state = await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test');
  assert.equal(state.reviews.at(-1)?.workspaceSteps?.length, 1);
  await dispatch('canvasControl.apply@1', { id: state.reviews.at(-1)!.id });
  const editor = await kernel.router.ask<{ immersivePane?: string }>('editor.state', undefined, 'core.test');
  assert.ok(editor.immersivePane);
  output = { steps: [{ action: 'invented.deleteEverything', arguments: { target: { title: '空白31' } } }], clarification: '' };
  await assert.rejects(planWorkspaceWithModel(planner, { ...prepared, id: 'invalid' }, new AbortController().signal), /未开放动作/u);
  output = { steps: [{ action: 'selection.resolve', arguments: { ids: ['not-in-directory'] } }], clarification: '' };
  await assert.rejects(planWorkspaceWithModel(planner, { ...prepared, id: 'invalid-ids' }, new AbortController().signal), /未提供的对象/u);
  output = { steps: [{ action: 'editor.immersive.enter', arguments: { target: { title: '空白31' } } }], clarification: '' };
  await planWorkspaceWithModel(planner, { ...prepared, id: 'changed-after-review' }, new AbortController().signal);
  const pending = (await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)!;
  const target = (await kernel.capabilities.request<ContentSummary[]>('content.summaries@1')).find(node => node.title === '空白 31')!;
  await dispatch('node.rename', { id: target.id, title: '更新后的标题' });
  await assert.rejects(dispatch('canvasControl.apply@1', { id: pending.id }), /引用的对象已变化/u);

  output = { steps: [{ action: 'editor.immersive.enter', arguments: { target: { title: '更新后的标题' } } }], clarification: '' };
  const changedWhileParsing = { ...planner, capabilities: { ...planner.capabilities, request: async (key: string, input: unknown, signal?: AbortSignal) => {
    const result = await planner.capabilities.request(key as KnownCapabilityType, input, signal);
    if (key === 'ai.generate@1') await dispatch('node.rename', { id: target.id, title: '解析期间改变' });
    return result;
  } } } as PluginContext;
  await assert.rejects(planWorkspaceWithModel(changedWhileParsing, { ...prepared, id: 'changed-during-parse' }, new AbortController().signal), /解析期间文档已变化/u);
});

test('a model plan stays pending until the document owner preview is actually applied, then resumes without replay', async () => {
  const { kernel, dispatch, context, nodes } = await harness();
  await dispatch('node.create', { title: '待确认卡' });
  const node = (await nodes()).find(node => node.title === '待确认卡')!;
  const planner = { ...context, capabilities: { ...context.capabilities, request: async (key: string, input: unknown, signal?: AbortSignal) => {
    if (key === 'ai.provider.catalog@1') return { activeId: 'chosen', options: [{ id: 'chosen', configured: true }] };
    if (key === 'ai.generate@1') return { text: JSON.stringify({ steps: [{ action: 'node.color', arguments: { target: { id: node.id }, color: '#3568a8' } }], clarification: '' }),
      provider: 'fixture', model: 'chosen', usage: { inputTokens: 30, outputTokens: 10 } };
    return context.capabilities.request(key as KnownCapabilityType, input, signal);
  } } } as PluginContext;
  await planWorkspaceWithModel(planner, { id: 'pending-semantic', sessionId: 'pending-semantic', prompt: '请调整待确认卡的颜色', providerProfileId: 'chosen',
    operation: 'canvas-control', sources: [], totalCharacters: 0, estimatedTokens: 0, createdAt: Date.now(), expiresAt: Date.now() + 60000 }, new AbortController().signal);
  const reviews = async () => (await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews;
  const parent = (await reviews()).find(review => review.workspaceSteps)!;
  await dispatch('canvasControl.apply@1', { id: parent.id });
  assert.equal((await reviews()).find(review => review.id === parent.id)?.status, 'pending');
  assert.equal((await nodes()).find(current => current.id === node.id)?.titleColor, node.titleColor);
  const child = (await reviews()).find(review => !review.workspaceSteps && review.status === 'pending')!;
  await dispatch('canvasControl.apply@1', { id: child.id });
  await dispatch('selection.set', { ids: [node.id], mode: 'replace' });
  await dispatch('canvasControl.apply@1', { id: parent.id });
  assert.equal((await reviews()).find(review => review.id === parent.id)?.status, 'applied');
  assert.equal((await nodes()).find(current => current.id === node.id)?.titleColor, '#3568a8');
  await dispatch('history.undo');
  assert.equal((await nodes()).find(current => current.id === node.id)?.titleColor, node.titleColor);
});
