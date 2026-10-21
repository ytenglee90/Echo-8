import type {
  PluginContext,
  PluginDefinition,
  TaskHandle,
} from '../../core/contracts.ts';
import type { LocalModelAsset } from '../../core/network-access.ts';
import type { PersonalTextAssetRecord } from '../../protocols/personal-assets.ts';
import type {
  AIContextSearchContribution,
  AIContextSearchRequest,
  AIContextSource,
} from '../../protocols/ai.ts';
import {
  LOCAL_SEMANTIC_PROVIDER_CHANGED_SIGNAL,
  LOCAL_SEMANTIC_PROVIDER_COMMANDS,
  LOCAL_SEMANTIC_PROVIDER_STATE_QUERY,
  type LocalSemanticProviderConfiguration,
  type LocalSemanticProviderPanelState,
} from '../../protocols/local-semantic.ts';
import { SEMANTIC_BLOCK_LENGTH } from '../../ai/semantic-blocks.ts';
import {
  readSemanticCatalog,
  sampleSemanticSource,
  semanticPreview,
} from '../../ai/semantic-source-sampling.ts';
import { localSemanticProviderManifest, LOCAL_SEMANTIC_PROVIDER_NAMESPACE } from './manifest.ts';
import {
  LOCAL_SEMANTIC_DECODE_CACHE_JOB,
  LOCAL_SEMANTIC_DISPOSE_MODEL_JOB,
  LOCAL_SEMANTIC_EMBED_JOB,
  LOCAL_SEMANTIC_ENCODE_CACHE_JOB,
  LOCAL_SEMANTIC_LOAD_MODEL_JOB,
  type LocalSemanticCacheSource,
  type LocalSemanticDecodeCacheResult,
  type LocalSemanticEmbedResult,
  type LocalSemanticEncodeCacheResult,
} from './worker-protocol.ts';

export { LOCAL_SEMANTIC_PROVIDER_NAMESPACE } from './manifest.ts';

const MAX_SOURCES = 10_000;
const EMBED_BATCH_SIZE = 8;
const PERSISTED_CACHE_ASSET_KEY = 'bge-small-zh-v1.5-index@1';
const PERSISTED_CACHE_PAYLOAD_BUDGET = 14 * 1024 * 1024;
const LOCAL_MODEL_DOWNLOAD_STEPS: ReadonlyArray<{ asset: LocalModelAsset; label: string }> = [
  { asset: 'bge-small-zh-v1.5.model', label: '中文语义模型' },
  { asset: 'bge-small-zh-v1.5.tokenizer', label: '中文分词器' },
  { asset: 'bge-small-zh-v1.5.tokenizer-config', label: '分词配置' },
  { asset: 'onnxruntime-web.wasm-runtime', label: 'ONNX 运行时入口' },
  { asset: 'onnxruntime-web.wasm-backend', label: 'ONNX Web 后端' },
  { asset: 'onnxruntime-web.wasm-binary', label: 'ONNX WASM 引擎' },
];

interface CachedChunk {
  source: AIContextSource;
  start: number;
  length: number;
  fingerprint: string;
  preview: string;
  vector: Float32Array;
  coverage: 'full' | 'sampled';
}

interface PersistentCacheSnapshot {
  available: boolean;
  sources: Map<string, LocalSemanticCacheSource>;
}

