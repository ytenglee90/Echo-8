import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import type { PluginContext } from '../src/core/contracts.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import { CANVAS_AGENT_TOOLS, runCanvasAgentLoop } from '../src/plugins/ai-assistant/canvas-agent-tools.ts';
import { canvasToolEvidence } from '../src/plugins/ai-assistant/canvas-tool-evidence.ts';
import type { AIGenerateRequest, AIGenerateResult, AIPreparedContext } from '../src/protocols/ai.ts';
import type { CanvasAgentQueryResult, CanvasAgentReadResult } from '../src/protocols/canvas-agent.ts';
import type { CanvasControlAdmission, CanvasControlPlan, CanvasControlState } from '../src/protocols/canvas-control.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { ConnectionEndpoint, ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import { deniesCanvasCapability } from '../src/services/canvas-capabilities.ts';
import { verifyControlApplication } from '../src/plugins/canvas-control/verification.ts';
import { captureControlSnapshot } from '../src/plugins/canvas-control/context.ts';
import { OPERATION_LOG_QUERY_V2, type OperationLogSnapshotV2 } from '../src/protocols/operation-log.ts';
import { initialCanvasAgentState } from '../src/plugins/ai-assistant/canvas-agent-tools.ts';
import { classifyAITurn, rememberTurnAssembly } from '../src/plugins/ai-assistant/turn-route.ts';
import { shortestCanvasPath } from '../src/plugins/canvas-control/structured-operations.ts';
import { cardRestructureTask, validateCardRestructurePlan } from '../src/plugins/ai-assistant/card-restructure.ts';

async function harness() {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createGroupsPlugin(), createConnectionsPlugin(), createCanvasControlPlugin()]);
  await kernel.start();
  const context = { capabilities: kernel.capabilities, signals: { emit() {} } } as unknown as PluginContext;
  const input: CanvasControlAdmission = { preparationId: 'agent:test', sessionId: 'session:agent', prompt: '让那位修钟学徒的资料更完整，并和新场景建立联系' };
  const create = (title: string, body = '', automaticContext = true) => kernel.router.dispatch<{ id: string }>('node.create', { title, body, x: 0, y: 0, automaticContext }, 'core.test');
  const state = () => kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test');
  const query = (query: Record<string, unknown>, admission = input) => kernel.capabilities.request<CanvasAgentQueryResult>('canvasControl.agentQuery@1', { ...admission, query });
  const submit = (plan: CanvasControlPlan, extra = {}) => kernel.capabilities.request<{ text: string }>('canvasControl.agentPlan@1', { ...input, plan, ...extra });
  return { kernel, context, input, create, state, query, submit };
}
function prepared(input: CanvasControlAdmission): AIPreparedContext {
  return { id: input.preparationId, sessionId: input.sessionId, prompt: input.prompt, operation: 'general',
    sources: [], createdAt: Date.now(), expiresAt: Date.now() + 60_000, totalCharacters: 0, estimatedTokens: 0 };
}
function tool(name: string, args: unknown): AIGenerateResult {
  return { text: '', provider: 'test', model: 'test', finishReason: 'tool-calls', toolCalls: [{ id: 'call:' + name, name, arguments: JSON.stringify(args) }] };
}
const initial: AIGenerateRequest = { messages: [{ role: 'user', content: '完善人物并关联新场景' }], canvasAgentTransport: 'native', tools: CANVAS_AGENT_TOOLS, maxOutputTokens: 4000, temperature: 0.2 };

test('discussion denies unsolicited write tool calls in native and JSON modes', async () => {
  const h = await harness();
  const input = { ...h.input, prompt: '人物卡怎么设计？' };
  const context = prepared(input);
  const args = { plan: { version: 1, actions: [{ type: 'create-node', ref: 'x', title: '模型擅自创建' }] } };
  for (const transport of ['native', 'json'] as const) {
    const first = transport === 'native' ? tool('propose_canvas_plan', args)
      : { provider: 'test', model: 'test', text: JSON.stringify({ canvas_tool: { name: 'propose_canvas_plan', arguments: args } }) };
    const result = await runCanvasAgentLoop(h.context, context, { ...initial, canvasAgentTransport: transport }, first, async request => {
      assert.match(request.messages.at(-1)!.content, /本轮为讨论/u);
      return { provider: 'test', model: 'test', text: '先确定角色目标和动机。' };
    }, async () => ({ messages: [], executed: 0 }), new AbortController().signal);
    assert.equal(result.canvasPlan, false);
    assert.equal((await h.state()).reviews.length, 0);
  }
  await h.kernel.plugins.stop('canvas-control');
});

