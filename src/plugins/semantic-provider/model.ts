import {
  createId,
  isRecord,
  type PluginContext,
  type PluginDefinition,
  type TaskHandle,
} from '../../core/contracts.ts';
import { assertNotAborted, yieldToMainThread } from '../../services/async-control.ts';
import type {
  AIContextSearchContribution,
  AIContextSearchRequest,
  AIContextSource,
} from '../../protocols/ai.ts';
import { validateAIContextSearchRequest } from '../../protocols/ai.ts';
import { isAbortError } from '../../services/abort.ts';
import {
  SEMANTIC_PROVIDER_CHANGED_SIGNAL,
  SEMANTIC_PROVIDER_COMMANDS,
  SEMANTIC_PROVIDER_PERSONAL_QUERY,
  SEMANTIC_PROVIDER_STATE_QUERY,
  type SemanticProviderConfiguration,
  type SemanticProviderPanelState,
  type SemanticProviderPersonalConnections,
  type SemanticProviderPreferences,
  type SemanticProviderProfile,
  type SemanticProviderProfileDraft,
  type SemanticProviderProfileState,
} from '../../protocols/semantic.ts';
import { SEMANTIC_PROVIDER_NAMESPACE, semanticProviderManifest } from './manifest.ts';
import { FULL_SEMANTIC_COVERAGE_LENGTH, SEMANTIC_BLOCK_LENGTH } from '../../services/semantic-blocks.ts';
import {
  readSemanticCatalog as readCatalog,
  sampleSemanticSource as sampleSource,
  semanticPreview,
} from '../../services/semantic-source-sampling.ts';

export { semanticBlockFingerprint } from '../../services/semantic-source-sampling.ts';

export { SEMANTIC_PROVIDER_NAMESPACE } from './manifest.ts';

const SAMPLE_LENGTH = SEMANTIC_BLOCK_LENGTH;
const MAX_SOURCES = 10_000;
interface ProfileIdPayload { profileId?: string }
interface SessionKeyPayload extends ProfileIdPayload { apiKey: string }

interface CachedChunk {
  source: AIContextSource;
  start: number;
  length: number;
  fingerprint: string;
  preview: string;
  vector: Float32Array;
  coverage: 'full' | 'sampled';
}

interface SourceSamples {
  source: AIContextSource;
  samples: Array<{ start: number; text: string; fingerprint: string }>;
  coverage: 'full' | 'sampled';
}

