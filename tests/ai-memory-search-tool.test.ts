import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import type { AIContextSource, AIMemoryIndexRecord } from '../src/protocols/ai.ts';
import {
  executeMemorySearchToolCalls,
  parseSearchMemoryArguments,
} from '../src/plugins/ai-assistant/memory-search-tool.ts';

const text = '[用户]\n发布窗口是否确定？\n\n[助手]\n@确认 发布窗口 = 十月\n';
const source: AIContextSource = {
  sourceId: 'memory:release', provider: 'ai-memory', kind: 'conversation',
  title: '发布计划', revision: 3, length: text.length,
};
const index: AIMemoryIndexRecord = {
  sessionId: 'session:1', sourceId: source.sourceId, title: source.title,
  schemaVersion: 2, sourceRevision: 3, sourceLength: text.length,
  summary: '发布窗口确定为十月。', keywords: ['发布', '窗口', '十月'],
  anchors: [{ term: '发布', start: 5, length: 2 }], createdAt: 1,
};

function context(): PluginContext {
  return {
    capabilities: {
      requestAll: async (key: string, request: { start: number; length: number }) => {
        if (key !== 'context.read@1') return [];
        return [{
          handled: true,
          source,
          text: request.length > 0 ? text.slice(request.start, request.start + request.length) : '',
        }];
      },
    },
  } as unknown as PluginContext;
}

test('memory search tool accepts only its small query schema', () => {
  assert.deepEqual(parseSearchMemoryArguments('{"query":"发布窗口","max_results":2}'), {
    query: '发布窗口', maxResults: 2,
  });
  assert.equal(parseSearchMemoryArguments('{"query":"发布窗口","sourceId":"memory:release"}'), undefined);
  assert.equal(parseSearchMemoryArguments('{"query":"发布","max_results":5}'), undefined);
});

test('memory search tool returns only revision-matched, untrusted bounded evidence', async () => {
  const result = await executeMemorySearchToolCalls(
    context(),
    { contextIntent: 'memory-recall' },
    { [index.sourceId]: index },
    [{ id: 'call:1', name: 'search_memory', arguments: '{"query":"发布窗口"}' }],
    new AbortController().signal,
  );
  assert.equal(result.executed, 1);
  assert.equal(result.messages[0]?.role, 'tool');
  assert.equal(result.messages[0]?.toolCallId, 'call:1');
  assert.match(result.messages[0]?.content ?? '', /<untrusted-memory-content>/u);
  assert.match(result.messages[0]?.content ?? '', /发布计划/u);
  assert.match(result.messages[0]?.content ?? '', /十月/u);
});

test('memory search tool respects an explicit-only conversation boundary', async () => {
  const result = await executeMemorySearchToolCalls(
    context(),
    { contextMode: 'explicit-only' },
    { [index.sourceId]: index },
    [{ id: 'call:1', name: 'search_memory', arguments: '{"query":"发布窗口"}' }],
  );
  assert.equal(result.executed, 0);
  assert.match(result.messages[0]?.content ?? '', /不自动检索/u);
});
