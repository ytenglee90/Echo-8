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
import { workspaceRequirements, readSemanticWorkspacePlan, semanticObservations } from '../src/services/workspace-semantic-plan.ts';
import { readWorkspaceSequence } from '../src/services/workspace-sequence-intent.ts';
import { prepareCatalogIntent } from '../src/plugins/ai-assistant/workspace-language-runtime.ts';

const preparation = (prompt: string): AIPreparedContext => ({ id: 'bridge', sessionId: 'bridge-session', prompt, providerProfileId: 'selected',
  operation: 'canvas-control', sources: [], totalCharacters: prompt.length, estimatedTokens: 0, createdAt: Date.now(), expiresAt: Date.now() + 60000 });

test('unknown application imperatives and weak title matches enter operation parsing while questions remain chat', () => {
  for (const prompt of ['把分组的那个管理窗口叫出来', '让我看看能调模型的那个页面', '找到选中连线的另一个端点', '查一下原点附近那几张卡片的连接情况']) {
    assert.equal(classifyAITurn(prompt).operation, 'canvas-control', prompt);
  }
  for (const prompt of ['显露索引设置窗口', '摊开群组管理面板', '合拢编辑器窗口', '显露模型连接的那个设置页面']) {
    assert.equal(classifyAITurn(prompt).operation, 'canvas-control', prompt);
    assert.equal(classifyAITurn(prompt).semanticFallback, true, prompt);
  }
  assert.equal(classifyAITurn('找到选中连线的另一个端点').semanticFallback, true);
  assert.equal(classifyAITurn('找到「选中连线的另一个端点」').semanticFallback, false);
  assert.equal(classifyAITurn('把「甲」改成蓝色，然后找到选中连线的另一个端点').semanticFallback, true);
  for (const prompt of ['怎么打开模型配置页？', '如果把模型切换会怎样', '帮我写一个关于窗口的故事', '为什么需要群组管理', '看看为什么模型没有回答',
    '最近模型反应慢', '轻量模型很快', '这个窗口刚刚弹出来', '当前模型配置似乎坏了']) {
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
        const result = typeof output === 'function' ? await output(recorded, calls) : output;
        return { provider: 'fixture', model: 'selected', text: JSON.stringify(result), usage: { inputTokens: 20, outputTokens: 10 } };
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

test('requirements retain quoted titles and coordinates and coverage cannot hide a known omitted action', () => {
  assert.deepEqual(workspaceRequirements('打开「先打开，后关闭」的正文，然后把节点移动到(10,20)，再关闭全部编辑器').map(req => req.text),
    ['打开「先打开，后关闭」的正文', '把节点移动到(10,20)', '关闭全部编辑器']);
  const requirements = workspaceRequirements('打开甲的正文，然后关闭全部编辑器');
  const expected = new Map([['r1', ['editor.open']], ['r2', ['editor.closeAll']]]);
  assert.throws(() => readSemanticWorkspacePlan({ version: 2, phase: 'final', steps: [{ id: 'a', action: 'editor.open', arguments: { target: { title: '甲' } } }],
    coverage: [{ requirementId: 'r1', status: 'planned', stepIds: ['a'] }, { requirementId: 'r2', status: 'planned', stepIds: ['a'] }], clarification: '' }, requirements, expected), /遗漏或替换/u);
  assert.throws(() => readSemanticWorkspacePlan({ steps: [{ action: 'editor.open', arguments: {} }], clarification: '' }, requirements, expected), /覆盖情况/u);
  const metadata = semanticObservations({ steps: [{ id: 'q', action: 'content.find', status: 'completed', result: {
    count: 2, matches: [{ id: 'visible', title: '可见', body: '不要发送正文', apiKey: '不要发送密钥' }, { id: 'private', title: '隐私标题' }],
  } }] }, new Set(['visible']));
  assert.equal((metadata[0]!.result as { count: number }).count, 1);
  assert.doesNotMatch(JSON.stringify(metadata), /正文|密钥|隐私标题|private/u);
  assert.equal(metadata[0]!.truncated, true);
  const ids = Array.from({ length: 1000 }, (_, index) => 'node-' + index);
  const large = semanticObservations({ steps: [{ id: 'q', action: 'content.find', status: 'completed',
    result: { count: 1000, matches: ids.map(id => ({ id, title: '长标题'.repeat(150) })) } }] }, new Set(ids));
  assert.equal(large[0]!.truncated, true);
  assert.ok(JSON.stringify(large).length < 12000);
});

test('expanded local surface and state expressions compile fully and incomplete compounds cannot run a partial native action', () => {
  for (const [name, action] of [['插件管理', 'settings.plugins.open'], ['群组管理', 'group.management.open'], ['索引设置', 'settings.retrieval.open'],
    ['模型连接页面', 'settings.models.open'], ['指令与偏好', 'settings.personal.open'], ['快捷键设置', 'settings.keys.open']] as const) {
    for (const prompt of [`我希望打开${name}`, `去${name}`, `翻到${name}`, `亮出${name}`, `弹开${name}`, `请问可以帮我打开${name}好吗？`, `带我到${name}`, `把${name}开一下`]) {
      assert.equal(compileWorkspaceLanguage(prompt)?.[0]?.action, action, prompt);
    }
  }
  for (const [prompt, action, args] of [
    ['把插件窗口收起来', 'settings.plugins.close', undefined], ['暂停自动保存', 'persistence.enabled', { enabled: false }],
    ['恢复自动保存', 'persistence.enabled', { enabled: true }], ['停止自动补全', 'completion.toggle', { enabled: false }],
    ['重置画布缩放', 'viewport.set', { zoom: 1 }], ['画布恢复原大小', 'viewport.set', { zoom: 1 }],
    ['我希望展开空白11的正文', 'editor.open', { target: { title: '空白11' } }],
  ] as const) { const step = compileWorkspaceLanguage(prompt)?.[0]; assert.equal(step?.action, action, prompt); assert.deepEqual(step?.arguments, args, prompt); }
  for (const prompt of ['我希望把那张卡片摆得舒服一点', '索引的那个窗口帮我翻出来', '去能调整模型的那个地方']) assert.equal(classifyAITurn(prompt).operation, 'canvas-control', prompt);
  const partial = classifyAITurn('打开空白11的正文，然后把那个陌生窗口给我变出来');
  assert.equal(partial.semanticFallback, true); assert.equal(partial.local, undefined); assert.equal(partial.native, undefined);
  const pronouns = readWorkspaceSequence('打开空白11的正文，然后进入它的沉浸写作模式，再打开群组管理').intent!;
  assert.deepEqual(pronouns.steps[1]!.arguments?.target, { title: '空白11' });
  const literal = readWorkspaceSequence('打开空白11的正文，然后打开「它」的正文').intent!;
  assert.deepEqual(literal.steps[1]!.arguments?.target, { title: '它' });
  assert.equal(classifyAITurn('先查看甲乙卡片谁更宽，再把更宽的卡片打开').semanticFallback, true);
  for (const prompt of ['麻烦把林渊和旧枪组成一个群组，名为第一章线索', '把林渊和旧枪摆整齐些，两张卡片之间留白',
    '把第一章线索里的节点切成文本框，标题改深蓝', '把选中节点横排，间距80']) assert.equal(classifyAITurn(prompt).semanticFallback, false, prompt);
  for (const prompt of ['我希望你解释模型设置有什么用', '我希望写一个关于窗口的故事', '如果打开插件会怎样']) assert.equal(classifyAITurn(prompt).category, 'chat', prompt);
  for (const prompt of ['我希望切换到护眼主题', '可不可以把主题切换到护眼？', '我希望护眼', '我想护眼']) {
    assert.equal(classifyAITurn(prompt).local?.kind, 'preset', prompt);
  }
});

test('a missing compound clause is corrected once before any editor opens and token usage includes both calls', async t => {
  const h = await harness(t);
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲' });
  const b = await h.dispatch<{ id: string }>('node.create', { title: '乙' });
  h.setOutput(async (_request: AIGenerateRequest, calls: number) => {
    assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
    const steps = [{ id: 'a', action: 'editor.open', arguments: { target: { id: a.id } } }];
    if (calls === 1) return { steps, clarification: '' };
    return { version: 2, phase: 'final', steps: [...steps, { id: 'b', action: 'editor.open', arguments: { target: { id: b.id }, mode: 'add' } }],
      coverage: [{ requirementId: 'r1', status: 'planned', stepIds: ['a'] }, { requirementId: 'r2', status: 'planned', stepIds: ['b'] }], clarification: '' };
  });
  const reply = await planWorkspaceWithModel(h.context, preparation('打开甲的正文，然后打开乙的正文'), new AbortController().signal);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), [a.id, b.id]);
  assert.equal(h.calls(), 2); assert.equal(reply.usage?.inputTokens, 40);
  assert.match(h.request()!.messages[1]!.content, /feedback/u);
});

test('false coverage and unsupported subclauses stop the whole compound before any workspace mutation', async t => {
  const h = await harness(t);
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲' });
  h.setOutput({ version: 2, phase: 'final', steps: [{ id: 'a', action: 'editor.open', arguments: { target: { id: a.id } } }],
    coverage: [{ requirementId: 'r1', status: 'planned', stepIds: ['a'] }, { requirementId: 'r2', status: 'planned', stepIds: ['a'] }], clarification: '' });
  await assert.rejects(planWorkspaceWithModel(h.context, preparation('打开甲的正文，然后关闭所有编辑器'), new AbortController().signal), /遗漏或替换/u);
  assert.equal(h.calls(), 2); assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
});

test('the model observes real metadata and chooses its later editor target without sending bodies or repeating queries', async t => {
  const h = await harness(t);
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲卡', width: 300, body: '正文秘密甲' });
  const b = await h.dispatch<{ id: string }>('node.create', { title: '乙卡', width: 700, body: '正文秘密乙' });
  h.setOutput((request: AIGenerateRequest, calls: number) => {
    if (calls === 1) return { version: 2, phase: 'observe', steps: [a, b].map((node, i) => ({ id: 'q' + i, action: 'node.inspect', arguments: { target: { id: node.id } } })),
      coverage: [{ requirementId: 'r1', status: 'observing', stepIds: ['q0', 'q1'] }, { requirementId: 'r2', status: 'pending', stepIds: [] }], clarification: '' };
    const payload = JSON.parse(request.messages[1]!.content);
    const rows = payload.observations[0] as Array<{ id: string; result: { id: string; width: number } }>;
    const widest = rows.reduce((a, b) => a.result.width > b.result.width ? a : b);
    assert.equal(widest.result.id, b.id); assert.doesNotMatch(JSON.stringify(request), /正文秘密/u);
    return { version: 2, phase: 'final', steps: [{ id: 'open', action: 'editor.open', arguments: { target: { id: widest.result.id } } }],
      coverage: [{ requirementId: 'r1', status: 'observed', stepIds: rows.map(row => row.id) }, { requirementId: 'r2', status: 'planned', stepIds: ['open'] }], clarification: '' };
  });
  await planWorkspaceWithModel(h.context, preparation('先查看甲乙卡片谁更宽，再把更宽的卡片打开'), new AbortController().signal);
  assert.equal(h.calls(), 2); assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), [b.id]);
});

