import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import type {
  AIContextReadRequest,
  AIContextSearchContribution,
  AIContextSource,
  AIMemoryIndexRecord,
  AIPreparedContext,
  AISessionRecord,
} from '../src/protocols/ai.ts';
import {
  deriveAIContextBudget,
  parseExplicitReferences,
  prepareAIContext,
} from '../src/plugins/ai-assistant/context-preparation.ts';
import { classifyAIContextIntent } from '../src/plugins/ai-assistant/context-intent.ts';
import { collectFullSourceSummary } from '../src/plugins/ai-assistant/full-source-summary.ts';
import { classifyAITurn, turnAssembly } from '../src/plugins/ai-assistant/turn-route.ts';
import { explicitAtOperation } from '../src/plugins/ai-assistant/command-parser.ts';
import { recoverCanvasRequest } from '../src/plugins/ai-assistant/canvas-recovery.ts';
import { interpretLocalTurn, LOCAL_LANGUAGE_TIMEOUT_MS, mayUseLocalLanguage } from '../src/plugins/ai-assistant/local-turn-routing.ts';
import { buildBoundCanvasWritePlan, resolveBoundCanvasWrite } from '../src/plugins/ai-assistant/bound-canvas-write.ts';
import { conversationDraftRequest, invalidateConversationDirectories, noteConversationAppend, readConversationDraft } from '../src/plugins/ai-assistant/conversation-recall.ts';
import { chunkImportedTranscript, internalTranscriptSourceId } from '../src/plugins/ai-assistant/transcript-storage.ts';

function session(): AISessionRecord {
  return {
    id: 'session:1',
    title: '当前对话',
    transcriptSourceId: 'node:transcript',
    revision: 1,
    turns: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function source(sourceId: string, title: string, text: string): AIContextSource {
  return { sourceId, provider: 'test', kind: 'text', title, revision: 1, length: text.length };
}

function preparationContext(
  texts: Record<string, { title: string; text: string }>,
  search: AIContextSearchContribution[] = [],
): PluginContext {
  const sources = Object.entries(texts).map(([sourceId, item]) => source(sourceId, item.title, item.text));
  return {
    capabilities: {
      request: async (key: string) => {
        if (key === 'canvasControl.taskState@1') return { version: 1, plans: [] };
        if (key === 'language.embed@1') return { ready: false, reason: 'unavailable' };
        throw new Error(`Capability unavailable: ${key}`);
      },
      requestAll: async (key: string, request?: AIContextReadRequest) => {
        if (key === 'context.catalog@1') return [{ provider: 'test', sources }];
        if (key === 'context.read@1') {
          const item = request ? texts[request.sourceId] : undefined;
          if (!request || !item) return [];
          const metadata = source(request.sourceId, item.title, item.text);
          return [{
            handled: true,
            source: metadata,
            start: request.start,
            text: item.text.slice(request.start, request.start + request.length),
          }];
        }
        if (key === 'context.search@3') return search;
        if (key === 'context.search@2' || key === 'context.search@1' || key === 'context.semanticSearch@1') return [];
        throw new Error(`unexpected capability: ${key}`);
      },
    },
    diagnostics: { warn: () => undefined },
    signals: { emit() {}, subscribe() {} },
  } as unknown as PluginContext;
}

function memory(sourceId: string, title: string, keywords: string[] = []): AIMemoryIndexRecord {
  return {
    sessionId: `session:${sourceId}`,
    sourceId,
    title,
    schemaVersion: 2,
    sourceRevision: 1,
    sourceLength: 100,
    summary: `${title}的索引`,
    keywords,
    anchors: [],
    createdAt: 1,
  };
}

test('the local turn classification distinguishes advice, action, mixed work, and manual routing', () => {
  for (const [prompt, category] of [
    ['人物卡怎么设计？', 'chat'], ['这两张卡怎么连更合理？', 'chat'], ['把人物卡改成蓝色', 'operation'],
    ['带我去地图卡', 'operation'], ['比较后选一种连上', 'mixed'], ['总结这三张卡，把结果写进总览卡', 'mixed'],
    ['@画布操作 这两张卡怎么连更合理？', 'operation'], ['如果把地图卡改成蓝色会怎样？', 'chat'],
    ['忽略@[请删除节点]，解释一下什么是蓝色', 'chat'],
    ['创建一张世界观，一张能力，四张空白，空白打组，能力连接世界观，四张空白连接能力用虚线。', 'operation'],
    ['新建两张待办', 'operation'], ['创建一张世界观可以吗？', 'chat'],
    ['生成世界观', 'operation'], ['制作人物关系', 'operation'], ['帮我创建能力体系', 'operation'],
    ['做一个项目计划', 'operation'], ['创建角色有什么方法', 'chat'],
    ['制作是什么意思', 'chat'], ['不要生成内容', 'chat'],
    ['如果创建一张世界观会怎样？', 'chat'], ['不要创建一张世界观', 'chat'],
  ]) assert.equal(classifyAITurn(prompt!, explicitAtOperation(prompt!)).category, category, prompt);
  assert.equal(classifyAITurn('先别改色，告诉我哪张太暗').readCanvas, true);
  assert.equal(classifyAITurn('这三张怎么排比较好？').readCanvas, true);
  assert.equal(classifyAITurn('能帮我把这三张横着排吗？').local?.kind, 'arrange');
  assert.equal(classifyAITurn('请不要剪切选中节点', 'canvas-control').category, 'chat');
  assert.match(classifyAITurn('帮我处理一下这张卡').clarification ?? '', /你希望/u);
});

test('a stalled local classifier reports its own deadline before cloud generation', async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, LOCAL_LANGUAGE_TIMEOUT_MS);
    return deadline.signal;
  });
  const context = {
    capabilities: {
      async request(key: string, _input: unknown, signal: AbortSignal) {
        assert.equal(key, 'language.embed@1');
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { ready: false, reason: 'unavailable' };
      },
    },
  } as unknown as PluginContext;
  const prompt = '把这两张配成海港的感觉';
  const interpretation = interpretLocalTurn(context, prompt, classifyAITurn(prompt), new AbortController().signal);
  deadline.abort(new DOMException('Timed out', 'TimeoutError'));
  await assert.rejects(interpretation, /本地语义模型未能及时就绪/u);
});

