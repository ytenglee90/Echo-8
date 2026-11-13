import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import type { CanvasControlAction, CanvasControlAdmission, CanvasControlState, CanvasControlGroupPlan, CanvasControlTaskState, CanvasControlContextV2 } from '../src/protocols/canvas-control.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { GroupRecord } from '../src/protocols/groups.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import { parseCanvasControlPlan } from '../src/services/canvas-control-validation.ts';
import { serializeProject, parseProject } from '../src/plugins/import-export/codec.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import { createAIProviderPlugin } from '../src/plugins/ai-provider/model.ts';
import { buildProviderRequest } from '../src/plugins/ai-provider/provider-transport.ts';

async function harness(execution: 'direct' | 'review' = 'review') {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createConnectionsPlugin(), createGroupsPlugin(), createCanvasControlPlugin()]);
  await kernel.start();
  assert.equal(kernel.plugins.isActive('canvas-control'), true);
  if (execution === 'review') await kernel.router.dispatch('canvasControl.execution@1', { execution }, 'core.test');
  return kernel;
}
let sequence = 0;

test('natural commands locate two distant nodes among 2000 and preserve connection identity through follow-ups and disambiguation', async () => {
  const kernel = await harness('direct');
  const create = (title: string, x: number, body = '') => kernel.router.dispatch<{ id: string }>('node.create', { title, x, y: 5_000, body }, 'core.test');
  const hero = await create('主角', 20_000, '年龄：29。\n\n左腕有一道旧伤。');
  const weapon = await create('武器', 21_000);
  for (let index = 0; index < 1_998; index += 1) await create(`其他节点 ${index}`, index * 4);
  const command = async (prompt: string) => {
    const input = { preparationId: `natural:${++sequence}`, sessionId: 'natural-test', prompt };
    const local = await kernel.capabilities.request<{ handled: boolean; text: string }>('canvasControl.localPlan@1', input);
    assert.equal(local.handled, true, prompt);
    const result = await kernel.router.dispatch<{ message: string; directPlanId?: string }>('canvasControl.offer@1', { ...input, text: local.text, complete: true }, 'core.test');
    assert.equal(result.directPlanId, undefined);
    return result;
  };
  const state = () => kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test');
  const apply = async () => kernel.router.dispatch('canvasControl.apply@1', { id: (await state()).reviews.at(-1)!.id }, 'core.test');
  const edges = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  await command('把主角连到武器，用虚线');
  assert.equal((await edges()).connections.length, 0);
  await apply();
  const edge = (await edges()).connections[0]!;
  assert.equal(edge.from.nodeId, hero.id); assert.equal(edge.to.nodeId, weapon.id); assert.equal(edge.titleRoute, true);
  await command('改成实线'); await apply();
  assert.deepEqual((await edges()).connections.map(item => [item.id, item.titleRoute]), [[edge.id, false]]);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await edges()).connections[0]?.titleRoute, true);
  const otherHero = await create('主角', 22_000);
  await command('把主角连到武器，用虚线');
  assert.equal((await state()).navigation?.choice, true);
  assert.ok((await state()).navigation?.items.some(item => item.id === otherHero.id));
  await kernel.router.dispatch('canvasControl.navigate@1', { id: otherHero.id }, 'core.test');
  assert.equal((await state()).navigation, undefined);
  await apply();
  assert.ok((await edges()).connections.some(item => item.from.nodeId === otherHero.id && item.to.nodeId === weapon.id));
  await command('把主角的年龄从 29 改成 31');
  await kernel.router.dispatch('canvasControl.navigate@1', { id: hero.id }, 'core.test');
  await apply();
  const read = await kernel.capabilities.requestAll<{ text?: string }>('context.read@1', { sourceId: hero.id, start: 0, length: 100 });
  assert.equal(read.find(item => item.text)?.text, '年龄：31。\n\n左腕有一道旧伤。');
  await kernel.plugins.stop('canvas-control');
});