test('apply selected preview items checks their own revisions and undoes the batch as one change', async () => {
  const h = await harness();
  const first = await h.create('甲'), skipped = await h.create('乙'), third = await h.create('丙');
  await h.query({ mode: 'search', query: '甲' });
  await h.query({ mode: 'search', query: '乙' });
  await h.query({ mode: 'search', query: '丙' });
  const plan = await h.submit({ version: 1, actions: [first, skipped, third].map(node => ({ type: 'update-node', id: node.id, x: 45 })) });
  await h.kernel.router.dispatch('canvasControl.offer@1', { ...h.input, text: plan.text, complete: true }, 'core.test');
  const review = (await h.state()).reviews.at(-1)!;
  await h.kernel.router.dispatch('node.rename', { id: skipped.id, title: '改了标题的乙' }, 'core.test');
  const positions = async () => {
    const current = await h.kernel.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: [first.id, skipped.id, third.id] });
    return [first, skipped, third].map(item => current.find(node => node.id === item.id)?.x);
  };
  await assert.rejects(() => h.kernel.router.dispatch('canvasControl.applyItems@1', { id: review.id, items: [4] }, 'core.test'), /超出/u);
  await h.kernel.router.dispatch('canvasControl.applyItems@1', { sessionId: h.input.sessionId, items: [1, 3] }, 'core.test');
  assert.deepEqual(await positions(), [45, 0, 45]);
  assert.equal((await h.state()).reviews.at(-1)?.verification?.status, 'verified');
  await h.kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.deepEqual(await positions(), [0, 0, 0]);
  await h.kernel.plugins.stop('canvas-control');
});

test('mixed summary cannot write into a read-only source and can append to the designated destination on correction', async () => {
  const h = await harness();
  const a = await h.create('来源卡', '第一条观察。');
  const b = await h.create('总览卡', '原有笔记。');
  const input = { ...h.input, prompt: '总结来源卡，把结果写进总览卡', sourceIds: [a.id, b.id] };
  const current = await h.kernel.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: input.sourceIds });
  const turn: AIPreparedContext = { ...prepared(input), operation: 'canvas-control', sources: current.map(node => ({
    sourceId: node.id, title: node.title, provider: 'text-node', kind: 'text', revision: node.revision,
    start: 0, length: 0, text: '', reason: 'explicit-reference',
  })) };
  rememberTurnAssembly(turn, { route: classifyAITurn(turn.prompt), readIds: [a.id], destinationId: b.id });
  await initialCanvasAgentState(h.context, turn, new AbortController().signal, input.sourceIds);
  const proposal = (id: string) => tool('propose_canvas_plan', { plan: { version: 1,
    actions: [{ type: 'update-node', id, append: '\n结果。' }] } });
  const result = await runCanvasAgentLoop(h.context, turn, initial, proposal(a.id), async request => {
    assert.match(request.messages.at(-1)!.content, /指定结果卡/u);
    return proposal(b.id);
  }, async () => ({ messages: [], executed: 0 }), new AbortController().signal);
  assert.equal(result.canvasPlan, true);
  assert.deepEqual(JSON.parse(result.result.text).actions.map((action: { id: string }) => action.id), [b.id]);
  await h.kernel.router.dispatch('canvasControl.offer@1', { ...input, text: result.result.text, complete: true }, 'core.test');
  const review = (await h.state()).reviews.at(-1)!;
  await h.kernel.router.dispatch('node.rename', { id: a.id, title: '已手改的来源卡' }, 'core.test');
  await assert.rejects(() => h.kernel.router.dispatch('canvasControl.apply@1', { id: review.id }, 'core.test'), /已经变化/u);
  await h.kernel.plugins.stop('canvas-control');
});