export function createLocalSemanticProviderPlugin(panel?: unknown): PluginDefinition {
  let cacheBySource = new Map<string, CachedChunk[]>();
  let indexTask: TaskHandle<void> | undefined;
  let modelLoaded = false;
  let cacheState: LocalSemanticProviderPanelState['cache'] = emptyCache('idle');

  return {
    manifest: localSemanticProviderManifest,

    start(context) {
      cacheBySource = new Map();
      indexTask = undefined;
      modelLoaded = false;
      cacheState = emptyCache(readConfiguration(context).enabled ? 'idle' : 'disabled');
      const notify = (reason: string, detail: Record<string, unknown> = {}) => {
        context.signals.emit(LOCAL_SEMANTIC_PROVIDER_CHANGED_SIGNAL, { reason, ...detail });
      };
      const enabled = () => readConfiguration(context).enabled;
      const readState = (): LocalSemanticProviderPanelState => ({
        enabled: enabled(),
        modelLoaded,
        cache: { ...cacheState },
      });
      const clearCache = (status: LocalSemanticProviderPanelState['cache']['status']) => {
        cacheBySource = new Map();
        cacheState = emptyCache(status);
      };
      const disposeModel = async () => {
        if (!modelLoaded) return;
        modelLoaded = false;
        if (!context.workers.available()) return;
        try {
          await context.workers.run(LOCAL_SEMANTIC_DISPOSE_MODEL_JOB);
        } catch (error) {
          context.diagnostics.warn('释放本地语义模型失败', error);
        }
      };
      const ensureModel = async (signal: AbortSignal, report: (progress: number) => void) => {
        if (modelLoaded) return;
        if (!context.workers.available()) throw new Error('当前环境无法启动本地语义 Worker');
        const download = async (asset: LocalModelAsset) => {
          const current = LOCAL_MODEL_DOWNLOAD_STEPS.findIndex((step) => step.asset === asset) + 1;
          const step = LOCAL_MODEL_DOWNLOAD_STEPS[current - 1];
          cacheState = {
            ...cacheState,
            status: 'downloading',
            error: undefined,
            download: { current, total: LOCAL_MODEL_DOWNLOAD_STEPS.length, label: step.label },
          };
          notify('model-download-progress', { asset, current, total: LOCAL_MODEL_DOWNLOAD_STEPS.length });
          const result = await context.network.downloadLocalModelAsset(asset, signal);
          report(0.12 * current / LOCAL_MODEL_DOWNLOAD_STEPS.length);
          return result;
        };
        cacheState = {
          ...cacheState,
          status: 'downloading',
          error: undefined,
          download: { current: 1, total: LOCAL_MODEL_DOWNLOAD_STEPS.length, label: LOCAL_MODEL_DOWNLOAD_STEPS[0].label },
        };
        notify('model-downloading');
        const model = await download('bge-small-zh-v1.5.model');
        const tokenizer = await download('bge-small-zh-v1.5.tokenizer');
        const tokenizerConfig = await download('bge-small-zh-v1.5.tokenizer-config');
        const runtimeModule = await download('onnxruntime-web.wasm-runtime');
        const runtimeBackend = await download('onnxruntime-web.wasm-backend');
        const runtimeWasm = await download('onnxruntime-web.wasm-binary');
        const decoder = new TextDecoder();
        await context.workers.run(
          LOCAL_SEMANTIC_LOAD_MODEL_JOB,
          {
            model: model.data,
            tokenizer: decoder.decode(tokenizer.data),
            tokenizerConfig: decoder.decode(tokenizerConfig.data),
            runtimeModule: decoder.decode(runtimeModule.data),
            runtimeBackend: decoder.decode(runtimeBackend.data),
            runtimeWasm: runtimeWasm.data,
          },
          signal,
          [model.data, tokenizer.data, tokenizerConfig.data, runtimeModule.data, runtimeBackend.data, runtimeWasm.data],
        );
        modelLoaded = true;
        cacheState = { ...cacheState, status: 'indexing', download: undefined };
        notify('model-ready');
      };
      const scheduleIndex = (force = false): TaskHandle<void> => {
        if (indexTask) return indexTask;
        if (!enabled()) throw new Error('本地语义检索已关闭');
        cacheState = { ...cacheState, status: 'indexing', error: undefined };
        notify('indexing');
        const task = context.tasks.schedule<void>({
          category: 'ai.local-semantic.index',
          label: '正在建立本地语义检索索引',
          priority: 19,
          noticeAfterMs: 650,
          timeoutMs: 20 * 60_000,
          estimatedCost: 6,
          run: async (signal, report, control) => {
            try {
              await buildIndex(context, {
                force,
                signal,
                report,
                waitIfPaused: control.waitIfPaused,
                ensureModel,
                readCache: () => cacheBySource,
                writeCache: (next) => { cacheBySource = next; },
                updateState: (next) => {
                  cacheState = { ...cacheState, ...next };
                  notify('index-progress');
                },
              });
              cacheState = {
                ...cacheState,
                status: 'ready',
                indexedSources: cacheBySource.size,
                indexedChunks: countChunks(cacheBySource),
                partialSources: countPartialSources(cacheBySource),
                lastBuiltAt: Date.now(),
                error: undefined,
              };
              notify('index-ready');
            } catch (error) {
              if (isAbortError(error)) throw error;
              cacheState = {
                ...cacheState,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
                download: undefined,
              };
              notify('index-error');
              throw error;
            }
          },
        });
        indexTask = task;
        void task.result.then(
          () => { if (indexTask === task) indexTask = undefined; },
          () => { if (indexTask === task) indexTask = undefined; },
        );
        return task;
      };
      const markDirty = (force = false) => {
        if (!enabled() || (!force && cacheBySource.size === 0)) return;
        if (indexTask) indexTask.cancel();
        indexTask = undefined;
        cacheState = { ...cacheState, status: 'dirty', error: undefined };
        notify('dirty');
      };

      context.commands.register<{ enabled: boolean }>({
        type: LOCAL_SEMANTIC_PROVIDER_COMMANDS.setEnabled,
        validate: (value): value is { enabled: boolean } => isRecord(value) && typeof value.enabled === 'boolean',
        handle: async ({ enabled: nextEnabled }) => {
          if (!nextEnabled) {
            indexTask?.cancel();
            indexTask = undefined;
            clearCache('disabled');
            await disposeModel();
          } else if (cacheState.status === 'disabled') {
            cacheState = emptyCache('idle');
          }
          notify(nextEnabled ? 'enabled' : 'disabled');
          return {
            transaction: {
              label: nextEnabled ? '启用本地语义检索' : '关闭本地语义检索',
              history: false,
              patches: [{
                op: 'set', domain: 'workspace', namespace: LOCAL_SEMANTIC_PROVIDER_NAMESPACE,
                key: 'configuration', value: { enabled: nextEnabled } satisfies LocalSemanticProviderConfiguration,
              }],
              events: [{ type: 'local.semantic.provider.configuration.changed', payload: { enabled: nextEnabled } }],
            },
          };
        },
      });
      context.commands.register<{ force?: boolean }>({
        type: LOCAL_SEMANTIC_PROVIDER_COMMANDS.rebuild,
        validate: (value): value is { force?: boolean } => value === undefined ||
          (isRecord(value) && (value.force === undefined || typeof value.force === 'boolean')),
        handle: (payload = {}) => ({ result: { taskId: scheduleIndex(payload.force ?? true).id } }),
      });
      context.commands.register({
        type: LOCAL_SEMANTIC_PROVIDER_COMMANDS.cancelIndex,
        handle: () => {
          if (!indexTask) return { result: { cancelled: false } };
          indexTask.cancel();
          indexTask = undefined;
          cacheState = {
            ...cacheState,
            status: cacheBySource.size > 0 ? 'dirty' : 'idle',
            error: undefined,
            download: undefined,
          };
          notify('index-cancelled');
          return { result: { cancelled: true } };
        },
      });
      context.commands.register({
        type: LOCAL_SEMANTIC_PROVIDER_COMMANDS.clearRuntimeCache,
        handle: async () => {
          indexTask?.cancel();
          indexTask = undefined;
          clearCache(enabled() ? 'idle' : 'disabled');
          await disposeModel();
          notify('cache-cleared');
          return { result: { cleared: true } };
        },
      });
      context.queries.register({ type: LOCAL_SEMANTIC_PROVIDER_STATE_QUERY, handle: readState });
      context.capabilities.provide<AIContextSearchRequest, AIContextSearchContribution>({
        key: 'context.semanticSearch@1',
        priority: 24,
        invoke: async (input, signal) => {
          validateSearchRequest(input);
          if (!enabled()) return emptyContribution();
          try {
            await scheduleIndex(false).result;
            if (signal?.aborted) throw abortError();
            const query = input.query?.trim() || input.terms.join(' ');
            const [vector] = await embedTexts(context, [query], signal);
            return vector ? searchCache(cacheBySource, vector, input) : emptyContribution();
          } catch (error) {
            if (isAbortError(error)) throw error;
            context.diagnostics.warn('本地语义检索不可用，已保留 BM25 结果', error);
            return emptyContribution();
          }
        },
      });
      context.events.subscribe('content.changed', () => markDirty());
      context.events.subscribe('nodes.deleted', () => markDirty());
      context.events.subscribe('node.created', () => markDirty());
      context.events.subscribe('node.renamed', () => markDirty());
      context.events.subscribe('document.replaced', () => markDirty(true));
      if (panel) {
        context.ui.contribute({
          id: 'local-semantic-provider.settings',
          slot: 'ai.retrieval',
          kind: 'view',
          label: '本地语义检索',
          component: panel,
          // This is the recommended retrieval path. Keep it immediately
          // before the optional cloud retrieval alternative.
          priority: 85,
        });
      }
    },

    async stop(context) {
      indexTask?.cancel();
      indexTask = undefined;
      cacheBySource = new Map();
      cacheState = emptyCache('idle');
      if (modelLoaded && context.workers.available()) {
        try {
          await context.workers.run(LOCAL_SEMANTIC_DISPOSE_MODEL_JOB);
        } catch {
          // Worker disposal is best-effort while plugin resources are shutting down.
        }
      }
      modelLoaded = false;
    },
  };
}