export function createSemanticProviderPlugin(): PluginDefinition {
  const sessionApiKeys = new Map<string, string>();
  const activeRequests = new Set<AbortController>();
  let cacheBySource = new Map<string, CachedChunk[]>();
  let cacheProfile = '';
  let indexTask: TaskHandle<void> | undefined;
  let cacheState: SemanticProviderPanelState['cache'] = {
    status: 'idle', indexedSources: 0, indexedChunks: 0, totalSources: 0, partialSources: 0,
  };

  return {
    manifest: semanticProviderManifest,

    start(context) {
      sessionApiKeys.clear();
      clearTransientCache('idle');

      const readConfiguration = (): SemanticProviderConfiguration => normalizeConfiguration(
        context.store.readValue(SEMANTIC_PROVIDER_NAMESPACE, 'configuration'),
      );
      const activeProfile = (
        configuration = readConfiguration(),
      ): SemanticProviderProfile | undefined => configuration.profiles.find(
        (profile) => profile.id === configuration.activeProfileId,
      ) ?? configuration.profiles[0];
      const syncApprovedOrigins = (configuration = readConfiguration()) => {
        context.network.configureOrigins(configuration.profiles.map((profile) => profile.endpoint));
      };
      syncApprovedOrigins();
      const profileState = (profile: SemanticProviderProfile): SemanticProviderProfileState => {
        const hasSessionKey = Boolean(sessionApiKeys.get(profile.id));
        return { ...profile, hasSessionKey, configured: isConfigured(profile, hasSessionKey) };
      };
      const readState = (): SemanticProviderPanelState => {
        const configuration = readConfiguration();
        const active = activeProfile(configuration);
        return {
          activeProfileId: active?.id,
          profiles: configuration.profiles.map(profileState),
          cache: { ...cacheState },
        };
      };
      const notify = (reason: string, detail: Record<string, unknown> = {}) => {
        context.signals.emit(SEMANTIC_PROVIDER_CHANGED_SIGNAL, { reason, ...detail });
      };
      const setConfiguration = (
        label: string,
        configuration: SemanticProviderConfiguration,
        eventPayload: Record<string, unknown>,
      ) => ({
        transaction: {
          label,
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: SEMANTIC_PROVIDER_NAMESPACE,
            key: 'configuration',
            value: configuration,
          }],
          events: [{ type: 'semantic.provider.configuration.changed', payload: eventPayload }],
        },
      });

      const scheduleIndex = (force = false): TaskHandle<void> => {
        if (indexTask) return indexTask;
        const profile = activeProfile();
        const hasKey = profile ? Boolean(sessionApiKeys.get(profile.id)) : false;
        if (!profile || !isConfigured(profile, hasKey)) {
          throw new Error('语义检索连接尚未就绪；请检查接口、模型、KEY 和远程内容授权');
        }
        cacheState = { ...cacheState, status: 'indexing', error: undefined };
        notify('indexing');
        const task = context.tasks.schedule<void>({
          category: 'ai.semantic.index',
          label: '正在建立远程语义检索索引',
          priority: 18,
          noticeAfterMs: 650,
          timeoutMs: 10 * 60_000,
          estimatedCost: Math.max(1, cacheState.totalSources),
          run: async (signal, report, control) => {
            try {
              await buildIndex(context, profile, sessionApiKeys.get(profile.id) ?? '', {
                force,
                signal,
                report,
                waitIfPaused: control.waitIfPaused,
                readCache: () => cacheBySource,
                writeCache: (next) => { cacheBySource = next; },
                readFingerprint: () => cacheProfile,
                writeFingerprint: (next) => { cacheProfile = next; },
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
              };
              notify('index-error');
              throw error;
            }
          },
        });
        indexTask = task;
        void task.result.finally(() => {
          if (indexTask === task) indexTask = undefined;
        }).catch(() => undefined);
        return task;
      };

      const markDirty = (clearAll = false) => {
        if (clearAll) {
          indexTask?.cancel();
          indexTask = undefined;
          cacheBySource = new Map();
          cacheProfile = '';
        }
        cacheState = {
          ...cacheState,
          status: cacheBySource.size > 0 ? 'dirty' : 'idle',
          indexedSources: cacheBySource.size,
          indexedChunks: countChunks(cacheBySource),
          partialSources: countPartialSources(cacheBySource),
          error: undefined,
        };
        notify('index-dirty');
      };

      context.commands.register({
        type: SEMANTIC_PROVIDER_COMMANDS.saveProfile,
        validate: isProfileDraft,
        handle: (payload) => {
          const configuration = readConfiguration();
          const profile = validateProfile(payload, payload.id?.trim() || createId('semantic-provider-profile'));
          const exists = configuration.profiles.some((candidate) => candidate.id === profile.id);
          const profiles = exists
            ? configuration.profiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
            : [...configuration.profiles, profile];
          return {
            result: { id: profile.id },
            ...setConfiguration(
              exists ? '修改语义检索连接' : '添加语义检索连接',
              { profiles, activeProfileId: profile.id },
              { profileId: profile.id, action: 'save' },
            ),
          };
        },
      });
      context.commands.register<{ profileId: string }>({
        type: SEMANTIC_PROVIDER_COMMANDS.removeProfile,
        validate: isRequiredProfileId,
        handle: (payload) => {
          const configuration = readConfiguration();
          if (!configuration.profiles.some((profile) => profile.id === payload.profileId)) {
            throw new Error('要删除的语义检索连接已经不存在');
          }
          const profiles = configuration.profiles.filter((profile) => profile.id !== payload.profileId);
          return setConfiguration(
            '删除语义检索连接',
            {
              profiles,
              activeProfileId: configuration.activeProfileId === payload.profileId
                ? profiles[0]?.id
                : configuration.activeProfileId,
            },
            { profileId: payload.profileId, action: 'remove' },
          );
        },
      });
      context.commands.register<{ profileId: string }>({
        type: SEMANTIC_PROVIDER_COMMANDS.activateProfile,
        validate: isRequiredProfileId,
        handle: (payload) => {
          const configuration = readConfiguration();
          if (!configuration.profiles.some((profile) => profile.id === payload.profileId)) {
            throw new Error('要启用的语义检索连接已经不存在');
          }
          return setConfiguration(
            '切换语义检索连接',
            { ...configuration, activeProfileId: payload.profileId },
            { profileId: payload.profileId, action: 'activate' },
          );
        },
      });
      context.commands.register<SessionKeyPayload, { configured: boolean }>({
        type: SEMANTIC_PROVIDER_COMMANDS.setSessionKey,
        validate: isSessionKeyPayload,
        handle: (payload) => {
          const profile = resolveProfile(readConfiguration(), payload.profileId);
          if (!profile) throw new Error('请先保存一个语义检索连接');
          sessionApiKeys.set(profile.id, payload.apiKey.trim());
          notify('key', { profileId: profile.id });
          return { result: { configured: isConfigured(profile, Boolean(sessionApiKeys.get(profile.id))) } };
        },
      });
      context.commands.register<ProfileIdPayload>({
        type: SEMANTIC_PROVIDER_COMMANDS.clearSessionKey,
        validate: isOptionalProfileId,
        handle: (payload = {}) => {
          const profile = resolveProfile(readConfiguration(), payload.profileId);
          if (profile) sessionApiKeys.delete(profile.id);
          notify('key', { profileId: profile?.id });
          return { result: { configured: false } };
        },
      });
      context.commands.register<SemanticProviderPersonalConnections>({
        type: SEMANTIC_PROVIDER_COMMANDS.restorePersonal,
        validate: isPersonalConnections,
        handle: (payload) => {
          const configuration = normalizeConfiguration(payload.configuration);
          const validIds = new Set(configuration.profiles.map((profile) => profile.id));
          sessionApiKeys.clear();
          for (const [profileId, apiKey] of Object.entries(payload.apiKeys)) {
            if (validIds.has(profileId) && apiKey) sessionApiKeys.set(profileId, apiKey);
          }
          return setConfiguration(
            '恢复本机语义检索连接',
            configuration,
            { action: 'restore' },
          );
        },
      });
      context.commands.register<{ force?: boolean }>({
        type: SEMANTIC_PROVIDER_COMMANDS.rebuild,
        validate: (value): value is { force?: boolean } => value === undefined ||
          (isRecord(value) && (value.force === undefined || typeof value.force === 'boolean')),
        handle: (payload = {}) => ({ result: { taskId: scheduleIndex(payload.force ?? true).id } }),
      });
      context.commands.register({
        type: SEMANTIC_PROVIDER_COMMANDS.clearCache,
        handle: () => {
          markDirty(true);
          return { result: { cleared: true } };
        },
      });
      context.queries.register({ type: SEMANTIC_PROVIDER_STATE_QUERY, handle: readState });
      context.queries.register<undefined, SemanticProviderPersonalConnections>({
        type: SEMANTIC_PROVIDER_PERSONAL_QUERY,
        handle: () => ({
          configuration: readConfiguration(),
          apiKeys: Object.fromEntries(sessionApiKeys),
        }),
      });

      context.capabilities.provide<AIContextSearchRequest, AIContextSearchContribution>({
        key: 'context.semanticSearch@1',
        priority: 20,
        invoke: async (input, signal) => {
          validateAIContextSearchRequest(input);
          const profile = activeProfile();
          const hasKey = profile ? Boolean(sessionApiKeys.get(profile.id)) : false;
          if (!profile || !isConfigured(profile, hasKey)) return emptyContribution();
          try {
            await scheduleIndex(false).result;
            if (signal?.aborted) throw abortError();
            const query = input.query?.trim() || input.terms.join(' ');
            const [vector] = await requestEmbeddings(
              context,
              profile,
              sessionApiKeys.get(profile.id) ?? '',
              [query],
              'query',
              signal,
              activeRequests,
            );
            if (!vector) return emptyContribution();
            return searchCache(cacheBySource, vector, input);
          } catch (error) {
            if (isAbortError(error)) throw error;
            context.diagnostics.warn('远程语义检索不可用，已保留本地 BM25 结果', error);
            return emptyContribution();
          }
        },
      });

      context.events.subscribe<{ profileId?: string; action?: string }>(
        'semantic.provider.configuration.changed',
        (message) => {
          syncApprovedOrigins();
          if (message.payload.action === 'remove' && message.payload.profileId) {
            sessionApiKeys.delete(message.payload.profileId);
          }
          markDirty(true);
          notify('configuration', message.payload);
        },
      );
      context.events.subscribe('content.changed', () => markDirty());
      context.events.subscribe('nodes.deleted', () => markDirty());
      context.events.subscribe('node.created', () => markDirty());
      context.events.subscribe('node.renamed', () => markDirty());
      context.events.subscribe('document.replaced', () => markDirty(true));
    },

    stop() {
      sessionApiKeys.clear();
      indexTask?.cancel();
      indexTask = undefined;
      for (const controller of activeRequests) controller.abort();
      activeRequests.clear();
      clearTransientCache('idle');
    },
  };

  function clearTransientCache(status: SemanticProviderPanelState['cache']['status']): void {
    cacheBySource = new Map();
    cacheProfile = '';
    cacheState = { status, indexedSources: 0, indexedChunks: 0, totalSources: 0, partialSources: 0 };
  }
}