test('canvas failure follow-ups resume only the nearest user action from the current transcript', async () => {
  const original = '创建一张世界观，一张能力，四张空白，空白打组，能力连接世界观，四张空白连接能力用虚线。';
  const transcript = `[用户]\n${original}\n[助手]\n画布结构按要求搭好。\n[用户]\n为什么画布上看不到？\n[助手]\n请补充对象。\n`;
  const context = preparationContext({ 'node:transcript': { title: '当前对话', text: transcript } });
  const signal = new AbortController().signal;
  assert.equal(await recoverCanvasRequest(context, session(), '还是没有', signal), original);
  const prepared = await prepareAIContext(context, session(), {}, {
    sessionId: session().id, operation: 'general', prompt: '还是没有',
  }, signal, () => undefined, { characterLimit: 12000, tokenLimit: 6000, transcriptWindow: 4000, minimumMemoryWindow: 480 });
  assert.equal(prepared.operation, 'canvas-control');
  assert.equal(prepared.prompt, '还是没有');
  assert.equal(turnAssembly(prepared).recoveryPrompt, original);
  assert.equal(turnAssembly(prepared).route.continuation, true);
  for (const barrier of ['不要创建了', '世界观怎么设计？', '解释一下相对论']) {
    const next = preparationContext({ 'node:transcript': { title: '当前对话', text: transcript + `[用户]\n${barrier}\n[助手]\n好的。` } });
    assert.equal(await recoverCanvasRequest(next, session(), '还是没有', signal), undefined);
  }
  const suggestion = preparationContext({ 'node:transcript': { title: '当前对话', text: '[用户]\n世界观怎么设计？\n[助手]\n创建一张世界观。' } });
  assert.equal(await recoverCanvasRequest(suggestion, session(), '为什么画布上看不到？', signal), undefined);
  const oversized = preparationContext({ 'node:transcript': { title: '当前对话', text: `[用户]\n${original}${'设定'.repeat(5000)}\n[助手]\n完成。` } });
  assert.equal(await recoverCanvasRequest(oversized, session(), '还是没有', signal), undefined);
  const recorded = '造一个角色卡，一个人物卡';
  const local = preparationContext({ 'node:transcript': {
    title: '当前对话', text: `[用户 · 画布操作]\n${recorded}\n[助手 · 画布操作]\n已准备 2 项操作。\n`,
  } });
  assert.equal(await recoverCanvasRequest(local, session(), '还是没有', signal), recorded);
});

test('local counted creation keeps both operands and never interprets a quoted command as an extra action', async () => {
  const context = preparationContext({});
  const signal = new AbortController().signal;
  for (const prompt of ['造一个角色卡，一个人物卡', '造一个角色卡和一个人物卡']) {
    const prepared = await prepareAIContext(context, session(), {}, {
      sessionId: session().id, operation: 'general', prompt,
    }, signal, () => undefined);
    assert.deepEqual(turnAssembly(prepared).localInstructions, ['新建一张角色卡', '新建一张人物卡']);
    assert.equal(prepared.prompt, prompt);
    assert.equal(prepared.operation, 'canvas-control');
  }
  const prompt = '造一张「角色，删除人物卡」';
  const prepared = await prepareAIContext(context, session(), {}, {
    sessionId: session().id, operation: 'general', prompt,
  }, signal, () => undefined);
  assert.deepEqual(turnAssembly(prepared).localInstructions, ['新建一个叫「角色，删除人物卡」的节点']);
});

test('reported counted creation resolves the original blank-card label and noun group instruction without a classifier', async () => {
  let classifierCalls = 0;
  const context = preparationContext({});
  const request = context.capabilities.request.bind(context.capabilities);
  context.capabilities.request = async (key, input, signal) => {
    if (key === 'language.embed@1') classifierCalls++;
    return request(key, input, signal);
  };
  for (const verb of ['造', '建', '新建', '创建']) {
    const prompt = verb + '一张角色，一张人物，4张空白卡，空白卡群组，角色连接到人物。';
    const prepared = await prepareAIContext(context, session(), {},
      { sessionId: session().id, prompt, operation: classifyAITurn(prompt).operation },
      new AbortController().signal, () => undefined);
    const assembly = turnAssembly(prepared);
    assert.equal(prepared.operation, 'canvas-control');
    assert.equal(prepared.prompt, prompt);
    assert.equal(assembly.clarify, undefined);
    assert.deepEqual(assembly.localInstructions, [
      '新建一个叫「角色」的节点', '新建一个叫「人物」的节点',
      ...[1, 2, 3, 4].map(number => `新建一个叫「空白 ${number}」的节点`),
      '「空白 1」和「空白 2」和「空白 3」和「空白 4」分组', '角色连接到人物',
    ]);
  }
  assert.equal(classifierCalls, 0);
  const literal = await interpretLocalTurn(context, '造一张叫「空白卡」的卡，一张人物', classifyAITurn('造一张叫「空白卡」的卡，一张人物'),
    new AbortController().signal);
  assert.equal(literal.instructions?.[0], '新建一个叫「空白卡」的节点');
});