test('cross-card exact synchronization stages a checked replacement and skips private sources', async () => {
  const h = await harness();
  const a = await h.create('人物卡', '林渊的职业：钟匠。');
  const b = await h.create('线索卡', '林渊的职业：钟匠。');
  const privateCard = await h.create('私密卡', '林渊的职业：钟匠。', false);
  const input = { ...h.input, prompt: '把画布上的「职业：钟匠」统一改成「职业：守夜人」' };
  const local = await h.kernel.capabilities.request<{ handled: boolean; text: string }>('canvasControl.localPlan@1', input);
  assert.equal(local.handled, true);
  await h.kernel.router.dispatch('canvasControl.offer@1', { ...input, text: local.text, complete: true }, 'core.test');
  const review = (await h.state()).reviews.at(-1)!;
  assert.equal(review.replacement?.count, 2);
  await h.kernel.router.dispatch('canvasControl.apply@1', { id: review.id }, 'core.test');
  const sources = await h.kernel.capabilities.requestAll<{ handled: boolean; text: string }>('context.read@1', { sourceId: a.id, start: 0, length: 100 });
  const second = await h.kernel.capabilities.requestAll<{ handled: boolean; text: string }>('context.read@1', { sourceId: b.id, start: 0, length: 100 });
  const original = await h.kernel.capabilities.requestAll<{ handled: boolean; text: string }>('context.read@1', { sourceId: privateCard.id, start: 0, length: 100 });
  assert.match(sources.find(item => item.handled)!.text, /守夜人/u);
  assert.match(second.find(item => item.handled)!.text, /守夜人/u);
  assert.match(original.find(item => item.handled)!.text, /钟匠/u);
  await h.kernel.plugins.stop('canvas-control');
});

test('path tracing uses true edges through routing points, honors direction and excludes private intermediates', () => {
  const endpoint = (nodeId: string, side: 'left' | 'right'): ConnectionEndpoint =>
    ({ nodeId, side, ...(nodeId === 'j' ? { kind: 'junction' } : {}) });
  const graph: ConnectionGraphSnapshot = { version: 1, junctions: [], connections: [
    ['a-j', 'a', 'j'], ['j-d', 'j', 'd'], ['a-b', 'a', 'private'], ['b-d', 'private', 'd'],
  ].map(([id, from, to]) => ({ id: id!, from: endpoint(from!, 'right'), to: endpoint(to!, 'left'),
    labelWidth: 180, labelHeight: 48, revision: 1, createdAt: 1 })) };
  const allowed = new Set(['a', 'd']);
  assert.deepEqual(shortestCanvasPath(graph, allowed, 'a', 'd', true), { objects: ['a', 'd'], edges: ['a-j', 'j-d'] });
  assert.equal(shortestCanvasPath(graph, allowed, 'd', 'a', true), undefined);
  assert.deepEqual(shortestCanvasPath(graph, allowed, 'd', 'a', false)?.edges, ['j-d', 'a-j']);
});

test('split scope preserves the original card and only rewires its side of the approved connections', () => {
  assert.deepEqual(cardRestructureTask('把长卡拆成人物、事件、地点三张，保留原卡并重接相关连线'), {
    names: ['长卡'], titles: ['人物', '事件', '地点'], reconnect: true,
  });
  const scope = { ids: ['long'], titles: ['人物', '事件', '地点'], reconnect: true };
  const edges = [{ id: 'edge', from: 'long', to: 'other', line: 'dashed' as const, label: '原标签', revision: 1 }];
  const plan: CanvasControlPlan = { version: 1, actions: [
    ...scope.titles.map((title, index) => ({ type: 'create-node' as const, ref: 'new' + index, title, text: '有关原文' })),
    { type: 'update-connection', id: 'edge', from: 'new0' },
  ] };
  assert.doesNotThrow(() => validateCardRestructurePlan(scope, plan, edges));
  assert.throws(() => validateCardRestructurePlan(scope, { ...plan, actions: [...plan.actions, { type: 'delete', ids: ['long'] }] }, edges), /保留原卡/u);
  assert.throws(() => validateCardRestructurePlan(scope, { ...plan, actions: [...plan.actions.slice(0, 3),
    { type: 'update-connection', id: 'edge', from: 'new0', to: 'new1' }] }, edges), /保留另一端/u);
});

