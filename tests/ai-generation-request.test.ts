import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import { nativeConversation } from '../src/plugins/ai-assistant/request-evidence.ts';
import type {
  AIPromptPolicyContribution,
  AIPromptTemplateCatalog,
  AIPreparedContext,
} from '../src/protocols/ai.ts';
import {
  buildGenerateRequest,
  expandPromptVariables,
  isPromptPolicyContribution,
} from '../src/plugins/ai-assistant/generation-request.ts';

function preparedContext(): AIPreparedContext {
  return {
    id: 'context:1',
    sessionId: 'session:1',
    prompt: '根据资料给出结论',
    operation: 'summarize',
    providerProfileId: 'provider:1',
    promptTemplateId: 'template:1',
    webSearchEnabled: true,
    selectedMemorySourceIds: ['memory:1'],
    createdAt: 1,
    expiresAt: 2,
    totalCharacters: 20,
    estimatedTokens: 10,
    sources: [{
      sourceId: 'memory:1',
      provider: 'ai-memory',
      kind: 'conversation',
      title: '发布计划',
      revision: 4,
      start: 0,
      length: 12,
      text: '发布窗口确定为十月。',
      reason: 'conversation-memory',
      boundary: 'conversation-turn',
      complete: true,
    }],
    memoryRetrieval: {
      mode: 'batched-index-coverage',
      batchSize: 10,
      batchesScanned: 1,
      candidateLimit: 50,
      candidatesMatched: 1,
      usableCandidates: 1,
      queryBranches: 1,
      coveredBranches: 1,
      evidenceMemories: 1,
      deferredMemories: 0,
      exhaustiveRequested: false,
      contextBudgetExhausted: false,
      evidenceCoveredBranches: 1,
    },
  };
}

function promptCatalog(): AIPromptTemplateCatalog {
  return {
    activeTemplateId: 'template:1',
    templates: [{
      id: 'template:1',
      name: '内容处理',
      systemInstruction: '处理方式：{{operation}}；来源：{{sourceKinds}}。',
      userInstruction: '总来源数：{{sourceCount}}。',
      createdAt: 1,
      updatedAt: 1,
    }],
  };
}

function contextWithPolicies(
  policies: AIPromptPolicyContribution[] | Error,
  warnings: unknown[] = [],
  toolCallingSupported = false,
): PluginContext {
  return {
    capabilities: {
      request: async () => toolCallingSupported ? {
        activeId: 'provider:1',
        options: [{
          id: 'provider:1', label: '测试连接', platform: '测试', model: 'test', configured: true,
          toolCallingSupported: true,
        }],
      } : { options: [] },
      requestAll: async () => {
        if (policies instanceof Error) throw policies;
        return policies;
      },
    },
    diagnostics: {
      warn: (...items: unknown[]) => warnings.push(items),
    },
  } as unknown as PluginContext;
}

test('long conversations preserve the latest text and exact earlier user constraints within a local budget', () => {
  const text = [
    '[用户]\n钟楼段落必须保留黎南的动机。',
    '[助手]\n' + '旧版草稿片段。'.repeat(950),
    '[用户]\n加入雨夜场景。',
    '[助手]\n开头需要保留。' + '长篇草稿。'.repeat(1500) + '最后一句。',
  ].join('\n');
  const history = nativeConversation(text, '把黎南那段改短一点');
  assert.equal(history[0]?.content, '钟楼段落必须保留黎南的动机。');
  assert.equal(history[1]?.content, '加入雨夜场景。');
  assert.match(history.at(-1)!.content, /^开头需要保留。[\s\S]+省略该条原文中段[\s\S]+最后一句。$/u);
  assert.ok(history.at(-1)!.content.length <= 4000);
  assert.doesNotMatch(JSON.stringify(history), /旧版草稿片段/u);
});

test('mechanical canvas prompts advertise a smaller tool set but descriptive body matches can read text', async () => {
  const context = { capabilities: { requestAll: async () => [], request: async (key: string) => {
    if (key === 'ai.provider.catalog@1') return { activeId: 'provider:1', options: [{ id: 'provider:1', canvasToolCallingSupported: true }] };
    if (key === 'canvasControl.context@2') return { instruction: 'legacy', objectDirectory: '' };
    assert.equal(key, 'canvasControl.agentQuery@1');
    return { nodes: [], groups: [], connections: [], total: 0, available: { nodes: true, groups: true, connections: true } };
  } }, diagnostics: { warn() {} } } as unknown as PluginContext;
  const prepared = { ...preparedContext(), operation: 'canvas-control' as const, sources: [], memoryRetrieval: undefined, webSearchEnabled: false };
  const simple = await buildGenerateRequest(context, { ...prepared, prompt: '把人物卡和武器卡的位置对齐，保留相对距离' }, { templates: [] });
  const described = await buildGenerateRequest(context, { ...prepared, prompt: '把写着铜片的卡片移动到人物卡上方' }, { templates: [] });
  assert.deepEqual(simple.tools?.map(tool => tool.function.name), ['query_canvas', 'propose_canvas_plan']);
  assert.ok(described.tools?.some(tool => tool.function.name === 'read_canvas'));
  assert.ok(JSON.stringify(simple).length < JSON.stringify(described).length * 0.75);
});