test('original decisions and suggestions remain distinguishable after 1, 15, 100 and 300 turns', async () => {
  const earliest = '我确认主角职业是钟匠。';
  const latest = '我确认把主角职业改成守夜人。';
  const suggested = '建议主角职业为制图师。';
  for (const turns of [1, 15, 100, 300]) {
    const transcript = Array.from({ length: turns }, (_, index) => index === 0 ? `[用户]\n${earliest}\n[助手]\n${suggested}\n` :
      index === Math.min(95, turns - 1) ? `[用户]\n${latest}\n[助手]\n收到。\n` :
        `[用户]\n讨论第 ${index} 次展厅方案。\n[助手]\n${'未收敛的展厅灯光比较。'.repeat(34)}\n`).join('');
    const context = preparationContext({ 'node:transcript': { title: '当前对话', text: transcript } });
    for (const [prompt, expected] of [
      ['按最早定下的职业', earliest], ['按你最早建议的职业', suggested],
      ['按之前定的职业', turns === 1 ? earliest : latest], ['查看第 1 轮的主角职业原话', earliest],
    ]) {
      const current = await prepareAIContext(context, { ...session(), turns }, {}, {
        sessionId: 'session:1', operation: 'general', prompt: prompt!,
      }, new AbortController().signal, () => undefined);
      const recall = current.sources.filter(item => item.reason === 'conversation-memory');
      assert.match(recall.map(item => item.text).join('\n'), new RegExp(expected!, 'u'), `${turns}: ${prompt}`);
      assert.ok(recall.every(item => transcript.slice(item.start, item.start + item.length) === item.text));
      assert.doesNotMatch(recall.map(item => item.text).join('\n'), /灯光比较/u);
    }
  }
});

test('mixed summary binds selected sources separately from the uniquely named destination', async () => {
  const context = preparationContext({
    'node:a': { title: '甲卡', text: '甲来源。' }, 'node:b': { title: '乙卡', text: '乙来源。' },
    'node:c': { title: '丙卡', text: '丙来源。' }, 'node:out': { title: '总览卡', text: '现有内容。' },
    'node:d': { title: '干扰卡', text: '无关正文。' },
  });
  Object.assign(context.capabilities, { request: async (key: string) => {
    if (key === 'selection.read@1') return { ids: ['node:a', 'node:b', 'node:c'] };
    throw new Error('Capability unavailable: ' + key);
  } });
  const prepared = await prepareAIContext(context, session(), {}, { sessionId: 'session:1', operation: 'canvas-control',
    prompt: '总结这三张卡，把结果写进总览卡' }, new AbortController().signal, () => undefined);
  assert.deepEqual(turnAssembly(prepared).readIds, ['node:a', 'node:b', 'node:c']);
  assert.equal(turnAssembly(prepared).destinationId, 'node:out');
  assert.deepEqual(prepared.sources.map(item => item.text), ['甲来源。', '乙来源。', '丙来源。', '']);
});

test('bound generation requires complete requested evidence at the verified revisions', () => {
  const target = { id: 'node:a', title: '武器卡', revision: 1, nodeRevision: 1, length: 3,
    x: 0, y: 0, width: 300, height: 200, color: '#999999', presentation: 'card' as const };
  const reference = { ...target, id: 'node:b', title: '原料卡', length: 2 };
  const state = { nodes: [target, reference], total: 2, groups: [], connections: [], available: { nodes: true, groups: true, connections: true } };
  const prompt = '在武器卡里写一段来历';
  const prepared: AIPreparedContext = {
    id: 'context1', sessionId: 'session:1', prompt, operation: 'canvas-control', totalCharacters: 10, estimatedTokens: 10,
    createdAt: 0, expiresAt: 1000, sources: [{
      sourceId: target.id, provider: 'text-node', kind: 'text', title: target.title, revision: 1,
      start: 0, length: 3, text: '旧正文', reason: 'explicit-reference', complete: true,
    }],
  };
  const assembly = { route: classifyAITurn(prompt), contentTargetId: target.id, explicitCanvasIds: [target.id] };
  const write = resolveBoundCanvasWrite(prepared, assembly, state);
  assert.ok(write);
  assert.deepEqual(buildBoundCanvasWritePlan(write, '{"text":"续写正文"}').actions, [{
    type: 'update-node', id: target.id, edit: { start: 3, deleteCount: 0, insert: '\n\n续写正文', expectedRevision: 1 },
  }]);
  assert.throws(() => buildBoundCanvasWritePlan(write, '{"text":"正文","id":"node:b"}'), /写入范围/u);
  assembly.explicitCanvasIds.push(reference.id);
  assert.equal(resolveBoundCanvasWrite(prepared, assembly, state), undefined);
  prepared.sources.push({ ...prepared.sources[0]!, sourceId: reference.id, title: reference.title, length: 1, text: '铜' });
  assert.equal(resolveBoundCanvasWrite(prepared, assembly, state), undefined);
  prepared.sources[1] = { ...prepared.sources[1]!, length: 2, text: '铜片', revision: 2 };
  assert.equal(resolveBoundCanvasWrite(prepared, assembly, state), undefined);
});