test('a relationship follow-up resolves the actual neighboring node and only changes the line after review', async () => {
  const kernel = await harness('direct');
  const initial = await offer(kernel, [
    { type: 'create-node', ref: 'hero', title: '主角', text: '主角正文' },
    { type: 'create-node', ref: 'weapon', title: '武器' },
    { type: 'create-connection', ref: 'relation', from: 'hero', to: 'weapon', line: 'solid' },
  ]);
  await kernel.router.dispatch('canvasControl.generate@1', { id: initial }, 'core.test');
  const hero = (await nodes(kernel)).find(node => node.title === '主角')!;
  const weapon = (await nodes(kernel)).find(node => node.title === '武器')!;
  const readEdge = async () => (await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0]!;
  const edge = await readEdge();
  await kernel.router.dispatch('selection.set', { ids: [weapon.id], mode: 'replace' }, 'core.test');
  const admission = { preparationId: 'line-followup', sessionId: 'session:test', prompt: '@画布操作 插入是用虚线' };
  const discovered = await kernel.capabilities.request<CanvasControlContextV2>('canvasControl.context@2', { ...admission, purpose: 'structure' });
  assert.match(discovered.objectDirectory, /主角/u);
  assert.match(discovered.objectDirectory, /"line":"solid"/u);
  assert.doesNotMatch(discovered.objectDirectory, /主角正文/u);
  const illegal = JSON.stringify({ version: 1, actions: [{ type: 'update-connection', id: edge.id, line: 'dashed', label: '越出线型范围' }] });
  await assert.rejects(() => kernel.router.dispatch('canvasControl.offer@1', { ...admission, text: illegal, complete: true }, 'core.test'), /范围外/u);
  const local = await kernel.capabilities.request<{ handled: boolean; text: string }>('canvasControl.localPlan@1', admission);
  assert.equal(local.handled, true);
  assert.deepEqual(JSON.parse(local.text).actions, [{ type: 'update-connection', id: edge.id, line: 'dashed' }]);
  const queued = await kernel.router.dispatch<{ directPlanId?: string }>('canvasControl.offer@1', { ...admission, text: local.text, complete: true }, 'core.test');
  assert.equal(queued.directPlanId, undefined);
  assert.equal((await readEdge()).titleRoute, false);
  const pending = (await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)!;
  await kernel.router.dispatch('canvasControl.apply@1', { id: pending.id }, 'core.test');
  assert.equal((await readEdge()).titleRoute, true);
  assert.equal((await readEdge()).id, edge.id);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await readEdge()).titleRoute, false);
  const named = await kernel.capabilities.request<CanvasControlContextV2>('canvasControl.context@2', { ...admission, preparationId: 'named-hero', prompt: '@画布操作 补充主角正文', purpose: 'content' });
  assert.match(named.objectDirectory, /"title":"主角","writable":false,"namedForReview":true/u);
  await assert.rejects(() => kernel.router.dispatch('canvasControl.offer@1', { ...admission, preparationId: 'named-hero', prompt: '@画布操作 补充主角正文', complete: true, text: JSON.stringify({ version: 1, actions: [{ type: 'delete', ids: [hero.id] }] }) }, 'core.test'), /范围外/u);
  await kernel.plugins.stop('canvas-control');
});

test('local recolor/move plans use the reviewed transaction path and task state follows apply undo redo and discard', async () => {
  const kernel = await harness();
  try {
    const id = await kernel.router.dispatch<{ id: string }>('node.create', { title: '本地操作', body: '不应发送的正文', x: 100, y: 80 }, 'core.test');
    await kernel.router.dispatch('selection.set', { ids: [id.id], mode: 'replace' }, 'core.test');
    const admission = { preparationId: 'local:1', sessionId: 'task:test', prompt: '@画布操作 把选中节点设为 #336699' };
    const result = await kernel.capabilities.request<{ handled: boolean; text?: string }>('canvasControl.localPlan@1', admission);
    assert.equal(result.handled, true); assert.doesNotMatch(result.text!, /不应发送的正文|"x"|"y"/u);
    await kernel.router.dispatch('canvasControl.offer@1', { ...admission, text: result.text!, complete: true }, 'core.test');
    const read = () => kernel.capabilities.request<CanvasControlTaskState>('canvasControl.taskState@1', { sessionId: 'task:test' });
    assert.equal((await read()).plans[0]?.status, 'pending');
    const planId = (await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)!.id;
    await kernel.router.dispatch('canvasControl.apply@1', { id: planId }, 'core.test');
    assert.equal((await read()).plans[0]?.status, 'applied');
    await kernel.router.dispatch('history.undo', undefined, 'core.test'); assert.equal((await read()).plans[0]?.status, 'undone');
    await kernel.router.dispatch('history.redo', undefined, 'core.test'); assert.equal((await read()).plans[0]?.status, 'applied');
    const next = { ...admission, preparationId: 'local:2', prompt: '把选中节点向右移动 100' };
    const move = await kernel.capabilities.request<{ handled: boolean; text?: string }>('canvasControl.localPlan@1', next);
    await kernel.router.dispatch('canvasControl.offer@1', { ...next, text: move.text!, complete: true }, 'core.test');
    const pending = (await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)!;
    await kernel.router.dispatch('canvasControl.dismiss@1', { id: pending.id }, 'core.test');
    assert.equal((await read()).plans.at(-1)?.status, 'dismissed');
  } finally { await kernel.plugins.stop('canvas-control'); }
});

