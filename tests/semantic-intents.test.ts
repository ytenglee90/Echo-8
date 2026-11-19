import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import type { PluginContext } from '../src/core/contracts.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createEditorPlugin } from '../src/plugins/editor/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import { workspaceActionsPlugin } from '../src/plugins/workspace-actions/model.ts';
import type { AIGenerateRequest, AIPreparedContext } from '../src/protocols/ai.ts';
import type { KnownCapabilityType } from '../src/protocols/messages.ts';
import { planWorkspaceWithModel } from '../src/plugins/ai-assistant/workspace-model-planner.ts';
import { readSemanticIntents, validateIntentMapping } from '../src/services/semantic-intents.ts';
import { workspaceRequirements } from '../src/services/workspace-semantic-plan.ts';
import { readTextComposition, readModelTextComposition, TEXT_COMPOSITION_ACTION, textCompositionSteps } from '../src/plugins/ai-assistant/text-composition.ts';
import { buildBoundCanvasWritePlan } from '../src/plugins/ai-assistant/bound-canvas-write.ts';
import { classifyAITurn } from '../src/plugins/ai-assistant/turn-route.ts';
import { compileWorkspaceLanguage } from '../src/services/workspace-language.ts';

test('local source, transformation and result slots survive independent verbs, destination forms and field orders', () => {
  for (const verb of ['改写', '重写', '润色', '扩写', '精简', '总结', '概括', '翻译']) {
    for (const create of ['用新的节点填入内容', '新建的节点插入内容', '新建的节点', '新建一个节点']) {
      const fields = [create, '标题为周明瑞', `正文内容为${verb}后的未命名节点内容`];
      for (const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) {
        const prompt = order.map(i => fields[i]).join('，');
        const task = readTextComposition(prompt)!;
        assert.deepEqual(task.sourceNames, ['未命名节点'], prompt); assert.equal(task.title, '周明瑞', prompt);
        assert.equal(textCompositionSteps(task).length, 3); assert.equal(classifyAITurn(prompt).operation, 'canvas-control');
      }
    }
    const prompt = `新建一个节点，把「旧，节点」的正文${verb}，把结果填入新建的节点`;
    assert.deepEqual(readTextComposition(prompt)?.sourceNames, ['旧，节点'], prompt);
  }
  assert.ok(readTextComposition('改写未命名节点的内容，用新的节点填入内容'));
  assert.equal(readTextComposition('改写甲的正文，用新节点填入内容，再删除乙'), undefined);
  for (const prompt of ['如果改写甲的正文并放到新节点会怎样', '怎么把改写的正文放到新节点？', '不要改写甲的正文，用新的节点填入内容']) assert.equal(readTextComposition(prompt), undefined);
});

const graph = (requests: string[]) => ({ version: 1, intents: requests.map((request, i) => ({ id: 'r' + (i + 1), kind: 'control', request, objects: [], dependsOn: [] })),
  coverage: [{ requirementId: 'r1', intentIds: requests.map((_request, i) => 'r' + (i + 1)) }], clarification: '' });

test('semantic graph rejects missing inputs, foreign result references and lost action mapping', () => {
  const requirements = workspaceRequirements('把两张正文各打开一个窗口');
  const parsed = readSemanticIntents(graph(['打开甲的正文', '打开乙的正文']), requirements);
  assert.equal(parsed.intents.length, 2);
  assert.throws(() => readSemanticIntents({ ...graph(['打开甲']), coverage: [] }, requirements), /全部要求/u);
  assert.throws(() => readSemanticIntents({ ...graph(['写入结果']), intents: [{ id: 'r1', kind: 'write', request: '写入结果', objects: [{ role: 'source', from: 'unknown' }], dependsOn: [] }] }, requirements), /来源或目标/u);
  const execution = { phase: 'final' as const, steps: [{ id: 'only', action: 'editor.open', arguments: {} }], clarification: '',
    coverage: ['r1','r2'].map(requirementId => ({ requirementId, status: 'planned', stepIds: ['only'] })) };
  assert.throws(() => validateIntentMapping(parsed, execution, TEXT_COMPOSITION_ACTION.id), /合并成同一步/u);
});

test('parallel objects, panels and unpunctuated sequences compile locally without swallowing later verbs into titles', () => {
  for (const [prompt, expected] of [
    ['打开「甲」和「乙」的正文', ['editor.open','editor.open']],
    ['关闭「甲」和「乙」的编辑器', ['editor.close','editor.close']],
    ['打开插件和检索设置', ['settings.plugins.open','settings.retrieval.open']],
    ['打开甲的正文并进入它的沉浸编辑', ['editor.open','editor.immersive.enter']],
    ['打开插件然后关闭检索设置再打开小地图', ['settings.plugins.open','settings.retrieval.close','minimap.open']],
  ] as const) {
    const steps = compileWorkspaceLanguage(prompt); assert.deepEqual(steps?.map(step => step.action), [...expected], prompt);
    assert.equal(classifyAITurn(prompt).semanticFallback, false, prompt);
  }
  assert.equal(compileWorkspaceLanguage('打开「甲和乙」的正文')?.length, 1);
  assert.equal(compileWorkspaceLanguage('打开甲和乙的正文', new Set(['甲和乙']))?.length, 1);
  assert.equal(compileWorkspaceLanguage('打开甲的正文并传送到月球'), undefined);
});