test('a model can delegate exact relative geometry and stale anchors reject the whole plan', async () => {
  const h = await harness();
  const a = await h.create('武器卡');
  const b = await h.create('人物卡');
  const plan: CanvasControlPlan = { version: 1, actions: [] };
  const args = { plan, placements: [{ nodeId: a.id, anchorId: b.id, side: 'below', gap: 35 }] };
  await h.query({ mode: 'search', query: '武器卡' });
  await assert.rejects(() => h.kernel.capabilities.request('canvasControl.agentPlan@2', { ...h.input, ...args }), /范围外/u);
  await h.query({ mode: 'search', query: '人物卡' });
  const result = await runCanvasAgentLoop(h.context, prepared(h.input), initial, tool('propose_canvas_plan', args),
    async () => { throw new Error('unexpected model round'); }, async () => ({ messages: [], executed: 0 }), new AbortController().signal);
  assert.equal(result.canvasPlan, true);
  await h.kernel.router.dispatch('canvasControl.offer@1', { ...h.input, text: result.result.text, complete: true }, 'core.test');
  const seen = (await h.state()).reviews.at(-1)!;
  assert.equal(seen.actions.length, 1);
  assert.equal(await h.kernel.router.dispatch('node.rename', { id: b.id, title: '人物新卡' }, 'core.test') !== undefined, true);
  await assert.rejects(() => h.kernel.router.dispatch('canvasControl.apply@1', { id: seen.id }, 'core.test'), /已经变化/u);
  const next = { ...h.input, preparationId: 'agent:relative-fresh' };
  await h.query({ mode: 'search', query: '武器卡' }, next);
  await h.query({ mode: 'search', query: '人物新卡' }, next);
  const fresh = await h.kernel.capabilities.request<{ text: string }>('canvasControl.agentPlan@2', { ...next, ...args });
  await h.kernel.router.dispatch('canvasControl.offer@1', { ...next, text: fresh.text, complete: true }, 'core.test');
  await h.kernel.router.dispatch('canvasControl.apply@1', { id: (await h.state()).reviews.at(-1)!.id }, 'core.test');
  const summaries = await h.kernel.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: [a.id, b.id] });
  const moved = summaries.find(node => node.id === a.id)!;
  const anchor = summaries.find(node => node.id === b.id)!;
  assert.equal(moved.y - anchor.y - anchor.height, 35);
  assert.equal((await h.state()).reviews.at(-1)?.verification?.status, 'verified');
  await h.kernel.plugins.stop('canvas-control');
});

test('identical tool results cite their existing call without replaying data or breaking the tool-message sequence', async () => {
  const h = await harness();
  await h.create('本轮目标');
  let round = 0;
  const search = (id: string): AIGenerateResult => ({ ...tool('query_canvas', { mode: 'search', query: '本轮目标' }),
    toolCalls: [{ id, name: 'query_canvas', arguments: '{"mode":"search","query":"本轮目标"}' }] });
  await runCanvasAgentLoop(h.context, prepared(h.input), initial, search('first'), async request => {
    if (++round === 1) return search('second');
    const results = request.messages.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.toolCallId), ['first', 'second']);
    assert.match(results[0]!.content, /"title":"本轮目标"/u);
    assert.match(results[1]!.content, /"previousCall":"first"/u);
    assert.doesNotMatch(results[1]!.content, /"nodes"/u);
    return { text: '已定位。', provider: 'test', model: 'test' };
  }, async () => ({ messages: [], executed: 0 }), new AbortController().signal);
  assert.equal(round, 2);
  await h.kernel.plugins.stop('canvas-control');
});

test('tool evidence sends only new rows and non-overlapping text after a validated lookup', () => {
  const h = prepared({ preparationId: 'x', sessionId: 'y', prompt: '整理人物关系' });
  const evidence = canvasToolEvidence(initial, h, new Set(['links']));
  const node = { id: 'node:hero', title: '一张标题足够长的测试人物卡', revision: 1, nodeRevision: 2, length: 700,
    x: 1, y: 2, width: 80, height: 60, color: '#123456', presentation: 'card' as const };
  const edge = { id: 'link:hero-weapon', from: node.id, to: 'node:weapon', line: 'dashed' as const, label: '武器原主', revision: 1 };
  const state = { nodes: [node], groups: [], connections: [edge], available: { nodes: true, groups: true, connections: true }, total: 1 };
  evidence.query(state, 'relations', 'query-first').record();
  const next = evidence.query({ ...state, nodes: [node, { ...node, id: 'node:weapon', title: '武器卡' }], total: 2 }, 'relations', 'query-two');
  assert.match(JSON.stringify(next.value), /"seenIn":"query-first"/u);
  assert.match(JSON.stringify(next.value), /"title":"武器卡"/u);
  assert.doesNotMatch(JSON.stringify(next.value), /"label":"武器原主"|"width"/u);
  const changed = evidence.query({ ...state, connections: [{ ...edge, revision: 2, line: 'solid' }] }, 'relations', 'query-three');
  assert.match(JSON.stringify(changed.value), /"line":"solid"/u);

  const shared = '重叠的验证范围。'.repeat(50);
  const read = { id: node.id, revision: 1, start: 0, text: '首段。' + shared, totalLength: shared.length + 6 };
  evidence.read(read, 'read-first').record();
  const second = evidence.read({ ...read, start: 3, text: shared + '末段。' }, 'read-second');
  assert.match(JSON.stringify(second.value), /"previousCall":"read-first"/u);
  assert.match(JSON.stringify(second.value), /"text":"末段。"/u);
  assert.doesNotMatch(JSON.stringify(second.value), /重叠的验证范围/u);
  const fresh = evidence.read({ ...read, revision: 2 }, 'read-third');
  assert.match(JSON.stringify(fresh.value), /重叠的验证范围/u);
  assert.doesNotMatch(JSON.stringify(fresh.value), /"previousCall"/u);
});

