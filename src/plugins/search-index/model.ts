import type { PluginContext, PluginDefinition, TaskHandle } from '../../core/contracts.ts';
import type {
  AIContextCatalogContribution,
  AIContextReadContribution,
  AIContextSearchContribution,
  AIContextSearchRequest,
  AIContextSource,
} from '../../protocols/ai.ts';
import { isAbortError } from '../../services/abort.ts';
import { defineManifest } from '../manifest.ts';
import {
  SEARCH_INDEX_ANALYZE_JOB,
  SEARCH_INDEX_POSTINGS_JOB,
  SEARCH_INDEX_SIGNATURE_JOB,
  SEARCH_INDEX_BLOOM_WORDS,
  SEARCH_INDEX_RANK_JOB,
  analyzeSearchChunks,
  buildCompressedSearchPostings,
  buildSearchSignature,
  findSearchPostingKeys,
  mightContainSearchTerm,
  rankSearchChunks,
  type SearchIndexAnalyzeRequest,
  type SearchIndexAnalyzedChunk,
  type SearchIndexCompressedPostings,
  type SearchIndexPostingsRequest,
  type SearchIndexRankRequest,
  type SearchIndexRankedChunk,
  type SearchIndexSignature,
} from './worker-jobs.ts';

const READ_WINDOW = 32 * 1024;
const TERM_BOUNDARY_OVERLAP = 96;
const REBUILD_DELAY_MS = 500;
const ANALYSIS_BATCH_SIZE = 16;

export interface SearchIndexStatus {
  state: 'idle' | 'building' | 'ready' | 'error';
  indexedSources: number;
  totalSources: number;
  approximateBytes: number;
  lastBuiltAt?: number;
  error?: string;
}

interface IndexedSource {
  source: AIContextSource;
  chunks: IndexedChunk[];
}

interface IndexedChunk {
  start: number;
  length: number;
  bloom: Uint32Array;
  termHashes: Uint32Array;
  postingOverflow: boolean;
}

interface RuntimeChunk {
  entry: IndexedSource;
  chunk: IndexedChunk;
}

interface RuntimeSearchIndex {
  chunks: RuntimeChunk[];
  postings: SearchIndexCompressedPostings;
  overflowKeys: Set<number>;
}

const EMPTY_POSTINGS: SearchIndexCompressedPostings = {
  termHashes: new Uint32Array(),
  offsets: new Uint32Array(1),
  postings: new Uint8Array(),
};

interface VerifiedChunk {
  key: number;
  entry: IndexedSource;
  chunk: IndexedChunk;
  readStart: number;
  textLength: number;
  termFrequency: Array<[string, number]>;
  firstMatch: number;
  phraseMatch: boolean;
  previewStart: number;
  preview: string;
}