test('text result references are mandatory and placeholder bodies never become create actions', () => {
  const args = { steps: [{ id: 'new', kind: 'create-node', title: '乙' },
    { id: 'body', kind: 'transform-text', sourceIds: ['a'], operation: 'rewrite', instruction: '保留事实重述' },
    { id: 'write', kind: 'fill-node', targetFrom: 'new', textFrom: 'body' }] };
  assert.deepEqual(readModelTextComposition(args, [{ id: 'a', revision: 5 }], '改写甲放到乙').sourceRevisions, { a: 5 });
  assert.throws(() => readModelTextComposition({ steps: args.steps.slice(0, 2) }, [{ id: 'a', revision: 5 }], '乙'), /三步/u);
  assert.throws(() => readModelTextComposition({ steps: [...args.steps.slice(0, 2), { ...args.steps[2], textFrom: 'new' }] }, [{ id: 'a', revision: 5 }], '乙'), /三步/u);
  const bound = { kind: 'create' as const, plan: { version: 2 as const, actions: [{ type: 'create-node' as const, ref: 'n', title: '乙' }] }, titles: ['乙'] };
  assert.throws(() => buildBoundCanvasWritePlan(bound, JSON.stringify({ texts: ['见下方改写正文。'] })), /正文/u);
  assert.equal(buildBoundCanvasWritePlan(bound, JSON.stringify({ texts: ['甲在雨中醒来。'] })).actions[0]?.type, 'create-node');
});

test('one natural clause becomes two independent editor operations, with mapping repaired before any execution', async t => {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createEditorPlugin(), createCanvasControlPlugin(), workspaceActionsPlugin]);
  await kernel.start(); t.after(async () => { for (const plugin of kernel.plugins.list().reverse()) if (plugin.status === 'active') await kernel.plugins.stop(plugin.id); });
  const dispatch = <T=unknown>(type: string, payload?: unknown) => kernel.router.dispatch<T>(type, payload, 'core.test');
  const a = await dispatch<{id:string}>('node.create', { title: '甲', body: '第一份正文禁止进入解析请求' });
  const b = await dispatch<{id:string}>('node.create', { title: '乙', body: '第二份正文禁止进入解析请求' });
  const requests: AIGenerateRequest[] = [];
  const context = { capabilities: {
    request: async (key: string, input?: unknown, signal?: AbortSignal) => {
      if (key === 'ai.provider.catalog@1') return { activeId: 'chosen', options: [{ id: 'chosen', configured: true }] };
      if (key === 'ai.generate@1') {
        const request = input as AIGenerateRequest; requests.push(request);
        assert.doesNotMatch(JSON.stringify(request), /正文禁止进入解析请求/u);
        let output: unknown;
        if (requests.length === 1) { assert.equal(JSON.parse(request.messages[1]!.content).stage, 'decompose'); output = graph(['打开甲的正文', '打开乙的正文']); }
        else {
          assert.deepEqual(await kernel.router.ask('editor.openPanes', undefined, 'core.test'), []);
          const first = { id: 'a', action: 'editor.open', arguments: { target: { id: a.id }, mode: 'add' } };
          output = { version: 2, phase: 'final', clarification: '', steps: requests.length === 2 ? [first] : [first, { id: 'b', action: 'editor.open', arguments: { target: { id: b.id }, mode: 'add' } }],
            coverage: [{ requirementId: 'r1', status: 'planned', stepIds: ['a'] }, { requirementId: 'r2', status: 'planned', stepIds: [requests.length === 2 ? 'a' : 'b'] }] };
        }
        return { text: JSON.stringify(output), provider: 'fixture', model: 'chosen', usage: { inputTokens: 10, outputTokens: 10 } };
      }
      return kernel.capabilities.request(key as KnownCapabilityType, input, signal);
    }, requestAll: (key: string, input?: unknown, signal?: AbortSignal) => kernel.capabilities.requestAll(key, input, signal),
  }, queries: { ask: (key: string, input?: unknown) => kernel.router.ask(key, input, 'core.test') }, commands: { dispatch }, signals: { emit() {} } } as unknown as PluginContext;
  const prepared: AIPreparedContext = { id: 'decomposed', sessionId: 'test', operation: 'canvas-control', prompt: '把甲乙两张正文各打开一个窗口', sources: [], totalCharacters: 0, estimatedTokens: 0, createdAt: 0, expiresAt: Date.now()+60000 };
  const result = await planWorkspaceWithModel(context, prepared, new AbortController().signal);
  assert.equal(requests.length, 3); assert.equal(result.usage?.inputTokens, 30);
  assert.deepEqual(await kernel.router.ask('editor.openPanes', undefined, 'core.test'), [a.id, b.id]);
});
