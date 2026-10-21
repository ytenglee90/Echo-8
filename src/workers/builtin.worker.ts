import type {
  WorkerCancelMessage,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from '../core/worker-service.ts';
import {
  SEARCH_INDEX_ANALYZE_JOB,
  SEARCH_INDEX_BLOOM_JOB,
  SEARCH_INDEX_POSTINGS_JOB,
  SEARCH_INDEX_RANK_JOB,
  SEARCH_INDEX_SIGNATURE_JOB,
  analyzeSearchChunks,
  buildSearchBloom,
  buildCompressedSearchPostings,
  buildSearchSignature,
  rankSearchChunks,
  type SearchIndexAnalyzeRequest,
  type SearchIndexBloomRequest,
  type SearchIndexPostingsRequest,
  type SearchIndexRankRequest,
} from '../plugins/search-index/worker-jobs.ts';
import {
  TEXT_ASSIST_COMPILE_JOB,
  compileTextAssistWorkerRequest,
  type TextAssistCompileRequest,
} from '../plugins/text-assist/worker-jobs.ts';
import {
  PERSISTENCE_PREPARE_CHECKPOINT_JOB,
  prepareCheckpointWorkerRequest,
} from '../core/persistence-worker-jobs.ts';
import {
  LOCAL_SEMANTIC_DECODE_CACHE_JOB,
  LOCAL_SEMANTIC_DISPOSE_MODEL_JOB,
  LOCAL_SEMANTIC_EMBED_JOB,
  LOCAL_SEMANTIC_ENCODE_CACHE_JOB,
  LOCAL_SEMANTIC_LOAD_MODEL_JOB,
  type LocalSemanticDecodeCacheRequest,
  type LocalSemanticEmbedRequest,
  type LocalSemanticEncodeCacheRequest,
  type LocalSemanticLoadModelRequest,
} from '../plugins/local-semantic-provider/worker-protocol.ts';
import {
  decodeLocalSemanticCache,
  disposeLocalSemanticModel,
  embedLocalSemanticTexts,
  encodeLocalSemanticCache,
  loadLocalSemanticModel,
} from '../plugins/local-semantic-provider/worker-jobs.ts';

type IncomingMessage = WorkerRequestMessage | WorkerCancelMessage;

const cancelled = new Set<string>();
const queue: WorkerRequestMessage[] = [];
let pumping = false;

globalThis.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (!message || typeof message.id !== 'string' || typeof message.type !== 'string') return;
  if (message.type === 'core.worker.cancel') {
    cancelled.add(message.id);
    return;
  }
  if ('payload' in message) {
    queue.push(message);
    schedulePump();
  }
});

function schedulePump(): void {
  if (pumping) return;
  pumping = true;
  setTimeout(() => { void pump(); }, 0);
}

async function pump(): Promise<void> {
  const message = queue.shift();
  if (!message) {
    pumping = false;
    return;
  }
  await execute(message);
  if (queue.length > 0) setTimeout(() => { void pump(); }, 0);
  else pumping = false;
}

async function execute(message: WorkerRequestMessage): Promise<void> {
  if (cancelled.delete(message.id)) return;
  try {
    const result = await runJob(message.type, message.payload);
    if (cancelled.delete(message.id)) return;
    const response: WorkerResponseMessage = { id: message.id, ok: true, result };
    if (result instanceof Uint32Array) globalThis.postMessage(response, { transfer: [result.buffer] });
    else globalThis.postMessage(response);
  } catch (error) {
    const response: WorkerResponseMessage = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    globalThis.postMessage(response);
  }
}

async function runJob(type: string, payload: unknown): Promise<unknown> {
  if (type === SEARCH_INDEX_BLOOM_JOB) {
    assertBloomRequest(payload);
    return buildSearchBloom(payload.text);
  }
  if (type === SEARCH_INDEX_SIGNATURE_JOB) {
    assertBloomRequest(payload);
    return buildSearchSignature(payload.text);
  }
  if (type === SEARCH_INDEX_POSTINGS_JOB) {
    assertPostingsRequest(payload);
    return buildCompressedSearchPostings(payload);
  }
  if (type === SEARCH_INDEX_ANALYZE_JOB) {
    assertAnalyzeRequest(payload);
    return analyzeSearchChunks(payload);
  }
  if (type === SEARCH_INDEX_RANK_JOB) {
    assertRankRequest(payload);
    return rankSearchChunks(payload);
  }
  if (type === TEXT_ASSIST_COMPILE_JOB) {
    assertTextAssistCompileRequest(payload);
    return compileTextAssistWorkerRequest(payload);
  }
  if (type === PERSISTENCE_PREPARE_CHECKPOINT_JOB) {
    return prepareCheckpointWorkerRequest(payload);
  }
  if (type === LOCAL_SEMANTIC_LOAD_MODEL_JOB) {
    assertLocalSemanticLoadRequest(payload);
    return loadLocalSemanticModel(payload);
  }
  if (type === LOCAL_SEMANTIC_EMBED_JOB) {
    assertLocalSemanticEmbedRequest(payload);
    return embedLocalSemanticTexts(payload);
  }
  if (type === LOCAL_SEMANTIC_ENCODE_CACHE_JOB) {
    assertLocalSemanticEncodeCacheRequest(payload);
    return encodeLocalSemanticCache(payload);
  }
  if (type === LOCAL_SEMANTIC_DECODE_CACHE_JOB) {
    assertLocalSemanticDecodeCacheRequest(payload);
    return decodeLocalSemanticCache(payload);
  }
  if (type === LOCAL_SEMANTIC_DISPOSE_MODEL_JOB) {
    await disposeLocalSemanticModel();
    return { disposed: true };
  }
  throw new Error(`Unknown managed worker job: ${type}`);
}

