import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import type {
  AIContextReadRequest,
  AIContextSearchContribution,
  AIContextSource,
  AIMemoryIndexRecord,
  AISessionRecord,
} from '../src/protocols/ai.ts';
import {
  deriveAIContextBudget,
  parseExplicitReferences,
  prepareAIContext,
} from '../src/plugins/ai-assistant/context-preparation.ts';
import { classifyAIContextIntent } from '../src/plugins/ai-assistant/context-intent.ts';

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

test('explicit AI references parse linked IDs, bracketed titles and direct IDs once', () => {
  assert.deepEqual(
    parseExplicitReferences('@[需求](node:1) 对照 @[发布计划] 和 @node:2，再看 @[需求](node:1)'),
    ['node:1', '发布计划', 'node:2'],
  );
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
  assert.deepEqual(prepared.sources.map((item) => item.sourceId), ['node:transcript']);
  assert.equal(prepared.memoryRetrieval?.candidatesMatched, 0);
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