test('context v2 sends only operation-specific fields while v1 remains available and bounded', async () => {
  const kernel = await harness();
  try {
    const created = await kernel.router.dispatch<{ id: string }>('node.create', { title: '目标', body: '完整正文不应出现在目录' }, 'core.test');
    await kernel.router.dispatch('selection.set', { ids: [created.id], mode: 'replace' }, 'core.test');
    const result = await kernel.capabilities.request<CanvasControlContextV2>('canvasControl.context@2', { preparationId: 'fields:1', sessionId: 's', prompt: '改色', purpose: 'appearance' });
    assert.ok(result.responseSchema); assert.match(result.objectDirectory, /"id"|"color"/u);
    assert.doesNotMatch(result.objectDirectory, /"x"|"y"|textLength|完整正文/u);
    assert.doesNotMatch(result.instruction, /text 替换全文|create-group:/u);
  } finally { await kernel.plugins.stop('canvas-control'); }
});

test('v2 local edits change only the stated range, round-trip and undo; v1 refuses the new field and stale revisions fail atomically', async () => {
  const kernel = await harness();
  try {
    const created = await kernel.router.dispatch<{ id: string }>('node.create', { title: '局部修改', body: '前文🙂。目标段。后文。' }, 'core.test');
    await kernel.router.dispatch('selection.set', { ids: [created.id], mode: 'replace' }, 'core.test');
    const summary = (await nodes(kernel)).find(node => node.id === created.id)!;
    const action = { type: 'update-node' as const, id: created.id, edit: { start: 5, deleteCount: 4, insert: '新段。', expectedRevision: summary.revision } };
    assert.throws(() => parseCanvasControlPlan(JSON.stringify({ version: 1, actions: [action] })), /字段/u);
    const admission = { preparationId: 'edit:1', sessionId: 'edit:test', prompt: '修改指定范围' };
    await kernel.capabilities.request('canvasControl.context@2', admission);
    await kernel.router.dispatch('canvasControl.offer@1', { ...admission, text: JSON.stringify({ version: 2, actions: [action] }), complete: true }, 'core.test');
    const review = (await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)!;
    await kernel.router.dispatch('canvasControl.apply@1', { id: review.id }, 'core.test');
    const body = async () => {
      const values = await kernel.capabilities.requestAll<{ handled: boolean; text?: string }>('context.read@1', { sourceId: created.id, start: 0, length: 100 });
      return values.find(value => value.handled)?.text;
    };
    assert.equal(await body(), '前文🙂。新段。后文。');
    await kernel.router.dispatch('history.undo', undefined, 'core.test'); assert.equal(await body(), '前文🙂。目标段。后文。');
    await kernel.router.dispatch('history.redo', undefined, 'core.test'); assert.equal(await body(), '前文🙂。新段。后文。');
    const next = { ...admission, preparationId: 'edit:2' };
    await kernel.capabilities.request('canvasControl.context@2', next);
    await kernel.router.dispatch('canvasControl.offer@1', { ...next, text: JSON.stringify({ version: 2, actions: [action] }), complete: true }, 'core.test');
    const stale = (await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)!;
    await assert.rejects(() => kernel.router.dispatch('canvasControl.apply@1', { id: stale.id }, 'core.test'), /修订/u);
    assert.equal(await body(), '前文🙂。新段。后文。');
  } finally { await kernel.plugins.stop('canvas-control'); }
});