async function buildIndex(
  context: PluginContext,
  options: {
    force: boolean;
    signal: AbortSignal;
    report(progress: number): void;
    waitIfPaused(): Promise<void>;
    ensureModel(signal: AbortSignal, report: (progress: number) => void): Promise<void>;
    readCache(): Map<string, CachedChunk[]>;
    writeCache(next: Map<string, CachedChunk[]>): void;
    updateState(next: Partial<LocalSemanticProviderPanelState['cache']>): void;
  },
): Promise<void> {
  const catalog = await readSemanticCatalog(context, options.signal);
  if (catalog.length > MAX_SOURCES) throw new Error(`当前画布有 ${catalog.length} 个可检索来源，超过单次本地语义索引上限 ${MAX_SOURCES}`);
  const persistent = await readPersistentCache(context, options.signal, options.force);
  const liveIds = new Set(catalog.map((source) => source.sourceId));
  const currentCache = options.readCache();
  const staged = new Map([...currentCache].filter(([sourceId]) => liveIds.has(sourceId)));
  const stale = options.force ? catalog : catalog.filter((source) => {
    const chunks = staged.get(source.sourceId);
    return !chunks?.length || chunks[0].source.revision !== source.revision;
  });
  options.updateState({ totalSources: catalog.length });
  if (stale.length === 0) {
    if (staged.size !== currentCache.size) await persistCache(context, staged, persistent.available, options.signal);
    options.writeCache(staged);
    options.report(1);
    return;
  }
  await options.ensureModel(options.signal, options.report);
  const sampled = [] as Awaited<ReturnType<typeof sampleSemanticSource>>[];
  for (let index = 0; index < stale.length; index += 1) {
    assertNotAborted(options.signal);
    await options.waitIfPaused();
    sampled.push(await sampleSemanticSource(context, stale[index], options.signal));
    if (index % 12 === 11) await yieldToMainThread();
    options.report(0.12 + 0.2 * (index + 1) / stale.length);
  }
  const nextChunks = new Map<string, CachedChunk[]>();
  const pending = new Map<string, Array<{ source: AIContextSource; start: number; text: string; fingerprint: string; coverage: 'full' | 'sampled' }>>();
  for (const sample of sampled) {
    const previous = new Map((staged.get(sample.source.sourceId) ?? []).map((chunk) => [chunk.fingerprint, chunk]));
    const retained = new Map(
      (persistent.sources.get(sample.source.sourceId)?.chunks ?? []).map((chunk) => [chunk.fingerprint, chunk]),
    );
    const chunks: CachedChunk[] = [];
    for (const block of sample.samples) {
      const existing = previous.get(block.fingerprint);
      if (existing) {
        chunks.push({
          ...existing,
          source: { ...sample.source },
          start: block.start,
          length: block.text.length,
          preview: semanticPreview(block.text),
          coverage: sample.coverage,
        });
        continue;
      }
      const retainedChunk = retained.get(block.fingerprint);
      if (retainedChunk) {
        chunks.push({
          source: { ...sample.source },
          start: block.start,
          length: block.text.length,
          fingerprint: block.fingerprint,
          preview: semanticPreview(block.text),
          vector: retainedChunk.vector,
          coverage: sample.coverage,
        });
        continue;
      }
      const group = pending.get(block.fingerprint) ?? [];
      group.push({ source: sample.source, ...block, coverage: sample.coverage });
      pending.set(block.fingerprint, group);
    }
    nextChunks.set(sample.source.sourceId, chunks);
  }
  const representatives = [...pending.values()].map((group) => group[0]);
  for (let offset = 0; offset < representatives.length; offset += EMBED_BATCH_SIZE) {
    assertNotAborted(options.signal);
    await options.waitIfPaused();
    const batch = representatives.slice(offset, offset + EMBED_BATCH_SIZE);
    const vectors = await embedTexts(context, batch.map((entry) => `${entry.source.title}\n${entry.text}`.slice(0, SEMANTIC_BLOCK_LENGTH + 240)), options.signal);
    if (vectors.length !== batch.length) throw new Error('本地语义模型返回的向量数量不一致');
    batch.forEach((representative, index) => {
      for (const entry of pending.get(representative.fingerprint) ?? [representative]) {
        const chunks = nextChunks.get(entry.source.sourceId) ?? [];
        chunks.push({
          source: { ...entry.source }, start: entry.start, length: entry.text.length,
          fingerprint: entry.fingerprint, preview: semanticPreview(entry.text), vector: vectors[index], coverage: entry.coverage,
        });
        nextChunks.set(entry.source.sourceId, chunks);
      }
    });
    const completed = Math.min(representatives.length, offset + batch.length);
    options.report(0.32 + 0.68 * completed / Math.max(1, representatives.length));
    options.updateState({
      indexedSources: staged.size + nextChunks.size,
      indexedChunks: countChunks(staged) + countChunks(nextChunks),
      partialSources: countPartialSources(staged) + countPartialSources(nextChunks),
    });
  }
  for (const source of stale) staged.delete(source.sourceId);
  for (const [sourceId, chunks] of nextChunks) staged.set(sourceId, chunks);
  await persistCache(context, staged, persistent.available, options.signal);
  options.writeCache(staged);
  options.report(1);
}