async function buildIndex(
  context: PluginContext,
  profile: SemanticProviderProfile,
  apiKey: string,
  options: {
    force: boolean;
    signal: AbortSignal;
    report(progress: number): void;
    waitIfPaused(): Promise<void>;
    readCache(): Map<string, CachedChunk[]>;
    writeCache(next: Map<string, CachedChunk[]>): void;
    readFingerprint(): string;
    writeFingerprint(next: string): void;
    updateState(next: Partial<SemanticProviderPanelState['cache']>): void;
  },
): Promise<void> {
  const catalog = await readCatalog(context, options.signal);
  if (catalog.length > MAX_SOURCES) {
    throw new Error(`当前画布有 ${catalog.length} 个可检索来源，超过单次语义索引上限 ${MAX_SOURCES}`);
  }
  const fingerprint = profileFingerprint(profile);
  const previous = options.readFingerprint() === fingerprint && !options.force
    ? options.readCache()
    : new Map<string, CachedChunk[]>();
  const liveIds = new Set(catalog.map((source) => source.sourceId));
  const staged = new Map([...previous].filter(([sourceId]) => liveIds.has(sourceId)));
  const stale = catalog.filter((source) => {
    const chunks = staged.get(source.sourceId);
    return !chunks?.length || chunks[0].source.revision !== source.revision;
  });
  options.updateState({ totalSources: catalog.length });
  if (stale.length === 0) {
    options.writeCache(staged);
    options.writeFingerprint(fingerprint);
    options.report(1);
    return;
  }

  const sourceSamples: SourceSamples[] = [];
  for (let index = 0; index < stale.length; index += 1) {
    assertNotAborted(options.signal);
    await options.waitIfPaused();
    sourceSamples.push(await sampleSource(context, stale[index], options.signal));
    if (index % 12 === 11) await yieldToMainThread();
    options.report(stale.length ? 0.25 * (index + 1) / stale.length : 0.25);
  }

  const nextChunks = new Map<string, CachedChunk[]>();
  const pendingSamples: Array<{
    source: AIContextSource;
    start: number;
    text: string;
    fingerprint: string;
  }> = [];
  for (const { source, samples, coverage } of sourceSamples) {
    const previousChunks = staged.get(source.sourceId) ?? [];
    const reusable = new Map(previousChunks.flatMap((chunk) =>
      chunk.fingerprint ? [[chunk.fingerprint, chunk] as const] : []));
    const chunks: CachedChunk[] = [];
    for (const sample of samples) {
      const existing = reusable.get(sample.fingerprint);
      if (!existing) {
        pendingSamples.push({ source, ...sample });
        continue;
      }
      chunks.push({
        ...existing,
        source: { ...source },
        start: sample.start,
        length: sample.text.length,
        fingerprint: sample.fingerprint,
        preview: semanticPreview(sample.text),
        coverage,
      });
    }
    nextChunks.set(source.sourceId, chunks);
  }
  const pendingGroups = new Map<string, typeof pendingSamples>();
  for (const sample of pendingSamples) {
    const group = pendingGroups.get(sample.fingerprint);
    if (group) group.push(sample);
    else pendingGroups.set(sample.fingerprint, [sample]);
  }
  const pendingRepresentatives = [...pendingGroups.values()].map((group) => group[0]);
  for (let offset = 0; offset < pendingRepresentatives.length; offset += profile.maxBatchSize) {
    assertNotAborted(options.signal);
    await options.waitIfPaused();
    const batch = pendingRepresentatives.slice(offset, offset + profile.maxBatchSize);
    const vectors = await requestEmbeddings(
      context,
      profile,
      apiKey,
      batch.map((item) => `${item.source.title}\n${item.text}`.slice(0, SAMPLE_LENGTH + 240)),
      'document',
      options.signal,
    );
    if (vectors.length !== batch.length) throw new Error('语义服务返回的向量数量与请求不一致');
    batch.forEach((representative, index) => {
      for (const item of pendingGroups.get(representative.fingerprint) ?? [representative]) {
        const chunks = nextChunks.get(item.source.sourceId) ?? [];
        chunks.push({
          source: { ...item.source },
          start: item.start,
          length: item.text.length,
          fingerprint: item.fingerprint,
          preview: semanticPreview(item.text),
          vector: vectors[index],
          coverage: item.source.length <= FULL_SEMANTIC_COVERAGE_LENGTH ? 'full' : 'sampled',
        });
        nextChunks.set(item.source.sourceId, chunks);
      }
    });
    const completed = Math.min(pendingRepresentatives.length, offset + batch.length);
    options.report(0.25 + 0.75 * completed / Math.max(1, pendingRepresentatives.length));
    options.updateState({
      indexedSources: staged.size + nextChunks.size,
      indexedChunks: countChunks(staged) + countChunks(nextChunks),
      partialSources: countPartialSources(staged) + countPartialSources(nextChunks),
    });
  }
  for (const source of stale) staged.delete(source.sourceId);
  for (const [sourceId, chunks] of nextChunks) staged.set(sourceId, chunks);
  options.writeCache(staged);
  options.writeFingerprint(fingerprint);
  options.report(1);
}

