import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { defineManifest } from '../src/plugins/manifest.ts';
import { createRetrievalSettingsPlugin } from '../src/plugins/retrieval-settings/model.ts';
import type { AIContextSearchContribution, AIContextSearchRequest } from '../src/protocols/ai.ts';
import type { SemanticRetrievalResult } from '../src/protocols/retrieval.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSemanticProviderPlugin } from '../src/plugins/semantic-provider/model.ts';

test('retrieval policy defaults local, gates cloud fallback, forwards scopes and survives provider failure', async () => {
  const calls: Array<{ kind: string; input: AIContextSearchRequest }> = [];
  let localHits = 0;
  let failCloud = false;
  const providers = {
    manifest: defineManifest('retrieval-test', '受控检索测试', { providesCapabilities: ['context.localSemanticSearch@1', 'context.remoteSemanticSearch@1'] }),
    start(context: import('../src/core/contracts.ts').PluginContext) {
      for (const [kind, key] of [['local', 'context.localSemanticSearch@1'], ['cloud', 'context.remoteSemanticSearch@1']] as const) {
        context.capabilities.provide<AIContextSearchRequest, AIContextSearchContribution>({ key, invoke: input => {
          calls.push({ kind, input });
          if (kind === 'cloud' && failCloud) throw new Error('云端断开');
          return { provider: kind, scanned: 1, hits: Array.from({ length: kind === 'local' ? localHits : 1 }, (_, index) => ({
            source: { sourceId: `node:${index}`, title: '线索', provider: kind, revision: 1, kind: 'text', length: 20 }, start: 0, length: 20, score: 1, preview: '原文',
          })) };
        } });
      }
    },
  };
  const kernel = new ApplicationKernel([providers, createRetrievalSettingsPlugin()]);
  await kernel.start();
  const search = (lexicalHits = 0) => kernel.capabilities.request<SemanticRetrievalResult>('context.semanticSearch@2', { terms: ['事故'], maxResults: 4, sourceIds: ['node:0'], lexicalHits });
  assert.deepEqual((await search()).attempted, ['local']);
  assert.ok(calls.every(call => call.kind === 'local'));
  await kernel.router.dispatch('retrieval.configure@1', { mode: 'keyword' }, 'core.test');
  calls.length = 0; assert.deepEqual((await search()).attempted, []); assert.equal(calls.length, 0);
  await kernel.router.dispatch('retrieval.configure@1', { mode: 'cloud-fallback' }, 'core.test');
  assert.deepEqual((await search()).attempted, ['local', 'cloud']);
  assert.ok(calls.every(call => call.input.sourceIds?.[0] === 'node:0'));
  assert.ok(calls.every(call => !('lexicalHits' in call.input)));
  calls.length = 0; await search(3); assert.deepEqual(calls.map(call => call.kind), ['local']);
  localHits = 3; calls.length = 0; await search(); assert.deepEqual(calls.map(call => call.kind), ['local']);
  localHits = 0; failCloud = true;
  const failed = await search(); assert.match(failed.warnings[0]!, /已保留本地结果/u);
  assert.equal((await kernel.capabilities.request<SemanticRetrievalResult>('context.semanticSearch@2', { terms: ['事故'], maxResults: 4, sourceIds: [] })).attempted.length, 0);
  await assert.rejects(() => kernel.router.dispatch('retrieval.configure@1', { mode: 'invalid' }, 'core.test'));
  await kernel.plugins.stop('retrieval-settings');
});

test('remote embedding builds only the requested source scope and requires its independent consent', async () => {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSemanticProviderPlugin()]);
  await kernel.start();
  const allowed = await kernel.router.dispatch<{ id: string }>('node.create', { title: '许可资料', body: '旧案的公开线索。' }, 'core.test');
  await kernel.router.dispatch('node.create', { title: '范围外资料', body: '这一段不属于本轮授权范围。' }, 'core.test');
  const draft = { label: '范围验证', platform: '测试', endpoint: 'https://semantic.example.test/v1/embeddings', model: 'fixture', apiStyle: 'openai-compatible' as const,
    authentication: 'none' as const, allowRemoteContent: false, maxBatchSize: 8 };
  const profile = await kernel.router.dispatch<{ id: string }>('semanticProvider.profile.save', draft, 'core.test');
  const sent: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    sent.push(...input);
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const search = () => kernel.capabilities.request<AIContextSearchContribution>('context.remoteSemanticSearch@1', { terms: ['旧案'], query: '旧案', maxResults: 4, sourceIds: [allowed.id] });
  try {
    assert.deepEqual((await search()).hits, []);
    assert.equal(sent.length, 0);
    await kernel.router.dispatch('semanticProvider.profile.save', { ...draft, id: profile.id, allowRemoteContent: true }, 'core.test');
    const result = await search();
    assert.deepEqual(result.hits.map(hit => hit.source.sourceId), [allowed.id]);
    assert.ok(sent.some(text => text.includes('许可资料')));
    assert.ok(sent.every(text => !text.includes('范围外资料') && !text.includes('本轮授权范围')));
  } finally {
    globalThis.fetch = originalFetch;
    await kernel.plugins.stop('semantic-provider');
  }
});