async function readPersistentCache(
  context: PluginContext,
  signal: AbortSignal,
  ignoreStored: boolean,
): Promise<PersistentCacheSnapshot> {
  let asset: PersonalTextAssetRecord | undefined;
  try {
    asset = await context.queries.ask<PersonalTextAssetRecord | undefined>('system.personalAssets.get', {
      key: PERSISTED_CACHE_ASSET_KEY,
    });
  } catch {
    return { available: false, sources: new Map() };
  }
  assertNotAborted(signal);
  if (ignoreStored || !asset?.text) return { available: true, sources: new Map() };
  try {
    const decoded = await context.workers.run<LocalSemanticDecodeCacheResult>(
      LOCAL_SEMANTIC_DECODE_CACHE_JOB,
      { text: asset.text },
      signal,
    );
    return {
      available: true,
      sources: new Map(decoded.sources.map((source) => [source.sourceId, source])),
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    context.diagnostics.warn('已忽略损坏或不兼容的本地语义缓存', error);
    return { available: true, sources: new Map() };
  }
}

async function persistCache(
  context: PluginContext,
  cache: Map<string, CachedChunk[]>,
  available: boolean,
  signal: AbortSignal,
): Promise<void> {
  if (!available) return;
  assertNotAborted(signal);
  try {
    const selected = selectPersistentSources(cache);
    const encoded = await context.workers.run<LocalSemanticEncodeCacheResult>(
      LOCAL_SEMANTIC_ENCODE_CACHE_JOB,
      { sources: selected.sources },
      signal,
    );
    assertNotAborted(signal);
    await context.commands.dispatch('system.personalAssets.set', {
      key: PERSISTED_CACHE_ASSET_KEY,
      asset: {
        schemaVersion: 1,
        text: encoded.text,
        fileName: 'Echo-8-local-semantic-index-v1.json',
        updatedAt: Date.now(),
      } satisfies PersonalTextAssetRecord,
    });
    if (selected.truncated || encoded.truncated) {
      context.diagnostics.info('本地语义持久缓存达到上限，未缓存的向量将在需要时重建', {
        retainedSources: encoded.retainedSources,
        retainedChunks: encoded.retainedChunks,
      });
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    context.diagnostics.warn('本地语义索引可用，但设备缓存写入失败', error);
  }
}

function selectPersistentSources(cache: Map<string, CachedChunk[]>): {
  sources: LocalSemanticCacheSource[];
  truncated: boolean;
} {
  const sources: LocalSemanticCacheSource[] = [];
  let estimatedLength = 128;
  let truncated = false;
  for (const [sourceId, chunks] of [...cache].sort(([left], [right]) => left.localeCompare(right))) {
    const estimatedSourceLength = 96 + sourceId.length + chunks.reduce((total, chunk) =>
      total + 176 + chunk.fingerprint.length + 4 * Math.ceil(chunk.vector.byteLength / 3), 0);
    if (estimatedLength + estimatedSourceLength > PERSISTED_CACHE_PAYLOAD_BUDGET) {
      truncated = true;
      continue;
    }
    sources.push({
      sourceId,
      revision: chunks[0]?.source.revision ?? 0,
      chunks: chunks.map((chunk) => ({
        start: chunk.start,
        length: chunk.length,
        fingerprint: chunk.fingerprint,
        coverage: chunk.coverage,
        vector: chunk.vector,
      })),
    });
    estimatedLength += estimatedSourceLength;
  }
  return { sources, truncated };
}

async function embedTexts(context: PluginContext, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const result = await context.workers.run<LocalSemanticEmbedResult>(LOCAL_SEMANTIC_EMBED_JOB, { texts }, signal);
  if (!result || !Array.isArray(result.vectors) || result.vectors.some((vector) => !(vector instanceof Float32Array))) {
    throw new Error('本地语义模型返回了无效向量');
  }
  return result.vectors;
}

function searchCache(
  cache: Map<string, CachedChunk[]>,
  queryVector: Float32Array,
  input: AIContextSearchRequest,
): AIContextSearchContribution {
  const filter = input.sourceIds?.length ? new Set(input.sourceIds) : undefined;
  const hits: AIContextSearchContribution['hits'] = [];
  let scanned = 0;
  for (const chunks of cache.values()) {
    if (!chunks.length || (filter && !filter.has(chunks[0].source.sourceId))) continue;
    let best: CachedChunk | undefined;
    let bestScore = -Infinity;
    for (const chunk of chunks) {
      scanned += 1;
      if (chunk.vector.length !== queryVector.length) continue;
      const score = dot(queryVector, chunk.vector);
      if (score > bestScore) { best = chunk; bestScore = score; }
    }
    if (best) hits.push({
      source: { ...best.source }, start: best.start, length: best.length,
      preview: best.preview, score: bestScore, retrievalMethod: 'semantic',
    });
  }
  hits.sort((left, right) => right.score - left.score || left.source.title.localeCompare(right.source.title, 'zh-CN'));
  return { provider: 'local-bge-small-zh-v1.5', hits: hits.slice(0, input.maxResults), scanned };
}

function readConfiguration(context: PluginContext): LocalSemanticProviderConfiguration {
  const value = context.store.readValue(LOCAL_SEMANTIC_PROVIDER_NAMESPACE, 'configuration');
  return isRecord(value) && typeof value.enabled === 'boolean' ? { enabled: value.enabled } : { enabled: true };
}

function emptyCache(status: LocalSemanticProviderPanelState['cache']['status']): LocalSemanticProviderPanelState['cache'] {
  return { status, indexedSources: 0, indexedChunks: 0, totalSources: 0, partialSources: 0 };
}

function countChunks(cache: Map<string, CachedChunk[]>): number {
  let total = 0;
  for (const chunks of cache.values()) total += chunks.length;
  return total;
}

function countPartialSources(cache: Map<string, CachedChunk[]>): number {
  let total = 0;
  for (const chunks of cache.values()) if (chunks[0]?.coverage === 'sampled') total += 1;
  return total;
}

function validateSearchRequest(value: AIContextSearchRequest): void {
  if (!value || !Array.isArray(value.terms) || value.terms.some((term) => typeof term !== 'string') ||
    !Number.isInteger(value.maxResults) || value.maxResults < 1 || value.maxResults > 100 ||
    (value.query !== undefined && typeof value.query !== 'string')) throw new Error('语义检索请求格式不正确');
}

function dot(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

function emptyContribution(): AIContextSearchContribution {
  return { provider: 'local-bge-small-zh-v1.5', hits: [], scanned: 0 };
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException('Local semantic retrieval aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
