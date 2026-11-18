import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { createAIProviderPlugin } from '../src/plugins/ai-provider/model.ts';
import { fetchWithInitialRetry } from '../src/plugins/ai-provider/provider-transport.ts';
import type { AIGenerateRequest, AIGenerateStream } from '../src/protocols/ai.ts';

const request: AIGenerateRequest = {
  messages: [{ role: 'user', content: '取消测试' }], temperature: 0.2, maxOutputTokens: 512,
};

async function provider() {
  const kernel = new ApplicationKernel([createAIProviderPlugin()]);
  await kernel.start();
  await kernel.router.dispatch('aiProvider.setPreferences', {
    endpoint: 'https://cancel-model.test/v1/chat/completions', model: 'cancel-test', authentication: 'none',
  }, 'core.test');
  return kernel;
}

for (const capability of ['ai.generate@1', 'ai.generate.stream@1']) test(`${capability} aborts the actual fetch while awaiting model headers without retrying`, async () => {
  const kernel = await provider();
  const originalFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    signal = init?.signal ?? undefined;
    started();
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const result = kernel.capabilities.request(capability, request, controller.signal);
    const rejected = assert.rejects(result, { name: 'AbortError' });
    await waiting;
    controller.abort();
    await rejected;
    assert.equal(signal?.aborted, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await kernel.plugins.stop('ai-provider');
  }
});

test('stopping after a streamed token aborts the provider connection and releases its reader', async () => {
  const kernel = await provider();
  const originalFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"尚未完成"}}]}\n\n'));
        signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const stream = await kernel.capabilities.request<AIGenerateStream>('ai.generate.stream@1', request, controller.signal);
    const events = stream.events[Symbol.asyncIterator]();
    assert.match(JSON.stringify((await events.next()).value), /尚未完成/u);
    controller.abort();
    await assert.rejects(events.next(), { name: 'AbortError' });
    assert.equal(signal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    await kernel.plugins.stop('ai-provider');
    assert.equal(kernel.resources.count('ai-provider'), 0);
  }
});

test('an already cancelled retry never sends a new model request', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(fetchWithInitialRetry(async () => { calls++; return new Response('{}'); },
    'https://cancel-model.test', {}, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});
