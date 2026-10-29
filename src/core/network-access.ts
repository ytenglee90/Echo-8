import type { LocalModelAsset, LocalModelAssetData } from '../protocols/network.ts';

export type AINetworkKind = 'generate' | 'embed' | 'model' | 'sync';

export type { LocalModelAsset, LocalModelAssetData } from '../protocols/network.ts';

export interface AINetworkPolicy {
  timeoutMs: number;
  maxRequestBytes: number;
  maxConcurrent: number;
  maxRequestsPerMinute: number;
}

export interface NetworkAccessOptions {
  fetcher?: typeof globalThis.fetch;
  now?: () => number;
  policies?: Partial<Record<AINetworkKind, Partial<AINetworkPolicy>>>;
}

interface LocalModelAssetDefinition {
  url: string;
  maxBytes: number;
  allowedFinalOrigins: readonly string[];
  /** Trusted storage/CDN host suffixes for this fixed Hugging Face model asset. */
  allowedFinalHostSuffixes?: readonly string[];
}

const DEFAULT_POLICIES: Record<AINetworkKind, AINetworkPolicy> = {
  generate: {
    timeoutMs: 5 * 60_000,
    maxRequestBytes: 4 * 1024 * 1024,
    maxConcurrent: 4,
    maxRequestsPerMinute: 60,
  },
  embed: {
    timeoutMs: 10 * 60_000,
    maxRequestBytes: 2 * 1024 * 1024,
    maxConcurrent: 2,
    maxRequestsPerMinute: 240,
  },
  model: {
    timeoutMs: 5 * 60_000,
    maxRequestBytes: 2,
    maxConcurrent: 1,
    maxRequestsPerMinute: 12,
  },
  sync: {
    timeoutMs: 2 * 60_000,
    maxRequestBytes: 16 * 1024 * 1024,
    maxConcurrent: 2,
    maxRequestsPerMinute: 600,
  },
};

const LOCAL_MODEL_ASSETS: Record<LocalModelAsset, LocalModelAssetDefinition> = {
  'bge-small-zh-v1.5.model': {
    url: 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx',
    maxBytes: 32 * 1024 * 1024,
    allowedFinalOrigins: [
      'https://huggingface.co',
      'https://cdn-lfs.huggingface.co',
      'https://cas-bridge.xethub.hf.co',
    ],
    allowedFinalHostSuffixes: ['hf.co'],
  },
  'bge-small-zh-v1.5.tokenizer': {
    url: 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json',
    maxBytes: 2 * 1024 * 1024,
    allowedFinalOrigins: ['https://huggingface.co'],
    allowedFinalHostSuffixes: ['hf.co'],
  },
  'bge-small-zh-v1.5.tokenizer-config': {
    url: 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer_config.json',
    maxBytes: 256 * 1024,
    allowedFinalOrigins: ['https://huggingface.co'],
    allowedFinalHostSuffixes: ['hf.co'],
  },
  'onnxruntime-web.wasm-runtime': {
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.wasm.min.mjs',
    maxBytes: 128 * 1024,
    allowedFinalOrigins: ['https://cdn.jsdelivr.net'],
  },
  'onnxruntime-web.wasm-backend': {
    // The public entrypoint imports this exact sibling. It is fetched through
    // the same governed asset path, then linked into the Worker Blob graph.
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.mjs',
    maxBytes: 1024 * 1024,
    allowedFinalOrigins: ['https://cdn.jsdelivr.net'],
  },
  'onnxruntime-web.wasm-binary': {
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.wasm',
    maxBytes: 16 * 1024 * 1024,
    allowedFinalOrigins: ['https://cdn.jsdelivr.net'],
  },
};

const ALLOWED_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
  'openai-organization',
  'openai-project',
  'x-api-key',
  'x-goog-api-key',
]);
const SECRET_QUERY_KEYS = /^(?:api[-_]?key|access[-_]?token|auth|authorization|key|token)$/iu;

  /** One governed, owner-scoped browser egress for AI providers and cloud sync. */
export class NetworkAccessService {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly policies: Record<AINetworkKind, AINetworkPolicy>;
  private readonly approvedOrigins = new Map<string, Set<string>>();
  private readonly recentRequests = new Map<string, number[]>();
  private readonly activeRequests = new Map<string, Set<AbortController>>();

  constructor(options: NetworkAccessOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.policies = {
      generate: mergePolicy(DEFAULT_POLICIES.generate, options.policies?.generate),
      embed: mergePolicy(DEFAULT_POLICIES.embed, options.policies?.embed),
      model: mergePolicy(DEFAULT_POLICIES.model, options.policies?.model),
      sync: mergePolicy(DEFAULT_POLICIES.sync, options.policies?.sync),
    };
  }