test('model dependency and existence branches use the existing owner lookup result in one plan', async t => {
  const h = await harness(t);
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲卡' });
  h.setOutput({ version: 2, phase: 'final', steps: [
    { id: 'lookup', action: 'content.find', arguments: { title: '甲卡' } },
    { id: 'open', action: 'editor.open', arguments: { target: { from: 'lookup' } }, when: { step: 'lookup', exists: true } },
  ], coverage: [{ requirementId: 'r1', status: 'planned', stepIds: ['lookup'] }, { requirementId: 'r2', status: 'planned', stepIds: ['open'] }], clarification: '' });
  await planWorkspaceWithModel(h.context, preparation('找到甲卡的节点，然后打开它的正文'), new AbortController().signal);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), [a.id]); assert.equal(h.calls(), 1);
});

test('ordinary version-two sequences stop later editors when an earlier target cannot be resolved', async t => {
  const h = await harness(t);
  const b = await h.dispatch<{ id: string }>('node.create', { title: '乙卡' });
  h.setOutput({ version: 2, phase: 'final', steps: [
    { id: 'lookup', action: 'content.find', arguments: { title: '确实不存在' } },
    { id: 'missing', action: 'editor.open', arguments: { target: { from: 'lookup' } } },
    { id: 'later', action: 'editor.open', arguments: { target: { id: b.id } } },
  ], coverage: [
    { requirementId: 'r1', status: 'planned', stepIds: ['lookup'] }, { requirementId: 'r2', status: 'planned', stepIds: ['missing'] },
    { requirementId: 'r3', status: 'planned', stepIds: ['later'] },
  ], clarification: '' });
  await planWorkspaceWithModel(h.context, preparation('找到确实不存在的节点，再打开它的正文，再打开乙卡的正文'), new AbortController().signal);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
});

