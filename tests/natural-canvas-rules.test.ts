import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import { inferAtOperation } from '../src/plugins/ai-assistant/command-parser.ts';
import { naturalWritebackIntent, writebackTaskInstructions } from '../src/plugins/ai-assistant/natural-writeback.ts';
import { naturalCanvasOperation } from '../src/services/ai-task-route.ts';
import { naturalNames, naturalTargetFilter } from '../src/services/natural-canvas-rules.ts';
import type { CanvasControlState } from '../src/protocols/canvas-control.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import { isTitleConnection } from '../src/protocols/connections.ts';
import { parseTranscriptMessages } from '../src/plugins/ai-assistant/transcript-presentation.ts';

test('natural operation catalog covers every content task without treating quoted actions as instructions', () => {
  const cases = [
    ['润色主角', 'polish'], ['把主角里写旧伤的那段扩写到300字', 'expand'], ['再短一点', 'shorten'],
    ['把旧伤那段改写一下', 'rewrite'], ['翻译主角', 'translate'], ['总结第一章线索组', 'summarize'],
    ['列出出现的人和地点', 'extract'], ['把线索按人物归类', 'classify'], ['对比新旧主角设定', 'compare'],
    ['检查时间线', 'verify'], ['分析主角动机', 'analyze'], ['安排第二章的写作步骤', 'plan'],
    ['把调查拆成三件事', 'decompose'], ['评估两个结局', 'evaluate'], ['如果记者先拿到地图会怎样', 'simulate'],
    ['哪个结局更适合开篇', 'decide'], ['给我三个走向', 'brainstorm'], ['给组织起五个名字', 'name'],
    ['列第二章大纲', 'outline'], ['细化到每一场', 'detailed-outline'], ['写成三分钟短片脚本', 'script'], ['写一段作品简介', 'copywriting'],
  ];
  for (const [prompt, expected] of cases) assert.equal(inferAtOperation(prompt!), expected, prompt);
  assert.equal(inferAtOperation('@总结 润色主角'), 'summarize');
  assert.equal(inferAtOperation('先别润色主角'), 'general');
  assert.equal(inferAtOperation('找到『删除地图』'), 'canvas-control');
  assert.deepEqual(naturalNames('『调查和取证』和武器'), ['调查和取证', '武器']);
  assert.equal(naturalCanvasOperation('把主角改名为旧版？'), undefined);
  assert.equal(naturalCanvasOperation('不要删除主角'), undefined);
  assert.deepEqual(naturalWritebackIntent('把主角里写旧伤的那段润色一下'), { kind: 'description', name: '主角', phrase: '旧伤' });
});

test('target filters combine group, conjunction, presentation and exclusions', () => {
  const filter = naturalTargetFilter('人物组里除了主角以外，空白且没连线的卡片');
  assert.equal(filter?.group, '人物组');
  assert.equal(filter?.empty, true);
  assert.equal(filter?.disconnected, true);
  assert.equal(filter?.presentation, 'card');
  assert.deepEqual(filter?.exclude, ['主角']);
  assert.deepEqual(naturalTargetFilter('人物组里空白且没连线的节点，主角除外')?.exclude, ['主角']);
  assert.equal(naturalTargetFilter('人物组里标题含『旧版』的节点')?.titleContains, '旧版');
  assert.equal(naturalTargetFilter('人物组里不明条件的节点'), undefined);
});

test('verbatim writing constraints survive twelve follow-ups without duplicating them or summarizing originals', () => {
  const original = '把主角里写旧伤的那段润色一下，保留我的口吻，不要修改人物年龄。';
  let instructions = writebackTaskInstructions(original);
  for (let index = 0; index < 12; index += 1) instructions = writebackTaskInstructions('再短一点，保留我的口吻。', instructions);
  assert.deepEqual(instructions, [original, '再短一点，保留我的口吻。']);
  assert.deepEqual(naturalWritebackIntent('再短一点，保留我的口吻。'), { kind: 'followup' });
  const legacyDetails = new Map([[1, { retrieval: { mode: 'local', attempted: 'invalid', matched: [], warnings: [] } }]]);
  const messages = parseTranscriptMessages('[助手]\n旧版回复', 1, legacyDetails as never);
  assert.equal(messages[0]?.retrieval, undefined);
});