  configureOrigins(owner: string, endpoints: Array<string | URL>): string[] {
    const origins = new Set<string>();
    for (const endpoint of endpoints) {
      if (!String(endpoint).trim()) continue;
      origins.add(validateEndpoint(endpoint).origin);
    }
    if (origins.size === 0) this.approvedOrigins.delete(owner);
    else this.approvedOrigins.set(owner, origins);
    return [...origins].sort();
  }

  clearOwner(owner: string): void {
    this.approvedOrigins.delete(owner);
    for (const key of [...this.recentRequests.keys()]) {
      if (key.startsWith(`${owner}:`)) this.recentRequests.delete(key);
    }
    for (const [key, controllers] of this.activeRequests) {
      if (!key.startsWith(`${owner}:`)) continue;
      for (const controller of controllers) controller.abort(new DOMException('Plugin stopped', 'AbortError'));
      this.activeRequests.delete(key);
    }
  }

  request(
    owner: string,
    kind: AINetworkKind,
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = requestUrl(input);
    validateEndpoint(url);
    if (!this.approvedOrigins.get(owner)?.has(url.origin)) {
      throw new Error(`网络地址尚未获得当前连接授权：${url.origin}`);
    }

    const policy = this.policies[kind];
    const requestInit = kind === 'sync'
      ? validateSyncRequestInit(init, policy.maxRequestBytes)
      : validateRequestInit(init, policy.maxRequestBytes);
    this.admitRate(owner, kind, policy);

    const key = `${owner}:${kind}`;
    const active = this.activeRequests.get(key) ?? new Set<AbortController>();
    if (active.size >= policy.maxConcurrent) {
      const label = kind === 'generate' ? '生成' : kind === 'embed' ? '语义检索' :
        kind === 'sync' ? '云同步' : '下载';
      throw new Error(`网络请求过多：${label}最多同时进行 ${policy.maxConcurrent} 个`);
    }

    const controller = new AbortController();
    active.add(controller);
    this.activeRequests.set(key, active);
    const relayAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener('abort', relayAbort, { once: true });
    if (init.signal?.aborted) relayAbort();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', relayAbort);
      active.delete(controller);
      if (active.size === 0) this.activeRequests.delete(key);
    };
    const timeout = setTimeout(() => {
      controller.abort(new DOMException('AI network request timed out', 'TimeoutError'));
      release();
    }, policy.timeoutMs);
    (timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();

    return this.fetcher(url.toString(), {
      ...requestInit,
      signal: controller.signal,
      redirect: 'error',
      credentials: kind === 'sync' && isCurrentOrigin(url) ? 'same-origin' : 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }).then((response) => {
      if (!response.ok || !response.body) {
        release();
        return response;
      }
      return wrapResponseBody(response, release);
    }, (error) => {
      release();
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
      throw error;
    });
  }

  /**
   * Retrieves one fixed public model asset for an on-device runtime. Unlike
   * provider traffic this accepts no URL, headers or canvas-derived body.
   */
  async downloadLocalModelAsset(
    owner: string,
    asset: LocalModelAsset,
    signal?: AbortSignal,
  ): Promise<LocalModelAssetData> {
    const definition = LOCAL_MODEL_ASSETS[asset];
    if (!definition) throw new Error(`Unknown local model asset: ${String(asset)}`);
    const policy = this.policies.model;
    this.admitRate(owner, 'model', policy);

    const key = `${owner}:model`;
    const active = this.activeRequests.get(key) ?? new Set<AbortController>();
    if (active.size >= policy.maxConcurrent) {
      throw new Error(`AI 网络请求过多：本地模型最多同时下载 ${policy.maxConcurrent} 个资源`);
    }
    const controller = new AbortController();
    active.add(controller);
    this.activeRequests.set(key, active);
    const relayAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', relayAbort, { once: true });
    if (signal?.aborted) relayAbort();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', relayAbort);
      active.delete(controller);
      if (active.size === 0) this.activeRequests.delete(key);
    };
    const timeout = setTimeout(() => {
      controller.abort(new DOMException('Local AI model download timed out', 'TimeoutError'));
      release();
    }, policy.timeoutMs);
    (timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();

    try {
      const response = await this.fetcher(definition.url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'force-cache',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error(`本地模型资源返回 HTTP ${response.status}`);
      const finalUrl = new URL(response.url || definition.url);
      const finalOrigin = finalUrl.origin;
      if (!isAllowedLocalModelFinalUrl(definition, finalUrl)) {
        throw new Error(`本地模型资源跳转到了未授权地址：${finalOrigin}`);
      }
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > definition.maxBytes) {
        throw new Error('本地模型资源大小超出安全上限');
      }
      const data = await response.arrayBuffer();
      if (!data.byteLength || data.byteLength > definition.maxBytes) {
        throw new Error('本地模型资源为空或超过安全上限');
      }
      return { asset, data };
    } finally {
      release();
    }
  }

