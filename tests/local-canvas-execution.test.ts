import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import type { AIGenerateRequest, AIGenerateResult, AIPreparedContext } from '../src/protocols/ai.ts';
import { registerAIGenerationRuntime } from '../src/plugins/ai-assistant/generation-runtime.ts';
import { buildBoundCanvasWritePlan, resolveBoundCanvasWrite } from '../src/plugins/ai-assistant/bound-canvas-write.ts';
import { interpretLocalTurn, mayUseLocalLanguage } from '../src/plugins/ai-assistant/local-turn-routing.ts';
import { classifyAITurn } from '../src/plugins/ai-assistant/turn-route.ts';
import { nativeCanvasIntent } from '../src/services/native-canvas-intent.ts';
import { naturalCanvasOperation } from '../src/services/ai-task-route.ts';

function prepared(prompt: string): AIPreparedContext {
  return { id: 'turn:local', sessionId: 'session:local', prompt, operation: 'canvas-control', sources: [],
    totalCharacters: prompt.length, estimatedTokens: 0, createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
}

async function generate(prompt: string, local: { handled: boolean; text?: string; unresolvedTarget?: boolean }) {
  let listener: (message: { payload: { preparationId: string } }) => void = () => undefined;
  const requests: string[] = [];
  let offered: unknown;
  let sent: AIGenerateRequest | undefined;
  let record!: (value: AIGenerateResult) => void;
  const recorded = new Promise<AIGenerateResult>(resolve => { record = resolve; });
  const turn = prepared(prompt);
  const context = {
    events: { subscribe(_type: string, handler: typeof listener) { listener = handler; } },
    signals: { emit() {} }, diagnostics: { warn() {} },
    tasks: { schedule({ run }: { run: (signal: AbortSignal, report: (value: number) => void) => Promise<unknown> }) {
      return { result: Promise.resolve().then(() => run(new AbortController().signal, () => undefined)), cancel() {} };
    } },
    commands: { async dispatch(type: string, payload: AIGenerateResult & { text: string }) {
      if (type === 'canvasControl.offer@1') {
        offered = JSON.parse(payload.text);
        return { message: (offered as { answer?: string }).answer ?? '已准备正文计划' };
      }
      assert.equal(type, 'ai.generation.record');
      record(payload);
      return {};
    } },
    capabilities: {
      async request(key: string, request: AIGenerateRequest) {
        requests.push(key);
        if (key === 'canvasControl.localPlan@1') return local;
        if (key === 'canvasControl.context@3') return { instruction: '', objectDirectory: '' };
        if (key === 'canvasControl.agentQuery@1') return { nodes: [], groups: [], connections: [], total: 0,
          available: { nodes: true, groups: true, connections: true } };
        if (key === 'ai.generate.stream@1') {
          sent = request;
          return { provider: 'fixture', model: 'fixture', events: (async function* () {
            yield { type: 'delta', delta: '{"texts":["生成的人物小传"]}' };
            yield { type: 'complete', usage: { inputTokens: 32, outputTokens: 12 } };
          })() };
        }
        // A configured provider must never enable an operation-planning fallback.
        if (key === 'ai.provider.catalog@1') return { activeId: 'paid', options: [{ id: 'paid', configured: true, canvasToolCallingSupported: true }] };
        throw new Error(`unexpected capability: ${key}`);
      },
      async requestAll() { return []; },
    },
  } as unknown as PluginContext;
  registerAIGenerationRuntime(context, {
    preparations: new Map([[turn.id, turn]]), tasks: new Map(), stateBySession: new Map(), actionBySession: new Map(),
    readPromptTemplates: () => ({ templates: [] }), readMemoryIndexes: () => ({}),
    readSessions: () => ({}), shouldAutoExtractMemoryCandidates: () => false,
  });
  listener({ payload: { preparationId: turn.id } });
  const result = await recorded;
  return { result, requests, offered, sent };
}

test('all unresolved and unsupported canvas controls stay local even with a configured provider', async () => {
  for (const prompt of ['把画布背景调整得更护眼', '调整注释颜色的透明度', '@画布操作 未支持的插件操作']) {
    const result = await generate(prompt, { handled: false });
    assert.equal(result.result.provider, 'local');
    assert.deepEqual(result.result.usage, { inputTokens: 0, outputTokens: 0 });
    assert.match(result.result.text, /只在本地处理/u);
    assert.equal(result.sent, undefined);
    assert.equal(result.offered, undefined);
    assert.ok(!result.requests.includes('ai.provider.catalog@1'));
  }
  const result = await generate('把不存在的卡片改成蓝色', { handled: true, unresolvedTarget: true,
    text: JSON.stringify({ version: 1, actions: [], answer: '没有找到指定卡片' }) });
  assert.equal(result.result.text, '没有找到指定卡片');
  assert.equal(result.sent, undefined);
  assert.deepEqual(result.result.usage, { inputTokens: 0, outputTokens: 0 });
});

test('explicit creation sends only a prose response contract and constructs actions locally', async () => {
  const result = await generate('创建一张人物卡，并写一段人物小传', { handled: false });
  assert.ok(result.sent);
  assert.equal(result.sent.tools, undefined);
  assert.equal(result.sent.canvasAgentTransport, undefined);
  assert.match(JSON.stringify(result.sent.messages), /不要调用画布工具或输出操作计划/u);
  assert.deepEqual(result.offered, { version: 2, actions: [{
    type: 'create-node', ref: 'local-text-0', title: '人物卡', presentation: 'card', text: '生成的人物小传',
  }] });
});

test('themes, backgrounds, annotations and view controls have local grammars without cloud intent classification', async () => {
  for (const prompt of ['改主题', '改背景颜色', '改注释颜色', '添加注释：请检查这里',
    '默认注释颜色改成红色', '全局注释颜色设置为蓝色', '放大画布', '缩小画布', '重置缩放', '全选画布', '取消选择',
    '执行本地命令：打开查找替换']) assert.ok(nativeCanvasIntent(prompt), prompt);
  assert.equal(naturalCanvasOperation('切换主题到深色')?.kind, 'theme');
  assert.equal(naturalCanvasOperation('把背景颜色改成浅蓝')?.kind, 'background');
  assert.equal(classifyAITurn('调整注释颜色的透明度').category, 'operation');
  assert.equal(nativeCanvasIntent('不要添加注释'), undefined);
  assert.equal(nativeCanvasIntent('怎么改注释颜色？'), undefined);
  const prompt = '把甲卡弄成蓝色，然后把乙卡往右挪40像素';
  const route = classifyAITurn(prompt);
  assert.equal(mayUseLocalLanguage(prompt, route), false);
  const context = { capabilities: { request() { throw new Error('must not classify'); } } } as unknown as PluginContext;
  const result = await interpretLocalTurn(context, prompt, route, new AbortController().signal);
  assert.equal(result.instructions?.length, 2);
});

test('generated prose cannot change locally bound creation titles or inject canvas actions', () => {
  const prompt = '新建两张人物，并设计人物小传';
  const turn = prepared(prompt);
  const write = resolveBoundCanvasWrite(turn, { route: classifyAITurn(prompt) }, {
    nodes: [], groups: [], connections: [], total: 0, available: { nodes: true, groups: true, connections: true },
  });
  assert.ok(write);
  const plan = buildBoundCanvasWritePlan(write, '{"texts":["甲的小传","乙的小传"]}');
  assert.equal(plan.actions.length, 2);
  assert.throws(() => buildBoundCanvasWritePlan(write, '{"texts":["甲的小传"]}'), /写入范围/u);
  assert.throws(() => buildBoundCanvasWritePlan(write, '{"texts":["甲","乙"],"actions":[{"type":"delete","ids":["other"]}]}'), /写入范围/u);
});