test('direct generation defaults on, commits new objects once and never directly edits existing content', async () => {
  const kernel = await harness('direct');
  const before = (await nodes(kernel)).length;
  assert.equal((await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).execution, 'direct');
  const id = await offer(kernel, creations);
  assert.equal((await nodes(kernel)).length, before);
  await kernel.router.dispatch('canvasControl.generate@1', { id }, 'core.test');
  assert.equal((await nodes(kernel)).length, before + 3);
  await assert.rejects(() => kernel.router.dispatch('canvasControl.generate@1', { id }, 'core.test'), /已处理/u);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await nodes(kernel)).length, before);
  await kernel.router.dispatch('history.redo', undefined, 'core.test');
  const hero = (await nodes(kernel)).find(node => node.title === '主角｜林渊')!;
  await kernel.router.dispatch('selection.set', { ids: [hero.id], mode: 'replace' }, 'core.test');
  const mixed = await offer(kernel, [{ type: 'create-node', ref: 'new', title: '仍需确认的新对象' }, { type: 'update-node', id: hero.id, text: '不能直接覆盖' }]);
  await kernel.router.dispatch('canvasControl.generate@1', { id: mixed }, 'core.test');
  assert.equal((await nodes(kernel)).some(node => node.title === '仍需确认的新对象'), false);
  assert.equal((await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.at(-1)?.status, 'pending');
});

test('switching to preview revokes pending direct generation and invalid creations remain atomic and reviewable', async () => {
  const kernel = await harness('direct');
  const before = (await nodes(kernel)).length;
  const id = await offer(kernel, [{ type: 'create-node', ref: 'new', title: '不应自动生成' }]);
  await kernel.router.dispatch('canvasControl.execution@1', { execution: 'review' }, 'core.test');
  await kernel.router.dispatch('canvasControl.generate@1', { id }, 'core.test');
  assert.equal((await nodes(kernel)).length, before);
  await kernel.router.dispatch('canvasControl.execution@1', { execution: 'direct' }, 'core.test');
  const invalid = await offer(kernel, [{ type: 'create-node', ref: 'bad', title: '尺寸错误', width: 20 }]);
  const result = await kernel.router.dispatch<{ message: string }>('canvasControl.generate@1', { id: invalid }, 'core.test');
  assert.match(result.message, /未成功/u);
  assert.equal((await nodes(kernel)).length, before);
  const state = await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test');
  assert.equal(state.open, true); assert.equal(state.reviews.at(-1)?.status, 'pending'); assert.match(state.reviews.at(-1)?.error ?? '', /尺寸/u);
});

