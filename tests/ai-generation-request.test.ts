import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
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
  const request = await buildGenerateRequest(
    contextWithPolicies([], [], true),
    preparedContext(),
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
  assert.equal(request.messages[1]?.role, 'system');
  assert.match(request.messages[1]!.content, /本次请求已启用当前模型平台的原生联网搜索/u);
  assert.equal(request.messages[2]?.role, 'system');
  assert.match(request.messages[2]!.content, /处理方式：总结；来源：conversation/u);
  assert.match(request.messages[2]!.content, /保持术语一致/u);
  assert.equal(request.messages[3]?.role, 'user');
  assert.match(request.messages[3]!.content, /总来源数：1/u);
  assert.match(request.messages[3]!.content, /<untrusted-canvas-content>\n发布窗口确定为十月。\n<\/untrusted-canvas-content>/u);
  assert.match(request.messages[3]!.content, /用户明确选择了 1 份记忆/u);
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
  assert.equal(request.messages[1]?.role, 'system');
  assert.match(request.messages[1]!.content, /本次请求已启用当前模型平台的原生联网搜索/u);
  assert.equal(request.messages[2]?.role, 'system');
  assert.match(request.messages[2]!.content, /处理方式：总结/u);
});