test('semantic canvas tools discover, range-read and submit a general-chat task through one verified atomic transaction', async () => {
  const h = await harness();
  const hero = await h.create('主角｜林渊', '修钟学徒。年龄29。');
  for (let index = 0; index < 140; index++) await h.create('背景' + index);
  let step = 0;
  const plan: CanvasControlPlan = { version: 2, actions: [
    { type: 'update-node', id: hero.id, edit: { start: 7, deleteCount: 2, insert: '31', expectedRevision: 1 }, color: '#3568a8', presentation: 'text-box' },
    { type: 'create-node', ref: 'scene', title: '钟楼', text: '雨夜重逢。' },
    { type: 'create-group', ref: 'chapter', title: '开篇', members: [hero.id, 'scene'] },
    { type: 'create-connection', ref: 'relation', from: hero.id, to: 'scene', line: 'dashed', label: '重逢' },
  ] };
  const result = await runCanvasAgentLoop(h.context, prepared(h.input), initial, tool('query_canvas', { mode: 'search', query: '林渊' }), async request => {
    step++;
    assert.equal(request.messages.at(-1)?.role, 'tool');
    if (step === 1) { assert.match(request.messages.at(-1)!.content, /林渊/u); return tool('read_canvas', { id: hero.id, start: 0, length: 40 }); }
    assert.match(request.messages.at(-1)!.content, /修钟学徒/u);
    return tool('propose_canvas_plan', { plan });
  }, async () => ({ messages: [], executed: 0 }), new AbortController().signal);
  assert.equal(result.canvasPlan, true); assert.equal(step, 2);
  await h.kernel.router.dispatch('canvasControl.offer@1', { ...h.input, text: result.result.text, complete: true }, 'core.test');
  const review = (await h.state()).reviews.at(-1)!;
  assert.equal(review.status, 'pending');
  await h.kernel.router.dispatch('canvasControl.apply@1', { id: review.id }, 'core.test');
  assert.deepEqual((await h.state()).reviews.at(-1)?.verification, { status: 'verified', checked: 4, mismatches: [] });
  const read = () => h.kernel.capabilities.requestAll<{ text?: string }>('context.read@1', { sourceId: hero.id, start: 0, length: 40 });
  assert.equal((await read()).find(part => part.text)?.text, '修钟学徒。年龄31。');
  assert.equal((await h.kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.length, 1);
  const log = await h.kernel.router.ask<OperationLogSnapshotV2>(OPERATION_LOG_QUERY_V2, undefined, 'core.test');
  assert.ok(log.entries.some(entry => entry.code === 'canvas-read' && entry.detail?.readCharacters === 10));
  assert.ok(log.entries.some(entry => entry.code === 'canvas-verification' && entry.detail?.checked === 4));
  assert.ok(!JSON.stringify(log).includes('修钟学徒'));
  await h.kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await read()).find(part => part.text)?.text, '修钟学徒。年龄29。');
  assert.equal((await h.kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.length, 0);
  const next = await h.query({ mode: 'state' }, { ...h.input, preparationId: 'agent:next', prompt: '它刚才改好了没有' });
  assert.match(JSON.stringify(next.tasks), /undone/u);
  await h.kernel.plugins.stop('canvas-control');
});