test('opposite existence branches do not depend on a deliberately skipped sibling branch', async t => {
  const h = await harness(t);
  const b = await h.dispatch<{ id: string }>('node.create', { title: '乙卡' });
  h.setOutput({ version: 2, phase: 'final', steps: [
    { id: 'lookup', action: 'content.find', arguments: { title: '确实不存在' } },
    { id: 'yes', action: 'editor.open', arguments: { target: { from: 'lookup' } }, when: { step: 'lookup', exists: true } },
    { id: 'no', action: 'editor.open', arguments: { target: { id: b.id } }, when: { step: 'lookup', exists: false } },
  ], coverage: [
    { requirementId: 'r1', status: 'planned', stepIds: ['lookup'] }, { requirementId: 'r2', status: 'planned', stepIds: ['yes'] },
    { requirementId: 'r3', status: 'planned', stepIds: ['no'] },
  ], clarification: '' });
  await planWorkspaceWithModel(h.context, preparation('找到确实不存在的节点，有就打开它的正文，没有就打开乙卡'), new AbortController().signal);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), [b.id]);
});

test('local pronoun bindings survive real title revalidation and open the same immersive editor without a model', async t => {
  const h = await harness(t);
  const target = await h.dispatch<{ id: string }>('node.create', { title: '空白11' });
  const intent = readWorkspaceSequence('打开空白11的正文，然后进入它的沉浸写作模式').intent!;
  const prepared = await prepareCatalogIntent(h.context, intent, 'local-session', undefined, [], new AbortController().signal);
  assert.equal(prepared.clarify, undefined);
  const receipt = await h.dispatch<{ status: string }>('workspace.plan.run@1', { version: 1, id: 'local-pronoun-proof', steps: prepared.steps });
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), [target.id]);
  assert.ok((await h.kernel.router.ask<{ immersivePane?: string }>('editor.state', undefined, 'core.test')).immersivePane);
  assert.equal(h.calls(), 0);
});