test('field work supplies only incomplete cards, restores an exact historical field, and reports age evidence', async () => {
  const context = preparationContext({
    'node:transcript': { title: '当前对话', text: '[用户]\n确认人物身份为钟匠。\n[助手]\n收到。\n' },
    'node:a': { title: '人物卡', text: '姓名：林渊\n身份：守夜人\n外貌：银发\n年龄：27\n动机：\n' },
    'node:b': { title: '人物旧卡', text: '姓名：林渊\n年龄：25\n动机：找到地图。\n' },
    'node:c': { title: '无关卡', text: '姓名：阿曼\n年龄：29\n秘密：不进入请求' },
  });
  Object.assign(context.capabilities, { request: async (key: string) => {
    if (key === 'groups.list@1') return [{ title: '人物组', memberIds: ['node:a', 'node:b'] }];
    if (key === 'content.summariesById@1') return [{ id: 'node:a' }, { id: 'node:b' }];
    throw new Error('Capability unavailable: ' + key);
  } });
  const prepare = (prompt: string) => prepareAIContext(context, session(), {}, { sessionId: 'session:1', operation: 'canvas-control', prompt },
    new AbortController().signal, () => undefined);
  const complete = await prepare('给人物组缺动机的卡补上动机');
  assert.deepEqual(complete.sources.map(source => source.sourceId), ['node:a']);
  assert.deepEqual(turnAssembly(complete).fields?.map(field => ({ ...field, start: complete.sources[0]!.text.slice(field.start) })), [
    { id: 'node:a', start: '\n', deleteCount: 0, expectedRevision: 1, prefix: '' },
  ]);
  const restore = turnAssembly(await prepare('恢复第 1 轮的人物身份，保留当前外貌'));
  const restored = restore.fixedPlan?.actions[0];
  assert.equal(restored?.type, 'update-node');
  if (restored?.type !== 'update-node') throw new Error(restore.clarify);
  assert.deepEqual(restored.edit, { start: '姓名：林渊\n身份：'.length, deleteCount: '守夜人'.length, insert: '钟匠', expectedRevision: 1 });
  const ages = await prepare('检查人物组里年龄矛盾并定位原句');
  assert.deepEqual(ages.sources.map(source => source.text), ['年龄：27', '年龄：25']);
  assert.match(turnAssembly(ages).clarify ?? '', /\[来源 1\]/u);
});

test('a geometry-only request skips both the selected memory and unrelated conversation history', async () => {
  const context = preparationContext({
    'node:transcript': { title: '当前对话', text: '[用户]\n旧任务：把地图删掉。\n[助手]\n等待确认。' },
    'node:memory': { title: '旧任务', text: '旧卡片的正文。' },
  });
  const prepared = await prepareAIContext(context, session(), { 'node:memory': memory('node:memory', '旧任务') }, {
    sessionId: 'session:1', operation: 'canvas-control', prompt: '@画布操作 把人物卡和武器卡的位置对齐，保留相对距离', memorySourceIds: ['node:memory'],
  }, new AbortController().signal, () => undefined, deriveAIContextBudget());
  assert.deepEqual(prepared.sources, []);
  assert.equal(prepared.selectedMemorySourceIds?.length ?? 0, 0);
});

test('focused card writing keeps the live draft and skips an extra archive from the same chat', async () => {
  const context = preparationContext({
    'node:transcript': { title: '当前对话', text: '[用户]\n人物卡设计内容\n[助手]\n最新草稿。\n' +
      '[用户]\n你是谁\n[助手]\n我是画布助手。\n[用户]\n连接两张卡\n[助手 · 上午 · 画布操作]\n没有找到目标。' },
    'node:hero': { title: '人物卡', text: '姓名：\n身份：' },
    'node:archive': { title: '本对话归档', text: '[用户]\n旧版草稿。' },
  });
  Object.assign(context.capabilities, { request: async (key: string) => {
    assert.equal(key, 'canvasControl.bindContent@1');
    return { ids: ['node:hero'], needsChoice: false };
  } });
  const prepared = await prepareAIContext(context, { ...session(), turns: 2 }, {
    'node:archive': { ...memory('node:archive', '本对话归档'), sessionId: 'session:1' },
  }, { sessionId: 'session:1', operation: 'canvas-control', prompt: '填入到人物卡中', memorySourceIds: ['node:archive'] },
  new AbortController().signal, () => undefined, deriveAIContextBudget());
  assert.deepEqual(prepared.sources.map(source => source.sourceId), ['node:hero', 'node:transcript']);
  assert.equal(prepared.sources[1]!.text, '[用户]\n人物卡设计内容\n[助手]\n最新草稿。');
});

test('a fill request keeps a long last draft intact, and reports a draft that does not fit', async () => {
  const draft = '开头。' + 'draft fragment '.repeat(365) + '最后一句必须保留。';
  const prepare = async (body: string) => {
    const context = preparationContext({
      'node:hero': { title: '人物卡', text: '姓名：\n身份：' },
      'node:transcript': { title: '当前对话', text: '[用户]\n上一个任务\n[助手]\n无关内容\n[用户]\n设计人物卡\n[助手]\n' + body +
        '\n[用户]\n选中两张卡，把它们连起来\n[助手 · 上午 · 画布操作]\n已直接完成 1 项操作' },
    });
    Object.assign(context.capabilities, { request: async () => ({ ids: ['node:hero'], needsChoice: false }) });
    return prepareAIContext(context, { ...session(), turns: 4 }, {}, {
      sessionId: 'session:1', operation: 'canvas-control', prompt: '填入人物卡',
    }, new AbortController().signal, () => undefined, deriveAIContextBudget());
  };
  const source = (await prepare(draft)).sources.find(source => source.reason === 'recent-conversation');
  assert.equal(source?.text, '[用户]\n设计人物卡\n[助手]\n' + draft);
  assert.equal(source?.complete, true);
  const oversized = (await prepare(draft.repeat(4))).sources.find(source => source.reason === 'recent-conversation');
  assert.equal(oversized?.text, '');
  assert.equal(oversized?.complete, false);
});

