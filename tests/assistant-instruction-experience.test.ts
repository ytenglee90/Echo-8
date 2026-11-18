import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import type { PluginContext } from '../src/core/contracts.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import { compileLocalInstructions } from '../src/plugins/ai-assistant/local-turn-routing.ts';
import { classifyAITurn } from '../src/plugins/ai-assistant/turn-route.ts';
import { runCreationBatches } from '../src/plugins/ai-assistant/creation-batches.ts';
import { ASSISTANT_INSTRUCTIONS, assistantInstructionCatalog, preferenceInstruction } from '../src/services/assistant-instructions.ts';
import { emptyAssistantPreferences, isAssistantPreferences, upgradeAssistantPreferences } from '../src/protocols/assistant-preferences.ts';
import { resolvePreference } from '../src/plugins/ai-assistant/personal-preferences.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { GroupRecord } from '../src/protocols/groups.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import type { WorkspaceActionIndex } from '../src/protocols/workspace-actions.ts';

async function harness() {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createConnectionsPlugin(), createGroupsPlugin(), createCanvasControlPlugin()]);
  await kernel.start();
  const context = { capabilities: { request: (key: string, input: unknown, signal?: AbortSignal) => kernel.capabilities.request(key, input, signal) },
    commands: { dispatch: (key: string, input: unknown) => kernel.router.dispatch(key, input, 'core.test') } } as unknown as PluginContext;
  const nodes = () => kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  return { kernel, context, nodes };
}

test('the reported 60-card request creates exactly 67 nodes, a 60-member group and the directed edge in one undo', async () => {
  const { kernel, nodes } = await harness();
  const initial = (await nodes()).length;
  const prompt = '生成60张空白，三张人物，两张角色，一张势力，一张地图，地图连接势力实线。60张空白打一个组';
  const parsed = compileLocalInstructions(prompt, classifyAITurn(prompt));
  assert.equal(parsed?.instructions?.length, 69, parsed?.clarification);
  const admission = { preparationId: 'reported-69', sessionId: 'reported', prompt };
  const plan = await kernel.capabilities.request<{ text: string }>('canvasControl.localPlan@2', { ...admission, instructions: parsed!.instructions });
  const offered = await kernel.router.dispatch<{ directPlanId: string }>('canvasControl.offer@1', { ...admission, text: plan.text, complete: true }, 'core.test');
  await kernel.router.dispatch('canvasControl.generate@1', { id: offered!.directPlanId }, 'core.test');
  assert.equal((await nodes()).length, initial + 67);
  const groups = await kernel.capabilities.request<GroupRecord[]>('groups.list@1');
  assert.equal(groups.length, 1); assert.equal(groups[0]!.memberIds.length, 60);
  const edge = (await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0]!;
  const names = new Map((await nodes()).map(node => [node.id, node.title]));
  assert.equal(names.get(edge.from.nodeId), '地图'); assert.equal(names.get(edge.to.nodeId), '势力');
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await nodes()).length, initial);
  assert.equal((await kernel.capabilities.request<GroupRecord[]>('groups.list@1')).length, 0);
  assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.length, 0);
  await kernel.router.dispatch('history.redo', undefined, 'core.test');
  assert.equal((await nodes()).length, initial + 67);
});