test('an unsupported local document/workspace combination delegates the whole request without partially opening the editor', async t => {
  const h = await harness(t);
  await h.dispatch('node.create', { title: '空白11' });
  const intent = readWorkspaceSequence('打开空白11的正文，然后创建名为乙的节点').intent!;
  const prepared = await prepareCatalogIntent(h.context, intent, 'mixed-session', undefined, [], new AbortController().signal);
  assert.equal(prepared.needsModel, true); assert.equal(prepared.clarify, undefined);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
  assert.equal((await h.kernel.capabilities.request<Array<{ title: string }>>('content.summaries@1')).some(node => node.title === '乙'), false);
});

test('observation dependencies remain revision-bound through later model rounds', async t => {
  const h = await harness(t);
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲卡', width: 300 });
  const b = await h.dispatch<{ id: string }>('node.create', { title: '乙卡', width: 700 });
  h.setOutput(async (_request: AIGenerateRequest, calls: number) => {
    if (calls === 1) return { version: 2, phase: 'observe', steps: [{ id: 'q', action: 'node.inspect', arguments: { target: { id: a.id } } }],
      coverage: [{ requirementId: 'r1', status: 'observing', stepIds: ['q'] }, { requirementId: 'r2', status: 'pending', stepIds: [] }], clarification: '' };
    await h.dispatch('node.rename', { id: a.id, title: '观察后的来源已变化' });
    return { version: 2, phase: 'final', steps: [{ id: 'open', action: 'editor.open', arguments: { target: { id: b.id } } }],
      coverage: [{ requirementId: 'r1', status: 'observed', stepIds: ['o1.q'] }, { requirementId: 'r2', status: 'planned', stepIds: ['open'] }], clarification: '' };
  });
  await assert.rejects(planWorkspaceWithModel(h.context, preparation('先看看甲卡的尺寸，再打开乙卡'), new AbortController().signal), /引用的对象已更改/u);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
});