test('offline opaque origins can configure and request an absolute AI endpoint', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'null', href: 'file:///C:/Echo-8.html' } });
  try {
    const kernel = new ApplicationKernel([createAIProviderPlugin()]);
    await kernel.start();
    const result = await kernel.router.dispatch<{ id: string }>('aiProvider.profile.save', {
      label: '离线连接', platform: '测试平台', endpoint: 'https://canvas-control.test/v1/chat/completions', model: 'test-model', authentication: 'none', apiStyle: 'openai',
    }, 'core.test');
    assert.ok(result.id);
    const request = buildProviderRequest({ id: result.id, label: '离线连接', platform: '测试平台',
      endpoint: 'https://canvas-control.test/v1/chat/completions', model: 'test-model', authentication: 'none', apiStyle: 'openai' },
    '', { messages: [{ role: 'user', content: '测试' }], temperature: 0.7, maxOutputTokens: 1024 }, true);
    assert.equal(request.endpoint, 'https://canvas-control.test/v1/chat/completions');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
async function offer(kernel: ApplicationKernel, actions: CanvasControlAction[], beforeOffer?: () => Promise<void>): Promise<string> {
  const admission: CanvasControlAdmission = { preparationId: `request:${++sequence}`, sessionId: 'session:test', prompt: '@画布操作 按要求处理' };
  const snapshot = await kernel.capabilities.request<{ instruction: string }>('canvasControl.context@1', admission);
  assert.match(snapshot.instruction, /untrusted-canvas-objects/u);
  await beforeOffer?.();
  await kernel.router.dispatch('canvasControl.offer@1', { ...admission, complete: true, text: JSON.stringify({ version: 1, actions }) }, 'core.test');
  const state = await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test');
  return state.reviews.at(-1)!.id;
}
const creations: CanvasControlAction[] = [
  { type: 'create-node', ref: 'hero', title: '主角｜林渊', text: '修钟学徒\n\n<b>字面文字</b>🧭', color: '#a83d44', width: 340 },
  { type: 'create-node', ref: 'chapter', title: '正文｜第001章', text: '旧钟响了。', color: '#454851' },
  { type: 'create-node', ref: 'header', title: '人物设定', presentation: 'text-box', color: '#a83d44' },
  { type: 'create-group', ref: 'people', title: '人物组', members: ['hero', 'header'] },
  { type: 'create-connection', ref: 'quote', from: 'hero', to: 'chapter', line: 'dashed', label: '引用' },
  { type: 'create-connection', ref: 'outline', from: 'people', to: 'chapter', line: 'solid', label: '展开' },
];
const nodes = (kernel: ApplicationKernel) => kernel.capabilities.request<ContentSummary[]>('content.summaries@1');

test('control does not prevent optional owners from stopping and can still create text objects', async () => {
  const kernel = await harness();
  await kernel.plugins.stop('groups');
  await kernel.plugins.stop('connections');
  assert.equal(kernel.plugins.isActive('canvas-control'), true);
  const id = await offer(kernel, [{ type: 'create-node', ref: 'plain', title: '独立文字能力' }]);
  await kernel.router.dispatch('canvasControl.apply@1', { id }, 'core.test');
  assert.equal((await nodes(kernel)).some(node => node.title === '独立文字能力'), true);
  await assert.rejects(() => offer(kernel, [{ type: 'create-group', ref: 'disabled', title: '不能创建', members: ['a', 'b'] }]), /启用群组/u);
  await kernel.plugins.start('groups');
  await kernel.plugins.start('connections');
  const next = await offer(kernel, creations);
  await kernel.router.dispatch('canvasControl.apply@1', { id: next }, 'core.test');
});

test('control directory stays scoped, accepts explicit references and supports read-only replies', async () => {
  const kernel = await harness();
  const target = (await nodes(kernel))[0];
  const base: CanvasControlAdmission = { preparationId: 'readonly:1', sessionId: 'query:1', prompt: '@画布操作 查看对象' };
  const empty = await kernel.capabilities.request<{ instruction: string }>('canvasControl.context@1', base);
  assert.equal(empty.instruction.includes(target.title), false);
  const answer = await kernel.router.dispatch<{ message: string }>('canvasControl.offer@1', { ...base, complete: true, text: JSON.stringify({ version: 1, actions: [], answer: '先选择要查看的节点' }) }, 'core.test');
  assert.equal(answer.message, '先选择要查看的节点');
  assert.equal((await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews.length, 0);
  const reference = { ...base, preparationId: 'explicit:1', sourceIds: [target.id] };
  const directory = await kernel.capabilities.request<{ instruction: string }>('canvasControl.context@1', reference);
  assert.equal(directory.instruction.includes(target.title), true);
  await assert.rejects(() => kernel.router.dispatch('canvasControl.offer@1', { ...reference, sessionId: 'other', complete: true, text: '{"version":1,"actions":[]}' }, 'core.test'), /失效/u);
  await assert.rejects(() => kernel.router.dispatch('canvasControl.offer@1', { ...reference, complete: false, text: '{"version":1,"actions":[]}' }, 'core.test'), /截断/u);
});

test('expired control plans cannot create objects', async () => {
  const kernel = await harness();
  const before = (await nodes(kernel)).length;
  const id = await offer(kernel, [{ type: 'create-node', ref: 'expired', title: '过期不创建' }]);
  const clock = Date.now;
  try {
    const later = clock() + 11 * 60_000;
    Date.now = () => later;
    await assert.rejects(() => kernel.router.dispatch('canvasControl.apply@1', { id }, 'core.test'), /过期/u);
  } finally { Date.now = clock; }
  assert.equal((await nodes(kernel)).length, before);
});

test('failed persistence admission keeps a proposal retryable and concurrent accepts cannot duplicate it', async () => {
  const kernel = await harness();
  const before = (await nodes(kernel)).length;
  const id = await offer(kernel, [{ type: 'create-node', ref: 'retry-one', title: '可靠重试' }]);
  kernel.transactions.setPersistenceSink(() => { throw new Error('模拟持久化失败'); });
  await assert.rejects(() => kernel.router.dispatch('canvasControl.apply@1', { id }, 'core.test'), /持久化/u);
  assert.equal((await nodes(kernel)).length, before);
  assert.equal((await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test')).reviews[0].status, 'pending');
  kernel.transactions.setPersistenceSink(() => undefined);
  const attempts = await Promise.allSettled([
    kernel.router.dispatch('canvasControl.apply@1', { id }, 'core.test'),
    kernel.router.dispatch('canvasControl.apply@1', { id }, 'core.test'),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await nodes(kernel)).filter(node => node.title === '可靠重试').length, 1);
});

test('control schema rejects executable commands, extra fields, invalid refs and incomplete data', () => {
  assert.throws(() => parseCanvasControlPlan('{"version":1,"actions":['), /完整/u);
  assert.throws(() => parseCanvasControlPlan('{"version":1,"actions":[{"type":"eval","code":"alert(1)"}]}'), /未知/u);
  assert.throws(() => parseCanvasControlPlan('{"version":3,"actions":[]}'), /版本/u);
  assert.throws(() => parseCanvasControlPlan('{"version":1,"actions":[{"type":"create-node","ref":"a","title":"A","url":"secret"}]}'), /字段/u);
  assert.throws(() => parseCanvasControlPlan('{"version":1,"actions":[{"type":"update-node","id":"a","text":"x","append":"y"}]}'), /同时/u);
  assert.throws(() => parseCanvasControlPlan('{"version":1,"actions":[{"type":"create-node","ref":"__proto__","title":"A"}]}'), /代号/u);
  assert.deepEqual(parseCanvasControlPlan('```json\n{"version":1,"actions":[],"answer":"没有需要修改的对象"}\n```').actions, []);
});

test('a mixed plan stays inert until accepted and commits as one undoable native book change', async () => {
  const kernel = await harness();
  const before = await nodes(kernel);
  const id = await offer(kernel, creations);
  assert.equal((await nodes(kernel)).length, before.length);
  const applied = await kernel.router.dispatch<{ createdIds: string[] }>('canvasControl.apply@1', { id }, 'core.test');
  assert.equal(applied.createdIds.length, 6);
  const after = await nodes(kernel);
  assert.equal(after.length, before.length + 3);
  const hero = after.find(node => node.title === '主角｜林渊')!;
  assert.equal(hero.titleColor, '#a83d44');
  const body = await kernel.capabilities.request<{ text: string }>('content.read@1', { nodeId: hero.id });
  assert.equal(body.text, '修钟学徒\n\n<b>字面文字</b>🧭');
  assert.equal(after.find(node => node.title === '人物设定')?.presentation, 'text-box');
  const graph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  assert.equal(graph.connections.length, 2);
  assert.equal(graph.connections.filter(edge => edge.titleRoute).length, 1);
  await assert.rejects(() => kernel.router.dispatch('canvasControl.apply@1', { id }, 'core.test'), /已处理/u);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await nodes(kernel)).length, before.length);
  assert.equal((await kernel.capabilities.request<GroupRecord[]>('groups.list@1')).length, 0);
  await kernel.router.dispatch('history.redo', undefined, 'core.test');
  assert.equal((await nodes(kernel)).length, before.length + 3);
  const source = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  const reopened = await parseProject(await serializeProject(source));
  assert.equal(Object.keys(reopened.document.namespaces.connections).length, 2);
  assert.equal(JSON.stringify(reopened.document).includes('canvasControlUI'), false);
  await kernel.plugins.stop('canvas-control');
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await nodes(kernel)).length, before.length);
});