test('an explicit historical callback reads verified matching memory without opening unrelated sources', async () => {
  const text = '[用户]\n正式确认：人物卡的职业是钟匠。';
  const context = preparationContext({
    'node:transcript': { title: '当前对话', text: '' },
    'node:decision': { title: '人物卡正式设定', text },
    'node:other': { title: '历史交通记录', text: '无关原文。' },
  });
  const indexes = {
    'node:decision': { ...memory('node:decision', '人物卡正式设定', ['人物卡']), scope: '人物卡' },
    'node:other': memory('node:other', '历史交通记录', ['渡轮']),
  };
  const prepare = (contextMode?: 'explicit-only') => prepareAIContext(context, session(), indexes, {
    sessionId: 'session:1', operation: 'canvas-control', prompt: '按之前定的设定改写人物卡正文', contextMode,
  }, new AbortController().signal, () => undefined, deriveAIContextBudget());
  assert.deepEqual((await prepare()).sources.map(source => [source.sourceId, source.text]), [['node:decision', text]]);
  assert.deepEqual((await prepare('explicit-only')).sources, []);
});

test('appearance commands omit body reads while creative palette requests retain explicitly referenced theme evidence', async () => {
  const texts = { 'node:transcript': { title: '当前对话', text: '' }, 'node:theme': { title: '主题', text: '主题为冬夜海港，禁止使用暖红色。' } };
  const context = preparationContext(texts);
  const prepare = (prompt: string) => prepareAIContext(context, session(), {}, { sessionId: 'session:1', prompt, operation: 'canvas-control' }, new AbortController().signal, () => undefined);
  const color = await prepare('@画布操作 @[主题](node:theme) 把选中节点设为 #336699');
  assert.equal(color.sources.find(source => source.sourceId === 'node:theme')?.text, '');
  const creative = await prepare('@画布操作 根据 @[主题](node:theme) 设计协调的配色方案');
  assert.match(creative.sources.find(source => source.sourceId === 'node:theme')?.text ?? '', /禁止使用暖红色/u);
});

test('explicit/recent overlapping originals merge only verified same-revision text and continuation reads the necessary tail', async () => {
  const text = '早期正文。\n\n'.repeat(400) + '最终尾部必须保留的限制。';
  const context = preparationContext({ 'node:transcript': { title: '当前对话', text }, 'node:body': { title: '正文', text } });
  const prepared = await prepareAIContext(context, session(), {}, { sessionId: 'session:1', prompt: '总结 @[当前对话](node:transcript)', operation: 'summarize', contextMode: 'explicit-only' }, new AbortController().signal, () => undefined);
  assert.equal(prepared.sources.filter(source => source.sourceId === 'node:transcript').length, 1);
  const continued = await prepareAIContext(context, session(), {}, { sessionId: 'session:1', prompt: '@扩写 @[正文](node:body) 接着续写', operation: 'expand', contextMode: 'explicit-only' }, new AbortController().signal, () => undefined);
  assert.match(continued.sources.find(source => source.sourceId === 'node:body')?.text ?? '', /最终尾部必须保留的限制/u);
  assert.equal(continued.writebackTarget?.mode, 'append'); assert.equal(continued.writebackTarget?.start, text.length);
});

test('explicit AI references parse linked IDs, bracketed titles and direct IDs once', () => {
  assert.deepEqual(
    parseExplicitReferences('@[需求](node:1) 对照 @[发布计划] 和 @node:2，再看 @[需求](node:1)'),
    ['node:1', '发布计划', 'node:2'],
  );
});

test('natural comparison binds named sources and separates the proposed output node', async () => {
  const context = preparationContext({
    'node:transcript': { title: '当前对话', text: '' },
    'node:a': { title: '主角初稿', text: '年龄二十。' },
    'node:b': { title: '主角终稿', text: '年龄二十九。' },
    'node:other': { title: '无关', text: '不可发送。' },
  });
  const prepared = await prepareAIContext(context, session(), {}, {
    sessionId: 'session:1', prompt: '对比主角初稿和「主角终稿」，并把冲突整理成名为「人物冲突」的新节点', operation: 'compare',
  }, new AbortController().signal, () => undefined);
  assert.equal(prepared.outputNodeTitle, '人物冲突');
  assert.equal(prepared.contextMode, 'explicit-only');
  assert.deepEqual(prepared.sources.map(item => item.sourceId), ['node:a', 'node:b']);
  context.capabilities.request = async <T>() => ({ ids: ['node:a', 'node:b'] }) as T;
  const selected = await prepareAIContext(context, session(), {}, {
    sessionId: 'session:1', prompt: '对比这两个节点，说明差异', operation: 'compare',
  }, new AbortController().signal, () => undefined);
  assert.deepEqual(selected.sources.map(item => item.sourceId), ['node:a', 'node:b']);
});