test('query feedback is rechecked locally before the final action even when it has no explicit source arguments', async t => {
  const h = await harness(t);
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲卡' });
  const b = await h.dispatch<{ id: string }>('node.create', { title: '乙卡' });
  await h.dispatch('selection.set', { ids: [a.id, b.id] }); await h.dispatch('group.create', { title: '原来的群组名' });
  const groups = await h.kernel.capabilities.request<Array<{ id: string; revision: number }>>('groups.list@1');
  h.setOutput(async (_request: AIGenerateRequest, calls: number) => {
    if (calls === 1) return { version: 2, phase: 'observe', steps: [{ id: 'q', action: 'group.list', arguments: {} }],
      coverage: [{ requirementId: 'r1', status: 'observing', stepIds: ['q'] }, { requirementId: 'r2', status: 'pending', stepIds: [] }], clarification: '' };
    await h.dispatch('group.rename@1', { id: groups[0]!.id, title: '查询之后已改名', expectedRevision: groups[0]!.revision });
    return { version: 2, phase: 'final', steps: [{ id: 'open', action: 'editor.open', arguments: { target: { id: a.id } } }],
      coverage: [{ requirementId: 'r1', status: 'observed', stepIds: ['o1.q'] }, { requirementId: 'r2', status: 'planned', stepIds: ['open'] }], clarification: '' };
  });
  await assert.rejects(planWorkspaceWithModel(h.context, preparation('先看看有哪些群组，再打开其中甲卡'), new AbortController().signal), /查询到的状态已变化/u);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
});

test('repeated queries, invented observations and body-reading observation phases cannot execute mutations', async t => {
  const h = await harness(t);
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲卡', body: '不允许读取正文' });
  const output = { version: 2, phase: 'observe', steps: [{ id: 'q', action: 'node.inspect', arguments: { target: { id: a.id } } }],
    coverage: [{ requirementId: 'r1', status: 'observing', stepIds: ['q'] }, { requirementId: 'r2', status: 'pending', stepIds: [] }], clarification: '' };
  h.setOutput(output);
  await assert.rejects(planWorkspaceWithModel(h.context, preparation('查看甲卡的尺寸，再打开它的正文'), new AbortController().signal), /重复查询/u);
  assert.equal(h.calls(), 2);
  h.setOutput({ ...output, steps: [{ id: 'q', action: 'content.read', arguments: { target: { id: a.id }, start: 0, length: 20 } }] });
  await assert.rejects(planWorkspaceWithModel(h.context, preparation('查看甲卡的尺寸，再打开它的正文'), new AbortController().signal), /受限公开元数据/u);
  h.setOutput({ ...output, phase: 'final', steps: [{ id: 'open', action: 'editor.open', arguments: { target: { id: a.id } } }],
    coverage: [{ requirementId: 'r1', status: 'observed', stepIds: ['o9.invented'] }, { requirementId: 'r2', status: 'planned', stepIds: ['open'] }] });
  await assert.rejects(planWorkspaceWithModel(h.context, preparation('查看甲卡的尺寸，再打开它的正文'), new AbortController().signal), /对应关系无效/u);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
});

