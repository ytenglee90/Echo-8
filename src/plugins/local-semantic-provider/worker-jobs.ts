import type {
  LocalSemanticCacheSource,
  LocalSemanticDecodeCacheRequest,
  LocalSemanticDecodeCacheResult,
  LocalSemanticEmbedRequest,
  LocalSemanticEmbedResult,
  LocalSemanticEncodeCacheRequest,
  LocalSemanticEncodeCacheResult,
  LocalSemanticLoadModelRequest,
} from './worker-protocol.ts';

interface LocalSemanticRuntime {
  tokenizer: {
    encode(text: string, options?: { add_special_tokens?: boolean; return_token_type_ids?: boolean | null }): {
      ids: number[];
      attention_mask: number[];
      token_type_ids?: number[];
    };
  };
  session: {
    inputNames: readonly string[];
    outputNames: readonly string[];
    run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
    release?(): Promise<void>;
  };
  Tensor: new (type: string, data: BigInt64Array, dims: readonly number[]) => unknown;
}

const MAX_INPUTS_PER_JOB = 16;
const MAX_INPUT_CHARACTERS = 2_000;
const MAX_TOTAL_CHARACTERS = 24_000;
const MAX_SEQUENCE_LENGTH = 512;
const LOCAL_SEMANTIC_CACHE_SCHEMA_VERSION = 1;
const LOCAL_SEMANTIC_CACHE_MODEL = 'Xenova/bge-small-zh-v1.5:quantized';
const MAX_CACHE_TEXT_LENGTH = 15 * 1024 * 1024;
const MAX_CACHE_SOURCES = 10_000;
const MAX_CACHE_CHUNKS = 200_000;
const MAX_VECTOR_DIMENSIONS = 8_192;

interface SerializedCacheChunk {
  start: number;
  length: number;
  fingerprint: string;
  coverage: 'full' | 'sampled';
  vector: string;
}

interface SerializedCacheSource {
  sourceId: string;
  revision: number;
  chunks: SerializedCacheChunk[];
}

let runtime: LocalSemanticRuntime | undefined;
let releaseRuntimeResources: (() => void) | undefined;

export async function loadLocalSemanticModel(request: LocalSemanticLoadModelRequest): Promise<{ inputNames: string[] }> {
  assertLoadRequest(request);
  await disposeLocalSemanticModel();
  const loadedRuntime = await loadExternalOnnxRuntime(request.runtimeModule, request.runtimeBackend, request.runtimeWasm);
  let session: LocalSemanticRuntime['session'] | undefined;
  try {
    const { Tokenizer } = await import('@huggingface/tokenizers');
    const tokenizer = new Tokenizer(JSON.parse(request.tokenizer), JSON.parse(request.tokenizerConfig));
    session = await loadedRuntime.ort.InferenceSession.create(new Uint8Array(request.model), {
      executionProviders: ['wasm'],
    });
    if (!session.inputNames.includes('input_ids') || !session.inputNames.includes('attention_mask')) {
      throw new Error('本地语义模型缺少 BERT 输入层');
    }
    if (session.outputNames.length === 0) {
      throw new Error('本地语义模型没有可用输出层');
    }
    runtime = { tokenizer, session, Tensor: loadedRuntime.ort.Tensor };
    releaseRuntimeResources = loadedRuntime.release;
    return { inputNames: [...session.inputNames] };
  } catch (error) {
    await session?.release?.();
    loadedRuntime.release();
    throw error;
  }
}