  private admitRate(owner: string, kind: AINetworkKind, policy: AINetworkPolicy): void {
    const key = `${owner}:${kind}`;
    const cutoff = this.now() - 60_000;
    const recent = (this.recentRequests.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= policy.maxRequestsPerMinute) {
      throw new Error(`AI 网络请求过于频繁：一分钟最多 ${policy.maxRequestsPerMinute} 次`);
    }
    recent.push(this.now());
    this.recentRequests.set(key, recent);
  }
}

function isAllowedLocalModelFinalUrl(definition: LocalModelAssetDefinition, url: URL): boolean {
  if (url.protocol !== 'https:' || url.port) return false;
  if (definition.allowedFinalOrigins.includes(url.origin)) return true;
  const hostname = url.hostname.toLocaleLowerCase('en-US');
  return definition.allowedFinalHostSuffixes?.some((suffix) => {
    const normalized = suffix.toLocaleLowerCase('en-US');
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  }) ?? false;
}

function mergePolicy(base: AINetworkPolicy, override?: Partial<AINetworkPolicy>): AINetworkPolicy {
  const policy = { ...base, ...override };
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 1 ||
    !Number.isFinite(policy.maxRequestBytes) || policy.maxRequestBytes < 2 ||
    !Number.isInteger(policy.maxConcurrent) || policy.maxConcurrent < 1 ||
    !Number.isInteger(policy.maxRequestsPerMinute) || policy.maxRequestsPerMinute < 1) {
    throw new Error('Invalid AI network policy');
  }
  return policy;
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    throw new Error('AI 网络请求必须提供受审查的地址和独立请求参数');
  }
  return new URL(String(input), typeof document === 'undefined' ? 'http://localhost' : document.baseURI);
}

function validateEndpoint(input: string | URL): URL {
  const url = input instanceof URL
    ? new URL(input.toString())
    : new URL(input, typeof document === 'undefined' ? 'http://localhost' : document.baseURI);
  if (url.username || url.password) throw new Error('AI 网络地址不能包含用户名或密码');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('远程 AI 地址必须使用 HTTPS；本地模型只允许 localhost 或回环地址');
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.test(key)) throw new Error('AI KEY 不能写在接口地址中，请使用认证方式字段');
  }
  return url;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

function validateRequestInit(init: RequestInit, maxBytes: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'POST') throw new Error('AI 网络出口只允许 POST 请求');
  if (typeof init.body !== 'string') throw new Error('AI 网络请求正文必须是 JSON 文本');
  const bytes = new TextEncoder().encode(init.body).byteLength;
  if (bytes > maxBytes) throw new Error(`AI 网络请求正文超过 ${Math.round(maxBytes / 1024 / 1024)} MB 安全上限`);
  try {
    JSON.parse(init.body);
  } catch {
    throw new Error('AI 网络请求正文不是有效 JSON');
  }
  const headers = new Headers(init.headers);
  for (const [name] of headers) {
    if (!ALLOWED_HEADERS.has(name.toLowerCase())) throw new Error(`AI 网络请求包含未授权请求头：${name}`);
  }
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) throw new Error('AI 网络请求必须使用 application/json');
  return { ...init, method, headers, body: init.body };
}

function validateSyncRequestInit(init: RequestInit, maxBytes: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    throw new Error('云同步只允许 GET、POST、PATCH 或 DELETE 请求');
  }
  const headers = new Headers(init.headers);
  for (const [name] of headers) {
    if (!ALLOWED_HEADERS.has(name.toLowerCase())) throw new Error(`云同步包含未授权请求头：${name}`);
  }
  if (method === 'GET') {
    if (init.body !== undefined && init.body !== null) throw new Error('云同步 GET 请求不能包含正文');
    return { ...init, method, headers, body: undefined };
  }
  if (typeof init.body !== 'string') throw new Error('云同步写请求正文必须是 JSON 文本');
  const bytes = new TextEncoder().encode(init.body).byteLength;
  if (bytes > maxBytes) throw new Error(`云同步请求超过 ${Math.round(maxBytes / 1024 / 1024)} MB 安全上限`);
  try { JSON.parse(init.body); } catch { throw new Error('云同步请求正文不是有效 JSON'); }
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) throw new Error('云同步写请求必须使用 application/json');
  return { ...init, method, headers, body: init.body };
}

function isCurrentOrigin(url: URL): boolean {
  if (typeof document === 'undefined') return false;
  return url.origin === new URL(document.baseURI).origin;
}

function wrapResponseBody(response: Response, release: () => void): Response {
  const reader = response.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