export function createSearchIndexPlugin(): PluginDefinition {
  const index = new Map<string, IndexedSource>();
  let runtimeIndex: RuntimeSearchIndex = { chunks: [], postings: EMPTY_POSTINGS, overflowKeys: new Set() };
  let task: TaskHandle<void> | undefined;
  let status: SearchIndexStatus = {
    state: 'idle', indexedSources: 0, totalSources: 0, approximateBytes: 0,
  };

  return {
    manifest: defineManifest('search-index', '画布检索索引', {
      requiresCapabilities: ['context.catalog@1', 'context.read@1'],
      providesCapabilities: ['context.search@2', 'context.search@3', 'search.index.status@1'],
      events: ['content.changed', 'node.created', 'node.renamed', 'nodes.deleted', 'document.replaced'],
      permissions: ['content.context.read', 'tasks.schedule', 'workers.run'],
      workerJobs: [
        SEARCH_INDEX_SIGNATURE_JOB,
        SEARCH_INDEX_POSTINGS_JOB,
        SEARCH_INDEX_ANALYZE_JOB,
        SEARCH_INDEX_RANK_JOB,
      ],
    }),

    start(context) {
      index.clear();
      status = { state: 'idle', indexedSources: 0, totalSources: 0, approximateBytes: 0 };

      const updateStatus = (patch: Partial<SearchIndexStatus>) => {
        status = { ...status, ...patch };
      };

      const scheduleRebuild = (delay = REBUILD_DELAY_MS) => {
        task?.cancel();
        updateStatus({ state: 'building', error: undefined });
        const nextTask = context.tasks.schedule<void>({
            category: 'search-index-rebuild',
            label: '正在更新画布检索目录',
            delayMs: delay,
            priority: 2,
            timeoutMs: 20 * 60_000,
            estimatedCost: 5,
            run: async (signal, report, control) => {
              const sources = await readCatalog(context);
              updateStatus({ totalSources: sources.length });
              const available = new Set(sources.map((source) => source.sourceId));
              for (const id of [...index.keys()]) if (!available.has(id)) index.delete(id);
              for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
                assertNotAborted(signal);
                await control.waitIfPaused();
                const source = sources[sourceIndex];
                const existing = index.get(source.sourceId);
                if (!existing || existing.source.revision !== source.revision ||
                  existing.source.length !== source.length || existing.source.title !== source.title) {
                  index.set(source.sourceId, await buildSourceIndex(context, source, signal, control));
                }
                report(sources.length === 0 ? 1 : (sourceIndex + 1) / sources.length);
              }
              const nextRuntimeIndex = await buildRuntimeSearchIndex(context, index, signal);
              assertNotAborted(signal);
              runtimeIndex = nextRuntimeIndex;
              updateStatus({
                state: 'ready',
                indexedSources: index.size,
                totalSources: sources.length,
                approximateBytes: approximateIndexBytes(index, runtimeIndex.postings),
                lastBuiltAt: Date.now(),
                error: undefined,
              });
            },
        });
        task = nextTask;
        void nextTask.result.catch((error) => {
          if (isAbortError(error)) return;
          updateStatus({ state: 'error', error: error instanceof Error ? error.message : String(error) });
          context.diagnostics.warn('画布检索索引重建失败', error);
        }).finally(() => {
          if (task === nextTask) task = undefined;
        });
      };

      const ensureReady = async () => {
        if (status.state === 'ready') return;
        if (!task) scheduleRebuild(0);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (task) await task.result;
        if (!isIndexReady(status)) throw new Error('检索索引尚未就绪');
      };

      context.capabilities.provide<AIContextSearchRequest, AIContextSearchContribution>({
        key: 'context.search@2',
        invoke: async (input, signal) => {
          validateSearchRequest(input);
          await ensureReady();
          return searchBM25(context, runtimeIndex, input, signal);
        },
      });
      context.capabilities.provide<AIContextSearchRequest, AIContextSearchContribution>({
        key: 'context.search@3',
        invoke: async (input, signal) => {
          validateSearchRequest(input);
          await ensureReady();
          return searchBM25(context, runtimeIndex, input, signal);
        },
      });

      context.capabilities.provide<undefined, SearchIndexStatus>({
        key: 'search.index.status@1',
        invoke: () => ({ ...status }),
      });

      context.events.subscribe<{ nodeId?: string }>('content.changed', (message) => {
        if (message.payload.nodeId) index.delete(message.payload.nodeId);
        updateStatus({ state: 'idle', indexedSources: index.size });
        scheduleRebuild();
      });
      context.events.subscribe<{ ids?: string[] }>('nodes.deleted', (message) => {
        for (const id of message.payload.ids ?? []) index.delete(id);
        updateStatus({ state: 'idle', indexedSources: index.size });
        scheduleRebuild();
      });
      context.events.subscribe('node.created', () => {
        updateStatus({ state: 'idle' });
        scheduleRebuild();
      });
      context.events.subscribe<{ nodeId?: string }>('node.renamed', (message) => {
        if (message.payload.nodeId) index.delete(message.payload.nodeId);
        updateStatus({ state: 'idle', indexedSources: index.size });
        scheduleRebuild();
      });
      context.events.subscribe('document.replaced', () => {
        index.clear();
        updateStatus({ state: 'idle', indexedSources: 0 });
        scheduleRebuild(0);
      });
      scheduleRebuild(0);
    },

    stop() {
      task?.cancel();
      task = undefined;
      index.clear();
      runtimeIndex = { chunks: [], postings: EMPTY_POSTINGS, overflowKeys: new Set() };
      status = { state: 'idle', indexedSources: 0, totalSources: 0, approximateBytes: 0 };
    },
  };
}

async function buildSourceIndex(
  context: PluginContext,
  source: AIContextSource,
  signal: AbortSignal,
  control: { waitIfPaused(): Promise<void> },
): Promise<IndexedSource> {
  const chunks: IndexedChunk[] = [];
  let tail = '';
  for (let start = 0; start < source.length; start += READ_WINDOW) {
    assertNotAborted(signal);
    await control.waitIfPaused();
    const read = await readSource(context, source.sourceId, start, Math.min(READ_WINDOW, source.length - start), signal);
    const signature = await executeSearchWorker<SearchIndexSignature>(
      context,
      SEARCH_INDEX_SIGNATURE_JOB,
      { text: `${source.title}\n${tail}${read}` },
      signal,
      () => buildSearchSignature(`${source.title}\n${tail}${read}`),
    );
    chunks.push({
      start,
      length: read.length,
      bloom: signature.bloom,
      termHashes: signature.termHashes,
      postingOverflow: signature.overflow,
    });
    tail = read.slice(-TERM_BOUNDARY_OVERLAP);
    if ((start / READ_WINDOW) % 8 === 7) await yieldToMainThread();
  }
  if (chunks.length === 0) {
    const signature = await executeSearchWorker<SearchIndexSignature>(
      context,
      SEARCH_INDEX_SIGNATURE_JOB,
      { text: source.title },
      signal,
      () => buildSearchSignature(source.title),
    );
    chunks.push({
      start: 0,
      length: 0,
      bloom: signature.bloom,
      termHashes: signature.termHashes,
      postingOverflow: signature.overflow,
    });
  }
  return { source: { ...source }, chunks };
}