test('independent creation resumes after cancellation without duplicates and undoes by batch', async () => {
  const { kernel, context, nodes } = await harness();
  const initial = (await nodes()).length;
  const prompt = '创建120张空白';
  const instructions = compileLocalInstructions(prompt, classifyAITurn(prompt))!.instructions!;
  assert.equal(instructions.length, 120);
  const input = { preparationId: 'batched-120', sessionId: 'batch', prompt };
  const controller = new AbortController();
  await assert.rejects(runCreationBatches(context, input, instructions, controller.signal, completed => {
    if (completed === 80) controller.abort();
  }), { name: 'AbortError' });
  assert.equal((await nodes()).length, initial + 80);
  assert.match(await runCreationBatches(context, input, instructions, new AbortController().signal, () => undefined), /已创建 120 个节点，共 2 批/u);
  assert.equal((await nodes()).length, initial + 120);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await nodes()).length, initial + 80);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await nodes()).length, initial);
  const mixed = compileLocalInstructions('新建90张空白，90张空白打一个组', classifyAITurn('新建90张空白，90张空白打一个组'));
  assert.equal(mixed?.instructions?.length, 91);
  const largeAdmission = { preparationId: 'large-group', sessionId: 'large-group', prompt: '新建90张空白，90张空白打一个组' };
  const large = await kernel.capabilities.request<{ text: string }>('canvasControl.localCreationPlan@1', { ...largeAdmission, instructions: mixed!.instructions });
  const offer = await kernel.router.dispatch<{ directPlanId: string }>('canvasControl.offer@1', { ...largeAdmission, text: large.text, complete: true }, 'core.test');
  await kernel.router.dispatch('canvasControl.generate@1', { id: offer.directPlanId }, 'core.test');
  assert.equal((await nodes()).length, initial + 90);
  assert.equal((await kernel.capabilities.request<GroupRecord[]>('groups.list@1'))[0]?.memberIds.length, 90);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await nodes()).length, initial);
  await assert.rejects(runCreationBatches(context, { ...input, preparationId: 'bad' }, [...instructions, '删除选中的节点'], new AbortController().signal, () => undefined));
  assert.equal((await nodes()).length, initial);
  await kernel.router.dispatch('node.create', { title: '空白 120' }, 'core.test');
  assert.match(await runCreationBatches(context, { ...input, preparationId: 'late-title-collision' }, instructions,
    new AbortController().signal, () => undefined), /已创建 120 个节点/u);
  const after = await nodes();
  assert.equal(after.length, initial + 121);
  assert.equal(new Set(after.map(node => node.title)).size, after.length, 'existing titles are skipped without dropping requested creations');
});

test('catalog aliases use local routes, preserve old preferences and respect availability and explicit parameters', () => {
  for (const item of ASSISTANT_INSTRUCTIONS) {
    const route = classifyAITurn(item.example!);
    assert.ok(route.local || route.native || route.workspaceSteps || route.catalogIntent, `${item.id}: ${item.example}`);
  }
  const index: WorkspaceActionIndex = { version: 1, registry: { version: 1, commands: [], queries: [], capabilities: [] }, actions: [
    { id: 'layout.vertical', owner: 'smart-layout', label: '竖排', category: '布局', effect: 'document', status: 'available', parameters: {} },
    { id: 'content.edit', owner: 'text-node', label: '编辑正文范围', category: '正文', effect: 'document', status: 'available', parameters: {} },
  ] };
  const catalog = assistantInstructionCatalog(index);
  assert.equal(catalog[1]!.customizable, false);
  const prefs = upgradeAssistantPreferences(emptyAssistantPreferences());
  prefs.entries = [{ id: 'alias', kind: 'phrase', phrase: '往下摆', action: 'vertical', gap: 120, enabled: true, status: 'active', evidence: 1 },
    { id: 'default', kind: 'gap', layout: 'vertical', gap: 60, enabled: true }];
  assert.equal(isAssistantPreferences(prefs), true);
  assert.equal(isAssistantPreferences({ ...prefs, schemaVersion: 1 }), false);
  assert.equal(resolvePreference('往下摆', prefs, undefined, catalog)?.instruction, '把选中节点垂直排列，间距 120');
  assert.equal(resolvePreference('把选中节点垂直排列', prefs)?.instruction, '把选中节点垂直排列，间距 60');
  assert.equal(resolvePreference('把选中节点垂直排列，间距 180', prefs), undefined);
  assert.equal(preferenceInstruction('untrusted:command'), undefined);
  index.actions[0]!.status = 'inactive';
  assert.match(resolvePreference('往下摆', prefs, undefined, assistantInstructionCatalog(index))?.reply ?? '', /当前不可用/u);
});