async function requestEmbeddings(
  context: PluginContext,
  profile: SemanticProviderProfile,
  apiKey: string,
  texts: string[],
  purpose: 'query' | 'document',
  signal: AbortSignal | undefined,
  requests?: Set<AbortController>,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const controller = new AbortController();
  requests?.add(controller);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (profile.authentication === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
    if (profile.authentication === 'api-key') {
      headers[profile.apiStyle === 'gemini' ? 'x-goog-api-key' : 'X-API-Key'] = apiKey;
    }
    const body = embeddingBody(profile, texts, purpose);
    const response = await context.network.embed(resolveEndpoint(profile.endpoint), {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`语义服务返回 HTTP ${response.status}`);
    return parseEmbeddings(await response.json(), profile.apiStyle, texts.length);
  } finally {
    signal?.removeEventListener('abort', abort);
    requests?.delete(controller);
  }
}

function embeddingBody(
  profile: SemanticProviderProfile,
  texts: string[],
  purpose: 'query' | 'document',
): Record<string, unknown> {
  if (profile.apiStyle === 'gemini') {
    return {
      requests: texts.map((text) => ({
        model: profile.model.startsWith('models/') ? profile.model : `models/${profile.model}`,
        content: { parts: [{ text }] },
        taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
      })),
    };
  }
  return {
    model: profile.model,
    input: texts,
    ...(profile.apiStyle === 'voyage' ? {
      input_type: purpose === 'query' ? 'query' : 'document',
    } : {}),
  };
}

function parseEmbeddings(
  payload: unknown,
  style: SemanticProviderProfile['apiStyle'],
  expected: number,
): Float32Array[] {
  if (!isRecord(payload)) throw new Error('语义服务返回了无法识别的数据');
  let values: unknown[] = [];
  if (style === 'gemini') {
    values = Array.isArray(payload.embeddings)
      ? payload.embeddings.map((entry) => isRecord(entry) ? entry.values : undefined)
      : isRecord(payload.embedding) ? [payload.embedding.values] : [];
  } else if (Array.isArray(payload.data)) {
    values = [...payload.data]
      .sort((left, right) => embeddingIndex(left) - embeddingIndex(right))
      .map((entry) => isRecord(entry) ? entry.embedding : undefined);
  }
  if (values.length !== expected) throw new Error('语义服务返回的向量数量不正确');
  const vectors = values.map((value) => normalizeVector(value));
  const dimension = vectors[0]?.length ?? 0;
  if (dimension < 2 || vectors.some((vector) => vector.length !== dimension)) {
    throw new Error('语义服务返回的向量维度不一致');
  }
  return vectors;
}

function normalizeVector(value: unknown): Float32Array {
  if (!Array.isArray(value) || value.length > 16_384 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error('语义服务返回的向量格式不正确');
  }
  const magnitude = Math.sqrt(value.reduce((total, item) => total + (item as number) ** 2, 0));
  if (!magnitude) throw new Error('语义服务返回了空向量');
  return Float32Array.from(value as number[], (item) => item / magnitude);
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
      source: { ...best.source },
      start: best.start,
      length: best.length,
      preview: best.preview,
      score: bestScore,
      retrievalMethod: 'semantic',
    });
  }
  hits.sort((left, right) => right.score - left.score || left.source.title.localeCompare(right.source.title, 'zh-CN'));
  return { provider: 'remote-semantic-embedding', hits: hits.slice(0, input.maxResults), scanned };
}