async function loadExternalOnnxRuntime(
  runtimeModule: string,
  runtimeBackend: string,
  runtimeWasm: ArrayBuffer,
): Promise<{
  ort: {
    InferenceSession: { create(model: Uint8Array, options: { executionProviders: string[] }): Promise<LocalSemanticRuntime['session']> };
    Tensor: LocalSemanticRuntime['Tensor'];
    env: { wasm: { wasmBinary?: ArrayBuffer; numThreads?: number } };
  };
  release: () => void;
}> {
  const backendUrl = URL.createObjectURL(new Blob([runtimeBackend], { type: 'text/javascript' }));
  const moduleSource = linkOnnxRuntimeEntry(runtimeModule, backendUrl);
  const url = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
  try {
    const ort = await import(/* @vite-ignore */ url) as {
      InferenceSession: { create(model: Uint8Array, options: { executionProviders: string[] }): Promise<LocalSemanticRuntime['session']> };
      Tensor: LocalSemanticRuntime['Tensor'];
      env: { wasm: { wasmBinary?: ArrayBuffer; numThreads?: number } };
    };
    ort.env.wasm.wasmBinary = runtimeWasm;
    ort.env.wasm.numThreads = 1;
    // ORT imports the fixed backend lazily during InferenceSession.create().
    // Keep that Blob URL alive until this model instance is explicitly released.
    return { ort, release: () => URL.revokeObjectURL(backendUrl) };
  } catch (error) {
    URL.revokeObjectURL(backendUrl);
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The public ORT entry resolves this one fixed sibling by filename at runtime.
 * Since the entry is imported from a Blob URL, replace only that exact, pinned
 * filename with the separately downloaded, governed backend Blob URL.
 */
export function linkOnnxRuntimeEntry(runtimeModule: string, backendUrl: string): string {
  const linked = runtimeModule.replace(
    /(['"])ort-wasm-simd-threaded\.mjs\1/gu,
    (_match, quote: string) => `${quote}${backendUrl}${quote}`,
  );
  if (linked === runtimeModule) {
    throw new Error('ONNX 运行时入口未包含受支持的固定后端引用');
  }
  return linked;
}

export async function embedLocalSemanticTexts(request: LocalSemanticEmbedRequest): Promise<LocalSemanticEmbedResult> {
  assertEmbedRequest(request);
  if (!runtime) throw new Error('本地语义模型尚未加载');
  const vectors = await Promise.all(request.texts.map((text) => embedOne(runtime!, text)));
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions < 2 || vectors.some((vector) => vector.length !== dimensions)) {
    throw new Error('本地语义模型返回了维度不一致的向量');
  }
  return { vectors, dimensions };
}

export async function disposeLocalSemanticModel(): Promise<void> {
  const current = runtime;
  const release = releaseRuntimeResources;
  runtime = undefined;
  releaseRuntimeResources = undefined;
  try {
    await current?.session.release?.();
  } finally {
    release?.();
  }
}

/**
 * Encodes only derived identities and vectors. Titles, excerpts and document
 * text deliberately stay out of the device-local cache.
 */
export function encodeLocalSemanticCache(
  request: LocalSemanticEncodeCacheRequest,
): LocalSemanticEncodeCacheResult {
  assertCacheSources(request.sources);
  const prefix = `{"schemaVersion":${LOCAL_SEMANTIC_CACHE_SCHEMA_VERSION},"model":${JSON.stringify(LOCAL_SEMANTIC_CACHE_MODEL)},"sources":[`;
  const suffix = ']}';
  const entries: string[] = [];
  let retainedChunks = 0;
  let currentLength = prefix.length + suffix.length;
  let truncated = false;
  const ordered = [...request.sources].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  for (const source of ordered) {
    const serialized: SerializedCacheSource = {
      sourceId: source.sourceId,
      revision: source.revision,
      chunks: source.chunks.map((chunk) => ({
        start: chunk.start,
        length: chunk.length,
        fingerprint: chunk.fingerprint,
        coverage: chunk.coverage,
        vector: float32ToBase64(chunk.vector),
      })),
    };
    const entry = JSON.stringify(serialized);
    const extraLength = entry.length + (entries.length > 0 ? 1 : 0);
    if (currentLength + extraLength > MAX_CACHE_TEXT_LENGTH) {
      truncated = true;
      continue;
    }
    entries.push(entry);
    currentLength += extraLength;
    retainedChunks += source.chunks.length;
  }
  return {
    text: `${prefix}${entries.join(',')}${suffix}`,
    retainedSources: entries.length,
    retainedChunks,
    truncated,
  };
}

export function decodeLocalSemanticCache(
  request: LocalSemanticDecodeCacheRequest,
): LocalSemanticDecodeCacheResult {
  if (!request || typeof request.text !== 'string' || request.text.length > MAX_CACHE_TEXT_LENGTH) {
    throw new Error('本地语义缓存无效或超过安全上限');
  }
  const value = JSON.parse(request.text) as unknown;
  if (!isRecord(value) || value.schemaVersion !== LOCAL_SEMANTIC_CACHE_SCHEMA_VERSION ||
    value.model !== LOCAL_SEMANTIC_CACHE_MODEL || !Array.isArray(value.sources)) {
    throw new Error('本地语义缓存版本不兼容');
  }
  if (value.sources.length > MAX_CACHE_SOURCES) throw new Error('本地语义缓存来源过多');
  const sources: LocalSemanticCacheSource[] = [];
  let chunkCount = 0;
  for (const item of value.sources) {
    if (!isRecord(item) || typeof item.sourceId !== 'string' || item.sourceId.length < 1 ||
      item.sourceId.length > 512 || !isSafeInteger(item.revision) || !Array.isArray(item.chunks)) {
      throw new Error('本地语义缓存来源记录无效');
    }
    chunkCount += item.chunks.length;
    if (chunkCount > MAX_CACHE_CHUNKS) throw new Error('本地语义缓存分块过多');
    const chunks = item.chunks.map((chunk): LocalSemanticCacheSource['chunks'][number] => {
      if (!isRecord(chunk) || !isSafeInteger(chunk.start) || !isSafeInteger(chunk.length) ||
        typeof chunk.fingerprint !== 'string' || chunk.fingerprint.length < 1 || chunk.fingerprint.length > 128 ||
        (chunk.coverage !== 'full' && chunk.coverage !== 'sampled') || typeof chunk.vector !== 'string') {
        throw new Error('本地语义缓存分块记录无效');
      }
      const vector = base64ToFloat32(chunk.vector);
      if (vector.length < 2 || vector.length > MAX_VECTOR_DIMENSIONS ||
        vector.some((component) => !Number.isFinite(component))) {
        throw new Error('本地语义缓存向量无效');
      }
      return {
        start: chunk.start,
        length: chunk.length,
        fingerprint: chunk.fingerprint,
        coverage: chunk.coverage,
        vector,
      };
    });
    sources.push({ sourceId: item.sourceId, revision: item.revision, chunks });
  }
  return { sources };
}

async function embedOne(model: LocalSemanticRuntime, text: string): Promise<Float32Array> {
  const encoded = model.tokenizer.encode(text, { add_special_tokens: true, return_token_type_ids: true });
  const ids = boundedTokenIds(encoded.ids);
  const attentionMask = ids.map((_, index) => index < encoded.attention_mask.length ? encoded.attention_mask[index] : 1);
  const tokenTypes = ids.map((_, index) => encoded.token_type_ids?.[index] ?? 0);
  const feeds: Record<string, unknown> = {
    input_ids: int64Tensor(model, ids),
    attention_mask: int64Tensor(model, attentionMask),
  };
  if (model.session.inputNames.includes('token_type_ids')) {
    feeds.token_type_ids = int64Tensor(model, tokenTypes);
  }
  const outputs = await model.session.run(feeds);
  const output = outputs[model.session.outputNames[0]];
  if (!output || output.dims.length < 2 || typeof output.dims[output.dims.length - 1] !== 'number') {
    throw new Error('本地语义模型输出格式不正确');
  }
  const dimensions = output.dims[output.dims.length - 1];
  if (!Number.isInteger(dimensions) || dimensions < 2 || dimensions > 8_192 || !(output.data instanceof Float32Array)) {
    throw new Error('本地语义模型输出向量无效');
  }
  return normalizeVector(output.data.slice(0, dimensions));
}

function int64Tensor(model: LocalSemanticRuntime, values: number[]): unknown {
  return new model.Tensor('int64', BigInt64Array.from(values, (value) => BigInt(value)), [1, values.length]);
}

function boundedTokenIds(ids: number[]): number[] {
  if (ids.length <= MAX_SEQUENCE_LENGTH) return ids;
  return [ids[0], ...ids.slice(1, MAX_SEQUENCE_LENGTH - 1), ids[ids.length - 1]];
}

function normalizeVector(value: Float32Array): Float32Array {
  const magnitude = Math.sqrt(value.reduce((total, item) => total + item ** 2, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('本地语义模型返回了空向量');
  return Float32Array.from(value, (item) => item / magnitude);
}

function assertLoadRequest(value: LocalSemanticLoadModelRequest): void {
  if (!(value.model instanceof ArrayBuffer) || value.model.byteLength < 1 || value.model.byteLength > 32 * 1024 * 1024 ||
    typeof value.tokenizer !== 'string' || value.tokenizer.length < 2 || value.tokenizer.length > 2 * 1024 * 1024 ||
    typeof value.tokenizerConfig !== 'string' || value.tokenizerConfig.length < 2 || value.tokenizerConfig.length > 256 * 1024 ||
    typeof value.runtimeModule !== 'string' || value.runtimeModule.length < 2 || value.runtimeModule.length > 128 * 1024 ||
    typeof value.runtimeBackend !== 'string' || value.runtimeBackend.length < 2 || value.runtimeBackend.length > 1024 * 1024 ||
    !(value.runtimeWasm instanceof ArrayBuffer) || value.runtimeWasm.byteLength < 1 || value.runtimeWasm.byteLength > 16 * 1024 * 1024) {
    throw new Error('本地语义模型资源无效或超过安全上限');
  }
}

function assertEmbedRequest(value: LocalSemanticEmbedRequest): void {
  if (!value || !Array.isArray(value.texts) || value.texts.length === 0 || value.texts.length > MAX_INPUTS_PER_JOB ||
    value.texts.some((text) => typeof text !== 'string' || !text.trim() || text.length > MAX_INPUT_CHARACTERS) ||
    value.texts.reduce((total, text) => total + text.length, 0) > MAX_TOTAL_CHARACTERS) {
    throw new Error('本地语义输入无效或超过批处理上限');
  }
}

function assertCacheSources(sources: LocalSemanticCacheSource[]): void {
  if (!Array.isArray(sources) || sources.length > MAX_CACHE_SOURCES) {
    throw new Error('本地语义缓存来源无效');
  }
  let chunkCount = 0;
  for (const source of sources) {
    if (!source || typeof source.sourceId !== 'string' || source.sourceId.length < 1 ||
      source.sourceId.length > 512 || !isSafeInteger(source.revision) || !Array.isArray(source.chunks)) {
      throw new Error('本地语义缓存来源无效');
    }
    chunkCount += source.chunks.length;
    if (chunkCount > MAX_CACHE_CHUNKS) throw new Error('本地语义缓存分块过多');
    for (const chunk of source.chunks) {
      if (!chunk || !isSafeInteger(chunk.start) || !isSafeInteger(chunk.length) ||
        typeof chunk.fingerprint !== 'string' || chunk.fingerprint.length < 1 || chunk.fingerprint.length > 128 ||
        (chunk.coverage !== 'full' && chunk.coverage !== 'sampled') || !(chunk.vector instanceof Float32Array) ||
        chunk.vector.length < 2 || chunk.vector.length > MAX_VECTOR_DIMENSIONS ||
        chunk.vector.some((component) => !Number.isFinite(component))) {
        throw new Error('本地语义缓存分块无效');
      }
    }
  }
}

function float32ToBase64(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 16_384)));
  }
  return btoa(binary);
}

function base64ToFloat32(value: string): Float32Array {
  if (value.length > Math.ceil(MAX_VECTOR_DIMENSIONS * 4 / 3) * 4 + 8) {
    throw new Error('本地语义缓存向量超过安全上限');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error('本地语义缓存向量编码无效');
  }
  if (binary.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('本地语义缓存向量长度无效');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Float32Array(bytes.buffer);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