test('fresh canvas requests use selection without past plans, while a follow-up sends only concise current status', async () => {
  const modes: string[] = [];
  const context = { capabilities: { requestAll: async () => [], request: async (key: string, input?: { query?: { mode: string } }) => {
    if (key === 'ai.provider.catalog@1') return { activeId: 'provider:1', options: [{ id: 'provider:1', canvasToolCallingSupported: true }] };
    assert.equal(key, 'canvasControl.agentQuery@1');
    const mode = input!.query!.mode;
    modes.push(mode);
    return { nodes: [], groups: [], connections: [], total: 0, available: { nodes: true, groups: true, connections: true },
      ...(mode === 'state' ? { tasks: { version: 1, plans: [{ goal: '旧计划', status: 'applied', actions: [{ text: '旧卡片正文不应携带' }], targets: [], actionCount: 1 },
        { goal: '把现有卡移动到上方', status: 'undone', actions: [{ x: 100 }], targets: [], actionCount: 1 }] } } : {}) };
  } }, diagnostics: { warn: () => undefined } } as unknown as PluginContext;
  const prepared = { ...preparedContext(), operation: 'general' as const, contextMode: 'explicit-only' as const, sources: [], memoryRetrieval: undefined };
  const first = await buildGenerateRequest(context, { ...prepared, prompt: '解释一下场景卡怎么设计' }, promptCatalog());
  const next = await buildGenerateRequest(context, { ...prepared, prompt: '刚才那张再移一点' }, promptCatalog());
  assert.deepEqual(modes, ['selection', 'state']);
  assert.doesNotMatch(JSON.stringify(first.messages), /latestTask|旧计划/u);
  const summary = JSON.stringify(next.messages);
  assert.match(summary, /undone/u);
  assert.doesNotMatch(summary, /旧计划|旧卡片正文不应携带/u);
});

test('AI prompt variables and policy validation stay bounded', () => {
  assert.equal(
    expandPromptVariables('{{operation}}/{{sourceKinds}}/{{sourceCount}}', {
      operation: '总结',
      sourceKinds: '对话',
      sourceCount: '2',
    }),
    '总结/对话/2',
  );
  assert.equal(isPromptPolicyContribution({
    provider: 'policy',
    systemInstructions: ['保持事实一致'],
    temperature: 0.4,
  }), true);
  assert.equal(isPromptPolicyContribution({
    provider: 'policy',
    systemInstructions: Array.from({ length: 9 }, () => '过多'),
  }), false);
});

test('generation request exposes only the bounded local memory tool to compatible providers', async () => {
  const prepared = preparedContext();
  prepared.memoryRetrieval!.deferredMemories = 1;
  prepared.memoryRetrieval!.evidenceCoveredBranches = 0;
  const request = await buildGenerateRequest(
    contextWithPolicies([], [], true),
    prepared,
    promptCatalog(),
  );
  assert.deepEqual(request.tools?.map((tool) => tool.function.name), ['search_memory']);
  assert.match(request.messages.find((message) => message.content.includes('search_memory'))?.content ?? '', /只读工具/u);
});

test('generation request applies the selected template and governed policy without trusting canvas text', async () => {
  const request = await buildGenerateRequest(contextWithPolicies([{
    provider: 'policy',
    priority: 10,
    systemInstructions: ['保持术语一致。'],
    userInstructions: ['只输出结果。'],
    temperature: 3,
    maxOutputTokens: 12,
  }]), preparedContext(), promptCatalog());

  assert.equal(request.providerId, 'provider:1');
  assert.equal(request.webSearch, true);
  assert.equal(request.temperature, 2);
  assert.equal(request.maxOutputTokens, 64);
  assert.equal(request.messages[0]?.role, 'system');
  assert.match(request.messages[0]!.content, /回答必须先给核心结论或直接成品/u);
  const systems = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const evidence = request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
  assert.match(systems, /本次请求已启用当前模型平台的原生联网搜索/u);
  assert.match(systems, /处理方式：总结；来源：conversation/u);
  assert.match(systems, /保持术语一致/u);
  assert.match(systems, /记忆执行协议/u);
  assert.match(evidence, /总来源数：1/u);
  assert.match(evidence, /<untrusted-canvas-content>\n发布窗口确定为十月。\n<\/untrusted-canvas-content>/u);
  assert.match(evidence, /用户明确选择了 1 份记忆/u);
});

test('generation request degrades to the active template when optional prompt policy is unavailable', async () => {
  const warnings: unknown[] = [];
  const request = await buildGenerateRequest(
    contextWithPolicies(new Error('policy unavailable'), warnings),
    preparedContext(),
    promptCatalog(),
  );

  assert.equal(warnings.length, 1);
  assert.equal(request.temperature, 0.35);
  assert.equal(request.maxOutputTokens, 2400);
  assert.match(request.messages[0]!.content, /回答必须先给核心结论或直接成品/u);
  assert.match(request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'), /本次请求已启用当前模型平台的原生联网搜索/u);
  assert.match(request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n'), /处理方式：总结/u);
});