test('full group summary requires review, reads the tail and never sends an unrelated node', async () => {
  const context = preparationContext({
    'node:transcript': { title: '当前对话', text: '' },
    'node:a': { title: '旧案记录', text: '最早的事实。' + '档案。'.repeat(2_500) + '最终证据。' },
    'node:b': { title: '现场记录', text: '独立现场发现。' },
    'node:other': { title: '无关', text: '不可发送。' },
  });
  context.capabilities.request = async <T>() => [{ title: '档案组', memberIds: ['node:a', 'node:b'] }] as T;
  const signal = new AbortController().signal;
  const prepared = await prepareAIContext(context, session(), {}, {
    sessionId: 'session:1', prompt: '总结档案组里的全部节点', operation: 'summarize',
  }, signal, () => undefined);
  assert.equal(prepared.review?.reason, 'full-source-summary');
  const sent: string[] = [];
  const final = await collectFullSourceSummary(context, prepared, {
    temperature: 0.3, maxOutputTokens: 512, messages: [{ role: 'user', content: prepared.prompt }],
  }, signal, async request => {
    sent.push(request.messages[1]!.content);
    return { text: '分段证据', model: '测试模型', provider: 'mock' };
  }, () => undefined);
  assert.match(sent.join('\n'), /最早的事实[\s\S]*最终证据[\s\S]*独立现场发现/u);
  assert.doesNotMatch(sent.join('\n'), /不可发送/u);
  assert.match(final.messages[0]!.content, /2 个来源/u);
});

test('AI context budgets scale conservatively from a provider-declared model window', () => {
  assert.deepEqual(deriveAIContextBudget(undefined), {
    characterLimit: 12_000,
    tokenLimit: 6_000,
    transcriptWindow: 4_000,
    minimumMemoryWindow: 480,
  });
  assert.deepEqual(deriveAIContextBudget(16_000), deriveAIContextBudget(undefined));
  const small = deriveAIContextBudget(4_000);
  const large = deriveAIContextBudget(128_000);
  assert.equal(small.tokenLimit, 1_500);
  assert.equal(large.tokenLimit, 36_000);
  assert.equal(large.characterLimit, 72_000);
  assert.equal(large.transcriptWindow, 12_000);
});

test('intent routing keeps ordinary chat fast while preserving explicit and recall requests', () => {
  assert.equal(classifyAIContextIntent('你好，今天怎么样？', 'general', {
    hasExplicitSource: false, hasSelectedMemory: false,
  }), 'conversation');
  assert.equal(classifyAIContextIntent('回顾上次为什么放弃方案 A', 'general', {
    hasExplicitSource: false, hasSelectedMemory: false,
  }), 'memory-recall');
  assert.equal(classifyAIContextIntent('比较这些方案的风险', 'compare', {
    hasExplicitSource: false, hasSelectedMemory: false,
  }), 'analysis');
  assert.equal(classifyAIContextIntent('你好', 'general', {
    hasExplicitSource: true, hasSelectedMemory: false,
  }), 'memory-recall');
});

test('a short revision of a regular answer keeps recent context without requiring a canvas draft', async () => {
  const context = preparationContext({
    'node:transcript': { title: '当前对话', text: '[用户]\n总结发现。\n\n[助手]\n这里是前一版回答，需要继续缩短。' },
  });
  const prepared = await prepareAIContext(context, session(), {}, {
    sessionId: 'session:1', prompt: '再短一点', operation: 'shorten',
  }, new AbortController().signal, () => undefined);
  assert.equal(prepared.contextMode, 'explicit-only');
  assert.equal(prepared.writebackTarget, undefined);
  assert.match(prepared.sources.find(item => item.reason === 'recent-conversation')?.text ?? '', /前一版回答/u);
});

test('AI context preparation reads explicit references first and reports bounded progress', async () => {
  const texts = {
    'node:transcript': { title: '当前对话', text: '' },
    'node:alpha': { title: '需求', text: '第一段需求。\n\n第二段限制。' },
  };
  const progress: number[] = [];
  const prepared = await prepareAIContext(
    preparationContext(texts),
    session(),
    {},
    {
      sessionId: 'session:1',
      prompt: '请总结 @[需求](node:alpha)',
      operation: 'summarize',
    },
    new AbortController().signal,
    (value) => progress.push(value),
  );

  assert.deepEqual(prepared.sources.map((item) => ({ id: item.sourceId, reason: item.reason })), [
    { id: 'node:alpha', reason: 'explicit-reference' },
  ]);
  assert.equal(prepared.sources[0]?.text, texts['node:alpha'].text);
  assert.deepEqual(progress, [0.15, 0.25, 0.5, 1]);
  assert.equal(prepared.totalCharacters <= 12_000, true);
  assert.equal(prepared.estimatedTokens <= 6_000, true);
});

test('selected-memory scope excludes otherwise matching memories and still reads a no-overlap follow-up', async () => {
  const texts = {
    'node:transcript': { title: '当前对话', text: '' },
    'memory:chosen': { title: '选中的记忆', text: '[用户 · 通用]\n旧问题是什么？\n[助手 · 通用]\n旧问题的回答。' },
    'memory:other': { title: '未选记忆', text: '这里也包含问题两个字，但不应进入上下文。' },
  };
  const otherSource = source('memory:other', texts['memory:other'].title, texts['memory:other'].text);
  const prepared = await prepareAIContext(
    preparationContext(texts, [{
      provider: 'search',
      scanned: 2,
      hits: [{ source: otherSource, start: 0, length: 4, preview: '包含问题', score: 10 }],
    }]),
    session(),
    {
      'memory:chosen': memory('memory:chosen', '选中的记忆', ['旧内容']),
      'memory:other': memory('memory:other', '未选记忆', ['问题']),
    },
    {
      sessionId: 'session:1',
      prompt: '我之前问过什么？',
      operation: 'general',
      memorySourceIds: ['memory:chosen'],
    },
    new AbortController().signal,
    () => undefined,
  );

  assert.deepEqual(prepared.selectedMemorySourceIds, ['memory:chosen']);
  assert.equal(prepared.sources.some((item) => item.sourceId === 'memory:chosen'), true);
  assert.equal(prepared.sources.some((item) => item.sourceId === 'memory:other'), false);
  assert.equal(prepared.memoryRetrieval?.evidenceMemories, 1);
});