function dot(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

function normalizeConfiguration(value: unknown): SemanticProviderConfiguration {
  if (!isRecord(value) || !Array.isArray(value.profiles)) return { profiles: [] };
  const profiles: SemanticProviderProfile[] = [];
  const ids = new Set<string>();
  for (const candidate of value.profiles) {
    if (!isProfile(candidate) || ids.has(candidate.id)) continue;
    try {
      const profile = validateProfile(candidate, candidate.id);
      profiles.push(profile);
      ids.add(profile.id);
    } catch {
      // Invalid personal connections never block document loading.
    }
  }
  return {
    profiles,
    activeProfileId: typeof value.activeProfileId === 'string' && ids.has(value.activeProfileId)
      ? value.activeProfileId
      : profiles[0]?.id,
  };
}

function isPreferences(value: unknown): value is SemanticProviderPreferences {
  return isRecord(value) && typeof value.endpoint === 'string' && typeof value.model === 'string' &&
    ['openai-compatible', 'voyage', 'gemini'].includes(String(value.apiStyle)) &&
    ['bearer', 'api-key', 'none'].includes(String(value.authentication)) &&
    typeof value.allowRemoteContent === 'boolean' && Number.isInteger(value.maxBatchSize);
}

function isProfile(value: unknown): value is SemanticProviderProfile {
  return isRecord(value) && isPreferences(value) && typeof value.id === 'string' &&
    typeof value.label === 'string' && typeof value.platform === 'string';
}

function isProfileDraft(value: unknown): value is SemanticProviderProfileDraft {
  return isRecord(value) && isPreferences(value) &&
    (value.id === undefined || typeof value.id === 'string') &&
    typeof value.label === 'string' && typeof value.platform === 'string';
}

function validateProfile(value: SemanticProviderProfileDraft, id: string): SemanticProviderProfile {
  const label = value.label.trim();
  const platform = value.platform.trim();
  const endpoint = value.endpoint.trim();
  const model = value.model.trim();
  if (!id || id.length > 160 || !label || !platform || label.length > 120 || platform.length > 120) {
    throw new Error('平台和连接名称不能为空，且不能超过 120 个字符');
  }
  if (endpoint.length > 2048 || model.length > 200) throw new Error('语义连接配置过长');
  if (endpoint) {
    const url = new URL(endpoint, typeof location === 'undefined' ? 'http://localhost' : location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('语义接口只支持 HTTP 或 HTTPS');
  }
  if (value.maxBatchSize < 1 || value.maxBatchSize > 100) throw new Error('单批数量必须在 1 到 100 之间');
  return {
    id, label, platform, endpoint, model,
    apiStyle: value.apiStyle,
    authentication: value.authentication,
    allowRemoteContent: value.allowRemoteContent,
    maxBatchSize: value.maxBatchSize,
  };
}

function resolveProfile(
  configuration: SemanticProviderConfiguration,
  profileId?: string,
): SemanticProviderProfile | undefined {
  return configuration.profiles.find((profile) => profile.id === profileId) ??
    configuration.profiles.find((profile) => profile.id === configuration.activeProfileId) ??
    configuration.profiles[0];
}

function isConfigured(profile: SemanticProviderProfile, hasSessionKey: boolean): boolean {
  return Boolean(profile.endpoint && profile.model && profile.allowRemoteContent &&
    (profile.authentication === 'none' || hasSessionKey));
}

function isRequiredProfileId(value: unknown): value is { profileId: string } {
  return isRecord(value) && typeof value.profileId === 'string' && value.profileId.length > 0;
}

function isOptionalProfileId(value: unknown): value is ProfileIdPayload {
  return value === undefined || (isRecord(value) &&
    (value.profileId === undefined || typeof value.profileId === 'string'));
}

function isSessionKeyPayload(value: unknown): value is SessionKeyPayload {
  return isRecord(value) && typeof value.apiKey === 'string' && value.apiKey.length <= 4096 &&
    (value.profileId === undefined || typeof value.profileId === 'string');
}

function isPersonalConnections(value: unknown): value is SemanticProviderPersonalConnections {
  return isRecord(value) && isRecord(value.configuration) && isRecord(value.apiKeys) &&
    Object.entries(value.apiKeys).every(([profileId, apiKey]) =>
      profileId.length <= 200 && typeof apiKey === 'string' && apiKey.length <= 4096);
}

function profileFingerprint(profile: SemanticProviderProfile): string {
  return [profile.id, profile.endpoint, profile.model, profile.apiStyle].join('|');
}

function resolveEndpoint(endpoint: string): string {
  return new URL(endpoint, typeof location === 'undefined' ? 'http://localhost' : location.origin).toString();
}

function embeddingIndex(value: unknown): number {
  return isRecord(value) && typeof value.index === 'number' ? value.index : Number.MAX_SAFE_INTEGER;
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

function emptyContribution(): AIContextSearchContribution {
  return { provider: 'remote-semantic-embedding', hits: [], scanned: 0 };
}

function abortError(): DOMException {
  return new DOMException('Semantic retrieval aborted', 'AbortError');
}