async function searchBM25(
  context: PluginContext,
  index: RuntimeSearchIndex,
  input: AIContextSearchRequest,
  signal?: AbortSignal,
): Promise<AIContextSearchContribution> {
  const terms = normalizeTerms([...(input.terms ?? []), ...(input.expandedTerms ?? [])]);
  const sourceFilter = input.sourceIds?.length ? new Set(input.sourceIds) : undefined;
  const candidateKeys = collectCandidateKeys(index, terms);
  const candidateChunks: RuntimeChunk[] = [];
  let totalChunks = 0;
  for (let key = 0; key < index.chunks.length; key += 1) {
    const candidate = index.chunks[key];
    if (sourceFilter && !sourceFilter.has(candidate.entry.source.sourceId)) continue;
    totalChunks += 1;
    if (candidateKeys === undefined || candidateKeys.has(key) || (
      index.overflowKeys.has(key) && terms.some((term) => mightContainSearchTerm(candidate.chunk.bloom, term))
    )) {
      candidateChunks.push(candidate);
    }
  }

  const verified: VerifiedChunk[] = [];
  const phrase = input.query?.trim().toLocaleLowerCase('zh-CN') ?? '';
  for (let batchStart = 0; batchStart < candidateChunks.length; batchStart += ANALYSIS_BATCH_SIZE) {
    assertNotAborted(signal);
    const analysisInput: SearchIndexAnalyzeRequest = { terms, phrase, chunks: [] };
    const metadata = new Map<number, {
      entry: IndexedSource;
      chunk: IndexedChunk;
      readStart: number;
    }>();
    const batchEnd = Math.min(candidateChunks.length, batchStart + ANALYSIS_BATCH_SIZE);
    for (let candidateIndex = batchStart; candidateIndex < batchEnd; candidateIndex += 1) {
      const { entry, chunk } = candidateChunks[candidateIndex];
      const readStart = Math.max(0, chunk.start - TERM_BOUNDARY_OVERLAP);
      const readLength = Math.min(
        entry.source.length - readStart,
        chunk.length + TERM_BOUNDARY_OVERLAP * 2,
      );
      const text = await readSource(context, entry.source.sourceId, readStart, readLength, signal);
      analysisInput.chunks.push({ key: candidateIndex, title: entry.source.title, text });
      metadata.set(candidateIndex, { entry, chunk, readStart });
    }
    const analyzed = await executeSearchWorker<SearchIndexAnalyzedChunk[]>(
      context,
      SEARCH_INDEX_ANALYZE_JOB,
      analysisInput,
      signal,
      () => analyzeSearchChunks(analysisInput),
    );
    for (const result of analyzed) {
      const source = metadata.get(result.key);
      if (!source) continue;
      verified.push({ ...source, ...result });
    }
    await yieldToMainThread();
  }

  const rankInput: SearchIndexRankRequest = {
    totalChunks,
    terms,
    candidates: verified.map((chunk) => ({
      key: chunk.key,
      title: chunk.entry.source.title,
      textLength: chunk.textLength,
      termFrequency: chunk.termFrequency,
      phraseMatch: chunk.phraseMatch,
    })),
  };
  const ranked = await executeSearchWorker<SearchIndexRankedChunk[]>(
    context,
    SEARCH_INDEX_RANK_JOB,
    rankInput,
    signal,
    () => rankSearchChunks(rankInput),
  );
  const scores = new Map(ranked.map((chunk) => [chunk.key, chunk.score]));
  const bestBySource = new Map<string, AIContextSearchContribution['hits'][number]>();
  for (const chunk of verified) {
    const score = scores.get(chunk.key) ?? 0;
    const previewStart = chunk.readStart + chunk.previewStart;
    const hit = {
      source: { ...chunk.entry.source },
      start: previewStart,
      length: Math.min(420, Math.max(0, chunk.entry.source.length - previewStart)),
      preview: chunk.preview,
      score,
      matchedTerms: chunk.termFrequency.map(([term]) => term),
      retrievalMethod: (chunk.phraseMatch ? 'exact' : 'bm25') as 'exact' | 'bm25',
    };
    const existing = bestBySource.get(hit.source.sourceId);
    if (!existing || hit.score > existing.score) bestBySource.set(hit.source.sourceId, hit);
  }
  const hits = [...bestBySource.values()]
    .sort((left, right) => right.score - left.score || left.source.title.localeCompare(right.source.title, 'zh-CN'))
    .slice(0, input.maxResults);
  return { provider: 'search-index-bm25', hits, scanned: candidateChunks.length };
}