test('node metadata and body edits compose with group and connection updates without dropping content', async () => {
  const kernel = await harness();
  await kernel.router.dispatch('canvasControl.apply@1', { id: await offer(kernel, creations) }, 'core.test');
  const current = await nodes(kernel), hero = current.find(node => node.title === '主角｜林渊')!, chapter = current.find(node => node.title === '正文｜第001章')!;
  const group = (await kernel.capabilities.request<GroupRecord[]>('groups.list@1'))[0];
  const edge = (await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.find(item => item.label === '引用')!;
  const memberIds = [hero.id, chapter.id];
  const groupPreview = await kernel.capabilities.request<CanvasControlGroupPlan>('canvasControl.groupsPlan@1', {
    actions: [{ type: 'update-group', id: group.id, title: '人物组新版', color: '#7354a3', members: memberIds }],
    expected: [group], nodes: await nodes(kernel),
  });
  assert.deepEqual(groupPreview.events, [
    { type: 'group.members.changed', payload: { groupId: group.id, added: [chapter.id], removed: group.memberIds.filter(id => id !== hero.id) } },
    { type: 'group.appearance.changed', payload: { ids: [group.id] } },
  ]);
  await kernel.router.dispatch('selection.set', { ids: [group.id, chapter.id], mode: 'replace' }, 'core.test');
  const id = await offer(kernel, [
    { type: 'update-node', id: hero.id, title: '主角｜林渊新版', append: '\n新动机', x: 250, y: 310, color: '#3568a8', width: 400, height: 240 },
    { type: 'update-group', id: group.id, title: '人物组新版', color: '#7354a3', members: memberIds },
    { type: 'update-connection', id: edge.id, label: '推动剧情', color: '#a83d44', line: 'solid' },
  ]);
  await kernel.router.dispatch('canvasControl.apply@1', { id }, 'core.test');
  const updated = (await nodes(kernel)).find(node => node.id === hero.id)!;
  assert.equal(updated.title, '主角｜林渊新版'); assert.equal(updated.x, 250); assert.equal(updated.width, 400);
  assert.equal((await kernel.capabilities.request<{ text: string }>('content.read@1', { nodeId: hero.id })).text, '修钟学徒\n\n<b>字面文字</b>🧭\n新动机');
  assert.equal((await kernel.capabilities.request<GroupRecord[]>('groups.list@1'))[0].title, '人物组新版');
  assert.deepEqual((await kernel.capabilities.request<GroupRecord[]>('groups.list@1'))[0].memberIds, memberIds);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await nodes(kernel)).find(node => node.id === hero.id)?.title, '主角｜林渊');
  assert.equal((await kernel.capabilities.request<GroupRecord[]>('groups.list@1'))[0].title, '人物组');
});