function assertLocalSemanticLoadRequest(value: unknown): asserts value is LocalSemanticLoadModelRequest {
  if (!isRecord(value) || !(value.model instanceof ArrayBuffer) || typeof value.tokenizer !== 'string' ||
    typeof value.tokenizerConfig !== 'string' || typeof value.runtimeModule !== 'string' ||
    typeof value.runtimeBackend !== 'string' ||
    !(value.runtimeWasm instanceof ArrayBuffer)) throw new Error('Invalid local semantic model worker request');
}

function assertLocalSemanticEmbedRequest(value: unknown): asserts value is LocalSemanticEmbedRequest {
  if (!isRecord(value) || !Array.isArray(value.texts) || value.texts.some((text) => typeof text !== 'string')) {
    throw new Error('Invalid local semantic embedding worker request');
  }
}

function assertLocalSemanticEncodeCacheRequest(value: unknown): asserts value is LocalSemanticEncodeCacheRequest {
  if (!isRecord(value) || !Array.isArray(value.sources) || value.sources.length > 10_000) {
    throw new Error('Invalid local semantic cache encode request');
  }
}

function assertLocalSemanticDecodeCacheRequest(value: unknown): asserts value is LocalSemanticDecodeCacheRequest {
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.length > 15 * 1024 * 1024) {
    throw new Error('Invalid local semantic cache decode request');
  }
}

function assertTextAssistCompileRequest(value: unknown): asserts value is TextAssistCompileRequest {
  if (!isRecord(value)) throw new Error('Invalid text assist resource request');
  let totalLength = 0;
  for (const role of ['common', 'personal', 'canvas', 'rules']) {
    const resource = value[role];
    if (typeof resource !== 'string' || resource.length > 16 * 1024 * 1024) {
      throw new Error(`Invalid text assist ${role} resource`);
    }
    totalLength += resource.length;
  }
  if (totalLength > 48 * 1024 * 1024) throw new Error('Text assist resources exceed worker limit');
}

function assertBloomRequest(value: unknown): asserts value is SearchIndexBloomRequest {
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.length > 128 * 1024) {
    throw new Error('Invalid search Bloom worker request');
  }
}

function assertPostingsRequest(value: unknown): asserts value is SearchIndexPostingsRequest {
  if (!isRecord(value) || !Array.isArray(value.chunks) || value.chunks.length > 200_000) {
    throw new Error('Invalid search postings worker request');
  }
  let totalTerms = 0;
  for (const chunk of value.chunks) {
    if (!isRecord(chunk) || !Number.isInteger(chunk.key) || (chunk.key as number) < 0 ||
      !(chunk.termHashes instanceof Uint32Array)) {
      throw new Error('Invalid search postings worker request');
    }
    totalTerms += chunk.termHashes.length;
    if (totalTerms > 8_500_000) throw new Error('Search postings worker request exceeds term limit');
  }
}

function assertAnalyzeRequest(value: unknown): asserts value is SearchIndexAnalyzeRequest {
  if (!isRecord(value) || !isStringList(value.terms, 24, 48) || typeof value.phrase !== 'string' ||
    value.phrase.length > 20_000 || !Array.isArray(value.chunks) || value.chunks.length > 16 ||
    value.chunks.some((chunk) => !isRecord(chunk) || !Number.isInteger(chunk.key) ||
      typeof chunk.title !== 'string' || chunk.title.length > 20_000 ||
      typeof chunk.text !== 'string' || chunk.text.length > 128 * 1024)) {
    throw new Error('Invalid search analysis worker request');
  }
}

function assertRankRequest(value: unknown): asserts value is SearchIndexRankRequest {
  if (!isRecord(value) || typeof value.totalChunks !== 'number' || !Number.isInteger(value.totalChunks) ||
    value.totalChunks < 0 ||
    !isStringList(value.terms, 24, 48) || !Array.isArray(value.candidates) ||
    value.candidates.length > 200_000 || value.candidates.some((candidate) =>
      !isRecord(candidate) || typeof candidate.key !== 'number' || !Number.isInteger(candidate.key) ||
      typeof candidate.title !== 'string' || typeof candidate.textLength !== 'number' ||
      !Number.isInteger(candidate.textLength) || candidate.textLength < 0 ||
      !Array.isArray(candidate.termFrequency) || candidate.termFrequency.length > 24 ||
      candidate.termFrequency.some((entry) => !Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== 'string' || typeof entry[1] !== 'number' || !Number.isFinite(entry[1])) ||
      typeof candidate.phraseMatch !== 'boolean')) {
    throw new Error('Invalid search ranking worker request');
  }
}

function isStringList(value: unknown, maximum: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum &&
    value.every((item) => typeof item === 'string' && item.length <= maximumLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