test('cancellation after an observation stops the continuation before it opens an editor', async t => {
  const h = await harness(t); const controller = new AbortController();
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲卡' });
  h.setOutput((_request: AIGenerateRequest, calls: number) => {
    if (calls === 2) controller.abort();
    return { version: 2, phase: 'observe', steps: [{ id: 'q', action: 'node.inspect', arguments: { target: { id: a.id } } }],
      coverage: [{ requirementId: 'r1', status: 'observing', stepIds: ['q'] }, { requirementId: 'r2', status: 'pending', stepIds: [] }], clarification: '' };
  });
  await assert.rejects(planWorkspaceWithModel(h.context, preparation('查看甲卡的尺寸，再打开它的正文'), controller.signal), { name: 'AbortError' });
  assert.equal(h.calls(), 2); assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
});

test('a correction and two distinct observations share the same four-call budget and aggregate usage', async t => {
  const h = await harness(t);
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲卡' });
  const b = await h.dispatch<{ id: string }>('node.create', { title: '乙卡' });
  h.setOutput((_request: AIGenerateRequest, calls: number) => {
    if (calls === 1) return { version: 2, phase: 'final', steps: [{ id: 'open', action: 'editor.open', arguments: { target: { id: b.id } } }], clarification: '' };
    if (calls <= 3) return { version: 2, phase: 'observe', steps: [{ id: 'q', action: 'node.inspect', arguments: { target: { id: calls === 2 ? a.id : b.id } } }],
      coverage: [{ requirementId: 'r1', status: 'observing', stepIds: ['q'] }, { requirementId: 'r2', status: 'pending', stepIds: [] }], clarification: '' };
    return { version: 2, phase: 'final', steps: [{ id: 'open', action: 'editor.open', arguments: { target: { id: b.id } } }],
      coverage: [{ requirementId: 'r1', status: 'observed', stepIds: ['o1.q', 'o2.q'] }, { requirementId: 'r2', status: 'planned', stepIds: ['open'] }], clarification: '' };
  });
  const reply = await planWorkspaceWithModel(h.context, preparation('先比较甲乙卡片的尺寸，再打开更宽的那个'), new AbortController().signal);
  assert.equal(h.calls(), 4); assert.equal(reply.usage?.inputTokens, 80);
  assert.deepEqual(await h.kernel.router.ask('editor.openPanes', undefined, 'core.test'), [b.id]);
});

test('model steps can use the existing 24-step owner limit instead of the former 12-step parsing limit', async t => {
  const h = await harness(t);
  const a = await h.dispatch<{ id: string }>('node.create', { title: '甲卡' });
  h.setOutput({ steps: Array.from({ length: 17 }, () => ({ action: 'node.inspect', arguments: { target: { id: a.id } } })), clarification: '' });
  let plan: WorkspacePlan | undefined;
  await planWorkspaceWithModel(h.context, preparation('将甲卡的实际参数重复读取17次'), new AbortController().signal, value => { plan = value; });
  assert.equal(plan?.steps.length, 17);
  const receipt = await h.kernel.router.ask<{ status: string; steps: unknown[] }>('workspace.plan.receipt@1', { id: plan!.id }, 'core.test');
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.steps.length, 17);
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
