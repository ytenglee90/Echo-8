import assert from 'node:assert/strict';
import test from 'node:test';

import { NetworkAccessService } from '../src/core/network-access.ts';

const JSON_REQUEST: RequestInit = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
};

test('AI network egress only reaches origins loaded from the owner connection profile', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const service = new NetworkAccessService({
    fetcher: (async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });
  service.configureOrigins('ai-provider', ['https://api.example.com/v1/chat/completions']);

  assert.throws(
    () => service.request('ai-provider', 'generate', 'https://collector.example.net/upload', JSON_REQUEST),
    /尚未获得当前连接授权/,
  );
  const response = await service.request(
    'ai-provider',
    'generate',
    'https://api.example.com/v1/chat/completions',
    JSON_REQUEST,
  );
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(calls[0].init?.credentials, 'omit');
});

test('AI network egress rejects insecure remote addresses, URL secrets and unreviewed request shapes', async () => {
  const service = new NetworkAccessService({
    fetcher: (async () => new Response('{}')) as typeof fetch,
  });
  assert.throws(
    () => service.configureOrigins('ai-provider', ['http://api.example.com/v1']),
    /必须使用 HTTPS/,
  );
  assert.throws(
    () => service.configureOrigins('ai-provider', ['https://api.example.com/v1?key=secret']),
    /不能写在接口地址/,
  );
  service.configureOrigins('ai-provider', ['http://127.0.0.1:11434/v1', 'https://api.example.com/v1']);
  assert.throws(
    () => service.request('ai-provider', 'generate', 'https://api.example.com/v1', {
      method: 'GET', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }),
    /只允许 POST/,
  );
  assert.throws(
    () => service.request('ai-provider', 'generate', 'https://api.example.com/v1', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
    }),
    /application\/json/,
  );
  assert.throws(
    () => service.request('ai-provider', 'generate', 'https://api.example.com/v1', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'secret' }, body: '{}',
    }),
    /未授权请求头/,
  );
});

test('AI network egress enforces central timeout, rate and lifecycle cancellation', async () => {
  let now = 1_000;
  const pendingSignals: AbortSignal[] = [];
  const service = new NetworkAccessService({
    now: () => now,
    policies: {
      generate: { timeoutMs: 15, maxConcurrent: 2, maxRequestsPerMinute: 2 },
    },
    fetcher: ((_input, init) => {
      pendingSignals.push(init?.signal as AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch,
  });
  service.configureOrigins('ai-provider', ['https://api.example.com/v1']);

  const timedOut = service.request('ai-provider', 'generate', 'https://api.example.com/v1', JSON_REQUEST);
  await assert.rejects(timedOut, /timed out/);
  const cancelled = service.request('ai-provider', 'generate', 'https://api.example.com/v1', JSON_REQUEST);
  service.clearOwner('ai-provider');
  await assert.rejects(cancelled, /Plugin stopped/);
  assert.equal(pendingSignals.every((signal) => signal.aborted), true);

  now += 60_001;
  service.configureOrigins('ai-provider', ['https://api.example.com/v1']);
  void service.request('ai-provider', 'generate', 'https://api.example.com/v1', JSON_REQUEST).catch(() => undefined);
  void service.request('ai-provider', 'generate', 'https://api.example.com/v1', JSON_REQUEST).catch(() => undefined);
  assert.throws(
    () => service.request('ai-provider', 'generate', 'https://api.example.com/v1', JSON_REQUEST),
    /过于频繁/,
  );
  service.clearOwner('ai-provider');
});

test('cloud sync egress permits authenticated PATCH metadata updates', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const service = new NetworkAccessService({
    fetcher: (async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });
  service.configureOrigins('cloud-sync', ['https://data.example']);

  const response = await service.request('cloud-sync', 'sync', 'https://data.example/v1/projects/project-123456', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ name: '新名称' }),
  });

  assert.equal(response.ok, true);
  assert.equal(calls[0]?.init?.method, 'PATCH');
  assert.equal(calls[0]?.init?.credentials, 'omit');
});

test('local model downloads use only fixed public assets and enforce redirected-origin and size limits', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const service = new NetworkAccessService({
    fetcher: (async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-length': '3' },
      });
    }) as typeof fetch,
  });

  const asset = await service.downloadLocalModelAsset('local-semantic-provider', 'bge-small-zh-v1.5.model');
  assert.equal(asset.data.byteLength, 3);
  assert.match(calls[0]?.url ?? '', /Xenova\/bge-small-zh-v1\.5\/resolve\/main\/onnx\/model_quantized\.onnx$/);
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.redirect, 'follow');
  assert.equal(calls[0]?.init?.credentials, 'omit');

  await service.downloadLocalModelAsset('local-semantic-provider', 'onnxruntime-web.wasm-runtime');
  assert.match(calls[1]?.url ?? '', /onnxruntime-web@1\.29\.0\/dist\/ort\.wasm\.min\.mjs$/);
  await service.downloadLocalModelAsset('local-semantic-provider', 'onnxruntime-web.wasm-backend');
  assert.match(calls[2]?.url ?? '', /onnxruntime-web@1\.29\.0\/dist\/ort-wasm-simd-threaded\.mjs$/);

  const regionalCdn = new NetworkAccessService({
    fetcher: (async () => ({
      ok: true,
      status: 200,
      url: 'https://us.aws.cdn.hf.co/model/Xenova/bge-small-zh-v1.5/model.onnx',
      headers: new Headers({ 'content-length': '1' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    })) as unknown as typeof fetch,
  });
  const regionalAsset = await regionalCdn.downloadLocalModelAsset(
    'local-semantic-provider', 'bge-small-zh-v1.5.model',
  );
  assert.equal(regionalAsset.data.byteLength, 1);

  const redirected = new NetworkAccessService({
    fetcher: (async () => ({
      ok: true,
      status: 200,
      url: 'https://unexpected.example.net/model.onnx',
      headers: new Headers({ 'content-length': '1' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    })) as unknown as typeof fetch,
  });
  await assert.rejects(
    redirected.downloadLocalModelAsset('local-semantic-provider', 'bge-small-zh-v1.5.model'),
    /跳转到了未授权地址/,
  );

  const deceptiveSuffix = new NetworkAccessService({
    fetcher: (async () => ({
      ok: true,
      status: 200,
      url: 'https://us.aws.cdn.hf.co.example.net/model.onnx',
      headers: new Headers({ 'content-length': '1' }),
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    })) as unknown as typeof fetch,
  });
  await assert.rejects(
    deceptiveSuffix.downloadLocalModelAsset('local-semantic-provider', 'bge-small-zh-v1.5.model'),
    /跳转到了未授权地址/,
  );
});