test('canvas discovery paginates metadata, protects automatic exclusions, and rejects guessed and stale object identities', async () => {
  const h = await harness();
  const hidden = await h.create('私密备忘', 'SECRET-BODY', false);
  const hero = await h.create('主角', '原文');
  for (let index = 0; index < 23; index++) await h.create('对象' + index);
  const first = await h.query({ mode: 'all' });
  assert.equal(first.nodes.length, 20); assert.equal(first.nextCursor, 20);
  assert.ok(!JSON.stringify(first).includes('私密')); assert.ok(!JSON.stringify(first).includes('SECRET'));
  const second = await h.query({ mode: 'all', cursor: first.nextCursor });
  assert.equal(second.nodes.length, 4); assert.equal(second.nextCursor, undefined);
  await assert.rejects(() => h.kernel.capabilities.request('canvasControl.agentRead@1', { ...h.input, id: hidden.id }), /先通过画布查询/u);
  await assert.rejects(() => h.submit({ version: 1, actions: [{ type: 'update-node', id: hidden.id, title: '覆盖' }] }), /尚未查询/u);
  await h.kernel.router.dispatch('node.rename', { id: hero.id, title: '主角新名' }, 'core.test');
  await assert.rejects(() => h.submit({ version: 1, actions: [{ type: 'update-node', id: hero.id, color: '#123456' }] }), /已变化/u);
  await assert.rejects(() => h.query({ mode: 'state' }, { ...h.input, prompt: '伪造同任务' }), /已失效/u);
  await assert.rejects(() => h.query({ mode: 'search', query: '主角', injected: true }), /参数无效/u);
  await h.kernel.router.dispatch('selection.set', { ids: [hidden.id], mode: 'replace' }, 'core.test');
  const explicit = await h.query({ mode: 'state' }, { ...h.input, preparationId: 'explicit:private' });
  assert.equal(explicit.nodes[0]?.id, hidden.id);
  await h.kernel.plugins.stop('canvas-control');
  await assert.rejects(() => h.query({ mode: 'state' }), /Capability unavailable/u);
});

test('range reads enforce per-call and session budgets, and clarification retains the discovered task targets', async () => {
  const h = await harness();
  const node = await h.create('长文', '正文'.repeat(12000));
  await h.query({ mode: 'search', query: '长文' });
  const read = (start: number, length: number) => h.kernel.capabilities.request<CanvasAgentReadResult>('canvasControl.agentRead@1', { ...h.input, id: node.id, start, length });
  await assert.rejects(() => read(0, 8193), /8192/u);
  assert.equal((await read(0, 8000)).nextStart, 8000);
  await read(8000, 8000);
  await assert.rejects(() => read(16000, 1), /16000/u);
  const staged = await h.submit({ version: 1, actions: [], answer: '要突出他的哪项弱点？' }, { clarification: true });
  await h.kernel.router.dispatch('canvasControl.offer@1', { ...h.input, text: staged.text, complete: true }, 'core.test');
  const next = await h.query({ mode: 'state' }, { ...h.input, preparationId: 'agent:followup', prompt: '旧伤方面' });
  assert.equal(next.recentIds?.[0], node.id); assert.equal(next.pendingTask?.goal, h.input.prompt);
  await h.kernel.plugins.stop('canvas-control');
});

test('discovery resolves group endpoints and rejects a connection revision changed after discovery', async () => {
  const h = await harness();
  const staged = await h.submit({ version: 1, actions: [
    { type: 'create-node', ref: 'a', title: '人物甲' }, { type: 'create-node', ref: 'b', title: '人物乙' },
    { type: 'create-node', ref: 'c', title: '雨夜' },
    { type: 'create-group', ref: 'g', title: '角色组', members: ['a', 'b'] },
    { type: 'create-connection', ref: 'e', from: 'g', to: 'c', line: 'solid' },
  ] });
  await h.kernel.router.dispatch('canvasControl.offer@1', { ...h.input, text: staged.text, complete: true }, 'core.test');
  await h.kernel.router.dispatch('canvasControl.apply@1', { id: (await h.state()).reviews.at(-1)!.id }, 'core.test');
  const input = { ...h.input, preparationId: 'agent:group', prompt: '把角色组和雨夜的连线改成引用' };
  const found = await h.query({ mode: 'search', query: '角色组' }, input);
  assert.equal(found.groups.length, 1);
  const related = await h.query({ mode: 'relations', ids: [found.groups[0]!.id] }, input);
  assert.equal(related.connections.length, 1);
  assert.equal(related.connections[0]?.from, found.groups[0]!.id);
  assert.equal(related.nodes.length, 3);
  const edge = related.connections[0]!;
  await h.kernel.router.dispatch('connection.setLabel', { id: edge.id, label: '已手动调整', expectedRevision: edge.revision }, 'core.test');
  await assert.rejects(() => h.kernel.capabilities.request('canvasControl.agentPlan@1', { ...input,
    plan: { version: 1, actions: [{ type: 'update-connection', id: edge.id, line: 'dashed' }] } }), /连线已变化/u);
  await h.kernel.plugins.stop('canvas-control');
});