test('out-of-scope and stale plans fail before changing any object', async () => {
  const kernel = await harness();
  const target = (await nodes(kernel))[0];
  await assert.rejects(() => offer(kernel, [{ type: 'update-node', id: target.id, text: '不应写入' }]), /范围外/u);
  await kernel.router.dispatch('selection.set', { ids: [target.id], mode: 'replace' }, 'core.test');
  const id = await offer(kernel, [
    { type: 'create-node', ref: 'new-one', title: '绝不部分创建' },
    { type: 'update-node', id: target.id, text: '旧计划' },
  ]);
  await kernel.router.dispatch('node.rename', { id: target.id, title: '用户已经修改' }, 'core.test');
  await assert.rejects(() => kernel.router.dispatch('canvasControl.apply@1', { id }, 'core.test'), /已经变化/u);
  assert.equal((await nodes(kernel)).some(node => node.title === '绝不部分创建'), false);
  assert.equal((await nodes(kernel)).find(node => node.id === target.id)?.title, '用户已经修改');
});

test('owner planning failure rolls back the whole batch and deletes clean references with undo', async () => {
  const kernel = await harness();
  const before = (await nodes(kernel)).length;
  const invalid = await offer(kernel, [
    { type: 'create-node', ref: 'bad-one', title: '不会留下', width: 20 },
    { type: 'create-node', ref: 'bad-two', title: '也不会留下' },
  ]);
  await assert.rejects(() => kernel.router.dispatch('canvasControl.apply@1', { id: invalid }, 'core.test'), /尺寸/u);
  assert.equal((await nodes(kernel)).length, before);
  await kernel.router.dispatch('canvasControl.apply@1', { id: await offer(kernel, creations) }, 'core.test');
  const hero = (await nodes(kernel)).find(node => node.title === '主角｜林渊')!;
  await kernel.router.dispatch('selection.set', { ids: [hero.id], mode: 'replace' }, 'core.test');
  await kernel.router.dispatch('canvasControl.apply@1', { id: await offer(kernel, [{ type: 'delete', ids: [hero.id] }]) }, 'core.test');
  assert.equal((await nodes(kernel)).some(node => node.id === hero.id), false);
  assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.some(edge => edge.from.nodeId === hero.id || edge.to.nodeId === hero.id), false);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await nodes(kernel)).some(node => node.id === hero.id), true);
});