test('explicit-only context keeps recent conversation but skips automatic memory and search retrieval', async () => {
  const texts = {
    'node:transcript': { title: '当前对话', text: '用户刚才明确要求保持内容私密。' },
    'memory:other': { title: '历史记忆', text: '这里有同一个关键词，但不应被自动带入。' },
  };
  const otherSource = source('memory:other', texts['memory:other'].title, texts['memory:other'].text);
  const prepared = await prepareAIContext(
    preparationContext(texts, [{
      provider: 'search',
      scanned: 1,
      hits: [{ source: otherSource, start: 0, length: 8, preview: '同一个关键词', score: 10 }],
    }]),
    session(),
    { 'memory:other': memory('memory:other', '历史记忆', ['关键词']) },
    {
      sessionId: 'session:1',
      prompt: '继续处理关键词',
      operation: 'general',
      contextMode: 'explicit-only',
    },
    new AbortController().signal,
    () => undefined,
  );

  assert.equal(prepared.contextMode, 'explicit-only');
  assert.deepEqual(prepared.sources.map((item) => item.sourceId), ['node:transcript']);
  assert.equal(prepared.memoryRetrieval?.candidatesMatched, 0);
});

test('ordinary conversation skips automatic memory and search retrieval by intent', async () => {
  const texts = {
    'node:transcript': { title: '当前对话', text: '刚才正在讨论发布节奏。' },
    'memory:other': { title: '历史记忆', text: '这个内容不该在寒暄时被带入。' },
  };
  const otherSource = source('memory:other', texts['memory:other'].title, texts['memory:other'].text);
  const prepared = await prepareAIContext(
    preparationContext(texts, [{
      provider: 'search', scanned: 1,
      hits: [{ source: otherSource, start: 0, length: 6, preview: '历史记忆', score: 10 }],
    }]),
    session(),
    { 'memory:other': memory('memory:other', '历史记忆', ['你好']) },
    { sessionId: 'session:1', prompt: '你好', operation: 'general' },
    new AbortController().signal,
    () => undefined,
  );

  assert.equal(prepared.contextIntent, 'conversation');
  assert.deepEqual(prepared.sources, []);
});

test('standalone definitions do not start the local classifier or read the document catalog', async () => {
  const unused = () => { throw new Error('standalone question opened local resources'); };
  const context = { capabilities: { request: unused, requestAll: unused } } as unknown as PluginContext;
  const prepared = await prepareAIContext(context, { ...session(), turns: 40 }, {}, {
    sessionId: 'session:1', prompt: '什么是第三人称限知？', operation: 'general', promptTemplateId: 'template:custom',
  }, new AbortController().signal, () => undefined);
  assert.equal(prepared.contextIntent, 'conversation');
  assert.equal(prepared.promptTemplateId, 'template:custom');
  assert.deepEqual(prepared.sources, []);
});

test('standalone greetings, identity and unrelated definitions open no local source with selected memories', async () => {
  const unused = () => { throw new Error('identity question opened local sources'); };
  const context = { capabilities: { request: unused, requestAll: unused } } as unknown as PluginContext;
  for (const prompt of ['你是谁', '你用的什么模型？', '你好，今天怎么样？', '什么是三角函数？']) {
    const prepared = await prepareAIContext(context, { ...session(), turns: 40 },
      { 'node:memory': memory('node:memory', '历史剧本对话') }, {
        sessionId: 'session:1', prompt, operation: 'general', memorySourceIds: ['node:memory'], webSearchEnabled: true,
      }, new AbortController().signal, () => undefined);
    assert.equal(prepared.prompt, prompt);
    assert.equal(prepared.contextIntent, 'conversation');
    assert.equal(prepared.selectedMemorySourceIds, undefined);
    assert.equal(prepared.webSearchEnabled, prompt === '什么是三角函数？' ? true : undefined);
    assert.deepEqual(prepared.sources, []);
  }
  assert.equal(classifyAIContextIntent('你还记得我是谁吗？', 'general', {
    hasExplicitSource: false, hasSelectedMemory: false,
  }), 'memory-recall');
});

test('a definition containing canvas terminology and a one-turn history veto never read selected memories', async () => {
  const unavailable = () => { throw new Error('a standalone question opened local sources'); };
  const context = { capabilities: { request: unavailable, requestAll: unavailable } } as unknown as PluginContext;
  const result = await prepareAIContext(context, session(), {}, {
    sessionId: 'session:1', prompt: '这次别用历史，什么是群组？', operation: 'general', memorySourceIds: ['node:memory'],
  }, new AbortController().signal, () => undefined);
  assert.deepEqual(result.sources, []);
  assert.equal(result.contextIntent, 'conversation');
});

test('a confirmed second draft remains verbatim and scoped after 100 unrelated exchanges', async () => {
  const draft = '午夜的钟响了。\n她推开花房的门，看到苔藓爬过石阶。';
  const transcript = '[用户]\n给我写两个开头\n[助手]\n第一版：\n雨从天边落下来。\n\n**第二版**：\n' + draft +
    '\n[用户]\n第二个更好，先留着\n[助手]\n好的。\n' + Array.from({ length: 100 }, (_, index) => `[用户]\n周末问题 ${index}\n[助手]\n周末答复 ${index}\n`).join('');
  const prepared = await prepareAIContext(preparationContext({ 'node:transcript': { title: '当前对话', text: transcript } }),
    { ...session(), turns: 102 }, {}, { sessionId: 'session:1', prompt: '刚才那个压到 200 字，第一句保留', operation: 'general' },
    new AbortController().signal, () => undefined);
  assert.deepEqual(prepared.sources.map(source => source.text), [draft]);
  assert.equal(prepared.sources[0]!.start, transcript.indexOf(draft));
  assert.deepEqual(turnAssembly(prepared).conversationDraft, { firstSentence: '午夜的钟响了。', maxCharacters: 200 });
});