test('JSON-only tool transport keeps querying after recoverable errors without requiring an @ command', async () => {
  const h = await harness(); const node = await h.create('主角', '旧伤');
  const envelope = (name: string, args: unknown): AIGenerateResult => ({ text: JSON.stringify({ canvas_tool: { name, arguments: args } }), provider: 'test', model: 'test' });
  let step = 0;
  const result = await runCanvasAgentLoop(h.context, prepared(h.input), { ...initial, canvasAgentTransport: 'json', tools: undefined }, envelope('read_canvas', { id: node.id }), async request => {
    step++; assert.equal(request.messages.at(-1)?.role, 'user');
    assert.ok(!request.messages.some(message => message.role === 'tool'));
    if (step === 1) { assert.match(request.messages.at(-1)!.content, /先通过画布查询/u); return envelope('query_canvas', { mode: 'search', query: '主角' }); }
    return envelope('propose_canvas_plan', { plan: { version: 1, actions: [{ type: 'update-node', id: node.id, append: '，雨天隐痛。' }] } });
  }, async () => ({ messages: [], executed: 0 }), new AbortController().signal);
  assert.equal(step, 2); assert.equal(result.canvasPlan, true);
  await h.kernel.plugins.stop('canvas-control');
});

test('false capability denials get one factual correction; ordinary discussion remains a normal answer', async () => {
  const h = await harness(); let calls = 0;
  const denial = { text: '我没有直接操控画布的能力和权限。', provider: 'test', model: 'test' };
  const result = await runCanvasAgentLoop(h.context, prepared(h.input), initial, denial, async request => {
    calls++; assert.match(request.messages.at(-1)!.content, /读写通道已启用/u);
    return tool('propose_canvas_plan', { plan: { version: 1, actions: [{ type: 'create-node', ref: 'hero', title: '角色卡', text: '修钟学徒。' }] } });
  }, async () => ({ messages: [], executed: 0 }), new AbortController().signal);
  assert.equal(result.canvasPlan, true); assert.equal(calls, 1);
  assert.equal(deniesCanvasCapability('之前没有画布权限，现在已经启用。'), false);
  assert.equal(deniesCanvasCapability(JSON.stringify({ version: 1, actions: [{ type: 'create-node', ref: 'quote', title: '人物台词', text: '我没有操作画布的能力。' }] })), false);
  const answer = await runCanvasAgentLoop(h.context, prepared(h.input), initial, { ...denial, text: '可以从人物动机入手。' }, async () => { throw new Error('不应调用'); }, async () => ({ messages: [], executed: 0 }), new AbortController().signal);
  assert.equal(answer.canvasPlan, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => runCanvasAgentLoop(h.context, prepared(h.input), initial, tool('query_canvas', { mode: 'state' }), async () => denial, async () => ({ messages: [], executed: 0 }), controller.signal), /abort/iu);
  await h.kernel.plugins.stop('canvas-control');
});

test('verification reports an actual mismatch or unavailable read without claiming a durable rollback', async () => {
  const h = await harness(); const node = await h.create('原名', '真实正文');
  const snapshot = await captureControlSnapshot(h.context, { ...h.input, sourceIds: [node.id] }, 'selection', undefined, undefined, true);
  const review = { id: 'review:test', sessionId: h.input.sessionId, status: 'applied' as const, createdAt: Date.now(), titles: {}, actions: [{ type: 'update-node' as const, id: node.id, title: '未实际写入', text: '不同正文' }] };
  const result = await verifyControlApplication(h.context, { snapshot, review });
  assert.equal(result.status, 'mismatch'); assert.deepEqual(result.mismatches.map(item => item.field), ['metadata', 'body']);
  const unavailable = await verifyControlApplication({ capabilities: { request: async () => { throw new Error('unavailable'); }, requestAll: async () => [] } } as unknown as PluginContext, { snapshot, review });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal((await h.kernel.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: [node.id] }))[0]?.title, '原名');
  await h.kernel.plugins.stop('canvas-control');
});