test('expanded local operations use owner plans, preserve links and reject stale batches', async () => {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createConnectionsPlugin(), createGroupsPlugin(), createCanvasControlPlugin()]);
  await kernel.start();
  let sequence = 0;
  let lastPrompt = '';
  let lastReply: unknown;
  const create = (title: string, x: number, body?: string) => kernel.router.dispatch<{ id: string }>('node.create', { title, x, y: x, body }, 'core.test');
  const hero = await create('主角', 200), weapon = await create('武器', 600), map = await create('旧地图', 900);
  const state = () => kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test');
  const run = async (prompt: string) => {
    lastPrompt = prompt;
    const input = { preparationId: `expanded:${++sequence}`, sessionId: 'expanded', prompt };
    const local = await kernel.capabilities.request<{ handled: boolean; text: string }>('canvasControl.localPlan@1', input);
    assert.equal(local.handled, true, prompt);
    lastReply = await kernel.router.dispatch('canvasControl.offer@1', { ...input, text: local.text, complete: true }, 'core.test');
    return lastReply;
  };
  const apply = async () => {
    const review = (await state()).reviews.at(-1)!;
    assert.equal(review?.status, 'pending', `${lastPrompt} ${JSON.stringify(lastReply)}`);
    return kernel.router.dispatch('canvasControl.apply@1', { id: review.id }, 'core.test');
  };
  const nodes = () => kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  await run('把主角、武器和旧地图编成一组，叫人物组'); await apply();
  await run('把人物组改成浅蓝');
  assert.equal((await state()).reviews.at(-1)?.actions[0]?.type, 'update-group');
  await apply();
  const group = (await kernel.capabilities.request<import('../src/protocols/groups.ts').GroupRecord[]>('groups.list@1'))[0]!;
  assert.equal(group.color, '#add8e6');
  await run('找出人物组里空白且没连线的节点，主角除外');
  assert.deepEqual((await state()).navigation?.items.map(item => item.id).sort(), [weapon.id, map.id].sort());
  await run('把它们切成文本框，标题栏改成深蓝'); await apply();
  assert.deepEqual((await nodes()).filter(node => [weapon.id, map.id].includes(node.id)).map(node => [node.presentation, node.titleColor]), [['text-box', '#244b85'], ['text-box', '#244b85']]);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.ok((await nodes()).every(node => node.presentation === 'card'));
  await run('主角分别指向武器和旧地图，用虚线'); await apply();
  assert.equal((await graph()).connections.length, 2);
  await run('谁指向武器？'); assert.equal((await state()).navigation?.items.length, 1);
  await run('把刚才那条线的标签改成『证据』'); await apply();
  assert.equal((await graph()).connections.find(edge => edge.to.nodeId === weapon.id)?.label, '证据');
  const lineId = (await graph()).connections.find(edge => edge.to.nodeId === weapon.id)!.id;
  await run('把刚才那条箭头反过来'); await apply();
  assert.equal((await graph()).connections.find(edge => edge.id === lineId)?.from.nodeId, weapon.id);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  await run('断开主角指向武器的线'); await apply();
  assert.equal((await graph()).connections.length, 1);
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.equal((await graph()).connections.length, 2);
  await run('把武器改名为旧枪'); await apply();
  assert.equal((await nodes()).find(node => node.id === weapon.id)?.title, '旧枪');
  await run('在主角右边新建一张叫线索的卡片'); await apply();
  const note = (await nodes()).find(node => node.title === '线索')!;
  assert.ok(note.x > (await nodes()).find(node => node.id === hero.id)!.x);
  await run('在主角右边新建一张叫灯塔的卡片，再从主角拉条虚线到灯塔');
  assert.deepEqual((await state()).reviews.at(-1)?.actions.map(action => action.type), ['create-node', 'create-connection']);
  await apply();
  const lighthouse = (await nodes()).find(node => node.title === '灯塔')!;
  const lighthouseLink = (await graph()).connections.find(edge => edge.to.nodeId === lighthouse.id);
  assert.ok(lighthouseLink && isTitleConnection(lighthouseLink));
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  assert.ok(!(await nodes()).some(node => node.id === lighthouse.id));
  assert.ok(!(await graph()).connections.some(edge => edge.to.nodeId === lighthouse.id));
  await run('把主角改成深蓝');
  const colorReview = (await state()).reviews.at(-1)!;
  await run('再浅一点');
  assert.equal((await state()).reviews.at(-1)?.id, colorReview.id);
  assert.equal((await state()).reviews.at(-1)?.actions[0]?.type === 'update-node' &&
    ((await state()).reviews.at(-1)!.actions[0] as { color?: string }).color, '#506f9d');
  await apply();
  const replaceTargets = [await create('替换甲', 1100, '青石、青石、青石'), await create('替换乙', 1400, '青石、青石、青石')];
  await run('把替换甲和替换乙正文的「青石」换成「白石」，第2处');
  assert.equal((await state()).reviews.at(-1)?.replacement?.count, 2);
  await apply();
  const read = (sourceId: string) => kernel.capabilities.requestAll<import('../src/protocols/ai.ts').AIContextReadContribution>('context.read@1', { sourceId, start: 0, length: 80 });
  for (const item of replaceTargets) assert.equal((await read(item.id))[0]?.text, '青石、白石、青石');
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  for (const item of replaceTargets) assert.equal((await read(item.id))[0]?.text, '青石、青石、青石');
  await run('把主角和旧枪左对齐');
  await kernel.router.dispatch('node.rename', { id: weapon.id, title: '并发改名' }, 'core.test');
  await assert.rejects(apply, /已经变化/u);
  assert.equal((await nodes()).find(node => node.id === weapon.id)?.x, 600);
  await kernel.plugins.stop('canvas-control');
});