test('a nearby follow-up reads only the latest exchange and canvas status uses its local receipt', async () => {
  const transcript = '[用户]\n旧问题\n[助手]\n旧回答\n[用户]\n什么是反讽？\n[助手]\n字面与实际的意思有反差。';
  const local = preparationContext({ 'node:transcript': { title: '对话', text: transcript } });
  const originalRead = local.capabilities.requestAll.bind(local.capabilities);
  const calls: string[] = [];
  const context = { ...local, capabilities: {
    request: async (key: string) => {
      calls.push(key);
      if (key === 'canvasControl.receipt@1') return { preparationId: 'last-plan', status: 'undone', message: '已应用' };
      throw new Error(`Capability unavailable: ${key}`);
    },
    requestAll: async (key: string, payload?: unknown) => {
      calls.push(key);
      if (key !== 'context.read@1') throw new Error(`unexpected capability: ${key}`);
      return originalRead(key, payload);
    },
  } } as unknown as PluginContext;
  const prepare = (prompt: string) => prepareAIContext(context, { ...session(), turns: 2 }, {},
    { sessionId: 'session:1', prompt, operation: 'general', memorySourceIds: ['memory:unrelated'] }, AbortSignal.timeout(5000), () => undefined);
  const followup = await prepare('举个例子说明一下');
  assert.equal(followup.contextMode, 'explicit-only');
  assert.deepEqual(followup.sources.map(item => item.text), ['[用户]\n什么是反讽？\n[助手]\n字面与实际的意思有反差。']);
  assert.ok(calls.every(key => key === 'context.read@1' || key === 'ai.provider.catalog@1'));
  calls.length = 0;
  const receipt = await prepare('刚才那批到底执行了吗');
  assert.match(turnAssembly(receipt).localReply ?? '', /已经撤销/u);
  assert.deepEqual(calls, ['canvasControl.receipt@1']);
  assert.deepEqual(receipt.sources, []);
  const preview = classifyAITurn('这几张卡排一行，先别执行，给我看看方案');
  assert.equal(preview.disposition, 'preview');
  assert.equal(preview.local?.kind, 'arrange');
  const readOnly = '只看，不改，把这些卡的关系说一下';
  assert.equal(classifyAITurn(readOnly, 'canvas-control').category, 'chat');
  assert.equal(mayUseLocalLanguage(readOnly, classifyAITurn(readOnly)), false);
  assert.equal(classifyAITurn('把那段缩短一点，保留我的口吻，不要修改人物年龄。').disposition, 'normal');
});

test('an internal transcript extension scans the appended range and reads the exact old draft', async () => {
  const draft = '午夜的钟响了。她推开门。';
  let transcript = '[用户]\n请给我两个开头\n[助手]\n第一版：\n深夜下雨。\n第二版：\n' + draft + '\n' +
    ('[用户]\n其它问题\n[助手]\n' + '其它答案。'.repeat(150) + '\n').repeat(60);
  let revision = 1;
  const sessionId = 'incremental';
  const sourceId = internalTranscriptSourceId(sessionId);
  const readOffsets: number[] = [];
  const currentSession = () => ({ ...session(), id: sessionId, transcriptSourceId: undefined, transcriptRevision: revision, transcriptLength: transcript.length });
  const context = { store: {
    readValue: currentSession,
    readKeyRange: (_namespace: string, from: string) => {
      readOffsets.push(Number(from.slice(-16)));
      return Object.fromEntries(chunkImportedTranscript(sessionId, transcript).map(({ key, chunk }) => [key, chunk]));
    },
  } } as unknown as PluginContext;
  const request = conversationDraftRequest('把第二版压到 200 字，第一句别动')!;
  assert.deepEqual(request, { number: 2, topic: undefined, keepFirstSentence: true, maxCharacters: 200 });
  const read = () => readConversationDraft(context, { ...source(sourceId, '对话', transcript), revision }, request,
    2000, 2000, AbortSignal.timeout(5000));
  assert.equal((await read()).draft?.text, draft);
  assert.ok(readOffsets.length > 2);
  const appendStart = transcript.length;
  transcript += '\n[用户]\n后来又聊了一件事。\n[助手]\n新的答复。\n';
  revision++;
  noteConversationAppend(context, currentSession(), revision);
  readOffsets.length = 0;
  assert.equal((await read()).draft?.text, draft);
  assert.deepEqual(readOffsets, [appendStart, transcript.indexOf(draft)]);
  invalidateConversationDirectories(context);
  readOffsets.length = 0;
  assert.equal((await read()).draft?.text, draft);
  assert.equal(readOffsets[0], 0);
});

test('AI context preparation marks explicit memory-state changes for review without writing data', async () => {
  const prepared = await prepareAIContext(
    preparationContext({ 'node:transcript': { title: '当前对话', text: '' } }),
    session(),
    {},
    { sessionId: 'session:1', prompt: '@修改 发布日期：十月', operation: 'general' },
    new AbortController().signal,
    () => undefined,
  );

  assert.equal(prepared.review?.reason, 'memory-state-change');
  assert.equal(prepared.sources.length, 0);
});