async function buildRuntimeSearchIndex(
  context: PluginContext,
  index: Map<string, IndexedSource>,
  signal: AbortSignal,
): Promise<RuntimeSearchIndex> {
  const chunks: RuntimeChunk[] = [];
  const overflowKeys = new Set<number>();
  const request: SearchIndexPostingsRequest = { chunks: [] };
  for (const entry of index.values()) {
    for (const chunk of entry.chunks) {
      const key = chunks.length;
      chunks.push({ entry, chunk });
      if (chunk.postingOverflow) overflowKeys.add(key);
      else request.chunks.push({ key, termHashes: chunk.termHashes });
    }
  }
  const postings = await executeSearchWorker<SearchIndexCompressedPostings>(
    context,
    SEARCH_INDEX_POSTINGS_JOB,
    request,
    signal,
    () => buildCompressedSearchPostings(request),
  );
  return { chunks, postings, overflowKeys };
}

function collectCandidateKeys(index: RuntimeSearchIndex, terms: string[]): Set<number> | undefined {
  const keys = new Set<number>();
  for (const term of terms) {
    const posting = findSearchPostingKeys(index.postings, term);
    if (!posting) return undefined;
    for (const key of posting) keys.add(key);
  }
  return keys;
}

function approximateIndexBytes(
  index: Map<string, IndexedSource>,
  postings: SearchIndexCompressedPostings,
): number {
  let bytes = postings.termHashes.byteLength + postings.offsets.byteLength + postings.postings.byteLength;
  for (const entry of index.values()) {
    for (const chunk of entry.chunks) {
      bytes += SEARCH_INDEX_BLOOM_WORDS * Uint32Array.BYTES_PER_ELEMENT + chunk.termHashes.byteLength;
    }
  }
  return bytes;
}

async function readCatalog(context: PluginContext): Promise<AIContextSource[]> {
  const contributions = await context.capabilities.requestAll<AIContextCatalogContribution>('context.catalog@1');
  const byId = new Map<string, AIContextSource>();
  for (const source of contributions.flatMap((contribution) => contribution.sources)) {
    if (source.automaticRetrieval === false) continue;
    if (!byId.has(source.sourceId)) byId.set(source.sourceId, source);
  }
  return [...byId.values()];
}

async function readSource(
  context: PluginContext,
  sourceId: string,
  start: number,
  length: number,
  signal?: AbortSignal,
): Promise<string> {
  const contributions = await context.capabilities.requestAll<AIContextReadContribution>(
    'context.read@1',
    { sourceId, start, length },
    signal,
  );
  const handled = contributions.find((result) => result.handled);
  if (!handled || typeof handled.text !== 'string') return '';
  return handled.text;
}

function normalizeTerms(raw: string[]): string[] {
  return [...new Set(raw.map((term) => term.trim().toLocaleLowerCase('zh-CN')).filter(Boolean))].slice(0, 24);
}

async function executeSearchWorker<TResult>(
  context: PluginContext,
  type: string,
  payload: unknown,
  signal: AbortSignal | undefined,
  fallback: () => TResult,
): Promise<TResult> {
  assertNotAborted(signal);
  if (!context.workers.available()) return fallback();
  return context.workers.run<TResult>(type, payload, signal);
}

function validateSearchRequest(input: AIContextSearchRequest): void {
  if (!input || !Array.isArray(input.terms) || input.terms.length === 0 || input.terms.length > 8 ||
    input.terms.some((term) => typeof term !== 'string' || term.length === 0 || term.length > 48) ||
    (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 20_000)) ||
    (input.expandedTerms !== undefined && (!Array.isArray(input.expandedTerms) || input.expandedTerms.length > 16 ||
      input.expandedTerms.some((term) => typeof term !== 'string' || term.length === 0 || term.length > 48))) ||
    (input.sourceIds !== undefined && (!Array.isArray(input.sourceIds) || input.sourceIds.length > 100 ||
      input.sourceIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200))) ||
    !Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 50) {
    throw new Error('索引检索请求不正确');
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isIndexReady(status: SearchIndexStatus): boolean {
  return status.state === 'ready';
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
