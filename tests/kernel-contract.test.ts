import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CapabilityRegistry } from '../src/core/capability-registry.ts';
import type { MessageEnvelope, PluginDefinition } from '../src/core/contracts.ts';
import { DiagnosticsService } from '../src/core/diagnostics.ts';
import { HistoryService } from '../src/core/history.ts';
import { InteractionStateMachine } from '../src/core/interaction-machine.ts';
import { scrubRetiredHistory, scrubRetiredStore } from '../src/core/legacy-migrations.ts';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { MessageRouter } from '../src/core/message-router.ts';
import { SpatialHashIndex } from '../src/services/spatial-index.ts';
import { canvasNodeDetail, NODE_PREVIEW_MIN_ZOOM } from '../src/plugins/canvas/lod.ts';
import {
  clampCanvasZoom,
  MAX_ZOOM,
  MIN_ZOOM,
} from '../src/plugins/canvas/surface-geometry.ts';
import { snapDraggedBounds, snapResizedBounds } from '../src/plugins/smart-layout/alignment.ts';
import { PluginManager, resolvePluginStartOrder } from '../src/core/plugin-manager.ts';
import { WorkerService, type ManagedWorkerFactory, type WorkerRequestMessage, type WorkerResponseMessage } from '../src/core/worker-service.ts';
import {
  externalizeContentChunks,
  hydrateExternalizedContentChunks,
  isAutosaveCheckpointDue,
  replayApplication,
  type PersistedApplication,
} from '../src/core/persistence.ts';
import { ResourceRegistry } from '../src/core/resource-registry.ts';
import { StateStore } from '../src/core/store.ts';
import { TaskScheduler } from '../src/core/task-scheduler.ts';
import { TransactionManager } from '../src/core/transaction-manager.ts';
import { UIRuntime } from '../src/core/ui-runtime.ts';
import { UISurfaceArbiter } from '../src/core/ui-surface-arbiter.ts';
import { contrastingInk } from '../src/ui/color-contrast.ts';
import { createAIAssistantPlugin, estimateAITokens } from '../src/plugins/ai-assistant/model.ts';
import { createAnnotationsPlugin } from '../src/plugins/annotations/model.ts';
import {
  activeInlineReferences,
  atQueryAt,
  compactReferenceToken,
  explicitAtOperation,
  inferAtOperation,
  replaceAtQuery,
  stripOperationCommands,
} from '../src/plugins/ai-assistant/command-parser.ts';
import { AI_OPERATION_DEFINITIONS } from '../src/plugins/ai-assistant/operations.ts';
import { inferMemorySuggestion } from '../src/plugins/ai-assistant/memory-suggestion.ts';
import { buildAIMentionSuggestions } from '../src/plugins/ai-assistant/mention-suggestions.ts';
import type { AIAssistantState } from '../src/plugins/ai-assistant/types.ts';
import { AI_PROVIDER_NAMESPACE, createAIProviderPlugin } from '../src/plugins/ai-provider/model.ts';
import { AI_PROVIDER_PRESETS, applyAIProviderPreset } from '../src/plugins/ai-provider/presets.ts';
import {
  SEMANTIC_PROVIDER_PRESETS,
  applySemanticProviderPreset,
} from '../src/plugins/ai-provider/semantic-presets.ts';
import {
  SEMANTIC_PROVIDER_COMMANDS,
  SEMANTIC_PROVIDER_PERSONAL_QUERY,
  type SemanticProviderPersonalConnections,
} from '../src/protocols/semantic.ts';
import {
  boundsIntersect,
  viewportCenterInWorld,
  worldViewport,
  type WorldBounds,
} from '../src/protocols/viewport.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import {
  CONNECTION_BATCH_RENDER_THRESHOLD,
  connectionCurvePath,
  connectionRenderMode,
  distanceToConnectionCurve,
} from '../src/plugins/connections/rendering.ts';
import type { ConnectionAppearanceSnapshot, ConnectionRecord } from '../src/protocols/connections.ts';
import { createClipboardPlugin } from '../src/plugins/clipboard/model.ts';
import { createEditorPlugin } from '../src/plugins/editor/model.ts';
import { applyTextColorPreview } from '../src/plugins/editor/appearance-preview.ts';
import { groupActionsByCategory } from '../src/plugins/command-palette/action-groups.ts';
import {
  inferFormatTarget,
  resolveActiveFormat,
  resolveFormatBrushRange,
  resolveFormatRange,
} from '../src/plugins/editor/format-target.ts';
import { resizePaneLayout, resizePaneWidths } from '../src/plugins/editor/pane-layout.ts';
import { computeGroupBounds } from '../src/plugins/groups/layout.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { parseProject, serializeProject, writeProjectToWritable } from '../src/plugins/import-export/codec.ts';
import { createImportExportPlugin } from '../src/plugins/import-export/model.ts';
import type { CloudSyncState } from '../src/cloud/contracts.ts';
import { createPalettePlugin } from '../src/plugins/palette/model.ts';
import { defineManifest } from '../src/plugins/manifest.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createSearchReplacePlugin } from '../src/plugins/search-replace/model.ts';
import { resolveSearchNavigation } from '../src/plugins/search-replace/navigation.ts';
import { groupHitsByNode } from '../src/plugins/search-replace/result-order.ts';
import { createSearchIndexPlugin } from '../src/plugins/search-index/model.ts';
import {
  SEMANTIC_PROVIDER_NAMESPACE,
  createSemanticProviderPlugin,
  semanticBlockFingerprint,
} from '../src/plugins/semantic-provider/model.ts';
import {
  LOCAL_SEMANTIC_PROVIDER_NAMESPACE,
  createLocalSemanticProviderPlugin,
} from '../src/plugins/local-semantic-provider/model.ts';
import {
  decodeLocalSemanticCache,
  encodeLocalSemanticCache,
} from '../src/plugins/local-semantic-provider/worker-jobs.ts';
import {
  LOCAL_SEMANTIC_DECODE_CACHE_JOB,
  LOCAL_SEMANTIC_ENCODE_CACHE_JOB,
  type LocalSemanticDecodeCacheRequest,
  type LocalSemanticEncodeCacheRequest,
} from '../src/plugins/local-semantic-provider/worker-protocol.ts';
import { createShortcutCenterPlugin } from '../src/plugins/shortcut-center/model.ts';
import { createSmartLayoutPlugin } from '../src/plugins/smart-layout/model.ts';
import { createStatisticsPlugin } from '../src/plugins/statistics/model.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { textAssistPlugin } from '../src/plugins/text-assist/plugin.ts';
import { endEllipsis } from '../src/ui/title-ellipsis.ts';
import { scrollHorizontalOverflow } from '../src/ui/horizontal-overflow.ts';
import { commandTooltip, formatShortcutChord } from '../src/ui/shortcut-presentation.ts';
import { mergeContentCatalogDeltas } from '../src/ui/runtime-hooks.ts';
import type {
  AIGenerateRequest,
  AIGenerateResult,
  AIGenerateStream,
  AIToolDefinition,
  AIMemoryCatalogSnapshot,
  AIMemoryIndexRecord,
  AIPreparedContext,
  AIPromptTemplateCatalog,
  AIProviderCatalog,
} from '../src/protocols/ai.ts';
import type { AIContextSearchContribution } from '../src/protocols/ai.ts';
import type { ContentCatalogDelta, ContentMutationPlan, ContentSummary } from '../src/protocols/content.ts';
import {
  AUTOSAVE_DISABLED_INTERVAL_MS,
  AUTOSAVE_INTERVAL_OPTIONS,
  AUTOSAVE_REALTIME_INTERVAL_MS,
  isEcho8ProjectFile,
  PROJECT_KIND,
  PROJECT_MEDIA_TYPE,
  PROJECT_RELATED_DIRECTORY_CAPABILITY,
  safeLocalFilename,
  type FileDirectoryTarget,
  type FileSaveTarget,
  type FileRuntimeState,
  type PersistenceSnapshot,
  type ProjectOpenPayload,
  type ProjectSource,
} from '../src/protocols/files.ts';
import { DEFAULT_TEXT_DOCUMENT_FORMAT } from '../src/protocols/formatting.ts';
import type { SearchHit, SearchNavigationSignal, SearchResult } from '../src/protocols/search.ts';
import type { SelectionSnapshot } from '../src/protocols/selection.ts';
import type { TextAssistResourceStatus } from '../src/protocols/text-assist.ts';

function createHarness(taskConcurrency = 1, workerFactory?: ManagedWorkerFactory) {
  const writeToken = Symbol('test-write');
  const diagnostics = new DiagnosticsService();
  const history = new HistoryService(1000);
  const store = new StateStore(writeToken);
  const transactions = new TransactionManager(store, history, writeToken);
  const router = new MessageRouter(transactions, diagnostics);
  const resources = new ResourceRegistry();
  const capabilities = new CapabilityRegistry();
  const textAssistRules = readFileSync(
    new URL('../public/Echo-8-text-assist-rules.txt', import.meta.url),
    'utf8',
  );
  capabilities.register('core.assets', {
    key: 'assets.readText@1',
    invoke: () => ({
      path: 'Echo-8-text-assist-rules.txt',
      text: textAssistRules,
      bytes: Buffer.byteLength(textAssistRules),
    }),
  });
  const ui = new UIRuntime();
  const tasks = new TaskScheduler(taskConcurrency);
  let autosaveIntervalMs = 60_000;
  const plugins = new PluginManager({
    resources,
    router,
    capabilities,
    store,
    ui,
    tasks,
    workers: new WorkerService(workerFactory),
    diagnostics,
  });
  const uiSurfaces = new UISurfaceArbiter(router, ui, diagnostics);
  uiSurfaces.start();
  router.setAdmissionChecker(plugins.isAdmitted);
  router.registerQuery('core.persistence', {
    type: 'system.persistence',
    handle: () => ({
      state: 'idle' as const,
      journalEntries: 0,
      recoveryPoints: 0,
      autosaveIntervalMs,
    }),
  });
  router.registerCommand<{ intervalMs: number }, PersistenceSnapshot>('core.persistence', {
    type: 'system.persistence.setAutosaveInterval',
    validate: (payload): payload is { intervalMs: number } => Boolean(
      payload && typeof payload === 'object' && typeof (payload as { intervalMs?: unknown }).intervalMs === 'number',
    ),
    handle: (payload) => {
      autosaveIntervalMs = payload.intervalMs;
      router.emitSignal('system.persistence.autosaveInterval.changed', { intervalMs: autosaveIntervalMs }, 'core.persistence');
      return {
        result: { state: 'idle', journalEntries: 0, recoveryPoints: 0, autosaveIntervalMs },
      };
    },
  });
  transactions.setNamespaceOwnerResolver(plugins.resolveNamespaceOwner);
  transactions.setWriteAuthorizer(plugins.canWriteOwnStore);
  return { diagnostics, history, store, transactions, router, resources, capabilities, ui, tasks, plugins };
}

test('durable commands pass through one transaction and global history', async () => {
  const harness = createHarness();
  harness.router.registerCommand('core.test', {
    type: 'test.set',
    handle: () => ({
      transaction: {
        label: '测试写入',
        patches: [
          { op: 'set', domain: 'document', namespace: 'test', key: 'value', value: 42 },
        ],
      },
    }),
  });

  await harness.router.dispatch('test.set', undefined, 'core.test');
  assert.equal(harness.store.readValue('document', 'test', 'value'), 42);
  assert.equal(harness.history.getState().undoCount, 1);

  assert.equal(await harness.transactions.undo(), true);
  assert.equal(harness.store.readValue('document', 'test', 'value'), undefined);
  assert.equal(harness.history.getState().redoCount, 1);

  assert.equal(await harness.transactions.redo(), true);
  assert.equal(harness.store.readValue('document', 'test', 'value'), 42);
});

test('workspace UI state is not accepted into document history', async () => {
  const harness = createHarness();
  harness.router.registerCommand('core.test', {
    type: 'test.layout',
    handle: () => ({
      transaction: {
        label: '调整布局',
        history: false,
        patches: [
          { op: 'set', domain: 'workspace', namespace: 'layout', key: 'width', value: 360 },
        ],
      },
    }),
  });

  await harness.router.dispatch('test.layout', undefined, 'core.test');
  assert.equal(harness.store.readValue('workspace', 'layout', 'width'), 360);
  assert.equal(harness.history.getState().undoCount, 0);
});

test('ephemeral signals are coalesced and never enter history', async () => {
  const harness = createHarness();
  const seen: number[] = [];
  harness.router.subscribeSignal('core.test', 'pointer.preview', (message) => {
    seen.push(message.payload as number);
  });

  harness.router.emitSignal('pointer.preview', 1, 'core.test');
  harness.router.emitSignal('pointer.preview', 2, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(seen, [2]);
  assert.equal(harness.history.getState().undoCount, 0);
});

test('nested queued commands fail fast while explicit compound commands preserve lineage', async () => {
  const harness = createHarness();
  let parentEnvelope: MessageEnvelope | undefined;
  let childEnvelope: MessageEnvelope | undefined;
  harness.plugins.register({
    manifest: defineManifest('compound-probe', '复合指令探针', {
      commands: ['probe.blocked', 'probe.compound', 'probe.child'],
      dispatches: ['probe.child'],
    }),
    start(context) {
      context.commands.register({
        type: 'probe.child',
        handle: (_payload, envelope) => {
          childEnvelope = envelope;
          return { result: 'child-result' };
        },
      });
      context.commands.register({
        type: 'probe.blocked',
        handle: async () => ({ result: await context.commands.dispatch('probe.child') }),
      });
      context.commands.register({
        type: 'probe.compound',
        handle: async (_payload, envelope) => {
          parentEnvelope = envelope;
          await Promise.resolve();
          return { result: await context.commands.invoke('probe.child') };
        },
      });
    },
  });
  await harness.plugins.start('compound-probe');

  await assert.rejects(
    () => Promise.race([
      harness.router.dispatch('probe.blocked', undefined, 'core.test'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('nested command timed out')), 100)),
    ]),
    /explicit compound-command channel/,
  );
  assert.equal(await harness.router.dispatch('probe.compound', undefined, 'core.test'), 'child-result');
  assert.ok(parentEnvelope);
  assert.ok(childEnvelope);
  assert.equal(childEnvelope.causationId, parentEnvelope.id);
  assert.equal(childEnvelope.correlationId, parentEnvelope.correlationId);
  assert.equal(childEnvelope.depth, parentEnvelope.depth + 1);
});

test('async handlers retain causality after await and deferred commands run after the active turn', async () => {
  const harness = createHarness();
  let parentEnvelope: MessageEnvelope | undefined;
  let signalEnvelope: MessageEnvelope | undefined;
  let deferredEnvelope: MessageEnvelope | undefined;
  harness.plugins.register({
    manifest: defineManifest('async-lineage-probe', '异步因果链探针', {
      commands: ['probe.asyncParent', 'probe.deferred'],
      dispatches: ['probe.deferred'],
      signals: ['probe.asyncSignal'],
    }),
    start(context) {
      context.signals.subscribe('probe.asyncSignal', (envelope) => {
        signalEnvelope = envelope;
      });
      context.commands.register({
        type: 'probe.deferred',
        handle: (_payload, envelope) => {
          deferredEnvelope = envelope;
          return { result: true };
        },
      });
      context.commands.register({
        type: 'probe.asyncParent',
        handle: async (_payload, envelope) => {
          parentEnvelope = envelope;
          await Promise.resolve();
          context.signals.emit('probe.asyncSignal');
          context.commands.defer('probe.deferred');
          return { result: true };
        },
      });
    },
  });
  await harness.plugins.start('async-lineage-probe');
  await harness.router.dispatch('probe.asyncParent', undefined, 'core.test');
  await waitFor(async () => signalEnvelope && deferredEnvelope ? true : undefined);

  assert.ok(parentEnvelope);
  assert.equal(signalEnvelope?.causationId, parentEnvelope.id);
  assert.equal(signalEnvelope?.correlationId, parentEnvelope.correlationId);
  assert.equal(deferredEnvelope?.causationId, parentEnvelope.id);
  assert.equal(deferredEnvelope?.correlationId, parentEnvelope.correlationId);
});

test('slow event listeners are isolated by plugin and never hold the formal command queue', async () => {
  const harness = createHarness();
  let releaseSlowListener!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlowListener = resolve;
  });
  let slowStarted = false;
  let fastCompleted = false;
  harness.router.subscribeEvent('core.slow-observer', 'probe.committed', async () => {
    slowStarted = true;
    await slowGate;
  });
  harness.router.subscribeEvent('core.fast-observer', 'probe.committed', () => {
    fastCompleted = true;
  });
  harness.router.registerCommand('core.test', {
    type: 'probe.commit',
    handle: () => ({
      result: true,
      transaction: {
        label: '事件隔离测试',
        history: false,
        patches: [{
          op: 'set', domain: 'workspace', namespace: 'core.eventProbe', key: 'value', value: 1,
        }],
        events: [{ type: 'probe.committed', payload: {} }],
      },
    }),
  });

  assert.equal(await Promise.race([
    harness.router.dispatch('probe.commit', undefined, 'core.test'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('command queue was blocked')), 100)),
  ]), true);
  await waitFor(async () => slowStarted && fastCompleted ? true : undefined);
  releaseSlowListener();
});

test('event delivery remains ordered inside each plugin after isolation', async () => {
  const harness = createHarness();
  const seen: number[] = [];
  harness.router.subscribeEvent('core.ordered-observer', 'probe.ordered', async (message) => {
    if (message.payload === 1) await new Promise((resolve) => setTimeout(resolve, 10));
    seen.push(message.payload as number);
  });
  harness.router.registerCommand<number>('core.test', {
    type: 'probe.publishOrdered',
    handle: (payload) => ({
      transaction: {
        label: '事件顺序测试',
        history: false,
        patches: [{
          op: 'set', domain: 'workspace', namespace: 'core.orderedProbe', key: 'value', value: payload,
        }],
        events: [{ type: 'probe.ordered', payload }],
      },
    }),
  });

  await harness.router.dispatch('probe.publishOrdered', 1, 'core.test');
  await harness.router.dispatch('probe.publishOrdered', 2, 'core.test');
  await waitFor(async () => seen.length === 2 ? true : undefined);
  assert.deepEqual(seen, [1, 2]);
});

test('broadcast lineage preserves correlation and terminates recursive plugin loops', async () => {
  const harness = createHarness();
  let rejected: unknown;
  const correlations = new Set<string>();
  harness.router.subscribeEvent('core.test', 'loop.committed', (message) => {
    correlations.add(message.correlationId);
  });
  harness.plugins.register({
    manifest: defineManifest('loop-probe', '循环保护探针', {
      namespaces: ['loopProbe'],
      namespaceDomains: { loopProbe: 'document' },
      commands: ['loop.tick'],
      events: ['loop.committed'],
      permissions: ['store.own.read', 'store.own.write'],
    }),
    start(context) {
      context.commands.register({
        type: 'loop.tick',
        handle: () => {
          const count = context.store.readValue<number>('loopProbe', 'count') ?? 0;
          return {
            transaction: {
              label: '循环保护测试',
              history: false,
              patches: [{
                op: 'set', domain: 'document', namespace: 'loopProbe', key: 'count', value: count + 1,
              }],
              events: [{ type: 'loop.committed', payload: { count: count + 1 } }],
            },
          };
        },
      });
      context.events.subscribe('loop.committed', () => {
        try {
          void context.commands.dispatch('loop.tick');
        } catch (error) {
          rejected = error;
        }
      });
    },
  });
  await harness.plugins.start('loop-probe');
  await harness.router.dispatch('loop.tick', undefined, 'core.test');
  const error = await waitFor(async () => rejected);
  assert.match(String(error), /propagation depth exceeded/);
  assert.equal(correlations.size, 1);
  assert.ok((harness.diagnostics.snapshot().counters.rejectedMessages ?? 0) >= 1);
  assert.ok((harness.store.readValue<number>('document', 'loopProbe', 'count') ?? 0) < 30);
});

test('text plugin hot-stop releases commands, UI and capabilities but preserves data', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  await harness.router.dispatch('node.create', { title: '保留的数据', body: '插件停用后仍应存在' }, 'core.test');

  const before = await harness.capabilities.request<Array<{ title: string }>>('content.summaries@1');
  assert.ok(before.some((node) => node.title === '保留的数据'));
  assert.ok(harness.resources.count('text-node') > 0);

  await harness.plugins.stop('text-node');
  assert.equal(harness.resources.count('text-node'), 0);
  assert.equal(harness.capabilities.has('content.summaries@1'), false);
  assert.equal(harness.ui.list('top.primary').length, 0);
  assert.ok(Object.keys(harness.store.readNamespace('document', 'textNode')).length >= 1);
  await assert.rejects(() => harness.router.dispatch('node.create', {}, 'core.test'), /unavailable/);

  await harness.plugins.start('text-node');
  const restored = await harness.capabilities.request<Array<{ title: string }>>('content.summaries@1');
  assert.ok(restored.some((node) => node.title === '保留的数据'));
  assert.deepEqual(
    harness.ui.list('top.primary').map((item) => item.id).sort(),
    ['text-node.create', 'text-node.toggle-selected-presentation'],
  );
});

test('plugin hot-stop closes capability admission and drains in-flight provider calls before teardown', async () => {
  const harness = createHarness();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let providerSettled = false;
  let stopObservedSettled = false;
  harness.plugins.register({
    manifest: defineManifest('draining-provider', '在途能力提供者', {
      providesCapabilities: ['test.draining@1'],
    }),
    start(context) {
      context.capabilities.provide({
        key: 'test.draining@1',
        invoke: (_input, signal) => new Promise((_resolve, reject) => {
          markStarted();
          signal?.addEventListener('abort', () => {
            queueMicrotask(() => {
              providerSettled = true;
              reject(signal.reason);
            });
          }, { once: true });
        }),
      });
    },
    stop() {
      stopObservedSettled = providerSettled;
    },
  });

  await harness.plugins.start('draining-provider');
  const request = harness.capabilities.request('test.draining@1');
  await started;
  const stopping = harness.plugins.stop('draining-provider');
  await assert.rejects(() => harness.capabilities.request('test.draining@1'), /unavailable/u);
  await assert.rejects(() => request, /stopping|AbortError/u);
  await stopping;
  assert.equal(stopObservedSettled, true);
  assert.equal(harness.capabilities.has('test.draining@1'), false);
});

test('a fresh empty canvas starts with two ordinary editable onboarding nodes and no undo noise', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');

  const summaries = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  assert.equal(summaries.length, 2);
  assert.deepEqual(
    new Set(summaries.map((node) => node.title)),
    new Set(['AI 助手使用指南', '画布基本操作指南']),
  );
  assert.ok(summaries.every((node) => node.width === 420 && node.height === 520));
  assert.equal(harness.history.getState().undoCount, 0);

  const bodies = await Promise.all(summaries.map(async (node) => ({
    title: node.title,
    text: (await harness.capabilities.request<{ text: string }>('content.read@1', {
      nodeId: node.id,
      start: 0,
      length: node.length,
    })).text,
  })));
  const aiGuide = bodies.find((node) => node.title === 'AI 助手使用指南')!.text;
  assert.match(aiGuide, /KEY/u);
  assert.match(aiGuide, /BM25/u);
  assert.match(aiGuide, /本机理解检索/u);
  assert.match(aiGuide, /AI 记忆中心面板/u);
  assert.match(aiGuide, /不会默认占用画布/u);
  assert.match(aiGuide, /提案/u);
  const canvasGuide = bodies.find((node) => node.title === '画布基本操作指南')!.text;
  assert.match(canvasGuide, /空格/u);
  assert.match(canvasGuide, /框选/u);
  assert.match(canvasGuide, /群组/u);
  assert.match(canvasGuide, /连线/u);
  assert.match(canvasGuide, /自动保存/u);

  const automatic = await harness.capabilities.request<{ hits: unknown[]; scanned: number }>(
    'context.search@1',
    { terms: ['BM25'], maxResults: 10 },
  );
  assert.equal(automatic.scanned, 0);
  assert.deepEqual(automatic.hits, []);
  const contextCatalog = await harness.capabilities.request<{
    sources: Array<{ sourceId: string; automaticRetrieval?: boolean }>;
  }>('context.catalog@1');
  const aiGuideSource = contextCatalog.sources.find((source) =>
    source.sourceId === summaries.find((node) => node.title === 'AI 助手使用指南')!.id);
  assert.equal(aiGuideSource?.automaticRetrieval, false);
  const explicitRead = await harness.capabilities.request<{ handled: boolean; text?: string }>(
    'context.read@1',
    { sourceId: aiGuideSource!.sourceId, start: 0, length: 200 },
  );
  assert.equal(explicitRead.handled, true);
  assert.match(explicitRead.text ?? '', /AI 助手/u);

  await harness.plugins.stop('text-node');
  await harness.plugins.start('text-node');
  assert.equal(
    (await harness.capabilities.request<ContentSummary[]>('content.summaries@1')).length,
    2,
  );
});

test('text assistance bootstraps one correction-rule resource and preserves it across hot-stop', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(textAssistPlugin);
  harness.plugins.register(createEditorPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('text-assist');
  await harness.plugins.start('editor');

  const summaries = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  const resourceTitles = new Set(['纠错与补全规则']);
  assert.equal(summaries.some((node) => resourceTitles.has(node.title)), false);
  assert.equal(Object.keys(harness.store.readNamespace('document', 'textAssistResource')).length, 1);
  assert.equal(harness.history.getState().undoCount, 0);

  const analysis = await harness.capabilities.request<{ completions: Array<{ label: string }> }>(
    'text.assist.analyze@2',
    { nodeId: 'ordinary', revision: 1, text: '因该', windowStart: 0, cursor: 2 },
  );
  assert.ok(analysis.completions.some((candidate) => candidate.label === '应该'));
  const resourceStatus = await harness.capabilities.request<TextAssistResourceStatus>(
    'text.assist.resources@3',
  );
  assert.equal(resourceStatus.ready, true);
  assert.equal(resourceStatus.association.state, 'same-origin');
  assert.ok(resourceStatus.correctionCount > 0);

  let fileRequestSignals = 0;
  const unsubscribeFileRequest = harness.router.subscribeSignal(
    'core.test',
    'text.assist.rules-file.requested',
    () => { fileRequestSignals += 1; },
  );
  assert.deepEqual(
    await harness.router.dispatch('textAssist.loadRulesFile', undefined, 'core.test'),
    { requested: true },
  );
  assert.equal(fileRequestSignals, 1);
  unsubscribeFileRequest();
  await assert.rejects(
    harness.router.dispatch('textAssist.importRulesFile', { name: 'rules.json', text: '{}' }, 'core.test'),
    /Invalid command payload/u,
  );

  const rules = harness.store.readValue<Record<string, unknown>>('document', 'textAssistResource', 'rules')!;
  assert.equal(rules.schemaVersion, 4);
  assert.equal(rules.ruleStorage, 'builtin-overlay');
  const rulesNodeId = rules.nodeId as string;
  const rulesSummary = (await harness.capabilities.request<ContentSummary[]>('content.summariesById@1', {
    nodeIds: [rulesNodeId],
  }))[0]!;
  const storedRuleNode = harness.store.readValue<Record<string, unknown>>('document', 'textNode', rulesNodeId)!;
  assert.equal(storedRuleNode.placement, 'system');
  assert.ok(harness.ui.listActions().some((action) =>
    action.owner === 'text-assist' && action.id === 'text-assist.open-rules-action'));
  assert.equal(harness.ui.listActions().some((action) =>
    action.owner === 'text-assist' && action.id === 'text-assist.ensure-resources-action'), false);
  assert.equal(harness.ui.listActions().some((action) =>
    action.owner === 'text-assist' && action.id === 'text-assist.merge-default-rules-action'), false);
  await harness.router.dispatch('textAssist.openRules', undefined, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const editorState = await harness.router.ask<{ openPanes: string[] }>('editor.state', undefined, 'core.test');
  assert.deepEqual(editorState.openPanes, [rulesNodeId]);
  const rulesContent = await harness.capabilities.request<{ revision: number; totalLength: number }>('content.read@1', {
    nodeId: rulesNodeId,
    start: 0,
    length: 1,
  });
  assert.ok(rulesContent.totalLength < 1_024);
  await harness.router.dispatch('content.applyDelta', {
    nodeId: rulesNodeId,
    start: rulesSummary.length,
    deleteCount: 0,
    insert: '\n\n[固定纠错]\n量子化布 => 量子画布',
    expectedRevision: rulesContent.revision,
  }, 'core.test');
  const updated = await harness.capabilities.request<{ completions: Array<{ label: string }> }>(
    'text.assist.analyze@2',
    { nodeId: 'ordinary', revision: 2, text: '量子化布', windowStart: 0, cursor: 4 },
  );
  assert.ok(updated.completions.some((candidate) => candidate.label === '量子画布'));

  await harness.plugins.stop('text-assist');
  assert.equal(harness.capabilities.has('text.assist.analyze@2'), false);
  assert.equal(Object.keys(harness.store.readNamespace('document', 'textAssistResource')).length, 1);
  const afterStop = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  assert.equal(afterStop.filter((node) => resourceTitles.has(node.title)).length, 0);
});

test('six nodes and connections serialize without embedding the bundled correction dictionary', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(textAssistPlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createConnectionsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('text-assist');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');

  const nodes = [];
  for (let index = 0; index < 6; index += 1) {
    nodes.push(await harness.router.dispatch<{ id: string }>('node.create', {
      title: `体积测试 ${index + 1}`,
      body: `第 ${index + 1} 个节点的短正文`,
      x: index * 240,
      y: (index % 2) * 180,
    }, 'core.test'));
  }
  for (let index = 1; index < nodes.length; index += 1) {
    await harness.router.dispatch('connection.create', {
      from: { nodeId: nodes[index - 1]!.id, side: 'right' },
      to: { nodeId: nodes[index]!.id, side: 'left' },
    }, 'core.test');
  }

  const file = await serializeProject({
    document: harness.store.snapshot().document,
    plugins: [],
  });
  assert.ok(file.size < 32 * 1_024, `expected a compact book, received ${file.size} bytes`);
});

test('an existing bundled correction dictionary is compacted to a versioned overlay', async () => {
  const harness = createHarness();
  const bundledRules = readFileSync(
    new URL('../public/Echo-8-text-assist-rules.txt', import.meta.url),
    'utf8',
  );
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(textAssistPlugin);
  await harness.plugins.start('text-node');
  const existing = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '纠错与补全规则',
    body: bundledRules,
  }, 'core.test');
  const now = Date.now();
  await harness.transactions.commit({
    label: '注入完整内置规则',
    history: false,
    patches: [{
      op: 'set',
      domain: 'document',
      namespace: 'textAssistResource',
      key: 'rules',
      value: {
        schemaVersion: 3,
        role: 'rules',
        nodeId: existing.id,
        createdAt: now,
        updatedAt: now,
        defaultRuleVersion: 4,
      },
      schemaOwner: 'text-assist',
    }],
  }, testEnvelope('full-default-rule-resource'), 'text-assist');

  await harness.plugins.start('text-assist');
  const compact = await harness.capabilities.request<{ text: string; totalLength: number }>('content.read@1', {
    nodeId: existing.id,
    start: 0,
    length: 2_048,
  });
  assert.ok(compact.totalLength < 1_024);
  assert.match(compact.text, /不重复写入书籍/u);
  const binding = harness.store.readValue<Record<string, unknown>>('document', 'textAssistResource', 'rules')!;
  assert.equal(binding.schemaVersion, 4);
  assert.equal(binding.ruleStorage, 'builtin-overlay');
});

test('text assistance upgrades an existing rule node without copying bundled rules into the book', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(textAssistPlugin);
  await harness.plugins.start('text-node');
  const existing = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '纠错与补全规则',
    body: '版本=2\n[固定纠错]\n因该 => 应当 | 提示=保留用户自己的选择',
  }, 'core.test');
  const now = Date.now();
  await harness.transactions.commit({
    label: '注入旧规则绑定',
    history: false,
    patches: [{
      op: 'set',
      domain: 'document',
      namespace: 'textAssistResource',
      key: 'rules',
      value: {
        schemaVersion: 2,
        role: 'rules',
        nodeId: existing.id,
        createdAt: now,
        updatedAt: now,
      },
      schemaOwner: 'text-assist',
    }],
  }, testEnvelope('old-rule-resource'), 'text-assist');
  const undoBeforeStart = harness.history.getState().undoCount;

  await harness.plugins.start('text-assist');

  const pieces: string[] = [];
  let offset = 0;
  while (true) {
    const slice = await harness.capabilities.request<{ text: string; totalLength: number }>('content.read@1', {
      nodeId: existing.id,
      start: offset,
      length: 256 * 1024,
    });
    pieces.push(slice.text);
    offset += slice.text.length;
    if (offset >= slice.totalLength) break;
  }
  const upgraded = pieces.join('');
  assert.match(upgraded, /因该 => 应当/u);
  assert.doesNotMatch(upgraded, /\[同音候选\]/u);
  assert.ok(upgraded.length < 1_024);
  const binding = harness.store.readValue<Record<string, unknown>>('document', 'textAssistResource', 'rules')!;
  assert.equal(binding.schemaVersion, 4);
  assert.equal(binding.defaultRuleVersion, 4);
  assert.equal(binding.ruleStorage, 'embedded');
  assert.equal(
    harness.store.readValue<Record<string, unknown>>('document', 'textNode', existing.id)?.placement,
    'system',
  );
  assert.equal(
    (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
      .some((summary) => summary.id === existing.id),
    false,
  );
  assert.equal(harness.history.getState().undoCount, undoBeforeStart);
});

test('text assistance permanently deletes retired lexicon nodes through entity deletion plans', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(textAssistPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('text-assist');

  const legacyNodes = await Promise.all(['通用词库', '个人词库', '画布词库'].map((title) =>
    harness.router.dispatch<{ id: string }>('node.create', { title, body: `${title}旧内容` }, 'core.test')));
  const now = Date.now();
  await harness.transactions.commit({
    label: '注入旧词库绑定',
    history: false,
    patches: legacyNodes.map((node, index) => ({
      op: 'set' as const,
      domain: 'document' as const,
      namespace: 'textAssistResource',
      key: ['common', 'personal', 'canvas'][index],
      value: {
        schemaVersion: 1,
        role: ['common', 'personal', 'canvas'][index],
        nodeId: node.id,
        createdAt: now,
        updatedAt: now,
      },
      schemaOwner: 'text-assist',
    })),
  }, testEnvelope('legacy-text-assist'), 'text-assist');

  await harness.router.dispatch('textAssist.ensureResources', undefined, 'core.test');
  const remaining = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  assert.equal(remaining.some((node) => legacyNodes.some((legacy) => legacy.id === node.id)), false);
  assert.deepEqual(Object.keys(harness.store.readNamespace('document', 'textAssistResource')), ['rules']);
});

test('text node titles are auto-numbered on creation and duplicate manual renames are rejected', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');

  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '项目计划' },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '项目计划' },
    'core.test',
  );
  const third = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '项目计划 2' },
    'core.test',
  );
  const summaries = await harness.capabilities.request<ContentSummary[]>('content.summariesById@1', {
    nodeIds: [first.id, second.id, third.id],
  });
  assert.deepEqual(summaries.map((item) => item.title), ['项目计划', '项目计划 2', '项目计划 3']);

  await assert.rejects(
    () => harness.router.dispatch('node.rename', { id: third.id, title: '项目计划' }, 'core.test'),
    /已经存在.*重新命名/u,
  );
  const unchanged = await harness.capabilities.request<ContentSummary[]>('content.summariesById@1', {
    nodeIds: [third.id],
  });
  assert.equal(unchanged[0]?.title, '项目计划 3');
});

test('renaming a text node updates its exact linked title references in the same undoable transaction', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');

  const target = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '项目管理', body: '目标正文中的项目管理不是自引用。' },
    'core.test',
  );
  await harness.router.dispatch('node.create', { title: '项目管理制度' }, 'core.test');
  const article = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '引用文章', body: '关联项目管理；项目管理制度；再次项目管理。' },
    'core.test',
  );

  await harness.router.dispatch('node.rename', { id: target.id, title: '项目统筹' }, 'core.test');
  const renamed = await harness.capabilities.request<ContentSummary[]>('content.summariesById@1', {
    nodeIds: [target.id],
  });
  const updatedBody = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: article.id,
    start: 0,
    length: 256,
  });
  assert.equal(renamed[0]?.title, '项目统筹');
  assert.equal(updatedBody.text, '关联项目统筹；项目管理制度；再次项目统筹。');

  await harness.transactions.undo();
  const restored = await harness.capabilities.request<ContentSummary[]>('content.summariesById@1', {
    nodeIds: [target.id],
  });
  const restoredBody = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: article.id,
    start: 0,
    length: 256,
  });
  assert.equal(restored[0]?.title, '项目管理');
  assert.equal(restoredBody.text, '关联项目管理；项目管理制度；再次项目管理。');
});

test('batch content creation reuses one derived title index instead of rescanning every node', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const reservedTitles: string[] = [];
  const startedAt = performance.now();
  for (let index = 0; index < 2_000; index += 1) {
    const plan = await harness.capabilities.request<ContentMutationPlan>('content.createPlan@1', {
      title: '批量节点',
      body: '',
      x: index,
      y: index,
      reservedTitles,
    });
    reservedTitles.push(plan.resolvedTitle!);
  }
  const elapsed = performance.now() - startedAt;
  assert.equal(new Set(reservedTitles).size, 2_000);
  assert.deepEqual(reservedTitles.slice(0, 4), ['批量节点', '批量节点 2', '批量节点 3', '批量节点 4']);
  assert.ok(elapsed < 2_000, `batch title planning took ${elapsed.toFixed(1)}ms`);
});

test('command availability broadcasts every plugin registration and hot-stop transition', async () => {
  const harness = createHarness();
  let changes = 0;
  const dispose = harness.router.subscribeCommands(() => {
    changes += 1;
  });
  assert.equal(harness.router.isCommandAvailable('node.create'), false);
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  assert.equal(harness.router.isCommandAvailable('node.create'), true);
  const afterStart = changes;
  await harness.plugins.stop('text-node');
  assert.equal(harness.router.isCommandAvailable('node.create'), false);
  assert.ok(changes > afterStart);
  dispose();
});

test('content catalog merges coalesced node changes without a full reset', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const initial = await harness.capabilities.request<ContentCatalogDelta>('content.catalog@2');
  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '目录一', body: 'first' },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '目录二', body: 'second' },
    'core.test',
  );
  await harness.router.dispatch('node.rename', { id: first.id, title: '目录一已改名' }, 'core.test');
  await harness.router.dispatch('node.move', { id: second.id, x: 987, y: 654 }, 'core.test');
  const delta = await harness.capabilities.request<ContentCatalogDelta>(
    'content.catalog@2',
    { sinceVersion: initial.version },
  );
  assert.equal(delta.reset, false);
  assert.equal(delta.summaries.find((node) => node.id === first.id)?.title, '目录一已改名');
  assert.deepEqual(
    (({ x, y }) => ({ x, y }))(delta.summaries.find((node) => node.id === second.id)!),
    { x: 987, y: 654 },
  );
  const settled = await harness.capabilities.request<ContentCatalogDelta>(
    'content.catalog@2',
    { sinceVersion: delta.version },
  );
  assert.equal(settled.reset, false);
  assert.deepEqual(settled.summaries, []);
  assert.deepEqual(settled.removedIds, []);
});

test('content catalog composes every active provider instead of selecting the first one', () => {
  const first: ContentSummary = {
    id: 'text-1', title: '文本', preview: '', x: 0, y: 0, width: 200, height: 120,
    titleColor: '#111111', textColor: '#111111', revision: 1, length: 0,
  };
  const second: ContentSummary = {
    id: 'embed-1', title: '嵌入内容', preview: '', x: 260, y: 0, width: 200, height: 120,
    titleColor: '#111111', textColor: '#111111', revision: 1, length: 0,
  };
  const stale: ContentSummary = {
    id: 'stale', title: '旧内容', preview: '', x: 0, y: 0, width: 100, height: 100,
    titleColor: '#111111', textColor: '#111111', revision: 1, length: 0,
  };
  const merged = mergeContentCatalogDeltas(new Map([[stale.id, stale]]), [
    { version: 4, reset: true, summaries: [first], removedIds: [] },
    { version: 2, reset: true, summaries: [second], removedIds: [] },
  ]);

  assert.equal(merged.geometryChanged, true);
  assert.deepEqual([...merged.catalog.keys()].sort(), ['embed-1', 'text-1']);
});

test('new text nodes without explicit coordinates are centred in the current canvas viewport', async () => {
  const harness = createHarness();
  const camera = { x: 100, y: 50, zoom: 2 };
  const viewport = { width: 1000, height: 600 };
  harness.plugins.register({
    manifest: defineManifest('viewport-probe', '视图中心测试能力', {
      providesCapabilities: ['canvas.viewportCenter@1'],
    }),
    start(context) {
      context.capabilities.provide({
        key: 'canvas.viewportCenter@1',
        invoke: () => viewportCenterInWorld(camera, viewport),
      });
    },
  });
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('viewport-probe');
  await harness.plugins.start('text-node');

  const created = await harness.router.dispatch<{ id: string }>('node.create', {}, 'core.test');
  const node = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((item) => item.id === created.id)!;
  assert.equal(camera.x + (node.x + node.width / 2) * camera.zoom, viewport.width / 2);
  assert.equal(camera.y + (node.y + node.height / 2) * camera.zoom, viewport.height / 2);

  const explicit = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { x: 12, y: 34 },
    'core.test',
  );
  const explicitNode = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((item) => item.id === explicit.id)!;
  assert.deepEqual({ x: explicitNode.x, y: explicitNode.y }, { x: 12, y: 34 });
});

test('spatial index returns the same exact viewport set as a linear bounds scan', () => {
  const items = Array.from({ length: 2_000 }, (_, index) => ({
    id: `node-${index}`,
    x: (index % 80) * 97 - 1_500,
    y: Math.floor(index / 80) * 83 - 700,
    width: 70 + index % 5,
    height: 55 + index % 7,
  }));
  const index = new SpatialHashIndex<(typeof items)[number]>(256);
  index.rebuild(items, (item) => item.id, (item) => item);
  const viewport = { x: -315, y: -120, width: 1_270, height: 840 };
  const expected = items.filter((item) => boundsIntersect(viewport, item)).map((item) => item.id).sort();
  const actual = index.query(viewport).map((item) => item.id).sort();
  assert.deepEqual(actual, expected);

  index.set('negative', { id: 'negative', x: 30, y: 40, width: -20, height: -10 }, {
    x: 30,
    y: 40,
    width: -20,
    height: -10,
  });
  assert.equal(index.query({ x: 10, y: 30, width: 20, height: 20 }).some((item) => item.id === 'negative'), true);
  index.delete('negative');
  assert.equal(index.get('negative'), undefined);
});

test('UI runtime rejects shortcut collisions before activation can become ambiguous', () => {
  const ui = new UIRuntime();
  ui.registerShortcut('plugin-a', {
    id: 'a',
    chord: 'mod+k',
    command: 'a.open',
    label: 'A',
  });
  assert.throws(
    () =>
      ui.registerShortcut('plugin-b', {
        id: 'b',
        chord: 'mod+k',
        command: 'b.open',
        label: 'B',
      }),
    /Shortcut conflict/,
  );
});

test('hold shortcuts expose central key state, follow overrides, and never become press commands', () => {
  const ui = new UIRuntime();
  const release = ui.registerShortcut('canvas', {
    id: 'canvas.pan-shortcut',
    chord: 'space',
    mode: 'hold',
    label: '平移画布',
    instruction: '按住快捷键并拖拽画布',
  });

  ui.setKeyPressed(' ', true);
  assert.equal(ui.isKeyPressed('space'), true);
  assert.equal(ui.isShortcutPressed('canvas', 'canvas.pan-shortcut'), true);
  ui.setKeyPressed(' ', false);
  assert.equal(ui.isShortcutPressed('canvas', 'canvas.pan-shortcut'), false);

  const releaseMembership = ui.registerShortcut('canvas', {
    id: 'canvas.group-membership-modifier',
    chord: 'control',
    mode: 'hold',
    label: '拖动节点时加入或移出群组',
  });
  ui.setKeyPressed('Control', true);
  assert.equal(ui.isShortcutPressed('canvas', 'canvas.group-membership-modifier'), true);
  ui.setKeyPressed('Control', false);
  assert.equal(ui.isShortcutPressed('canvas', 'canvas.group-membership-modifier'), false);

  const releaseDuplicate = ui.registerShortcut('canvas', {
    id: 'canvas.duplicate-modifier',
    chord: 'alt',
    mode: 'hold',
    label: '拖动时复制节点',
  });
  ui.setKeyPressed('Alt', true);
  assert.equal(ui.isShortcutPressed('canvas', 'canvas.duplicate-modifier'), true);
  ui.setKeyPressed('Alt', false);
  assert.equal(ui.isShortcutPressed('canvas', 'canvas.duplicate-modifier'), false);
  assert.throws(() => ui.registerShortcut('canvas', {
    id: 'invalid-alt-press',
    chord: 'alt',
    command: 'canvas.invalid',
    label: '非法单键触发',
  }), /Invalid shortcut chord/);

  ui.setShortcutOverrides('shortcut-center', [
    { targetOwner: 'canvas', targetId: 'canvas.pan-shortcut', chord: 'shift+p' },
  ]);
  ui.setKeyPressed('Shift', true);
  ui.setKeyPressed('p', true);
  assert.equal(ui.isShortcutPressed('canvas', 'canvas.pan-shortcut'), true);
  ui.clearPressedKeys();
  assert.equal(ui.isShortcutPressed('canvas', 'canvas.pan-shortcut'), false);

  const event = {
    key: 'p',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: true,
  } as KeyboardEvent;
  assert.equal(ui.matchShortcut(event), undefined);

  release();
  releaseMembership();
  releaseDuplicate();
  assert.equal(ui.listShortcuts().length, 0);
});

test('exclusive UI surfaces use a deterministic stack and release claims on hot-stop', async () => {
  const harness = createHarness();
  const surfacePlugin = (id: string) => ({
    manifest: defineManifest(id, `面板 ${id}`, {
      commands: [`${id}.open`, `${id}.close`],
      ui: [`${id}.panel`],
      permissions: ['ui.right.contribute'],
    }),
    start(context: Parameters<NonNullable<ReturnType<typeof createShortcutCenterPlugin>['start']>>[0]) {
      context.commands.register({
        type: `${id}.open`,
        handle: () => {
          context.ui.activateSurface('right.primary', `${id}.panel`);
          return { result: true };
        },
      });
      context.commands.register({
        type: `${id}.close`,
        handle: () => {
          context.ui.deactivateSurface('right.primary', `${id}.panel`);
          return { result: true };
        },
      });
      context.ui.contribute({
        id: `${id}.panel`,
        slot: 'right.primary',
        kind: 'view',
        label: id,
      });
    },
  });
  harness.plugins.register(surfacePlugin('surface-a'));
  harness.plugins.register(surfacePlugin('surface-b'));
  await harness.plugins.start('surface-a');
  await harness.plugins.start('surface-b');
  assert.deepEqual(harness.ui.list('right.primary').map((item) => item.owner), ['surface-a', 'surface-b']);

  await harness.router.dispatch('surface-a.open', undefined, 'core.test');
  assert.deepEqual(harness.ui.list('right.primary').map((item) => item.owner), ['surface-a']);
  await harness.router.dispatch('surface-b.open', undefined, 'core.test');
  assert.deepEqual(harness.ui.list('right.primary').map((item) => item.owner), ['surface-b']);
  await harness.router.dispatch('surface-b.close', undefined, 'core.test');
  assert.deepEqual(harness.ui.list('right.primary').map((item) => item.owner), ['surface-a']);

  await harness.plugins.stop('surface-a');
  assert.deepEqual(harness.ui.list('right.primary').map((item) => item.owner), ['surface-b']);
  assert.equal(harness.ui.surfaceSnapshot().find((surface) => surface.slot === 'right.primary')?.active, undefined);
});

test('nonexclusive floating surfaces remain visible while tracking one most-recent close target', () => {
  const ui = new UIRuntime();
  ui.contribute('search', { id: 'panel', slot: 'overlay.floating', kind: 'view', label: '查找' });
  ui.contribute('ai', { id: 'panel', slot: 'overlay.floating', kind: 'view', label: 'AI' });
  ui.activateSurface('search', 'overlay.floating', 'panel', 'search.close');
  ui.activateSurface('ai', 'overlay.floating', 'panel', 'ai.close');

  assert.deepEqual(ui.list('overlay.floating').map((item) => item.owner), ['search', 'ai']);
  assert.deepEqual(ui.closableSurfaces().map((surface) => surface.owner), ['ai', 'search']);

  ui.activateSurface('search', 'overlay.floating', 'panel', 'search.close');
  assert.equal(ui.closableSurfaces()[0]?.owner, 'search');
  ui.deactivateSurface('search', 'overlay.floating', 'panel');
  assert.equal(ui.closableSurfaces()[0]?.owner, 'ai');
});

test('command palette groups public actions by function with deterministic separators and ordering', () => {
  const groups = groupActionsByCategory([
    { category: '系统', label: '诊断', priority: 20 },
    { category: '编辑', label: '粘贴', priority: 30 },
    { category: '文件', label: '保存', priority: 20 },
    { category: '编辑', label: '撤销', priority: 10 },
    { category: '画布', label: '聚焦', priority: 10 },
    { category: 'AI', label: '助手', priority: 10 },
  ]);
  assert.deepEqual(groups.map((group) => group.category), ['文件', '画布', '编辑', 'AI', '系统']);
  assert.deepEqual(groups.find((group) => group.category === '编辑')?.actions.map((action) => action.label), [
    '撤销',
    '粘贴',
  ]);
});

test('shortcut overrides support explicit unbound state, reject conflicts and restore defaults', () => {
  const ui = new UIRuntime();
  ui.registerShortcut('plugin-a', { id: 'open', chord: 'mod+1', command: 'a.open', label: 'A' });
  ui.registerShortcut('plugin-b', { id: 'open', chord: 'mod+2', command: 'b.open', label: 'B' });
  ui.registerShortcut('plugin-c', { id: 'open', command: 'c.open', label: 'C' });

  const initiallyUnassigned = ui.listShortcuts().find((item) => item.owner === 'plugin-c');
  assert.equal(initiallyUnassigned?.chord, '');
  assert.equal(initiallyUnassigned?.baseChord, '');
  assert.equal(initiallyUnassigned?.disabled, true);
  assert.equal(ui.matchShortcut({
    key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  } as KeyboardEvent), undefined);

  ui.setShortcutOverrides('shortcut-center', [
    { targetOwner: 'plugin-a', targetId: 'open', chord: 'mod+9' },
  ]);
  assert.equal(ui.listShortcuts().find((item) => item.owner === 'plugin-a')?.chord, 'mod+9');
  assert.equal(ui.listShortcuts().find((item) => item.owner === 'plugin-a')?.disabled, false);
  assert.equal(ui.listShortcuts().find((item) => item.owner === 'plugin-a')?.overridden, true);

  ui.setShortcutOverrides('shortcut-center', [
    { targetOwner: 'plugin-a', targetId: 'open', disabled: true },
  ]);
  const cleared = ui.listShortcuts().find((item) => item.owner === 'plugin-a');
  assert.equal(cleared?.disabled, true);
  assert.equal(cleared?.chord, '');
  assert.equal(ui.matchShortcut({
    key: '1', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
  } as KeyboardEvent), undefined);

  assert.throws(
    () => ui.setShortcutOverrides('shortcut-center', [
      { targetOwner: 'plugin-a', targetId: 'open', chord: 'mod+2' },
    ]),
    /Shortcut conflict/,
  );
  assert.equal(ui.listShortcuts().find((item) => item.owner === 'plugin-a')?.chord, '');
  assert.equal(ui.listShortcuts().find((item) => item.owner === 'plugin-a')?.disabled, true);

  ui.clearShortcutOverrides('shortcut-center');
  assert.equal(ui.listShortcuts().find((item) => item.owner === 'plugin-a')?.chord, 'mod+1');
  assert.equal(ui.listShortcuts().find((item) => item.owner === 'plugin-a')?.overridden, false);

  ui.setShortcutOverrides('shortcut-center', [
    { targetOwner: 'plugin-c', targetId: 'open', chord: 'mod+3' },
  ]);
  assert.equal(ui.listShortcuts().find((item) => item.owner === 'plugin-c')?.chord, 'mod+3');
  ui.clearShortcutOverrides('shortcut-center');
  assert.equal(ui.listShortcuts().find((item) => item.owner === 'plugin-c')?.disabled, true);
});

test('toolbar shortcut presentation follows effective overrides and explicit clearing', () => {
  const ui = new UIRuntime();
  ui.registerShortcut('plugin-a', {
    id: 'open',
    chord: 'mod+1',
    command: 'a.open',
    label: '打开',
  });
  const presentation = {
    owner: 'plugin-a',
    command: 'a.open',
    label: '打开',
    tooltip: '打开操作（Ctrl/⌘ + 1）',
  };

  assert.equal(commandTooltip(presentation, ui.listShortcuts()), '打开操作（Ctrl/⌘ + 1）');
  ui.setShortcutOverrides('shortcut-center', [
    { targetOwner: 'plugin-a', targetId: 'open', chord: 'alt+shift+9' },
  ]);
  assert.equal(commandTooltip(presentation, ui.listShortcuts()), '打开操作（Alt + Shift + 9）');
  assert.equal(formatShortcutChord('mod+shift+l'), 'Ctrl/⌘ + Shift + L');

  ui.setShortcutOverrides('shortcut-center', [
    { targetOwner: 'plugin-a', targetId: 'open', disabled: true },
  ]);
  assert.equal(commandTooltip(presentation, ui.listShortcuts()), '打开操作');
});

test('overflow wheel scrolling is bounded, horizontal and leaves zoom gestures alone', () => {
  const target = { scrollWidth: 720, clientWidth: 240, scrollLeft: 0 };
  assert.equal(scrollHorizontalOverflow(target, { deltaX: 0, deltaY: 90 }), true);
  assert.equal(target.scrollLeft, 90);
  assert.equal(scrollHorizontalOverflow(target, { deltaX: 160, deltaY: 2 }), true);
  assert.equal(target.scrollLeft, 250);
  assert.equal(scrollHorizontalOverflow(target, { deltaX: 0, deltaY: 999 }), true);
  assert.equal(target.scrollLeft, 480);
  assert.equal(scrollHorizontalOverflow(target, { deltaX: 0, deltaY: 20 }), false);
  assert.equal(scrollHorizontalOverflow(target, { deltaX: 0, deltaY: -999 }), true);
  assert.equal(target.scrollLeft, 0);
  assert.equal(scrollHorizontalOverflow(target, { deltaX: 0, deltaY: 40, ctrlKey: true }), false);
  assert.equal(target.scrollLeft, 0);
});

test('shortcut center persists personal choices outside history and hot-stop releases overrides', async () => {
  const harness = createHarness();
  harness.router.registerQuery('core.shortcuts', {
    type: 'system.shortcuts',
    handle: () => harness.ui.listShortcuts(),
  });
  const target = {
    manifest: defineManifest('shortcut-target', '快捷键目标', {
      commands: ['target.open'],
      shortcuts: ['target.open-shortcut'],
      permissions: ['ui.shortcut.register'],
    }),
    start(context: Parameters<NonNullable<ReturnType<typeof createShortcutCenterPlugin>['start']>>[0]) {
      context.commands.register({ type: 'target.open', handle: () => ({ result: true }) });
      context.ui.shortcut({
        id: 'target.open-shortcut',
        chord: 'mod+1',
        command: 'target.open',
        label: '目标动作',
      });
    },
  };
  const center = createShortcutCenterPlugin();
  harness.plugins.register(target);
  harness.plugins.register(center);
  await harness.plugins.start('shortcut-target');
  await harness.plugins.start('shortcut-center');
  const historyBefore = harness.history.getState().undoCount;

  await harness.router.dispatch('shortcuts.setOverride', {
    targetOwner: 'shortcut-target',
    targetId: 'target.open-shortcut',
    chord: 'mod+8',
  }, 'core.test');
  assert.equal(harness.ui.listShortcuts().find((item) => item.owner === 'shortcut-target')?.chord, 'mod+8');
  assert.equal(harness.history.getState().undoCount, historyBefore);

  await harness.router.dispatch('shortcuts.clearOverride', {
    targetOwner: 'shortcut-target',
    targetId: 'target.open-shortcut',
  }, 'core.test');
  const cleared = harness.ui.listShortcuts().find((item) => item.owner === 'shortcut-target');
  assert.equal(cleared?.disabled, true);
  assert.equal(cleared?.chord, '');
  assert.equal(harness.history.getState().undoCount, historyBefore);

  await harness.plugins.stop('shortcut-center');
  assert.equal(harness.resources.count('shortcut-center'), 0);
  assert.equal(harness.ui.listShortcuts().find((item) => item.owner === 'shortcut-target')?.chord, 'mod+1');
  assert.equal(
    harness.store.readNamespace('workspace', 'shortcutCenter').overrides instanceof Array,
    true,
  );
});

test('shortcut overrides survive a fresh workspace through the personal preference broadcast', async () => {
  const preferences = new Map<string, unknown>();
  const startSession = async () => {
    const harness = createHarness();
    harness.router.registerQuery('core.preferences', {
      type: 'system.preferences.get',
      validate: (payload): payload is { key: string } =>
        typeof payload === 'object' && payload !== null &&
        typeof (payload as { key?: unknown }).key === 'string',
      handle: (payload) => preferences.get(payload.key),
    });
    harness.router.registerCommand('core.preferences', {
      type: 'system.preferences.set',
      validate: (payload): payload is { key: string; value: unknown } =>
        typeof payload === 'object' && payload !== null &&
        typeof (payload as { key?: unknown }).key === 'string' &&
        Object.prototype.hasOwnProperty.call(payload, 'value'),
      handle: (payload) => {
        preferences.set(payload.key, payload.value);
        return { result: { saved: true } };
      },
    });
    harness.router.registerQuery('core.shortcuts', {
      type: 'system.shortcuts',
      handle: () => harness.ui.listShortcuts(),
    });
    const target = {
      manifest: defineManifest('persistent-shortcut-target', '持久快捷键目标', {
        commands: ['persistent-target.open'],
        shortcuts: ['persistent-target.open-shortcut'],
        permissions: ['ui.shortcut.register'],
      }),
      start(context: Parameters<NonNullable<ReturnType<typeof createShortcutCenterPlugin>['start']>>[0]) {
        context.commands.register({ type: 'persistent-target.open', handle: () => ({ result: true }) });
        context.ui.shortcut({
          id: 'persistent-target.open-shortcut',
          chord: 'mod+1',
          command: 'persistent-target.open',
          label: '持久快捷键目标',
        });
      },
    };
    harness.plugins.register(target);
    harness.plugins.register(createShortcutCenterPlugin());
    await harness.plugins.start('persistent-shortcut-target');
    await harness.plugins.start('shortcut-center');
    return harness;
  };

  const first = await startSession();
  await first.router.dispatch('shortcuts.setOverride', {
    targetOwner: 'persistent-shortcut-target',
    targetId: 'persistent-target.open-shortcut',
    chord: 'mod+8',
  }, 'core.test');
  await waitFor(async () => preferences.size === 1 ? true : undefined);

  const reopened = await startSession();
  assert.equal(
    reopened.ui.listShortcuts().find((item) => item.owner === 'persistent-shortcut-target')?.chord,
    'mod+8',
  );
});

test('registered actions execute through the system broadcast and diagnostics do not expose content', async () => {
  const secret = 'PRIVATE-BODY-DO-NOT-EXPOSE';
  const probe = {
    manifest: defineManifest('action-probe', '动作探针', {
      namespaces: ['actionProbe'],
      namespaceDomains: { actionProbe: 'document' },
      commands: ['probe.write'],
      actions: ['probe.write-action'],
      permissions: ['store.own.write', 'ui.action.register'],
    }),
    start(context: Parameters<NonNullable<ReturnType<typeof createShortcutCenterPlugin>['start']>>[0]) {
      context.commands.register({
        type: 'probe.write',
        handle: () => ({
          transaction: {
            label: '动作广播写入',
            patches: [{ op: 'set' as const, domain: 'document' as const, namespace: 'actionProbe', key: 'body', value: secret }],
          },
        }),
      });
      context.ui.action({
        id: 'probe.write-action',
        label: '执行探针动作',
        command: 'probe.write',
        category: '测试',
      });
    },
  };
  const kernel = new ApplicationKernel([probe]);
  await kernel.start();
  const actions = await kernel.router.ask<Array<{ owner: string; id: string }>>('system.actions', undefined, 'core.test');
  assert.ok(actions.some((action) => action.owner === 'action-probe' && action.id === 'probe.write-action'));

  await kernel.router.dispatch('system.action.execute', { owner: 'action-probe', id: 'probe.write-action' }, 'core.test');
  await waitFor(async () => kernel.store.readValue('document', 'actionProbe', 'body') === secret ? true : undefined);
  const runtime = await kernel.router.ask('system.runtime', undefined, 'core.test');
  assert.equal(JSON.stringify(runtime).includes(secret), false);

  await kernel.plugins.stop('action-probe');
  assert.equal(kernel.ui.listActions().some((action) => action.owner === 'action-probe'), false);
});

test('view command failures broadcast one safe user-visible action notice', async () => {
  const kernel = new ApplicationKernel([]);
  await kernel.start();
  const secretPayload = 'PRIVATE-VIEW-PAYLOAD';
  kernel.router.registerCommand('core.test', {
    type: 'probe.ui-failure',
    handle: () => {
      throw new Error('无法完成测试操作');
    },
  });
  let notice: MessageEnvelope<{ owner: string; type: string; message: string }> | undefined;
  const dispose = kernel.router.subscribeSignal('core.test', 'system.ui.action.failed', (envelope) => {
    notice = envelope as MessageEnvelope<{ owner: string; type: string; message: string }>;
  });
  try {
    await assert.rejects(
      () => kernel.createViewClient('core.test-view').dispatch('probe.ui-failure', { body: secretPayload }),
      /无法完成测试操作/u,
    );
    const failure = await waitFor(async () => notice);
    assert.deepEqual(failure.payload, {
      owner: 'core.test-view',
      type: 'probe.ui-failure',
      message: '无法完成测试操作',
    });
    assert.equal(JSON.stringify(failure).includes(secretPayload), false);
  } finally {
    dispose();
  }
});

test('portable file URL text assets require explicit association without attempting fetch', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      baseURI: 'file:///C:/portable/Echo-8.html',
    },
  });
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error('file URL fetch must not run');
  }) as typeof fetch;
  try {
    const kernel = new ApplicationKernel([]);
    await assert.rejects(
      () => kernel.capabilities.request(
        'assets.readText@1',
        { path: 'Echo-8-text-assist-rules.txt' },
      ),
      /requires explicit association/u,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('text-assist imports a bounded TXT through its typed command after UI selection', async () => {
  const kernel = new ApplicationKernel([textNodePlugin, textAssistPlugin]);
  await kernel.start();
  const baseRules = readFileSync(
    new URL('../public/Echo-8-text-assist-rules.txt', import.meta.url),
    'utf8',
  );
  const importedRules = baseRules.replace(
    '[固定纠错]',
    '[固定纠错]\n量子化布 => 量子画布 | 提示=测试导入',
  );
  const result = await kernel.router.dispatch<{ loaded: true; name: string }>(
    'textAssist.importRulesFile',
    { name: 'my-rules.txt', text: importedRules },
    'core.test',
  );
  assert.equal(result.loaded, true);
  assert.equal(result.name, 'my-rules.txt');
  const status = await kernel.capabilities.request<TextAssistResourceStatus>('text.assist.resources@3');
  assert.deepEqual(status.association, { state: 'stored', fileName: 'my-rules.txt' });
  assert.equal(status.bindings.rules?.ruleStorage, 'embedded');
  const analysis = await kernel.capabilities.request<{ completions: Array<{ label: string }> }>(
    'text.assist.analyze@2',
    { nodeId: 'ordinary', revision: 1, text: '量子化布', windowStart: 0, cursor: 4 },
  );
  assert.ok(analysis.completions.some((candidate) => candidate.label === '量子画布'));
});

test('automatic-save cadence is a validated personal setting outside document history', async () => {
  const kernel = new ApplicationKernel([]);
  await kernel.start();
  const before = await kernel.router.ask<PersistenceSnapshot>('system.persistence', undefined, 'core.test');
  assert.equal(before.autosaveIntervalMs, 60_000);
  const historyBefore = kernel.history.getState().undoCount;
  const selected = AUTOSAVE_INTERVAL_OPTIONS[3];
  const after = await kernel.router.dispatch<PersistenceSnapshot>(
    'system.persistence.setAutosaveInterval',
    { intervalMs: selected },
    'core.test',
  );
  assert.equal(after.autosaveIntervalMs, selected);
  assert.equal(kernel.history.getState().undoCount, historyBefore);
  assert.equal(AUTOSAVE_INTERVAL_OPTIONS.includes(AUTOSAVE_REALTIME_INTERVAL_MS), true);
  const disabled = await kernel.router.dispatch<PersistenceSnapshot>(
    'system.persistence.setAutosaveInterval',
    { intervalMs: AUTOSAVE_DISABLED_INTERVAL_MS },
    'core.test',
  );
  assert.equal(disabled.autosaveIntervalMs, AUTOSAVE_DISABLED_INTERVAL_MS);
  await assert.rejects(
    () => kernel.router.dispatch(
      'system.persistence.setAutosaveInterval',
      { intervalMs: 45_000 },
      'core.test',
    ),
    /Invalid command payload/u,
  );
});

test('real-time target saving is debounced and off keeps later document commits local', async () => {
  const kernel = new ApplicationKernel([textNodePlugin]);
  await kernel.start();
  const requests: Array<{ documentRevision: number }> = [];
  const unsubscribe = kernel.router.subscribeSignal(
    'core.test',
    'system.persistence.automaticSave.requested',
    (message) => { requests.push(message.payload as { documentRevision: number }); },
  );
  await kernel.router.dispatch(
    'system.persistence.setAutosaveInterval',
    { intervalMs: AUTOSAVE_REALTIME_INTERVAL_MS },
    'core.test',
  );
  await kernel.router.dispatch('node.create', { title: '实时保存调度' }, 'core.test');
  await kernel.router.dispatch('node.create', { title: '连续修改只触发一次' }, 'core.test');
  await waitFor(async () => requests.length === 1 ? true : undefined, 2_500);
  const revision = await kernel.router.ask<{ revision: number }>(
    'system.document.revision', undefined, 'core.test',
  );
  assert.equal(requests[0].documentRevision, revision.revision);

  await kernel.router.dispatch(
    'system.persistence.setAutosaveInterval',
    { intervalMs: AUTOSAVE_DISABLED_INTERVAL_MS },
    'core.test',
  );
  await kernel.router.dispatch('node.create', { title: '只进入本机恢复日志' }, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_REALTIME_INTERVAL_MS + 150));
  assert.equal(requests.length, 1);
  unsubscribe();
});

test('large personal text assets bypass preference limits without entering the canvas document', async () => {
  const kernel = new ApplicationKernel([]);
  await kernel.start();
  const text = `版本=3\n${'纠错规则\n'.repeat(70_000)}`;
  assert.ok(text.length > 256 * 1024);
  await kernel.router.dispatch('system.personalAssets.set', {
    key: 'rules@1',
    asset: {
      schemaVersion: 1,
      text,
      fileName: 'Echo-8-text-assist-rules.txt',
      updatedAt: 123,
    },
  }, 'core.test');
  const restored = await kernel.router.ask<{ text: string; fileName?: string }>(
    'system.personalAssets.get',
    { key: 'rules@1' },
    'core.test',
  );
  assert.equal(restored.text, text);
  assert.equal(restored.fileName, 'Echo-8-text-assist-rules.txt');
  const project = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  assert.equal(Object.prototype.hasOwnProperty.call(project.document.namespaces, 'personalAssets'), false);
  assert.equal(kernel.history.getState().undoCount, 0);
});

test('automatic full checkpoints are due only when the configured time interval elapses', () => {
  const checkpointAt = 1_000_000;
  const interval = 300_000;
  assert.equal(isAutosaveCheckpointDue(checkpointAt, checkpointAt + interval - 1, interval), false);
  assert.equal(isAutosaveCheckpointDue(checkpointAt, checkpointAt + interval, interval), true);
  assert.equal(isAutosaveCheckpointDue(undefined, checkpointAt, interval), true);
});

test('palette theme activation is workspace-only and hot-stop restores the core theme', async () => {
  const harness = createHarness();
  const palette = createPalettePlugin();
  harness.plugins.register(palette);
  await harness.plugins.start('palette');

  assert.equal(harness.ui.getActiveTheme().owner, 'palette');
  assert.equal(harness.ui.getActiveTheme().mode, 'light');
  const historyBefore = harness.history.getState().undoCount;
  await harness.router.dispatch('palette.setPreferences', {
    themeId: 'dark',
    editorBackground: '#123456',
    editorChromeBackground: '#654321',
    toolbarBackground: '#fefefe',
    annotationColor: '#ff5500',
    groupBackground: '#336699',
  }, 'core.test');
  assert.equal(harness.ui.getActiveTheme().mode, 'dark');
  assert.equal(harness.ui.getActiveTheme().tokens.editor, '#123456');
  assert.equal(harness.ui.getActiveTheme().tokens.editorPaper, '#123456');
  assert.equal(harness.ui.getActiveTheme().tokens.editorChrome, '#654321');
  assert.equal(harness.ui.getActiveTheme().tokens.toolbar, '#fefefe');
  assert.equal(harness.ui.getActiveTheme().tokens.annotation, '#ff5500');
  assert.equal(harness.ui.getActiveTheme().tokens.groupBackground, '#336699');
  assert.equal(harness.history.getState().undoCount, historyBefore);

  await harness.router.dispatch('palette.open', undefined, 'core.test');
  assert.deepEqual(harness.ui.topSurface(['right.primary']), {
    owner: 'palette',
    id: 'palette.panel',
    slot: 'right.primary',
    closeCommand: 'palette.close',
  });
  assert.equal(harness.store.readValue('workspace', 'palette', 'open'), true);
  assert.equal(harness.history.getState().undoCount, historyBefore);
  await harness.router.dispatch('palette.close', undefined, 'core.test');
  assert.equal(harness.ui.topSurface(['right.primary']), undefined);
  assert.equal(harness.store.readValue('workspace', 'palette', 'open'), false);

  await harness.plugins.stop('palette');
  assert.equal(harness.ui.getActiveTheme().owner, 'core.ui');
  assert.equal(harness.store.readValue('workspace', 'palette', 'preferences') !== undefined, true);

  await harness.plugins.start('palette');
  assert.equal(harness.ui.getActiveTheme().mode, 'dark');
  assert.equal(harness.ui.getActiveTheme().tokens.editorPaper, '#123456');
  assert.equal(harness.ui.getActiveTheme().tokens.editorChrome, '#654321');
  assert.equal(harness.ui.getActiveTheme().tokens.toolbar, '#fefefe');
  assert.equal(harness.ui.getActiveTheme().tokens.annotation, '#ff5500');
  assert.equal(harness.ui.getActiveTheme().tokens.groupBackground, '#336699');
});

test('navigation ink is derived from the configured toolbar background', () => {
  assert.equal(contrastingInk('#ffffff'), '#18181a');
  assert.equal(contrastingInk('#000000'), '#ffffff');
  assert.equal(contrastingInk('rgba(250, 250, 249, 0.92)'), '#18181a');
});

test('opening a text editor makes every governed right panel yield through core UI arbitration', async () => {
  const harness = createHarness();
  const genericRightPanel: PluginDefinition = {
    manifest: defineManifest('generic-right-panel', '任意右侧面板', {
      namespaces: ['genericRightPanel'],
      namespaceDomains: { genericRightPanel: 'workspace' },
      commands: ['genericRightPanel.open', 'genericRightPanel.close'],
      dispatches: ['genericRightPanel.close'],
      ui: ['generic-right-panel.view'],
      permissions: ['store.own.read', 'store.own.write', 'ui.right.contribute'],
    }),
    start(context) {
      const setOpen = (open: boolean) => ({
        transaction: {
          label: open ? '打开任意右侧面板' : '关闭任意右侧面板',
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: 'genericRightPanel',
            key: 'open',
            value: open,
          }],
        },
      });
      context.commands.register({
        type: 'genericRightPanel.open',
        handle: () => {
          context.ui.activateSurface('right.primary', 'generic-right-panel.view', 'genericRightPanel.close');
          return setOpen(true);
        },
      });
      context.commands.register({
        type: 'genericRightPanel.close',
        handle: () => {
          context.ui.deactivateSurface('right.primary', 'generic-right-panel.view');
          return setOpen(false);
        },
      });
      context.ui.contribute({
        id: 'generic-right-panel.view',
        slot: 'right.primary',
        kind: 'view',
        label: '任意右侧面板',
      });
    },
  };
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createEditorPlugin());
  harness.plugins.register(createPalettePlugin());
  harness.plugins.register(genericRightPanel);
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  await harness.plugins.start('palette');
  await harness.plugins.start('generic-right-panel');
  const created = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '打开编辑区' },
    'core.test',
  );
  await harness.router.dispatch('palette.open', undefined, 'core.test');
  assert.equal(harness.store.readValue('workspace', 'palette', 'open'), true);

  await harness.router.dispatch('editor.open', { id: created.id }, 'core.test');
  await waitFor(async () => harness.store.readValue('workspace', 'palette', 'open') === false);

  assert.equal(harness.ui.topSurface(['right.primary']), undefined);

  await harness.router.dispatch('genericRightPanel.open', undefined, 'core.test');
  assert.equal(harness.store.readValue('workspace', 'genericRightPanel', 'open'), true);
  await harness.router.dispatch('editor.open', { id: created.id }, 'core.test');
  await waitFor(async () => harness.store.readValue('workspace', 'genericRightPanel', 'open') === false);

  assert.equal(harness.ui.topSurface(['right.primary']), undefined);
});

test('palette composes owner appearance plans into one undoable document transaction', async () => {
  const harness = createHarness();
  const selection = createSelectionPlugin();
  const palette = createPalettePlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(selection);
  harness.plugins.register(palette);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('palette');

  const created = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '配色目标', body: '颜色由文本插件持有' },
    'core.test',
  );
  await harness.router.dispatch('selection.set', { ids: [created.id], mode: 'replace' }, 'core.test');
  const targets = await harness.capabilities.request<Array<{
    kind: string;
    color: string;
    entities: Array<{ id: string; revision: number; expectedColor: string }>;
  }>>('palette.targets@1');
  const titleTarget = targets.find((target) => target.kind === 'node-title');
  assert.ok(titleTarget);
  const initialTitleColors = await harness.capabilities.request<Array<{ color: string; count: number }>>(
    'palette.titleColors@1',
  );
  const initialSummaries = await harness.capabilities.request<Array<{ titleColor: string }>>(
    'content.summaries@1',
  );
  assert.equal(
    initialTitleColors.reduce((total, record) => total + record.count, 0),
    initialSummaries.length,
  );
  assert.ok(initialTitleColors.some((record) => record.color === titleTarget.color && record.count >= 1));
  const historyBefore = harness.history.getState().undoCount;

  await harness.router.dispatch(
    'palette.applyAppearance',
    { kind: titleTarget.kind, color: '#8a3ffc', entities: titleTarget.entities },
    'core.test',
  );
  const changed = await harness.capabilities.request<Array<{ id: string; titleColor: string }>>(
    'content.summaries@1',
  );
  assert.equal(changed.find((node) => node.id === created.id)?.titleColor, '#8a3ffc');
  const changedTitleColors = await harness.capabilities.request<Array<{ color: string; count: number }>>(
    'palette.titleColors@1',
  );
  assert.equal(
    changedTitleColors.reduce((total, record) => total + record.count, 0),
    changed.length,
  );
  assert.ok(changedTitleColors.some((record) => record.color === '#8a3ffc' && record.count === 1));
  assert.equal(harness.history.getState().undoCount, historyBefore + 1);

  await harness.transactions.undo();
  const restored = await harness.capabilities.request<Array<{ id: string; titleColor: string }>>(
    'content.summaries@1',
  );
  assert.equal(restored.find((node) => node.id === created.id)?.titleColor, titleTarget.color);
});

test('selection palette changes only the selected object and keeps the change undoable', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createPalettePlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('palette');
  const shortcut = harness.ui.listShortcuts().find((item) => item.id === 'palette.selection-color-shortcut');
  assert.equal(shortcut?.chord, 'p');
  assert.equal(shortcut?.command, 'palette.selectionColor.open');

  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '局部配色一' },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '局部配色二' },
    'core.test',
  );
  const before = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  const firstBefore = before.find((node) => node.id === first.id)!;
  const secondBefore = before.find((node) => node.id === second.id)!;
  await harness.router.dispatch('selection.set', {
    items: [{ id: first.id, kind: 'text-node' }],
    mode: 'replace',
  }, 'core.test');
  const historyBefore = harness.history.getState().undoCount;

  await harness.router.dispatch('palette.selectionColor.open', undefined, 'core.test');
  const picker = await harness.router.ask<{
    sessionId: string;
    color: string;
    appearancePreview?: { kind?: string; entityIds?: string[] };
  }>('palette.colorPicker.state', undefined, 'core.test');
  assert.equal(picker.color, firstBefore.titleColor);
  assert.equal(picker.appearancePreview?.kind, 'node-title');
  assert.deepEqual(picker.appearancePreview?.entityIds, [first.id]);
  await harness.router.dispatch('palette.colorPicker.commit', {
    sessionId: picker.sessionId,
    color: '#356ac3',
  }, 'core.test');
  await harness.router.dispatch('palette.colorPicker.close', {
    sessionId: picker.sessionId,
    silent: true,
  }, 'core.test');

  const changed = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  assert.equal(changed.find((node) => node.id === first.id)?.titleColor, '#356ac3');
  assert.equal(changed.find((node) => node.id === second.id)?.titleColor, secondBefore.titleColor);
  assert.equal(harness.history.getState().undoCount, historyBefore + 1);

  await harness.transactions.undo();
  const restored = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  assert.equal(restored.find((node) => node.id === first.id)?.titleColor, firstBefore.titleColor);
  assert.equal(restored.find((node) => node.id === second.id)?.titleColor, secondBefore.titleColor);
});

test('selection palette recolors mixed module kinds in one undoable transaction and records every used color', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createConnectionsPlugin());
  harness.plugins.register(createGroupsPlugin());
  harness.plugins.register(createPalettePlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');
  await harness.plugins.start('groups');
  await harness.plugins.start('palette');

  const left = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '混合颜色节点', x: 100, y: 100,
  }, 'core.test');
  const right = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '混合颜色目标', x: 600, y: 100,
  }, 'core.test');
  const connection = await harness.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: left.id, side: 'right' },
    to: { nodeId: right.id, side: 'left' },
  }, 'core.test');
  await harness.router.dispatch('selection.set', { ids: [left.id, right.id], mode: 'replace' }, 'core.test');
  const group = await harness.router.dispatch<{ id: string }>('group.create', { title: '混合颜色群组' }, 'core.test');
  const beforeNode = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === left.id)!;
  const historyBefore = harness.history.getState().undoCount;

  await harness.router.dispatch('selection.set', {
    items: [
      { id: left.id, kind: 'text-node' },
      { id: connection.id, kind: 'connection', part: 'line' },
      { id: group.id, kind: 'group' },
    ],
    mode: 'replace',
  }, 'core.test');
  await harness.router.dispatch('palette.selectionColor.open', undefined, 'core.test');
  let picker = await harness.router.ask<{
    sessionId: string;
    appearancePreview?: { targets?: Array<{ kind: string; entityIds: string[] }> };
    colors: Array<{ color: string; count: number }>;
  }>('palette.colorPicker.state', undefined, 'core.test');
  assert.deepEqual(
    picker.appearancePreview?.targets?.map((target) => target.kind).sort(),
    ['connection-line', 'group-fill', 'node-title'],
  );
  await harness.router.dispatch('palette.colorPicker.commit', {
    sessionId: picker.sessionId,
    color: '#4a7c59',
  }, 'core.test');
  await harness.router.dispatch('palette.colorPicker.close', {
    sessionId: picker.sessionId,
    silent: true,
  }, 'core.test');

  assert.equal(
    (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
      .find((node) => node.id === left.id)?.titleColor,
    '#4a7c59',
  );
  assert.equal(
    (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))
      .find((item) => item.id === connection.id)?.lineColor,
    '#4a7c59',
  );
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string; color?: string }>>('groups.list@1'))
      .find((item) => item.id === group.id)?.color,
    '#4a7c59',
  );
  assert.equal(harness.history.getState().undoCount, historyBefore + 1);

  await harness.router.dispatch('palette.selectionColor.open', undefined, 'core.test');
  picker = await harness.router.ask('palette.colorPicker.state', undefined, 'core.test');
  assert.ok(picker.colors.some((record) => record.color === '#4a7c59' && record.count >= 3));
  await harness.router.dispatch('palette.colorPicker.close', {
    sessionId: picker.sessionId,
    silent: true,
  }, 'core.test');

  await harness.transactions.undo();
  assert.equal(
    (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
      .find((node) => node.id === left.id)?.titleColor,
    beforeNode.titleColor,
  );
  assert.equal(
    (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))
      .find((item) => item.id === connection.id)?.lineColor,
    undefined,
  );
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string; color?: string }>>('groups.list@1'))
      .find((item) => item.id === group.id)?.color,
    undefined,
  );
});

test('selection palette persists independent line, label-box, and label-text colors', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createConnectionsPlugin());
  harness.plugins.register(createPalettePlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');
  await harness.plugins.start('palette');

  const left = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '局部连线左', x: 100, y: 100,
  }, 'core.test');
  const right = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '局部连线右', x: 600, y: 100,
  }, 'core.test');
  const connection = await harness.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: left.id, side: 'right' },
    to: { nodeId: right.id, side: 'left' },
  }, 'core.test');
  const initial = (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0];
  await harness.router.dispatch('connection.setLabel', {
    id: connection.id,
    label: '局部标签',
    expectedRevision: initial.revision,
  }, 'core.test');

  const cases = [
    { part: 'line', kind: 'connection-line', field: 'lineColor', color: '#315f9f' },
    {
      part: 'label-background',
      kind: 'connection-label-background',
      field: 'labelBackgroundColor',
      color: '#f0d989',
    },
    {
      part: 'label-text',
      kind: 'connection-label-text',
      field: 'labelTextColor',
      color: '#703d92',
    },
  ] as const;

  for (const item of cases) {
    await harness.router.dispatch('selection.set', {
      items: [{ id: connection.id, kind: 'connection', part: item.part }],
      mode: 'replace',
    }, 'core.test');
    await harness.router.dispatch('palette.selectionColor.open', undefined, 'core.test');
    const picker = await harness.router.ask<{
      sessionId: string;
      appearancePreview?: { kind?: string; entityIds?: string[] };
    }>('palette.colorPicker.state', undefined, 'core.test');
    assert.equal(picker.appearancePreview?.kind, item.kind);
    assert.deepEqual(picker.appearancePreview?.entityIds, [connection.id]);
    await harness.router.dispatch('palette.colorPicker.commit', {
      sessionId: picker.sessionId,
      color: item.color,
    }, 'core.test');
    await harness.router.dispatch('palette.colorPicker.close', {
      sessionId: picker.sessionId,
      silent: true,
    }, 'core.test');
    const stored = (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0];
    assert.equal(stored[item.field], item.color);
  }

  const selected = await harness.capabilities.request<{
    items: Array<{ id: string; part?: string }>;
  }>('selection.read@1');
  assert.equal(selected.items[0]?.part, 'label-text');
  await harness.transactions.undo();
  const undone = (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0];
  assert.equal(undone.labelTextColor, undefined);
  assert.equal(undone.labelBackgroundColor, '#f0d989');
  assert.equal(undone.lineColor, '#315f9f');
});

test('selection palette stores group and annotation overrides without changing global defaults', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createGroupsPlugin());
  harness.plugins.register(createAnnotationsPlugin());
  harness.plugins.register(createPalettePlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('groups');
  await harness.plugins.start('annotations');
  await harness.plugins.start('palette');

  const first = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '群组颜色一', x: 100, y: 100,
  }, 'core.test');
  const second = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '群组颜色二', x: 500, y: 100,
  }, 'core.test');
  await harness.router.dispatch('selection.set', { ids: [first.id, second.id], mode: 'replace' }, 'core.test');
  const group = await harness.router.dispatch<{ id: string }>('group.create', { title: '局部群组色' }, 'core.test');

  await harness.router.dispatch('selection.set', {
    items: [{ id: group.id, kind: 'group' }],
    mode: 'replace',
  }, 'core.test');
  await harness.router.dispatch('palette.selectionColor.open', undefined, 'core.test');
  let picker = await harness.router.ask<{
    sessionId: string;
    appearancePreview?: { kind?: string };
  }>('palette.colorPicker.state', undefined, 'core.test');
  assert.equal(picker.appearancePreview?.kind, 'group-fill');
  await harness.router.dispatch('palette.colorPicker.commit', {
    sessionId: picker.sessionId,
    color: '#547f6a',
  }, 'core.test');
  await harness.router.dispatch('palette.colorPicker.close', {
    sessionId: picker.sessionId,
    silent: true,
  }, 'core.test');
  const storedGroup = (await harness.capabilities.request<Array<{ id: string; color?: string }>>(
    'groups.list@1',
  )).find((item) => item.id === group.id);
  assert.equal(storedGroup?.color, '#547f6a');

  const annotation = await harness.router.dispatch<{ id: string }>('annotation.create', {
    target: { kind: 'text-node', targetId: first.id },
    body: '局部注释色',
  }, 'core.test');
  await harness.router.dispatch('selection.set', {
    items: [{ id: annotation.id, kind: 'annotation' }],
    mode: 'replace',
  }, 'core.test');
  await harness.router.dispatch('palette.selectionColor.open', undefined, 'core.test');
  picker = await harness.router.ask('palette.colorPicker.state', undefined, 'core.test');
  assert.equal(picker.appearancePreview?.kind, 'annotation-marker');
  await harness.router.dispatch('palette.colorPicker.commit', {
    sessionId: picker.sessionId,
    color: '#c64f4f',
  }, 'core.test');
  await harness.router.dispatch('palette.colorPicker.close', {
    sessionId: picker.sessionId,
    silent: true,
  }, 'core.test');
  const storedAnnotation = (await harness.capabilities.request<Array<{ id: string; color?: string }>>(
    'annotations.list@1',
  )).find((item) => item.id === annotation.id);
  assert.equal(storedAnnotation?.color, '#c64f4f');

  const preferences = harness.store.readValue<{
    groupBackground: string;
    annotationColor: string;
  }>('workspace', 'palette', 'preferences');
  assert.notEqual(preferences?.groupBackground, '#547f6a');
  assert.notEqual(preferences?.annotationColor, '#c64f4f');
});

test('global color reset restores document and personal defaults while keeping the document reset undoable', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createConnectionsPlugin());
  harness.plugins.register(createGroupsPlugin());
  harness.plugins.register(createAnnotationsPlugin());
  harness.plugins.register(createPalettePlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');
  await harness.plugins.start('groups');
  await harness.plugins.start('annotations');
  await harness.plugins.start('palette');

  const left = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '重置颜色一', body: 'abcdef', x: 100, y: 100,
  }, 'core.test');
  const right = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '重置颜色二', x: 600, y: 100,
  }, 'core.test');
  const connection = await harness.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: left.id, side: 'right' },
    to: { nodeId: right.id, side: 'left' },
  }, 'core.test');
  await harness.router.dispatch('selection.set', { ids: [left.id, right.id], mode: 'replace' }, 'core.test');
  const group = await harness.router.dispatch<{ id: string }>('group.create', { title: '重置颜色群组' }, 'core.test');
  const annotation = await harness.router.dispatch<{ id: string }>('annotation.create', {
    target: { kind: 'text-node', targetId: left.id },
    body: '重置颜色注释',
  }, 'core.test');

  const globalTargets = await harness.capabilities.request<Array<{
    kind: string;
    color: string;
    entities: Array<{ id: string; revision: number; expectedColor: string }>;
  }>>('palette.targets@1');
  const connectionTarget = globalTargets.find((target) => target.kind === 'connection-line')!;
  await harness.router.dispatch('palette.applyAppearance', {
    kind: connectionTarget.kind,
    color: '#665544',
    entities: connectionTarget.entities,
  }, 'core.test');

  await harness.router.dispatch('selection.set', {
    items: [
      { id: left.id, kind: 'text-node' },
      { id: connection.id, kind: 'connection', part: 'line' },
      { id: group.id, kind: 'group' },
      { id: annotation.id, kind: 'annotation' },
    ],
    mode: 'replace',
  }, 'core.test');
  await harness.router.dispatch('palette.selectionColor.open', undefined, 'core.test');
  const picker = await harness.router.ask<{ sessionId: string }>(
    'palette.colorPicker.state',
    undefined,
    'core.test',
  );
  await harness.router.dispatch('palette.colorPicker.commit', {
    sessionId: picker.sessionId,
    color: '#7b4d8f',
  }, 'core.test');
  await harness.router.dispatch('palette.colorPicker.close', {
    sessionId: picker.sessionId,
    silent: true,
  }, 'core.test');

  let format = await harness.capabilities.request<{
    revision: number;
    contentRevision: number;
    format: { color: string };
  }>('content.formatting@2', { nodeId: left.id });
  await harness.router.dispatch('content.setDocumentFormat', {
    nodeId: left.id,
    expectedRevision: format.revision,
    patch: { color: '#234567' },
  }, 'core.test');
  format = await harness.capabilities.request('content.formatting@2', { nodeId: left.id });
  await harness.router.dispatch('content.setRangeFormat', {
    nodeId: left.id,
    expectedRevision: format.revision,
    expectedContentRevision: format.contentRevision,
    start: 1,
    end: 4,
    scope: 'selection',
    patch: { color: '#c34567' },
  }, 'core.test');
  await harness.router.dispatch('palette.setPreferences', {
    editorBackground: '#eeeeee',
    editorChromeBackground: '#dddddd',
    toolbarBackground: '#cccccc',
    annotationColor: '#bb5500',
    groupBackground: '#335577',
  }, 'core.test');
  const historyBeforeReset = harness.history.getState().undoCount;

  const reset = await harness.router.dispatch<{ changed: number }>('palette.resetAppearance', undefined, 'core.test');
  await harness.router.dispatch('palette.setPreferences', {
    themeId: 'light',
    editorBackground: '#f1f1ef',
    editorChromeBackground: '#ffffff',
    toolbarBackground: '#fafaf9',
    annotationColor: '#ff9f0a',
    groupBackground: '#202124',
  }, 'core.test');
  assert.ok(reset.changed > 0);
  assert.equal(harness.history.getState().undoCount, historyBeforeReset + 1);

  assert.equal(
    (await harness.capabilities.request<ConnectionAppearanceSnapshot>('connections.appearance@1')).color,
    undefined,
  );
  assert.equal(
    (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))
      .find((item) => item.id === connection.id)?.lineColor,
    undefined,
  );
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string; color?: string }>>('groups.list@1'))
      .find((item) => item.id === group.id)?.color,
    undefined,
  );
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string; color?: string }>>('annotations.list@1'))
      .find((item) => item.id === annotation.id)?.color,
    undefined,
  );
  assert.equal(
    (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
      .find((node) => node.id === left.id)?.titleColor,
    '#202124',
  );
  const resetFormat = await harness.capabilities.request<{
    format: { color: string };
    marks: Array<{ format: { color?: string } }>;
  }>('content.formatting@2', { nodeId: left.id });
  assert.equal(resetFormat.format.color, DEFAULT_TEXT_DOCUMENT_FORMAT.color);
  assert.equal(resetFormat.marks.some((mark) => mark.format.color !== undefined), false);
  assert.deepEqual(
    harness.store.readValue('workspace', 'palette', 'preferences'),
    {
      themeId: 'light',
      editorBackground: '#f1f1ef',
      editorChromeBackground: '#ffffff',
      toolbarBackground: '#fafaf9',
      annotationColor: '#ff9f0a',
      groupBackground: '#202124',
    },
  );

  await harness.transactions.undo();
  assert.equal(
    (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
      .find((node) => node.id === left.id)?.titleColor,
    '#7b4d8f',
  );
  assert.equal(
    (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))
      .find((item) => item.id === connection.id)?.lineColor,
    '#7b4d8f',
  );
  const restoredFormat = await harness.capabilities.request<{
    format: { color: string };
    marks: Array<{ format: { color?: string } }>;
  }>('content.formatting@2', { nodeId: left.id });
  assert.equal(restoredFormat.format.color, '#234567');
  assert.equal(restoredFormat.marks.some((mark) => mark.format.color === '#c34567'), true);
});

test('object-level appearance migrations keep legacy records inheriting global colors', async () => {
  const legacyConnection = {
    id: 'connection-legacy',
    from: { nodeId: 'left', side: 'right' },
    to: { nodeId: 'right', side: 'left' },
    revision: 1,
    createdAt: 1,
  };
  const legacyGroup = {
    id: 'group-legacy',
    title: '',
    memberIds: ['left', 'right'],
    titleStyle: { fontSize: 16, fontWeight: 600 },
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const legacyAnnotation = {
    id: 'annotation-legacy',
    target: { kind: 'text-node', targetId: 'left' },
    body: '旧注释',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const connections = createConnectionsPlugin();
  const groups = createGroupsPlugin();
  const annotations = createAnnotationsPlugin();
  const connectionMigration = connections.migrations?.find((item) => item.from === 5 && item.to === 6);
  const groupMigration = groups.migrations?.find((item) => item.from === 1 && item.to === 2);
  const annotationMigration = annotations.migrations?.find((item) => item.from === 1 && item.to === 2);
  assert.ok(connectionMigration);
  assert.ok(groupMigration);
  assert.ok(annotationMigration);

  assert.deepEqual(
    await connectionMigration.migrate({ connections: { [legacyConnection.id]: legacyConnection } }),
    { connections: { [legacyConnection.id]: legacyConnection } },
  );
  assert.deepEqual(
    await groupMigration.migrate({ groups: { [legacyGroup.id]: legacyGroup } }),
    { groups: { [legacyGroup.id]: legacyGroup } },
  );
  assert.deepEqual(
    await annotationMigration.migrate({ annotations: { [legacyAnnotation.id]: legacyAnnotation } }),
    { annotations: { [legacyAnnotation.id]: legacyAnnotation } },
  );
  assert.equal(connections.manifest.dataVersion, 6);
  assert.equal(groups.manifest.dataVersion, 2);
  assert.equal(annotations.manifest.dataVersion, 2);
});

test('global palette persists one contrast-safe connection curve color through the connection owner', async () => {
  const kernel = new ApplicationKernel([
    textNodePlugin,
    createSelectionPlugin(),
    createConnectionsPlugin(),
    createPalettePlugin(),
  ]);
  await kernel.start();

  const targets = await kernel.capabilities.request<Array<{
    kind: string;
    label: string;
    scopeLabel: string;
    color: string;
    entities: Array<{ id: string; revision: number; expectedColor: string }>;
  }>>('palette.targets@1');
  const connectionTarget = targets.find((target) => target.kind === 'connection-line');
  assert.ok(connectionTarget);
  assert.equal(connectionTarget.label, '连接曲线');
  assert.equal(connectionTarget.scopeLabel, '当前画布的全部连接曲线');
  const historyBefore = kernel.history.getState().undoCount;

  await kernel.router.dispatch('palette.applyAppearance', {
    kind: 'connection-line',
    color: '#245eb4',
    entities: connectionTarget.entities,
  }, 'core.test');
  assert.deepEqual(
    await kernel.capabilities.request<ConnectionAppearanceSnapshot>('connections.appearance@1'),
    { color: '#245eb4', revision: 1 },
  );
  assert.equal(kernel.history.getState().undoCount, historyBefore + 1);

  await kernel.transactions.undo();
  assert.deepEqual(
    await kernel.capabilities.request<ConnectionAppearanceSnapshot>('connections.appearance@1'),
    { revision: 0 },
  );
  await kernel.transactions.redo();

  const source = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  const descriptor = source.plugins.find((plugin) => plugin.id === 'connections');
  assert.equal(descriptor?.dataVersion, 6);
  assert.deepEqual(descriptor?.namespaces.sort(), ['connectionAppearance', 'connections']);

  const reopened = new ApplicationKernel([
    textNodePlugin,
    createSelectionPlugin(),
    createConnectionsPlugin(),
    createPalettePlugin(),
  ]);
  await reopened.start();
  await reopened.router.dispatch(
    'system.document.replace',
    await parseProject(await serializeProject(source)),
    'core.test',
  );
  assert.deepEqual(
    await reopened.capabilities.request<ConnectionAppearanceSnapshot>('connections.appearance@1'),
    { color: '#245eb4', revision: 1 },
  );
});

test('global color picker is an ephemeral governed modal and lists canvas colors', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createPalettePlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('palette');

  const first = await harness.router.dispatch<{ id: string }>('node.create', { title: '颜色一' }, 'core.test');
  const second = await harness.router.dispatch<{ id: string }>('node.create', { title: '颜色二' }, 'core.test');
  let nodes = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  const secondNode = nodes.find((node) => node.id === second.id)!;
  await harness.router.dispatch('palette.applyAppearance', {
    kind: 'node-title',
    color: '#7a8b9c',
    entities: [{
      id: secondNode.id,
      revision: secondNode.nodeRevision ?? secondNode.revision,
      expectedColor: secondNode.titleColor,
    }],
  }, 'core.test');
  nodes = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  const firstNode = nodes.find((node) => node.id === first.id)!;
  const historyBeforeOpen = harness.history.getState().undoCount;

  await harness.router.dispatch('palette.nodeTitlePicker.open', {
    targets: [{
      id: firstNode.id,
      revision: firstNode.nodeRevision ?? firstNode.revision,
      expectedColor: firstNode.titleColor,
    }],
    anchor: { x: 240, y: 160, width: 24, height: 24 },
  }, 'core.test');
  assert.deepEqual(harness.ui.topSurface(['overlay.modal']), {
    owner: 'palette',
    id: 'palette.node-title-picker',
    slot: 'overlay.modal',
    closeCommand: 'palette.colorPicker.close',
  });
  const picker = await harness.router.ask<{
    open: boolean;
    targets: Array<{ id: string }>;
    titleColors: Array<{ color: string; count: number }>;
  }>('palette.nodeTitlePicker.state', undefined, 'core.test');
  assert.equal(picker.open, true);
  assert.equal(picker.targets[0]?.id, first.id);
  assert.equal(picker.titleColors.reduce((total, record) => total + record.count, 0), nodes.length);
  assert.equal(picker.titleColors.some((record) => record.color === '#7a8b9c'), true);
  const globalPicker = await harness.router.ask<{
    open: boolean;
    sessionId: string;
    colors: Array<{ color: string; count: number }>;
  }>('palette.colorPicker.state', undefined, 'core.test');
  assert.equal(globalPicker.open, true);
  assert.equal(globalPicker.sessionId.startsWith(`node-title:${first.id}:`), true);
  assert.equal(
    globalPicker.colors.reduce((total, record) => total + record.count, 0),
    nodes.length * 2 + 5,
  );
  assert.equal(globalPicker.colors.some((record) => record.color === '#202124'), true);
  assert.equal(harness.history.getState().undoCount, historyBeforeOpen);

  await harness.router.dispatch('palette.nodeTitlePicker.close', undefined, 'core.test');
  assert.equal(harness.ui.topSurface(['overlay.modal']), undefined);
  assert.equal(harness.history.getState().undoCount, historyBeforeOpen);

  await harness.router.dispatch('palette.nodeTitlePicker.open', {
    targets: [{
      id: firstNode.id,
      revision: firstNode.nodeRevision ?? firstNode.revision,
      expectedColor: firstNode.titleColor,
    }],
    anchor: { x: 240, y: 160, width: 24, height: 24 },
  }, 'core.test');
  let cancelledSession: { sessionId: string; committed: boolean } | undefined;
  harness.router.subscribeSignal('core.test', 'palette.colorPicker.result', (message) => {
    cancelledSession = message.payload as { sessionId: string; committed: boolean };
  });
  await harness.plugins.stop('palette');
  await waitFor(async () => cancelledSession);
  assert.equal(cancelledSession?.committed, false);
  assert.equal(harness.ui.topSurface(['overlay.modal']), undefined);
  assert.equal(harness.resources.count('palette'), 0);
});

test('project container round-trips fragmented records and rejects checksum corruption', async () => {
  const largeValue = '画布分块🙂'.repeat(30_000);
  const source: ProjectSource = {
    document: {
      revision: 17,
      namespaces: {
        textContent: { large: { value: largeValue } },
        unknownPlugin: { opaque: { retained: true } },
      },
    },
    history: {
      undo: Array.from({ length: 8 }, (_, index) => ({
        id: `old-${index}`,
        label: '不应写进紧凑书籍的旧操作',
        timestamp: index,
        forward: [{ op: 'set', domain: 'document', namespace: 'textContent', key: `old-${index}`, value: largeValue }],
        inverse: [],
      })),
      redo: [],
    },
    plugins: [{ id: 'unknown-plugin', version: '7.2.1', namespaces: ['unknownPlugin'], available: false }],
  };
  const blob = await serializeProject(source);
  const streamedParts: Blob[] = [];
  const streamedBytes = await writeProjectToWritable(source, {
    write: async (part) => { streamedParts.push(part); },
    close: async () => undefined,
  });
  const streamedBlob = new Blob(streamedParts, { type: PROJECT_MEDIA_TYPE });
  assert.equal(streamedBytes, streamedBlob.size);
  const streamedProject = await parseProject(streamedBlob);
  const bufferedProject = await parseProject(blob);
  assert.deepEqual(streamedProject.document, bufferedProject.document);
  assert.deepEqual(streamedProject.history, bufferedProject.history);
  assert.deepEqual(bufferedProject.history, { undo: [], redo: [] });
  assert.deepEqual(streamedProject.manifest.plugins, bufferedProject.manifest.plugins);
  const parsed = await parseProject(blob);
  assert.equal(blob.type, PROJECT_MEDIA_TYPE);
  assert.equal(parsed.manifest.kind, PROJECT_KIND);
  assert.equal(
    (parsed.document.namespaces.textContent.large as { value: string }).value,
    largeValue,
  );
  assert.deepEqual(parsed.document.namespaces.unknownPlugin.opaque, { retained: true });
  assert.equal(parsed.manifest.plugins[0].id, 'unknown-plugin');

  const text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const compress = async (value: string) => new Response(
    new Blob([value]).stream().pipeThrough(new CompressionStream('gzip')),
  ).blob();
  const legacy = await compress(text.replace(PROJECT_KIND, 'forma-canvas-project'));
  await assert.rejects(() => parseProject(legacy), /不是可识别的 Echo-8/u);
  const corrupted = await compress(text.replace('retained', 'retAined'));
  await assert.rejects(() => parseProject(corrupted), /校验失败/);
});

test('project parser rejects decompression expansion and oversized logical fragments before allocation grows', async () => {
  const compressed = await new Response(
    new Blob(['x'.repeat(4096)]).stream().pipeThrough(new CompressionStream('gzip')),
  ).blob();
  await assert.rejects(
    parseProject(compressed, undefined, () => undefined, {
      maxCompressedBytes: 1024 * 1024,
      maxDecompressedBytes: 1024,
      maxLogicalEntryBytes: 1024,
      maxFragmentsPerEntry: 8,
      maxEntries: 8,
    }),
    /解压后体积超出安全上限/u,
  );

  const fragmented = new Blob([
    `${JSON.stringify({
      type: 'manifest',
      kind: 'echo-8-project',
      formatVersion: 2,
      coreVersion: '0.1.0',
      savedAt: 1,
      documentRevision: 0,
      historyMode: 'none',
      plugins: [],
    })}\n`,
    `${JSON.stringify({ type: 'start', section: 'document', namespace: 'fixture', key: 'large', fragments: 1 })}\n`,
    `${JSON.stringify({ type: 'fragment', index: 0, data: '12345678901' })}\n`,
  ]);
  await assert.rejects(
    parseProject(fragmented, undefined, () => undefined, {
      maxCompressedBytes: 1024 * 1024,
      maxDecompressedBytes: 1024 * 1024,
      maxLogicalEntryBytes: 10,
      maxFragmentsPerEntry: 8,
      maxEntries: 8,
    }),
    /单条逻辑记录超出安全上限/u,
  );
});

test('project file detection accepts the saved extension and the common eco8 typing alias', () => {
  assert.equal(isEcho8ProjectFile(new File([''], '项目.echo8')), true);
  assert.equal(isEcho8ProjectFile(new File([''], '项目.ECO8')), true);
  assert.equal(isEcho8ProjectFile(new File([''], '项目.txt', { type: PROJECT_MEDIA_TYPE })), true);
  assert.equal(isEcho8ProjectFile(new File([''], '项目.txt', { type: 'text/plain' })), false);
});

test('native filename suggestions share one cross-platform safety policy', () => {
  assert.equal(safeLocalFilename('  章节：一/二.  '), '章节：一_二');
  assert.equal(safeLocalFilename('CON'), '_CON');
  assert.equal(safeLocalFilename('LPT9.txt'), '_LPT9.txt');
  assert.equal(safeLocalFilename('   '), '未命名节点');
  assert.equal(safeLocalFilename('a'.repeat(200)).length, 120);
});

test('opening another project arbitrates picker and dropped-file intents before replacing unsaved work', async () => {
  const kernel = new ApplicationKernel([textNodePlugin, createImportExportPlugin()]);
  await kernel.start();
  const kept = await kernel.router.dispatch<{ id: string }>(
    'node.create',
    { title: '目标文件节点', body: '只应在目标文件里出现' },
    'core.test',
  );
  const targetSource = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  const targetBlob = await serializeProject(targetSource) as Blob & { name?: string };
  Object.defineProperty(targetBlob, 'name', { value: '另一本书籍.echo8' });
  const currentOnly = await kernel.router.dispatch<{ id: string }>(
    'node.create',
    { title: '当前未保存节点', body: '不能被直接覆盖' },
    'core.test',
  );

  const pickerRequest = await kernel.router.dispatch<{ openPicker: boolean }>(
    'file.requestOpenProject',
    undefined,
    'core.test',
  );
  assert.deepEqual(pickerRequest, { openPicker: false });
  assert.deepEqual(
    (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).pendingOpen,
    { kind: 'picker', phase: 'needs-decision' },
  );
  assert.deepEqual(
    await kernel.router.dispatch('system.ui.escape', undefined, 'core.test'),
    { requested: true, surfaces: 1 },
  );
  await waitFor(async () => (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).pendingOpen === undefined
    ? true
    : undefined);
  await kernel.router.dispatch('file.requestOpenProject', undefined, 'core.test');
  const summaries = await kernel.capabilities.request<Array<{ id: string }>>('content.summaries@1');
  assert.equal(summaries.some((node) => node.id === currentOnly.id), true);

  const proceed = await kernel.router.dispatch<{ openPicker: boolean; authorizationId?: string }>(
    'file.proceedPendingOpen',
    { authorizationId: 'test-open-authorization' },
    'core.test',
  );
  assert.deepEqual(proceed, { openPicker: true, authorizationId: 'test-open-authorization' });
  await kernel.router.dispatch('file.openProject', {
    file: targetBlob,
    authorizationId: proceed.authorizationId,
  }, 'core.test');
  await waitFor(async () => {
    const next = await kernel.capabilities.request<Array<{ id: string }>>('content.summaries@1');
    return next.some((node) => node.id === kept.id) && !next.some((node) => node.id === currentOnly.id)
      ? next
      : undefined;
  }, 5_000);

  const nextCurrent = await kernel.router.dispatch<{ id: string }>(
    'node.create',
    { title: '第二轮未保存节点', body: '需要先保存' },
    'core.test',
  );

  await kernel.router.dispatch('file.openProject', { file: targetBlob }, 'core.test');
  const savedParts: Blob[] = [];
  let saveClosed = false;
  await kernel.router.dispatch('file.saveAndOpenPending', {
    destination: {
      name: '当前书籍.echo8',
      createWritable: async () => ({
        write: async (part: Blob) => { savedParts.push(part); },
        close: async () => { saveClosed = true; },
      }),
    },
  }, 'core.test');

  await waitFor(async () => {
    const next = await kernel.capabilities.request<Array<{ id: string }>>('content.summaries@1');
    return next.some((node) => node.id === kept.id) && !next.some((node) => node.id === nextCurrent.id)
      ? next
      : undefined;
  }, 5_000);
  assert.equal(saveClosed, true);
  assert.equal((await parseProject(new Blob(savedParts))).manifest.kind, PROJECT_KIND);
  assert.equal(
    (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).pendingOpenName,
    undefined,
  );
  const openedRevision = await kernel.router.ask<{ revision: number }>(
    'system.document.revision',
    undefined,
    'core.test',
  );
  assert.equal(
    (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).savedDocumentRevision,
    openedRevision.revision,
  );
});

test('book-library file switching skips the canvas prompt and keeps a recovery point', async () => {
  const kernel = new ApplicationKernel([textNodePlugin, createImportExportPlugin()]);
  await kernel.start();
  const recoveryLabels: string[] = [];
  const createRecoveryPoint = kernel.persistence.createRecoveryPoint.bind(kernel.persistence);
  kernel.persistence.createRecoveryPoint = async (label) => {
    recoveryLabels.push(label);
    return createRecoveryPoint(label);
  };
  await kernel.router.dispatch(
    'node.create',
    { title: '书库切换前的内容', body: '应进入恢复点，而不是弹出二次确认' },
    'core.test',
  );
  const targetBlob = await serializeProject({
    document: { revision: 0, namespaces: {} },
    history: { undo: [], redo: [] },
    plugins: [],
  }) as Blob & { name?: string };
  Object.defineProperty(targetBlob, 'name', { value: '书库目标.echo8' });

  await kernel.router.dispatch('file.openProjectFromLibrary', { file: targetBlob }, 'core.test');
  assert.equal(
    (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).pendingOpen,
    undefined,
  );
  await waitFor(async () => {
    const summaries = await kernel.capabilities.request<Array<{ title: string }>>('content.summaries@1');
    return summaries.some((node) => node.title === '书库切换前的内容') ? undefined : summaries;
  }, 5_000);
  assert.equal(recoveryLabels.includes('打开文件前'), true);
});

test('opening a native book binds it as the automatic-save destination immediately', async () => {
  const kernel = new ApplicationKernel([textNodePlugin, createImportExportPlugin()]);
  await kernel.start();
  const savedNode = await kernel.router.dispatch<{ id: string }>(
    'node.create',
    { title: '已打开书籍', body: '原始内容' },
    'core.test',
  );
  const source = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  const file = await serializeProject(source) as Blob & { name?: string };
  Object.defineProperty(file, 'name', { value: '自动保存目标.echo8' });

  let written = new Blob();
  let writeCount = 0;
  const destination: FileSaveTarget = {
    name: '自动保存目标.echo8',
    async createWritable() {
      const pending: Blob[] = [];
      return {
        async write(part: Blob) { pending.push(part); },
        async close() { written = new Blob(pending, { type: PROJECT_MEDIA_TYPE }); writeCount += 1; },
      };
    },
  };

  await kernel.router.dispatch('file.openProject', { file, destination }, 'core.test');
  await kernel.router.dispatch('file.proceedPendingOpen', undefined, 'core.test');
  await waitFor(async () => (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).hasProjectDestination
    ? true
    : undefined);
  assert.equal(
    (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).hasProjectDestination,
    true,
  );

  const openedState = await kernel.capabilities.request<FileRuntimeState>('file.state@1');
  kernel.router.emitSignal(
    'system.persistence.automaticSave.requested',
    { documentRevision: openedState.savedDocumentRevision! },
    'core.persistence',
  );
  assert.equal(writeCount, 0);

  await kernel.router.dispatch('node.rename', { id: savedNode.id, title: '打开后已修改' }, 'core.test');
  const changedRevision = await kernel.router.ask<{ revision: number }>(
    'system.document.revision', undefined, 'core.test',
  );
  kernel.router.emitSignal(
    'system.persistence.automaticSave.requested',
    { documentRevision: changedRevision.revision },
    'core.persistence',
  );
  await waitFor(async () => writeCount === 1 ? true : undefined);
  const saved = await parseProject(written);
  assert.equal(
    (saved.document.namespaces.textNode[savedNode.id] as { title: string }).title,
    '打开后已修改',
  );
});

test('cloud books use cloud save by default, suppress local-location prompts, and keep Save As as a local copy', async () => {
  let syncCount = 0;
  let disconnectCount = 0;
  const cloudState = (): CloudSyncState => ({
    panelOpen: false,
    phase: 'ready',
    configured: true,
    authenticated: true,
    accounts: [],
    installations: [],
    activeInstallationId: 'installation:test',
    activeProjectId: 'project:test',
    activeProjectName: '云端测试书籍',
    headRevision: syncCount,
    pendingCommits: 0,
    upgradeAvailable: false,
    lastSyncedAt: Date.now(),
  });
  const cloudPlugin: PluginDefinition = {
    manifest: defineManifest('cloud-sync', '测试云同步', {
      commands: ['cloudSync.syncNow', 'cloudSync.disconnectProject'],
      queries: ['cloudSync.state'],
      signals: ['cloudSync.updated'],
    }),
    start(context) {
      context.queries.register({ type: 'cloudSync.state', handle: cloudState });
      context.commands.register({
        type: 'cloudSync.syncNow',
        handle: () => {
          syncCount += 1;
          const next = cloudState();
          context.signals.emit('cloudSync.updated', next);
          return { result: next };
        },
      });
      context.commands.register({
        type: 'cloudSync.disconnectProject',
        handle: () => {
          disconnectCount += 1;
          return { result: cloudState() };
        },
      });
    },
  };
  const kernel = new ApplicationKernel([cloudPlugin, textNodePlugin, createImportExportPlugin()]);
  await kernel.start();
  await kernel.router.dispatch('node.create', { title: '只保存到云端' }, 'core.test');
  await waitFor(async () => (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).cloudProjectActive
    ? true
    : undefined);

  let saveLocationNotices = 0;
  const unsubscribe = kernel.router.subscribeSignal(
    'core.test',
    'file.save-location.required',
    () => { saveLocationNotices += 1; },
  );
  kernel.router.emitSignal(
    'system.persistence.automaticSave.requested', { documentRevision: 1 }, 'core.persistence',
  );
  assert.equal(saveLocationNotices, 0);

  await kernel.router.dispatch('file.saveProject', undefined, 'core.test');
  assert.equal(syncCount, 1);
  const revision = await kernel.router.ask<{ revision: number }>('system.document.revision', undefined, 'core.test');
  const savedState = await kernel.capabilities.request<FileRuntimeState>('file.state@1');
  assert.equal(savedState.savedDocumentRevision, revision.revision);
  assert.equal(savedState.saveLocationRequired, false);
  assert.equal(savedState.hasProjectDestination, false);

  const copied: Blob[] = [];
  let copyClosed = false;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      showSaveFilePicker: async () => ({
        name: '云端测试书籍-副本.echo8',
        createWritable: async () => ({
          write: async (part: Blob) => { copied.push(part); },
          close: async () => { copyClosed = true; },
        }),
      }),
    },
  });
  try {
    await kernel.router.dispatch('file.saveProjectAs', undefined, 'core.test');
    await waitFor(async () => copyClosed ? true : undefined);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    unsubscribe();
  }
  assert.equal(syncCount, 1);
  assert.equal(disconnectCount, 0);
  assert.equal((await parseProject(new Blob(copied))).manifest.kind, PROJECT_KIND);
  assert.equal(
    (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).hasProjectDestination,
    false,
  );
});

test('a new book gets a cloud target on the unified autosave request while a local book keeps local-save rules', async () => {
  let createCount = 0;
  let nativePickerCount = 0;
  let activeProjectId: string | undefined;
  const installation = {
    id: 'installation:test',
    accountId: 'account:test',
    accountName: '测试账户',
    workerUrl: 'https://data.example',
    workerVersion: 2,
    latestWorkerVersion: 2,
    upgradeAvailable: false,
    status: 'ready' as const,
  };
  const cloudState = (): CloudSyncState => ({
    panelOpen: false,
    phase: 'ready',
    configured: true,
    authenticated: true,
    accounts: [],
    installations: [installation],
    activeInstallationId: installation.id,
    activeProjectId,
    activeProjectName: activeProjectId ? '新书籍 10/16 12:00' : undefined,
    headRevision: activeProjectId ? 1 : 0,
    pendingCommits: 0,
    upgradeAvailable: false,
  });
  const cloudPlugin: PluginDefinition = {
    manifest: defineManifest('cloud-sync', '测试云同步', {
      commands: ['cloudSync.syncNow', 'cloudSync.disconnectProject', 'cloudSync.saveCurrentAsProject'],
      queries: ['cloudSync.state'],
      signals: ['cloudSync.updated'],
    }),
    start(context) {
      context.queries.register({ type: 'cloudSync.state', handle: cloudState });
      context.commands.register({
        type: 'cloudSync.syncNow',
        handle: () => ({ result: cloudState() }),
      });
      context.commands.register({
        type: 'cloudSync.disconnectProject',
        handle: () => {
          activeProjectId = undefined;
          const next = cloudState();
          context.signals.emit('cloudSync.updated', next);
          return { result: next };
        },
      });
      context.commands.register({
        type: 'cloudSync.saveCurrentAsProject',
        handle: () => {
          createCount += 1;
          activeProjectId = 'project:first-save';
          const next = cloudState();
          context.signals.emit('cloudSync.updated', next);
          return {
            result: {
              id: activeProjectId,
              name: next.activeProjectName!,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              headRevision: 1,
            },
          };
        },
      });
    },
  };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      showSaveFilePicker: async () => {
        nativePickerCount += 1;
        throw new Error('首次云保存不应打开本地文件选择器');
      },
    },
  });
  try {
    const kernel = new ApplicationKernel([cloudPlugin, textNodePlugin, createImportExportPlugin()]);
    await kernel.start();
    await kernel.router.dispatch('system.document.new', undefined, 'core.test');
    assert.equal(createCount, 0);
    const beforeAutomaticSave = await kernel.router.ask<{ revision: number }>(
      'system.document.revision', undefined, 'core.test',
    );
    kernel.router.emitSignal(
      'system.persistence.automaticSave.requested',
      { documentRevision: beforeAutomaticSave.revision },
      'core.persistence',
    );
    await waitFor(async () => createCount === 1 ? true : undefined);
    const initialRevision = await kernel.router.ask<{ revision: number }>(
      'system.document.revision', undefined, 'core.test',
    );
    const initialFileState = await kernel.capabilities.request<FileRuntimeState>('file.state@1');
    assert.equal(initialFileState.cloudProjectActive, true);
    assert.equal(initialFileState.savedDocumentRevision, initialRevision.revision);
    assert.equal(initialFileState.hasProjectDestination, false);

    await kernel.router.dispatch('node.create', { title: '当前内容必须保留' }, 'core.test');
    const revision = await kernel.router.ask<{ revision: number }>(
      'system.document.revision', undefined, 'core.test',
    );
    kernel.router.emitSignal(
      'system.persistence.automaticSave.requested',
      { documentRevision: revision.revision },
      'core.persistence',
    );
    assert.equal(createCount, 1);
    assert.equal(nativePickerCount, 0);

    const localSource = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
    const localFile = await serializeProject(localSource) as Blob & { name?: string };
    Object.defineProperty(localFile, 'name', { value: '仍按本地规则.echo8' });
    const localOpened = new Promise<void>((resolve) => {
      const unsubscribe = kernel.router.subscribeEvent(
        'core.test',
        'document.replaced',
        (message) => {
          if ((message.payload as { origin?: string }).origin !== 'file') return;
          unsubscribe();
          resolve();
        },
      );
    });
    await kernel.router.dispatch('file.openProjectFromLibrary', { file: localFile }, 'core.test');
    await localOpened;
    await waitFor(async () => (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).cloudProjectActive
      ? undefined
      : true);
    const localRevision = await kernel.router.ask<{ revision: number }>(
      'system.document.revision', undefined, 'core.test',
    );
    kernel.router.emitSignal(
      'system.persistence.automaticSave.requested',
      { documentRevision: localRevision.revision },
      'core.persistence',
    );
    await waitFor(async () => (await kernel.capabilities.request<FileRuntimeState>('file.state@1')).saveLocationRequired
      ? true
      : undefined);
    assert.equal(createCount, 1);
    assert.equal(nativePickerCount, 0);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('project-related directory picker starts from the bound native book without exposing its handle', async () => {
  const kernel = new ApplicationKernel([textNodePlugin, createImportExportPlugin()]);
  await kernel.start();
  const destination: FileSaveTarget = {
    name: '同目录书籍.echo8',
    async createWritable() {
      return {
        async write() { /* test sink */ },
        async close() { /* test sink */ },
      };
    },
  };
  await kernel.router.dispatch('file.saveProject', { destination }, 'core.test');
  await waitFor(async () => (await kernel.capabilities.request<FileRuntimeState>('file.state@1'))
    .hasProjectDestination ? true : undefined);

  const directory: FileDirectoryTarget = {
    name: '书籍所在文件夹',
    async getFileHandle(name) {
      return { name, async createWritable() { throw new Error('not used'); } };
    },
  };
  let pickerOptions: { mode?: string; startIn?: unknown; id?: string } | undefined;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      showDirectoryPicker: async (options: typeof pickerOptions) => {
        pickerOptions = options;
        return directory;
      },
    },
  });
  try {
    const selected = await kernel.capabilities.request<FileDirectoryTarget | undefined>(
      PROJECT_RELATED_DIRECTORY_CAPABILITY,
    );
    assert.equal(selected, directory);
    assert.equal(pickerOptions?.startIn, destination);
    assert.equal(pickerOptions?.mode, 'readwrite');
    assert.equal(pickerOptions?.id, undefined);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('opening a project uses the core replacement boundary and preserves opaque namespaces', async () => {
  const kernel = new ApplicationKernel([textNodePlugin]);
  await kernel.start();
  const kept = await kernel.router.dispatch<{ id: string }>(
    'node.create',
    { title: '文件内节点', body: '应在重新打开后存在' },
    'core.test',
  );
  const source = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  source.document.namespaces.unknownFeature = { opaque: { version: 9, payload: ['a', 'b'] } };
  source.plugins.push({
    id: 'unknown-feature',
    version: '9.0.0',
    namespaces: ['unknownFeature'],
    available: false,
  });
  const project = await parseProject(await serializeProject(source));
  const discarded = await kernel.router.dispatch<{ id: string }>(
    'node.create',
    { title: '文件外节点' },
    'core.test',
  );

  await kernel.router.dispatch('system.document.replace', project, 'core.test');
  const summaries = await kernel.capabilities.request<Array<{ id: string }>>('content.summaries@1');
  assert.equal(summaries.some((node) => node.id === kept.id), true);
  assert.equal(summaries.some((node) => node.id === discarded.id), false);
  assert.deepEqual(kernel.store.readValue('document', 'unknownFeature', 'opaque'), {
    version: 9,
    payload: ['a', 'b'],
  });
  assert.equal(kernel.history.getState().undoCount, 0);
  const resaved = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  assert.equal(resaved.plugins.find((plugin) => plugin.id === 'unknown-feature')?.available, false);
});

test('new book replacement clears document content and history behind a recovery point', async () => {
  const kernel = new ApplicationKernel([textNodePlugin]);
  await kernel.start();
  const recoveryLabels: string[] = [];
  const createRecoveryPoint = kernel.persistence.createRecoveryPoint.bind(kernel.persistence);
  kernel.persistence.createRecoveryPoint = async (label) => {
    recoveryLabels.push(label);
    return createRecoveryPoint(label);
  };
  await kernel.router.dispatch('node.create', { title: '新建前内容', body: '应只留在恢复点里' }, 'core.test');
  assert.equal(kernel.history.getState().undoCount > 0, true);

  await kernel.router.dispatch('system.document.new', undefined, 'core.test');

  const summaries = await kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  assert.deepEqual(summaries, []);
  assert.equal(kernel.history.getState().undoCount, 0);
  assert.equal(recoveryLabels.includes('新建书籍前'), true);
});

test('project opening applies ordered plugin data migrations on a staged copy and retires legacy history', async () => {
  const migratingPlugin: PluginDefinition = {
    manifest: defineManifest('migration-probe', '迁移探针', {
      dataVersion: 3,
      namespaces: ['migrationCurrent'],
    }),
    migrations: [
      {
        from: 1,
        to: 2,
        migrate(data) {
          const legacy = structuredClone(data.migrationLegacy ?? {});
          return { ...data, migrationLegacy: { ...legacy, migratedOnce: true } };
        },
      },
      {
        from: 2,
        to: 3,
        migrate(data) {
          return { migrationCurrent: structuredClone(data.migrationLegacy ?? {}) };
        },
      },
    ],
    start() {},
  };
  const kernel = new ApplicationKernel([migratingPlugin]);
  await kernel.start();
  const project: ProjectOpenPayload = {
    manifest: {
      type: 'manifest',
      kind: PROJECT_KIND,
      formatVersion: 1,
      coreVersion: '0.1.0',
      savedAt: 1,
      documentRevision: 7,
      plugins: [{
        id: 'migration-probe',
        version: '0.0.1',
        dataVersion: 1,
        namespaces: ['migrationLegacy'],
        available: true,
      }],
    },
    document: {
      revision: 7,
      namespaces: { migrationLegacy: { item: { value: '旧结构' } } },
    },
    history: {
      undo: [{
        id: 'legacy-history',
        label: '旧结构操作',
        timestamp: 1,
        forward: [{
          op: 'set', domain: 'document', namespace: 'migrationLegacy', key: 'item', value: { value: '旧结构' },
        }],
        inverse: [],
      }],
      redo: [],
    },
  };

  await kernel.router.dispatch('system.document.replace', project, 'core.test');
  assert.deepEqual(kernel.store.readNamespace('document', 'migrationCurrent'), {
    item: { value: '旧结构' },
    migratedOnce: true,
  });
  assert.deepEqual(kernel.store.readNamespace('document', 'migrationLegacy'), {});
  assert.equal(kernel.history.getState().undoCount, 0);
  const source = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  const descriptor = source.plugins.find((candidate) => candidate.id === 'migration-probe');
  assert.equal(descriptor?.dataVersion, 3);
  assert.deepEqual(descriptor?.namespaces, ['migrationCurrent']);
});

test('failed plugin data migration preserves both the open document and the source payload', async () => {
  const failingPlugin: PluginDefinition = {
    manifest: defineManifest('failing-migration', '失败迁移', {
      dataVersion: 2,
      namespaces: ['failingMigration'],
    }),
    migrations: [{
      from: 1,
      to: 2,
      migrate(data) {
        data.failingMigration.changed = true;
        throw new Error('fixture migration failure');
      },
    }],
    start() {},
  };
  const kernel = new ApplicationKernel([textNodePlugin, failingPlugin]);
  await kernel.start();
  const current = await kernel.router.dispatch<{ id: string }>(
    'node.create',
    { title: '必须保留', body: '当前正文' },
    'core.test',
  );
  const project: ProjectOpenPayload = {
    manifest: {
      type: 'manifest',
      kind: PROJECT_KIND,
      formatVersion: 2,
      coreVersion: '0.1.0',
      savedAt: 1,
      documentRevision: 2,
      historyMode: 'none',
      plugins: [{
        id: 'failing-migration',
        version: '0.0.1',
        dataVersion: 1,
        namespaces: ['failingMigration'],
        available: true,
      }],
    },
    document: { revision: 2, namespaces: { failingMigration: { old: { value: true } } } },
    history: { undo: [], redo: [] },
  };
  const untouched = structuredClone(project);

  await assert.rejects(
    () => kernel.router.dispatch('system.document.replace', project, 'core.test'),
    /数据迁移 1 → 2 失败/u,
  );
  assert.deepEqual(project, untouched);
  const summaries = await kernel.capabilities.request<Array<{ id: string }>>('content.summaries@1');
  assert.equal(summaries.some((item) => item.id === current.id), true);
});

test('recovery journal replay restores state and linear history actions after a checkpoint', () => {
  const baseline: PersistedApplication = {
    formatVersion: 1,
    savedAt: 100,
    store: {
      formatVersion: 1,
      document: { revision: 0, namespaces: {} },
      workspace: { revision: 0, namespaces: {} },
    },
    history: { undo: [], redo: [] },
  };
  const setPatch = { op: 'set' as const, domain: 'document' as const, namespace: 'demo', key: 'value', value: 7 };
  const deletePatch = { op: 'delete' as const, domain: 'document' as const, namespace: 'demo', key: 'value' };
  const recovered = replayApplication(baseline, [
    {
      id: 'record:1',
      label: '写入',
      timestamp: 101,
      forward: [setPatch],
      inverse: [deletePatch],
      sourceMessageId: 'message:1',
      historyAction: 'record',
    },
    {
      id: 'undo:1',
      label: '撤销：写入',
      timestamp: 102,
      forward: [deletePatch],
      inverse: [setPatch],
      sourceMessageId: 'record:1',
      historyAction: 'undo',
    },
    {
      id: 'redo:1',
      label: '重做：写入',
      timestamp: 103,
      forward: [setPatch],
      inverse: [deletePatch],
      sourceMessageId: 'record:1',
      historyAction: 'redo',
    },
  ]);
  assert.equal(recovered.store.document.namespaces.demo.value, 7);
  assert.equal(recovered.history.undo.length, 1);
  assert.equal(recovered.history.redo.length, 0);
});

test('local checkpoints externalize immutable text chunks and hydrate without changing application state', () => {
  const chunkA = { id: 'chunk:a', contentId: 'content:1', text: '第一块正文' };
  const chunkB = { id: 'chunk:b', contentId: 'content:1', text: '第二块正文' };
  const historicChunk = { id: 'chunk:old', contentId: 'content:1', text: '历史正文' };
  const application: PersistedApplication = {
    formatVersion: 1,
    savedAt: 200,
    store: {
      formatVersion: 1,
      document: {
        revision: 5,
        namespaces: {
          textContent: {
            'content:1': {
              id: 'content:1', storageVersion: 2, chunkIds: ['chunk:a', 'chunk:b'],
              chunkLengths: [5, 5], length: 10, revision: 3,
            },
          },
          textContentChunk: { 'chunk:a': chunkA, 'chunk:b': chunkB },
        },
      },
      workspace: { revision: 0, namespaces: {} },
    },
    history: {
      undo: [{
        id: 'history:chunk', label: '修改正文', timestamp: 199,
        forward: [{ op: 'set', domain: 'document', namespace: 'textContentChunk', key: 'chunk:old', value: historicChunk }],
        inverse: [{ op: 'delete', domain: 'document', namespace: 'textContentChunk', key: 'chunk:old' }],
      }],
      redo: [],
    },
  };
  const externalized = externalizeContentChunks(application);
  assert.deepEqual(externalized.stored.contentChunkIds, ['chunk:a', 'chunk:b', 'chunk:old']);
  assert.deepEqual(externalized.stored.activeContentChunkIds, ['chunk:a', 'chunk:b']);
  assert.deepEqual(externalized.stored.application.store.document.namespaces.textContentChunk, {});
  assert.equal(externalized.chunks.get('chunk:a'), chunkA);
  assert.doesNotMatch(JSON.stringify(externalized.stored), /历史正文/u);
  const hydrated = hydrateExternalizedContentChunks(externalized.stored, externalized.chunks);
  assert.deepEqual(hydrated, application);
  assert.throws(
    () => hydrateExternalizedContentChunks(externalized.stored, new Map([['chunk:a', chunkA]])),
    /chunk:b/u,
  );
});

test('TXT and DOCX export read content through ranges and file plugin hot-stop releases its task surface', async () => {
  const harness = createHarness();
  const files = createImportExportPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createEditorPlugin());
  harness.plugins.register(files);
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  await harness.plugins.start('import-export');
  const body = `第一段\n${'范围读取'.repeat(80_000)}`;
  const node = await harness.router.dispatch<{ id: string }>('node.create', { title: '长正文', body }, 'core.test');
  await harness.router.dispatch('editor.open', { id: node.id }, 'core.test');
  const artifactReady = new Promise<Blob>((resolve) => {
    harness.router.subscribeSignal('core.test', 'file.artifact.ready', (message) => {
      const artifact = message.payload as { blob: Blob; filename: string };
      if (artifact.filename === '长正文.txt') resolve(artifact.blob);
    });
  });
  const historyBefore = harness.history.getState().undoCount;
  await harness.router.dispatch('file.exportText', { scope: 'canvas' }, 'core.test');
  const artifact = await artifactReady;
  const exported = await artifact.text();
  assert.ok(exported.includes('长正文'), `unexpected export prefix: ${JSON.stringify(exported.slice(0, 80))}`);
  assert.ok(exported.includes('第一段'));
  assert.ok(exported.includes('范围读取'.repeat(1_000)));
  assert.equal(harness.history.getState().undoCount, historyBefore);

  await harness.router.dispatch('node.create', { title: '重复标题', body: '第二个节点' }, 'core.test');
  await harness.router.dispatch('node.create', { title: '重复标题', body: '第三个节点' }, 'core.test');
  const savedFiles = new Map<string, Blob>([['重复标题.txt', new Blob(['原有文件'])]]);
  const directory = {
    name: '导出目录',
    async getFileHandle(filename: string, options?: { create?: boolean }) {
      if (!options?.create && !savedFiles.has(filename)) {
        throw new DOMException('File not found', 'NotFoundError');
      }
      return {
        name: filename,
        async createWritable() {
          let pending = new Blob();
          return {
            async write(data: Blob) { pending = data; },
            async close() { savedFiles.set(filename, pending); },
            async abort() { pending = new Blob(); },
          };
        },
      };
    },
  };
  const canvasExportReady = new Promise<void>((resolve) => {
    harness.router.subscribeSignal('core.test', 'file.status', (message) => {
      const status = message.payload as { operation: string; state: string; message: string };
      if (status.operation === 'text-export' && status.state === 'ready' && status.message.includes('5 个 TXT')) resolve();
    });
  });
  await harness.router.dispatch('file.exportText', { scope: 'canvas', directory }, 'core.test');
  await canvasExportReady;
  assert.deepEqual([...savedFiles.keys()].sort(), [
    'AI 助手使用指南.txt',
    '画布基本操作指南.txt',
    '重复标题 (2).txt',
    '重复标题 2.txt',
    '重复标题.txt',
    '长正文.txt',
  ]);
  assert.equal(await savedFiles.get('重复标题.txt')?.text(), '原有文件');
  assert.equal(await savedFiles.get('重复标题 (2).txt')?.text(), '重复标题\n\n第二个节点');
  assert.equal(await savedFiles.get('重复标题 2.txt')?.text(), '重复标题 2\n\n第三个节点');
  assert.equal(harness.history.getState().undoCount, historyBefore + 2);

  const wordReady = new Promise<{ blob: Blob; filename: string }>((resolve) => {
    harness.router.subscribeSignal('core.test', 'file.artifact.ready', (message) => {
      const artifact = message.payload as { blob: Blob; filename: string };
      if (artifact.filename.endsWith('.docx')) resolve(artifact);
    });
  });
  await harness.router.dispatch('file.exportWord', { scope: 'current' }, 'core.test');
  const word = await wordReady;
  const header = new Uint8Array(await word.blob.slice(0, 4).arrayBuffer());
  assert.deepEqual([...header], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(word.blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(harness.history.getState().undoCount, historyBefore + 2);

  await harness.plugins.stop('import-export');
  assert.equal(harness.resources.count('import-export'), 0);
  assert.ok(harness.store.readValue('workspace', 'fileUI', 'open') === undefined);
});

test('renaming an exported node updates its document heading and native filename when the browser supports move', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createEditorPlugin());
  harness.plugins.register(createImportExportPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  await harness.plugins.start('import-export');
  const node = await harness.router.dispatch<{ id: string }>(
    'node.create', { title: '旧标题', body: '正文' }, 'core.test',
  );
  let saved = new Blob();
  const movedNames: string[] = [];
  const destination: FileSaveTarget = {
    name: '旧标题.txt',
    async move(name) { movedNames.push(name); },
    async createWritable() {
      let pending = new Blob();
      return {
        async write(data) { pending = data; },
        async close() { saved = pending; },
      };
    },
  };
  const exported = waitForFileStatus(harness, 'text-export', 'ready');
  await harness.router.dispatch(
    'file.exportText', { scope: 'current', nodeId: node.id, destination }, 'core.test',
  );
  await exported;
  await harness.router.dispatch('node.rename', { id: node.id, title: '新标题' }, 'core.test');
  const renamedState = await harness.capabilities.request<{ renameRequired?: boolean }>(
    'file.textExportState@1', { nodeId: node.id },
  );
  assert.equal(renamedState.renameRequired, true);
  harness.router.emitSignal(
    'system.persistence.automaticSave.requested', { documentRevision: 1 }, 'core.persistence',
  );
  await waitFor(async () => movedNames.includes('新标题.txt') ? true : undefined);
  await waitFor(async () => (await saved.text()).startsWith('新标题\n\n') ? true : undefined);
  const synchronized = await harness.capabilities.request<{ renameRequired?: boolean }>(
    'file.textExportState@1', { nodeId: node.id },
  );
  assert.equal(synchronized.renameRequired, false);
  await harness.plugins.stop('import-export');
});

test('whole-canvas TXT bindings overwrite prior files and retire the old filename after a title change', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createEditorPlugin());
  harness.plugins.register(createImportExportPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  await harness.plugins.start('import-export');
  const created = await harness.router.dispatch<{ id: string }>(
    'node.create', { title: '全画布原名', body: '第一版' }, 'core.test',
  );
  const savedFiles = new Map<string, Blob>();
  const directory = {
    name: '整画布导出目录',
    async getFileHandle(filename: string, options?: { create?: boolean }) {
      if (!options?.create && !savedFiles.has(filename)) {
        throw new DOMException('File not found', 'NotFoundError');
      }
      return {
        name: filename,
        async createWritable() {
          let pending = new Blob();
          return {
            async write(data: Blob) { pending = data; },
            async close() { savedFiles.set(filename, pending); },
          };
        },
      };
    },
    async removeEntry(filename: string) {
      if (!savedFiles.delete(filename)) throw new DOMException('File not found', 'NotFoundError');
    },
  };
  let ready = waitForFileStatus(harness, 'text-export', 'ready');
  await harness.router.dispatch('file.exportText', { scope: 'canvas', directory }, 'core.test');
  await ready;
  assert.equal(await savedFiles.get('全画布原名.txt')?.text(), '全画布原名\n\n第一版');

  let summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((item) => item.id === created.id)!;
  await harness.router.dispatch('content.applyDelta', {
    nodeId: created.id,
    start: summary.length,
    deleteCount: 0,
    insert: '更新',
    expectedRevision: summary.revision,
  }, 'core.test');
  harness.router.emitSignal(
    'system.persistence.automaticSave.requested', { documentRevision: 1 }, 'core.persistence',
  );
  await waitFor(async () => (await savedFiles.get('全画布原名.txt')?.text())
    ?.endsWith('第一版更新') ? true : undefined);

  await harness.router.dispatch('node.rename', { id: created.id, title: '全画布新名' }, 'core.test');
  harness.router.emitSignal(
    'system.persistence.automaticSave.requested', { documentRevision: 2 }, 'core.persistence',
  );
  await waitFor(async () => savedFiles.has('全画布新名.txt') && !savedFiles.has('全画布原名.txt')
    ? true : undefined);
  assert.equal(await savedFiles.get('全画布新名.txt')?.text(), '全画布新名\n\n第一版更新');

  summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((item) => item.id === created.id)!;
  await harness.router.dispatch('content.applyDelta', {
    nodeId: created.id,
    start: summary.length,
    deleteCount: 0,
    insert: '再次更新',
    expectedRevision: summary.revision,
  }, 'core.test');
  ready = waitForFileStatus(harness, 'text-export', 'ready');
  await harness.router.dispatch('file.exportText', { scope: 'canvas', directory }, 'core.test');
  await ready;
  assert.equal(savedFiles.has('全画布新名 (2).txt'), false);
  assert.equal((await savedFiles.get('全画布新名.txt')?.text())?.endsWith('再次更新'), true);
  await harness.plugins.stop('import-export');
});

test('automatic canvas save and text export coalesce without overlapping one native destination', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createEditorPlugin());
  harness.plugins.register(createImportExportPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  await harness.plugins.start('import-export');
  const node = await harness.router.dispatch<{ id: string }>(
    'node.create', { title: '连续保存', body: '初始' }, 'core.test',
  );
  const writes: Blob[] = [];
  let active = 0;
  let maximumActive = 0;
  let blockNext = false;
  const writeStarted = deferredSignal();
  const releaseWrite = deferredSignal();
  const destination: FileSaveTarget = {
    name: '连续保存.txt',
    async createWritable() {
      if (blockNext) {
        blockNext = false;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      let pending = new Blob();
      return {
        async write(data) { pending = data; },
        async close() { writes.push(pending); active -= 1; },
        async abort() { active = Math.max(0, active - 1); },
      };
    },
  };
  const initialReady = waitForFileStatus(harness, 'text-export', 'ready');
  await harness.router.dispatch(
    'file.exportText', { scope: 'current', nodeId: node.id, destination }, 'core.test',
  );
  await initialReady;
  let summary = (await harness.capabilities.request<ContentSummary[]>(
    'content.summaries@1',
  )).find((item) => item.id === node.id)!;
  await harness.router.dispatch('content.applyDelta', {
    nodeId: node.id,
    start: summary.length,
    deleteCount: 0,
    insert: '甲',
    expectedRevision: summary.revision,
  }, 'core.test');
  blockNext = true;
  harness.router.emitSignal(
    'system.persistence.automaticSave.requested', { documentRevision: 2 }, 'core.persistence',
  );
  await writeStarted.promise;
  summary = (await harness.capabilities.request<ContentSummary[]>(
    'content.summaries@1',
  )).find((item) => item.id === node.id)!;
  await harness.router.dispatch('content.applyDelta', {
    nodeId: node.id,
    start: summary.length,
    deleteCount: 0,
    insert: '乙',
    expectedRevision: summary.revision,
  }, 'core.test');
  harness.router.emitSignal(
    'system.persistence.automaticSave.requested', { documentRevision: 3 }, 'core.persistence',
  );
  releaseWrite.resolve();
  await waitFor(async () => writes.length >= 3 ? true : undefined, 2_000);
  assert.equal(maximumActive, 1);
  assert.equal((await writes.at(-1)!.text()).endsWith('初始甲乙'), true);
  await harness.plugins.stop('import-export');
});

test('history retains at least one thousand meaningful entries and truncates cold excess', () => {
  const history = new HistoryService(1000);
  for (let index = 0; index < 1100; index += 1) {
    history.record({
      id: `entry:${index}`,
      label: `操作 ${index}`,
      timestamp: index * 2000,
      forward: [{ op: 'set', domain: 'document', namespace: 'test', key: 'value', value: index }],
      inverse: [{ op: 'delete', domain: 'document', namespace: 'test', key: 'value' }],
    });
  }
  assert.equal(history.getState().undoCount, 1000);
  assert.equal(history.getState().nextUndo, '操作 1099');
});

test('deterministic randomized transaction replay returns to the exact initial and final states', async () => {
  const harness = createHarness();
  harness.router.registerCommand<{ key: string; delete?: boolean; value?: unknown }>('core.test', {
    type: 'random.mutate',
    handle: (payload) => ({
      transaction: {
        label: '随机回放操作',
        patches: [payload.delete
          ? { op: 'delete' as const, domain: 'document' as const, namespace: 'randomReplay', key: payload.key }
          : {
              op: 'set' as const,
              domain: 'document' as const,
              namespace: 'randomReplay',
              key: payload.key,
              value: payload.value,
            }],
      },
    }),
  });
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const expected = new Map<string, unknown>();
  const operationCount = 600;
  for (let index = 0; index < operationCount; index += 1) {
    const key = `key-${Math.floor(random() * 80)}`;
    const remove = random() < 0.28;
    const value = {
      serial: index,
      score: Math.floor(random() * 1_000_000),
      flags: [random() > 0.5, random() > 0.5],
    };
    await harness.router.dispatch(
      'random.mutate',
      remove ? { key, delete: true } : { key, value },
      'core.test',
    );
    if (remove) expected.delete(key);
    else expected.set(key, value);
  }
  const finalState = Object.fromEntries(expected);
  assert.deepEqual(harness.store.readNamespace('document', 'randomReplay'), finalState);
  for (let index = 0; index < operationCount; index += 1) assert.equal(await harness.transactions.undo(), true);
  assert.deepEqual(harness.store.readNamespace('document', 'randomReplay'), {});
  for (let index = 0; index < operationCount; index += 1) assert.equal(await harness.transactions.redo(), true);
  assert.deepEqual(harness.store.readNamespace('document', 'randomReplay'), finalState);
});

test('plugins cannot dispatch commands they did not declare as consumed', async () => {
  const harness = createHarness();
  harness.router.registerCommand('core.test', {
    type: 'external.noop',
    handle: () => ({ result: true }),
  });
  harness.plugins.register({
    manifest: defineManifest('strict-plugin', '严格插件'),
    start: async (context) => {
      await context.commands.dispatch('external.noop');
    },
  });

  await assert.rejects(() => harness.plugins.start('strict-plugin'), /did not declare dispatched command/);
  assert.equal(harness.plugins.list()[0].status, 'faulted');
  assert.equal(harness.resources.count('strict-plugin'), 0);
});

test('plugin permissions are validated and enforced at runtime write boundaries', async () => {
  const harness = createHarness();
  assert.throws(
    () => harness.plugins.register({
      manifest: defineManifest('unknown-permission', '未知权限', { permissions: ['system.everything'] }),
      start() {},
    }),
    /unknown permission/,
  );
  assert.throws(
    () => harness.plugins.register({
      manifest: defineManifest('undeclared-action-permission', '无动作权限', {
        actions: ['unsafe.action'],
      }),
      start() {},
    }),
    /ui\.action\.register/,
  );

  harness.plugins.register({
    manifest: defineManifest('read-denied', '读取拒绝', {
      namespaces: ['readDenied'],
      namespaceDomains: { readDenied: 'workspace' },
    }),
    start(context) {
      context.store.readValue('readDenied', 'value');
    },
  });
  await assert.rejects(() => harness.plugins.start('read-denied'), /store\.own\.read/);
  assert.equal(harness.plugins.list().find((plugin) => plugin.id === 'read-denied')?.status, 'faulted');

  harness.plugins.register({
    manifest: defineManifest('write-denied', '写入拒绝', {
      namespaces: ['writeDenied'],
      namespaceDomains: { writeDenied: 'document' },
      commands: ['writeDenied.set'],
    }),
    start(context) {
      context.commands.register({
        type: 'writeDenied.set',
        handle: () => ({
          transaction: {
            label: '不允许的写入',
            patches: [{
              op: 'set', domain: 'document', namespace: 'writeDenied', key: 'value', value: true,
            }],
          },
        }),
      });
    },
  });
  await harness.plugins.start('write-denied');
  await assert.rejects(
    () => harness.router.dispatch('writeDenied.set', undefined, 'core.test'),
    /store\.own\.write/,
  );
  assert.equal(harness.store.hasValue('document', 'writeDenied', 'value'), false);
});

test('payload-free plugin messages reject undeclared input by default', async () => {
  const harness = createHarness();
  harness.plugins.register({
    manifest: defineManifest('empty-message-probe', '空消息探针', {
      commands: ['emptyMessage.command'],
      queries: ['emptyMessage.query'],
    }),
    start(context) {
      context.commands.register({ type: 'emptyMessage.command', handle: () => ({ result: true }) });
      context.queries.register({ type: 'emptyMessage.query', handle: () => true });
    },
  });
  await harness.plugins.start('empty-message-probe');

  assert.equal(await harness.router.dispatch('emptyMessage.command', undefined, 'core.test'), true);
  assert.equal(await harness.router.ask('emptyMessage.query', undefined, 'core.test'), true);
  await assert.rejects(
    () => harness.router.dispatch('emptyMessage.command', { unexpected: true }, 'core.test'),
    /Invalid command payload/,
  );
  await assert.rejects(
    () => harness.router.ask('emptyMessage.query', { unexpected: true }, 'core.test'),
    /Invalid query payload/,
  );
});

test('interaction sessions cannot be ended by another owner or a stale gesture', () => {
  const interactions = new InteractionStateMachine();
  assert.deepEqual(interactions.begin('dragging-node', 'canvas', 'drag-1'), {
    mode: 'dragging-node', owner: 'canvas', sessionId: 'drag-1',
  });
  assert.equal(interactions.end('groups', 'dragging-node', 'drag-1'), false);
  assert.equal(interactions.end('canvas', 'dragging-node', 'drag-old'), false);
  assert.equal(interactions.current(), 'dragging-node');
  assert.equal(interactions.end('canvas', 'dragging-node', 'drag-1'), true);
  assert.deepEqual(interactions.snapshot(), { mode: 'idle' });
});

test('kernel-owned resource leases dispose timers and files exactly once on hot-stop', async () => {
  const harness = createHarness();
  let intervalTicks = 0;
  let timeoutTicks = 0;
  let fileReleases = 0;
  harness.plugins.register({
    manifest: defineManifest('resource-probe', '资源探针'),
    start(context) {
      context.resources.interval(() => { intervalTicks += 1; }, 2);
      context.resources.timeout(() => { timeoutTicks += 1; }, 100);
      context.resources.track('file', () => { fileReleases += 1; });
    },
  });
  await harness.plugins.start('resource-probe');
  await new Promise((resolve) => setTimeout(resolve, 8));
  await harness.plugins.stop('resource-probe');
  const stoppedTicks = intervalTicks;
  await new Promise((resolve) => setTimeout(resolve, 12));

  assert.ok(stoppedTicks > 0);
  assert.equal(intervalTicks, stoppedTicks);
  assert.equal(timeoutTicks, 0);
  assert.equal(fileReleases, 1);
  assert.equal(harness.resources.count('resource-probe'), 0);
});

test('plugin pause and uninstall release resources while preserving owned data for reinstall', async () => {
  const harness = createHarness();
  let installs = 0;
  let starts = 0;
  let pauses = 0;
  let stops = 0;
  let uninstalls = 0;
  harness.plugins.register({
    manifest: defineManifest('lifecycle-probe', '生命周期探针', {
      namespaces: ['lifecycleProbe'],
      namespaceDomains: { lifecycleProbe: 'document' },
      commands: ['lifecycleProbe.write'],
      permissions: ['store.own.write'],
    }),
    install() { installs += 1; },
    start(context) {
      starts += 1;
      context.commands.register({
        type: 'lifecycleProbe.write',
        handle: () => ({
          transaction: {
            label: '写入生命周期数据',
            patches: [{
              op: 'set', domain: 'document', namespace: 'lifecycleProbe', key: 'retained', value: 42,
            }],
          },
        }),
      });
    },
    pause() { pauses += 1; },
    stop() { stops += 1; },
    uninstall() { uninstalls += 1; },
  });

  await harness.plugins.start('lifecycle-probe');
  await harness.router.dispatch('lifecycleProbe.write', undefined, 'core.test');
  await harness.plugins.pause('lifecycle-probe');
  assert.equal(harness.resources.count('lifecycle-probe'), 0);
  assert.equal(harness.store.readValue('document', 'lifecycleProbe', 'retained'), 42);
  await assert.rejects(
    () => harness.router.dispatch('lifecycleProbe.write', undefined, 'core.test'),
    /Command unavailable/,
  );

  await harness.plugins.start('lifecycle-probe');
  assert.equal(installs, 1);
  assert.equal(starts, 2);
  assert.equal(pauses, 1);
  await harness.plugins.stop('lifecycle-probe');
  await harness.plugins.uninstall('lifecycle-probe');
  assert.equal(stops, 1);
  assert.equal(uninstalls, 1);
  assert.equal(harness.plugins.list().find((plugin) => plugin.id === 'lifecycle-probe')?.status, 'removed');
  assert.equal(harness.store.readValue('document', 'lifecycleProbe', 'retained'), 42);

  await harness.plugins.start('lifecycle-probe');
  assert.equal(installs, 2);
  assert.equal(starts, 3);
});

test('plugin auto-start resolves explicit and capability dependencies without registration-order coupling', async () => {
  const harness = createHarness();
  const started: string[] = [];
  const consumer: PluginDefinition = {
    manifest: defineManifest('ordered-consumer', '后注册顺序消费者', {
      dependencies: ['ordered-provider'],
      requiresCapabilities: ['ordered.capability@1'],
    }),
    start() { started.push('consumer'); },
  };
  const provider: PluginDefinition = {
    manifest: defineManifest('ordered-provider', '后注册能力提供者', {
      providesCapabilities: ['ordered.capability@1'],
    }),
    start(context) {
      started.push('provider');
      context.capabilities.provide({ key: 'ordered.capability@1', invoke: () => 'ready' });
    },
  };
  harness.plugins.register(consumer);
  harness.plugins.register(provider);
  assert.deepEqual(harness.plugins.planAutoStart(), ['ordered-provider', 'ordered-consumer']);
  await harness.plugins.startAutoPlugins();
  assert.deepEqual(started, ['provider', 'consumer']);
});

test('plugin dependency analysis rejects explicit cycles and explains missing capability providers', () => {
  const harness = createHarness();
  harness.plugins.register({
    manifest: defineManifest('cycle-a', '循环 A', { dependencies: ['cycle-b'] }),
    start() {},
  });
  assert.throws(() => harness.plugins.register({
    manifest: defineManifest('cycle-b', '循环 B', { dependencies: ['cycle-a'] }),
    start() {},
  }), /cycle-a -> cycle-b -> cycle-a/u);
  assert.equal(harness.plugins.list().some((plugin) => plugin.id === 'cycle-b'), false);

  assert.throws(() => resolvePluginStartOrder([
    defineManifest('missing-consumer', '缺少能力的消费者', {
      requiresCapabilities: ['missing.capability@1'],
    }),
  ]), /missing capability missing\.capability@1/u);
  assert.throws(() => resolvePluginStartOrder([
    defineManifest('cap-cycle-a', '能力循环 A', {
      requiresCapabilities: ['capability.b@1'],
      providesCapabilities: ['capability.a@1'],
    }),
    defineManifest('cap-cycle-b', '能力循环 B', {
      requiresCapabilities: ['capability.a@1'],
      providesCapabilities: ['capability.b@1'],
    }),
  ]), /cap-cycle-a -> cap-cycle-b -> cap-cycle-a/u);
});

test('task scheduler supports queued pause, bounded retry and timeout', async () => {
  const scheduler = new TaskScheduler(1);
  let releaseFirst!: () => void;
  const first = scheduler.schedule('task-test', {
    category: 'blocker',
    priority: 10,
    run: async () => new Promise<number>((resolve) => {
      releaseFirst = () => resolve(1);
    }),
  });
  let secondRuns = 0;
  const second = scheduler.schedule('task-test', {
    category: 'paused',
    priority: 5,
    run: async () => {
      secondRuns += 1;
      return 2;
    },
  });
  second.pause();
  await Promise.resolve();
  releaseFirst();
  assert.equal(await first.result, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(secondRuns, 0);
  assert.equal(scheduler.snapshot().paused, 1);
  second.resume();
  assert.equal(await second.result, 2);

  let attempts = 0;
  const retried = scheduler.schedule('task-test', {
    category: 'retry',
    priority: 1,
    maxRetries: 1,
    retryDelayMs: 0,
    run: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary');
      return 'ready';
    },
  });
  assert.equal(await retried.result, 'ready');
  assert.equal(attempts, 2);

  const timedOut = scheduler.schedule('task-test', {
    category: 'timeout',
    priority: 1,
    timeoutMs: 10,
    run: async (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await assert.rejects(timedOut.result, (error: unknown) =>
    error instanceof DOMException && error.name === 'TimeoutError');
});

test('task scheduler delays long-operation notices and clears them when work settles', async () => {
  const scheduler = new TaskScheduler(1);
  const quick = scheduler.schedule('task-test', {
    category: 'quick',
    label: '快速任务',
    priority: 1,
    noticeAfterMs: 20,
    run: async () => 'done',
  });
  assert.equal(await quick.result, 'done');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(scheduler.snapshot().tasks.length, 0);

  let release!: () => void;
  const long = scheduler.schedule('task-test', {
    category: 'long',
    label: '正在处理大型内容',
    priority: 1,
    noticeAfterMs: 10,
    run: async () => new Promise<string>((resolve) => {
      release = () => resolve('done');
    }),
  });
  assert.equal(scheduler.snapshot().tasks[0].noticeVisible, false);
  const notice = await waitFor(async () => {
    const task = scheduler.snapshot().tasks.find((item) => item.id === long.id);
    return task?.noticeVisible ? task : undefined;
  });
  assert.equal(notice.label, '正在处理大型内容');
  release();
  assert.equal(await long.result, 'done');
  assert.equal(scheduler.snapshot().tasks.some((task) => task.id === long.id), false);
});

test('task scheduler keeps two remote generations and one checkpoint active together', async () => {
  const scheduler = new TaskScheduler(4, 16);
  const releases: Array<() => void> = [];
  const scheduleBlocked = (category: string, estimatedCost: number) => scheduler.schedule('task-test', {
    category,
    priority: 5,
    estimatedCost,
    run: async () => new Promise<string>((resolve) => {
      releases.push(() => resolve(category));
    }),
  });
  const firstGeneration = scheduleBlocked('ai-generation:first', 4);
  const secondGeneration = scheduleBlocked('ai-generation:second', 4);
  const checkpoint = scheduleBlocked('checkpoint', 8);
  await waitFor(async () => releases.length === 3 ? true : undefined);
  assert.equal(scheduler.snapshot().active, 3);
  assert.equal(scheduler.snapshot().activeCost, 16);
  for (const release of releases) release();
  assert.deepEqual(await Promise.all([
    firstGeneration.result,
    secondGeneration.result,
    checkpoint.result,
  ]), ['ai-generation:first', 'ai-generation:second', 'checkpoint']);
});

test('task scheduler owns delayed admission and cancellation for debounced plugin work', async () => {
  const scheduler = new TaskScheduler(1);
  let runs = 0;
  const cancelled = scheduler.schedule('task-test', {
    category: 'debounced-index',
    delayMs: 30,
    priority: 1,
    run: async () => {
      runs += 1;
    },
  });
  cancelled.cancel();
  await assert.rejects(cancelled.result, (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, 0);

  const admitted = scheduler.schedule('task-test', {
    category: 'debounced-index',
    delayMs: 15,
    priority: 1,
    run: async () => {
      runs += 1;
      return 'rebuilt';
    },
  });
  assert.equal(runs, 0);
  assert.equal(await admitted.result, 'rebuilt');
  assert.equal(runs, 1);
});

test('hot-stop refuses to remove the last provider of an active required capability', async () => {
  const harness = createHarness();
  harness.plugins.register({
    manifest: defineManifest('cap-provider', '能力提供者', {
      providesCapabilities: ['test.capability@1'],
    }),
    start(context) {
      context.capabilities.provide({ key: 'test.capability@1', invoke: () => true });
    },
  });
  harness.plugins.register({
    manifest: defineManifest('cap-consumer', '能力消费者', {
      requiresCapabilities: ['test.capability@1'],
    }),
    start() {},
  });
  await harness.plugins.start('cap-provider');
  await harness.plugins.start('cap-consumer');

  const providerSnapshot = harness.plugins.list().find((plugin) => plugin.id === 'cap-provider');
  assert.equal(providerSnapshot?.category, 'provider');
  assert.equal(providerSnapshot?.toggleable, false);
  assert.deepEqual(providerSnapshot?.blockers, ['能力消费者']);

  await assert.rejects(() => harness.plugins.stop('cap-provider'), /仍被这些活动插件依赖/);
  assert.equal(harness.plugins.isActive('cap-provider'), true);
  await harness.plugins.stop('cap-consumer');
  await harness.plugins.stop('cap-provider');
  assert.equal(harness.capabilities.has('test.capability@1'), false);
});

test('a plugin transaction cannot write another plugin namespace without an owned patch plan', async () => {
  const harness = createHarness();
  harness.plugins.register({
    manifest: defineManifest('owner-a', '所有者 A', {
      namespaces: ['ownedData'],
      namespaceDomains: { ownedData: 'document' },
    }),
    start() {},
  });
  harness.plugins.register({
    manifest: defineManifest('writer-b', '写入者 B', {
      commands: ['writer.try'],
    }),
    start(context) {
      context.commands.register({
        type: 'writer.try',
        handle: () => ({
          transaction: {
            label: '越权写入',
            patches: [
              { op: 'set', domain: 'document', namespace: 'ownedData', key: 'x', value: 1 },
            ],
          },
        }),
      });
    },
  });
  await harness.plugins.start('owner-a');
  await harness.plugins.start('writer-b');

  await assert.rejects(
    () => harness.router.dispatch('writer.try', undefined, 'core.test'),
    /Patch owner mismatch/,
  );
  assert.equal(harness.store.readValue('document', 'ownedData', 'x'), undefined);
});

test('selection deletes nodes and attached connections in one undoable transaction', async () => {
  const harness = createHarness();
  const selectionPlugin = createSelectionPlugin();
  const connectionsPlugin = createConnectionsPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(selectionPlugin);
  harness.plugins.register(connectionsPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');

  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '节点 A', x: 100, y: 100 },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '节点 B', x: 500, y: 100 },
    'core.test',
  );
  await harness.router.dispatch(
    'connection.create',
    {
      from: { nodeId: first.id, side: 'right' },
      to: { nodeId: second.id, side: 'left' },
    },
    'core.test',
  );
  await harness.router.dispatch('selection.set', { ids: [first.id], mode: 'replace' }, 'core.test');
  const beforeDeleteHistory = harness.history.getState().undoCount;

  await harness.router.dispatch('selection.delete', undefined, 'core.test');
  const afterDelete = await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1');
  const connectionsAfterDelete = await harness.capabilities.request<unknown[]>('connections.list@1');
  assert.equal(afterDelete.some((node) => node.id === first.id), false);
  assert.equal(connectionsAfterDelete.length, 0);
  assert.equal(harness.history.getState().undoCount, beforeDeleteHistory + 1);

  await harness.transactions.undo();
  const afterUndo = await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1');
  const connectionsAfterUndo = await harness.capabilities.request<unknown[]>('connections.list@1');
  assert.equal(afterUndo.some((node) => node.id === first.id), true);
  assert.equal(connectionsAfterUndo.length, 1);
});

test('title connection shortcut operation creates, converts, and disconnects selected node titles', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createConnectionsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');

  const left = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '标题起点', x: 100, y: 100,
  }, 'core.test');
  const right = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '标题终点', x: 500, y: 200,
  }, 'core.test');
  // Deliberately select from right to left: shortcut direction follows the
  // user's selection order, not the nodes' visual position.
  await harness.router.dispatch('selection.set', { ids: [right.id, left.id], mode: 'replace' }, 'core.test');

  const shortcut = harness.ui.listShortcuts().find((item) =>
    item.owner === 'connections' && item.id === 'connections.toggle-title-selected-shortcut',
  );
  assert.equal(shortcut?.chord, 'shift+l');
  assert.equal(shortcut?.command, 'connection.toggleTitleSelected');

  const created = await harness.router.dispatch<{ id?: string }>(
    'connection.toggleTitleSelected', undefined, 'core.test',
  );
  let connections = await harness.capabilities.request<ConnectionRecord[]>('connections.list@1');
  assert.equal(connections.length, 1);
  assert.equal(connections[0].id, created.id);
  assert.deepEqual(connections[0].from, { nodeId: right.id, side: 'title' });
  assert.deepEqual(connections[0].to, { nodeId: left.id, side: 'title' });

  await harness.router.dispatch('connection.toggleTitleSelected', undefined, 'core.test');
  connections = await harness.capabilities.request<ConnectionRecord[]>('connections.list@1');
  assert.equal(connections.length, 0);
  await harness.transactions.undo();
  connections = await harness.capabilities.request<ConnectionRecord[]>('connections.list@1');
  assert.equal(connections[0].from.side, 'title');

  await harness.transactions.undo();
  await harness.router.dispatch('connection.toggleSelected', undefined, 'core.test');
  connections = await harness.capabilities.request<ConnectionRecord[]>('connections.list@1');
  const ordinaryId = connections[0].id;
  assert.notEqual(connections[0].from.side, 'title');
  assert.equal(connections[0].from.nodeId, right.id);
  assert.equal(connections[0].to.nodeId, left.id);

  const converted = await harness.router.dispatch<{ id?: string; converted?: boolean }>(
    'connection.toggleTitleSelected', undefined, 'core.test',
  );
  connections = await harness.capabilities.request<ConnectionRecord[]>('connections.list@1');
  assert.equal(converted.converted, true);
  assert.equal(connections[0].id, ordinaryId);
  assert.deepEqual(connections[0].from, { nodeId: right.id, side: 'title' });
  assert.deepEqual(connections[0].to, { nodeId: left.id, side: 'title' });
});

test('annotations follow text edits and target deletion in the same global transactions', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createAnnotationsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('annotations');

  const node = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '带注释正文',
    body: 'abcdef',
  }, 'core.test');
  const annotation = await harness.router.dispatch<{ id: string }>('annotation.create', {
    target: { kind: 'text-range', targetId: node.id, offset: 3 },
    body: '这里需要复核',
  }, 'core.test');

  await harness.router.dispatch('content.applyDelta', {
    nodeId: node.id,
    start: 1,
    deleteCount: 0,
    insert: 'XY',
  }, 'core.test');
  let records = await harness.capabilities.request<Array<{
    id: string;
    target: { kind: string; targetId: string; offset?: number };
  }>>('annotations.list@1');
  assert.equal(records.find((item) => item.id === annotation.id)?.target.offset, 5);

  await harness.transactions.undo();
  records = await harness.capabilities.request('annotations.list@1');
  assert.equal(records.find((item) => item.id === annotation.id)?.target.offset, 3);

  const insertionAtAnchor = await harness.capabilities.request<{ patches: unknown[] }>(
    'content.anchorTransformPlan@1',
    { nodeId: node.id, start: 3, deleteCount: 0, insertLength: 1 },
  );
  assert.equal(insertionAtAnchor.patches.length, 0);

  await harness.router.dispatch('content.applyDelta', {
    nodeId: node.id,
    start: 3,
    deleteCount: 0,
    insert: 'Z',
    typingSessionId: 'annotation-right-boundary',
  }, 'core.test');
  records = await harness.capabilities.request('annotations.list@1');
  assert.equal(records.find((item) => item.id === annotation.id)?.target.offset, 3);

  await harness.router.dispatch('content.applyDelta', {
    nodeId: node.id,
    start: 1,
    deleteCount: 2,
    insert: '',
    typingSessionId: 'annotation-cut-range',
  }, 'core.test');
  records = await harness.capabilities.request('annotations.list@1');
  assert.equal(records.some((item) => item.id === annotation.id), false);
  await harness.transactions.undo();

  await harness.router.dispatch('content.applyDelta', {
    nodeId: node.id,
    start: 7,
    deleteCount: 0,
    insert: 'XY',
    typingSessionId: 'annotation-paste-range',
    annotationCopies: [{ relativeOffset: 2, body: '复制的注释' }],
  }, 'core.test');
  records = await harness.capabilities.request('annotations.list@1');
  assert.equal(records.some((item) => item.id !== annotation.id &&
    item.target.offset === 9 && (item as { body?: string }).body === '复制的注释'), true);
  await harness.transactions.undo();

  await harness.router.dispatch('selection.set', {
    items: [{ id: node.id, kind: 'text-node' }],
    mode: 'replace',
  }, 'core.test');
  await harness.router.dispatch('selection.delete', undefined, 'core.test');
  assert.deepEqual(await harness.capabilities.request('annotations.list@1'), []);

  await harness.transactions.undo();
  records = await harness.capabilities.request('annotations.list@1');
  assert.equal(records.some((item) => item.id === annotation.id), true);
  assert.equal((await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1'))
    .some((item) => item.id === node.id), true);
});

test('annotation creation opens its editor at the captured caret position', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createEditorPlugin());
  harness.plugins.register(createAnnotationsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('editor');
  await harness.plugins.start('annotations');
  const node = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '光标注释', body: '在这里插入注释',
  }, 'core.test');
  await harness.router.dispatch('editor.open', { id: node.id }, 'core.test');
  harness.router.emitSignal('editor.selection.preview', {
    id: node.id,
    start: 4,
    end: 4,
    focused: true,
    screenAnchor: { x: 210, y: 190 },
  }, 'editor');
  const created = await harness.router.dispatch<{ id: string }>('annotation.createAtContext', undefined, 'core.test');
  const annotationState = await waitFor(async () => {
    const state = await harness.capabilities.request<{
      open?: { id: string; rect: { x: number; y: number } };
      records: Array<{ id: string; target: { kind: string; offset?: number } }>;
    }>('annotations.state@1');
    return state.open?.id === created.id ? state : undefined;
  });
  assert.equal(annotationState.open?.rect.x, 222);
  assert.equal(annotationState.open?.rect.y, 202);
  assert.equal(annotationState.records.find((record) => record.id === created.id)?.target.offset, 4);
});

test('immersive annotations use a nested governed surface without evicting the editor', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createEditorPlugin());
  harness.plugins.register(createAnnotationsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('editor');
  await harness.plugins.start('annotations');
  const node = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '沉浸注释', body: '需要保持当前沉浸界面。',
  }, 'core.test');
  await harness.router.dispatch('editor.open', { id: node.id }, 'core.test');
  await harness.router.dispatch('editor.enterImmersive', { id: node.id }, 'core.test');
  const editorSurface = harness.ui.topSurface(['overlay.modal']);
  assert.equal(editorSurface?.id, 'editor.immersive');
  const annotation = await harness.router.dispatch<{ id: string }>('annotation.create', {
    target: { kind: 'text-range', targetId: node.id, offset: 3 },
    body: '沉浸中的注释',
  }, 'core.test');
  await waitFor(async () => {
    const state = await harness.capabilities.request<{
      open?: { id: string; surface: string };
    }>('annotations.state@1');
    return state.open?.id === annotation.id && state.open.surface === 'immersive' ? true : undefined;
  });
  assert.equal(harness.ui.topSurface(['overlay.modal'])?.id, 'editor.immersive');
  assert.equal(
    harness.ui.topSurface(['editor.immersive.overlay'])?.id,
    'annotations.immersive-popup',
  );
  await harness.router.dispatch('annotation.close', undefined, 'core.test');
  assert.equal(harness.ui.topSurface(['editor.immersive.overlay']), undefined);
  assert.equal(harness.ui.topSurface(['overlay.modal'])?.id, 'editor.immersive');
});

test('connections derive their sides from current node centres and reject reverse duplicates', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createConnectionsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');

  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '动态端点 A', x: 100, y: 100 },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '动态端点 B', x: 600, y: 100 },
    'core.test',
  );
  const created = await harness.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: first.id, side: 'left' },
    to: { nodeId: second.id, side: 'right' },
  }, 'core.test');
  let connections = await harness.capabilities.request<Array<{
    id: string;
    from: { nodeId: string; side: string };
    to: { nodeId: string; side: string };
  }>>('connections.list@1');
  assert.equal(connections[0].from.side, 'right');
  assert.equal(connections[0].to.side, 'left');

  const duplicate = await harness.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: second.id, side: 'left' },
    to: { nodeId: first.id, side: 'right' },
  }, 'core.test');
  assert.equal(duplicate.id, created.id);
  assert.equal((await harness.capabilities.request<unknown[]>('connections.list@1')).length, 1);

  await harness.router.dispatch('node.moveMany', {
    positions: [{ id: first.id, x: 1000, y: 100 }],
  }, 'core.test');
  connections = await harness.capabilities.request('connections.list@1');
  assert.equal(connections[0].from.side, 'left');
  assert.equal(connections[0].to.side, 'right');
});

test('title-bar connections stay pinned to title endpoints through movement and history', async () => {
  const harness = new ApplicationKernel([
    textNodePlugin,
    createSelectionPlugin(),
    createConnectionsPlugin(),
  ]);
  await harness.start();

  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '标题端点 A', x: 100, y: 100 },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '标题端点 B', x: 140, y: 600 },
    'core.test',
  );
  const created = await harness.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: first.id, side: 'title' },
    to: { nodeId: second.id, side: 'title' },
  }, 'core.test');
  let connections = await harness.capabilities.request<ConnectionRecord[]>('connections.list@1');
  assert.equal(connections[0].from.side, 'title');
  assert.equal(connections[0].to.side, 'title');

  await harness.router.dispatch('node.moveMany', {
    positions: [{ id: second.id, x: 900, y: 400 }],
  }, 'core.test');
  connections = await harness.capabilities.request<ConnectionRecord[]>('connections.list@1');
  assert.equal(connections[0].from.side, 'title');
  assert.equal(connections[0].to.side, 'title');
  await harness.transactions.undo();
  assert.equal((await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0].to.side, 'title');
  await harness.transactions.undo();
  assert.equal((await harness.capabilities.request<ConnectionRecord[]>('connections.list@1')).length, 0);
  await harness.transactions.redo();
  assert.equal((await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0].from.side, 'title');

  const labelResult = await harness.router.dispatch<{ revision: number }>('connection.setLabel', {
    id: created.id,
    label: '前置\n条件',
    expectedRevision: 1,
  }, 'core.test');
  assert.equal(labelResult.revision, 2);
  assert.equal((await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0].label, '前置\n条件');
  await assert.rejects(
    harness.router.dispatch('connection.setLabel', {
      id: created.id,
      label: '过期修改',
      expectedRevision: 1,
    }, 'core.test'),
    /连线文字已变化/u,
  );
  await harness.transactions.undo();
  assert.equal((await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0].label, undefined);
  await harness.transactions.redo();
  assert.equal((await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0].label, '前置\n条件');

  const resizeResult = await harness.router.dispatch<{
    width: number;
    height: number;
    revision: number;
  }>('connection.resizeLabel', {
    id: created.id,
    width: 286,
    height: 96,
    expectedRevision: 2,
  }, 'core.test');
  assert.deepEqual(resizeResult, { width: 286, height: 96, revision: 3 });
  let resizedConnection = (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0];
  assert.deepEqual(
    [resizedConnection.labelWidth, resizedConnection.labelHeight, resizedConnection.revision],
    [286, 96, 3],
  );
  await assert.rejects(
    harness.router.dispatch('connection.resizeLabel', {
      id: created.id,
      width: 320,
      height: 120,
      expectedRevision: 2,
    }, 'core.test'),
    /文字框已经变化/u,
  );
  await harness.transactions.undo();
  resizedConnection = (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0];
  assert.deepEqual([resizedConnection.labelWidth, resizedConnection.labelHeight, resizedConnection.revision], [180, 48, 2]);
  await harness.transactions.redo();
  resizedConnection = (await harness.capabilities.request<ConnectionRecord[]>('connections.list@1'))[0];
  assert.deepEqual([resizedConnection.labelWidth, resizedConnection.labelHeight, resizedConnection.revision], [286, 96, 3]);

  const source = await harness.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  assert.equal(source.plugins.find((plugin) => plugin.id === 'connections')?.dataVersion, 6);
  const reopened = new ApplicationKernel([
    textNodePlugin,
    createSelectionPlugin(),
    createConnectionsPlugin(),
  ]);
  await reopened.start();
  await reopened.router.dispatch(
    'system.document.replace',
    await parseProject(await serializeProject(source)),
    'core.test',
  );
  const restored = await reopened.capabilities.request<ConnectionRecord[]>('connections.list@1');
  assert.equal(restored[0].from.side, 'title');
  assert.equal(restored[0].to.side, 'title');
  assert.equal(restored[0].label, '前置\n条件');
  assert.equal(restored[0].labelWidth, 286);
  assert.equal(restored[0].labelHeight, 96);
  assert.equal(restored[0].revision, 3);
});

test('connection rendering batches large visible sets while preserving pointer hit geometry', () => {
  assert.equal(connectionRenderMode(CONNECTION_BATCH_RENDER_THRESHOLD), 'interactive-svg');
  assert.equal(connectionRenderMode(CONNECTION_BATCH_RENDER_THRESHOLD + 1), 'batched-svg');
  assert.match(connectionCurvePath({ x: 0, y: 0 }, { x: 120, y: 0 }), /^M 0 0 C /u);
  assert.ok(distanceToConnectionCurve({ x: 60, y: 0 }, { x: 0, y: 0 }, { x: 120, y: 0 }) < 0.01);
  assert.ok(distanceToConnectionCurve({ x: 60, y: 40 }, { x: 0, y: 0 }, { x: 120, y: 0 }) > 35);
});

test('box selection is workspace state and supports add and remove modes', async () => {
  const harness = createHarness();
  const selectionPlugin = createSelectionPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(selectionPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  const far = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '远处节点', x: 1800, y: 1200 },
    'core.test',
  );
  const historyBeforeSelection = harness.history.getState().undoCount;

  await harness.router.dispatch(
    'selection.box',
    { x: 0, y: 0, width: 800, height: 800, mode: 'replace' },
    'core.test',
  );
  const nearSelection = await harness.capabilities.request<{ ids: string[] }>('selection.read@1');
  assert.ok(nearSelection.ids.length >= 1);
  assert.equal(nearSelection.ids.includes(far.id), false);

  await harness.router.dispatch(
    'selection.box',
    { x: 1700, y: 1100, width: 400, height: 400, mode: 'add' },
    'core.test',
  );
  const added = await harness.capabilities.request<{ ids: string[] }>('selection.read@1');
  assert.equal(added.ids.includes(far.id), true);
  assert.equal(harness.history.getState().undoCount, historyBeforeSelection);
});

test('setting an identical selection is a no-op and does not invalidate dependants', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  const node = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '幂等选择', body: '不应重复触发统计' },
    'core.test',
  );
  let changes = 0;
  harness.router.subscribeEvent('core.test', 'selection.changed', () => {
    changes += 1;
  });

  await harness.router.dispatch('selection.set', { ids: [node.id], mode: 'replace' }, 'core.test');
  await Promise.resolve();
  await harness.router.dispatch('selection.set', { ids: [node.id], mode: 'replace' }, 'core.test');
  await Promise.resolve();

  assert.equal(changes, 1);
});

test('selection catalogs keep connections directly selectable but exclude them from select all', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createConnectionsPlugin());
  harness.plugins.register(createGroupsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');
  await harness.plugins.start('groups');
  const left = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '选择左', body: 'L', x: 1000, y: 1000 },
    'core.test',
  );
  const right = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '选择右', body: 'R', x: 1500, y: 1000 },
    'core.test',
  );
  const connection = await harness.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: left.id, side: 'right' },
    to: { nodeId: right.id, side: 'left' },
  }, 'core.test');

  await harness.router.dispatch('selection.box', {
    x: 1320, y: 1070, width: 100, height: 20, mode: 'replace',
  }, 'core.test');
  const lineOnly = await harness.capabilities.request<{
    items: Array<{ id: string; kind: string }>;
  }>('selection.read@1');
  assert.deepEqual(lineOnly.items, [{ id: connection.id, kind: 'connection' }]);

  await harness.router.dispatch('selection.box', {
    x: 990, y: 990, width: 360, height: 190, mode: 'replace',
  }, 'core.test');
  const nodeAndLine = await harness.capabilities.request<{
    items: Array<{ id: string; kind: string }>;
  }>('selection.read@1');
  assert.ok(nodeAndLine.items.some((item) => item.id === left.id && item.kind === 'text-node'));
  assert.equal(nodeAndLine.items.some((item) => item.id === connection.id), false);

  await harness.router.dispatch('selection.set', { ids: [left.id, right.id], mode: 'replace' }, 'core.test');
  const group = await harness.router.dispatch<{ id: string }>('group.create', { title: '选择群组' }, 'core.test');

  await harness.router.dispatch('selection.box', {
    x: 1040, y: 1020, width: 80, height: 35, mode: 'replace',
  }, 'core.test');
  const memberOnly = await harness.capabilities.request<{
    items: Array<{ id: string; kind: string }>;
  }>('selection.read@1');
  assert.deepEqual(memberOnly.items, [{ id: left.id, kind: 'text-node' }]);
  await harness.router.dispatch('connection.toggleSelected', undefined, 'core.test');
  assert.equal((await harness.capabilities.request<unknown[]>('connections.list@1')).length, 0);
  await harness.transactions.undo();
  await new Promise((resolve) => setTimeout(resolve, 0));

  await harness.router.dispatch('selection.box', {
    x: 900, y: 900, width: 1000, height: 500, mode: 'replace',
  }, 'core.test');
  const groupAndLine = await harness.capabilities.request<{
    items: Array<{ id: string; kind: string }>;
  }>('selection.read@1');
  assert.ok(groupAndLine.items.some((item) => item.id === group.id && item.kind === 'group'));
  assert.equal(groupAndLine.items.some((item) => item.id === left.id), false);
  assert.equal(groupAndLine.items.some((item) => item.id === right.id), false);
  assert.equal(groupAndLine.items.some((item) => item.id === connection.id), false);

  await harness.router.dispatch('selection.all', undefined, 'core.test');
  const all = await harness.capabilities.request<{
    ids: string[];
    items: Array<{ id: string; kind: string }>;
  }>('selection.read@1');
  assert.equal(all.items.some((item) => item.id === connection.id && item.kind === 'connection'), false);
  assert.ok(all.items.some((item) => item.id === group.id && item.kind === 'group'));
  assert.equal(all.items.some((item) => item.id === left.id), false);
  assert.equal(all.items.some((item) => item.id === right.id), false);

  await harness.router.dispatch('selection.set', {
    items: [{ id: connection.id, kind: 'connection' }],
    mode: 'replace',
  }, 'core.test');
  await harness.router.dispatch('selection.delete', undefined, 'core.test');
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string }>>('connections.list@1')).length,
    0,
  );
  assert.equal((await harness.capabilities.request<Array<{ id: string }>>('groups.list@1')).length, 1);
  await harness.transactions.undo();
  await new Promise((resolve) => setTimeout(resolve, 0));

  await harness.router.dispatch('selection.set', {
    items: [{ id: group.id, kind: 'group' }],
    mode: 'replace',
  }, 'core.test');
  const historyBeforeGroupDelete = harness.history.getState().undoCount;
  await harness.router.dispatch('selection.delete', undefined, 'core.test');
  assert.equal((await harness.capabilities.request<Array<{ id: string }>>('groups.list@1')).length, 0);
  const summaries = await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1');
  assert.equal(summaries.some((item) => item.id === left.id), false);
  assert.equal(summaries.some((item) => item.id === right.id), false);
  assert.equal((await harness.capabilities.request<unknown[]>('connections.list@1')).length, 0);
  assert.equal(harness.history.getState().undoCount, historyBeforeGroupDelete + 1);
  await harness.transactions.undo();
  assert.equal((await harness.capabilities.request<unknown[]>('groups.list@1')).length, 1);
  const restoredNodes = await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1');
  assert.ok(restoredNodes.some((item) => item.id === left.id));
  assert.ok(restoredNodes.some((item) => item.id === right.id));
  assert.equal((await harness.capabilities.request<unknown[]>('connections.list@1')).length, 1);
});

test('group title controls are removed while legacy title data remains readable and member deletion stays direct', async () => {
  const harness = createHarness();
  const selectionPlugin = createSelectionPlugin();
  const groupsPlugin = createGroupsPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(selectionPlugin);
  harness.plugins.register(groupsPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('groups');

  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '组员 A', x: 100, y: 100 },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '组员 B', x: 460, y: 100 },
    'core.test',
  );
  await harness.router.dispatch(
    'selection.set',
    { ids: [first.id, second.id], mode: 'replace' },
    'core.test',
  );
  await harness.router.dispatch<{ id: string }>('group.create', { title: '第一行\n第二行' }, 'core.test');
  assert.equal(harness.router.isCommandAvailable('group.updateTitle'), false);
  assert.equal(harness.router.isCommandAvailable('group.rename'), false);
  assert.equal(harness.router.isCommandAvailable('group.setTitleStyle'), false);
  const groups = await harness.capabilities.request<Array<{
    id: string;
    title: string;
    memberIds: string[];
    titleStyle: { fontSize: number; fontWeight: number };
    titleMarks: Array<{ start: number; end: number; fontSize: number; fontWeight: number }>;
  }>>('groups.list@1');
  assert.equal(groups[0].title, '第一行\n第二行');
  assert.deepEqual(groups[0].memberIds, [first.id, second.id]);
  assert.deepEqual(groups[0].titleStyle, { fontSize: 13, fontWeight: 650 });
  assert.deepEqual(groups[0].titleMarks, []);

  await harness.router.dispatch('selection.set', { ids: [first.id], mode: 'replace' }, 'core.test');
  const historyBeforeDelete = harness.history.getState().undoCount;
  await harness.router.dispatch('selection.delete', undefined, 'core.test');
  assert.equal((await harness.capabilities.request<unknown[]>('groups.list@1')).length, 0);
  const afterMemberDelete = await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1');
  assert.equal(afterMemberDelete.some((node) => node.id === first.id), false);
  assert.equal(afterMemberDelete.some((node) => node.id === second.id), true);
  assert.equal(harness.history.getState().undoCount, historyBeforeDelete + 1);

  await harness.transactions.undo();
  const restoredGroups = await harness.capabilities.request<Array<{ memberIds: string[] }>>('groups.list@1');
  assert.deepEqual(restoredGroups[0].memberIds, [first.id, second.id]);
});

test('group membership commands add and remove nodes as one undoable group-owned transaction', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createGroupsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('groups');

  const first = await harness.router.dispatch<{ id: string }>('node.create', { title: '成员一' }, 'core.test');
  const second = await harness.router.dispatch<{ id: string }>('node.create', { title: '成员二' }, 'core.test');
  const third = await harness.router.dispatch<{ id: string }>('node.create', { title: '待加入' }, 'core.test');
  await harness.router.dispatch('selection.set', { ids: [first.id, second.id], mode: 'replace' }, 'core.test');
  const group = await harness.router.dispatch<{ id: string }>('group.create', {}, 'core.test');

  const beforeAdd = harness.history.getState().undoCount;
  await harness.router.dispatch(
    'group.membership.add',
    { groupId: group.id, nodeIds: [third.id] },
    'core.test',
  );
  let groups = await harness.capabilities.request<Array<{ memberIds: string[] }>>('groups.list@1');
  assert.deepEqual(groups[0].memberIds, [first.id, second.id, third.id]);
  assert.equal(harness.history.getState().undoCount, beforeAdd + 1);

  await harness.transactions.undo();
  groups = await harness.capabilities.request<Array<{ memberIds: string[] }>>('groups.list@1');
  assert.deepEqual(groups[0].memberIds, [first.id, second.id]);
  await harness.transactions.redo();

  await harness.router.dispatch(
    'group.membership.remove',
    { groupId: group.id, nodeIds: [third.id] },
    'core.test',
  );
  groups = await harness.capabilities.request<Array<{ memberIds: string[] }>>('groups.list@1');
  assert.deepEqual(groups[0].memberIds, [first.id, second.id]);
  await harness.transactions.undo();
  groups = await harness.capabilities.request<Array<{ memberIds: string[] }>>('groups.list@1');
  assert.deepEqual(groups[0].memberIds, [first.id, second.id, third.id]);
});

test('Ctrl-modified node drops move and change group membership in one undoable transaction', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createGroupsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('groups');

  const first = await harness.router.dispatch<{ id: string }>(
    'node.create', { title: '框内一', x: 100, y: 200 }, 'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create', { title: '框内二', x: 500, y: 200 }, 'core.test',
  );
  const third = await harness.router.dispatch<{ id: string }>(
    'node.create', { title: '拖入节点', x: 1000, y: 200 }, 'core.test',
  );
  await harness.router.dispatch('selection.set', { ids: [first.id, second.id], mode: 'replace' }, 'core.test');
  const group = await harness.router.dispatch<{ id: string }>('group.create', {}, 'core.test');

  const addPointer = { x: 300, y: 300 };
  const addTarget = await harness.capabilities.request<{ action: 'add'; groupId: string }>(
    'group.dropTarget@1', { nodeId: third.id, pointer: addPointer },
  );
  assert.deepEqual(addTarget, { action: 'add', groupId: group.id });
  const historyBeforeAdd = harness.history.getState().undoCount;
  await harness.router.dispatch('group.membership.drop', {
    nodeId: third.id,
    positions: [{ id: third.id, x: 300, y: 240 }],
    pointer: addPointer,
    target: addTarget,
  }, 'core.test');
  let groups = await harness.capabilities.request<Array<{ memberIds: string[] }>>('groups.list@1');
  let nodes = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  assert.equal(groups[0].memberIds.includes(third.id), true);
  assert.equal(nodes.find((node) => node.id === third.id)?.x, 300);
  assert.equal(harness.history.getState().undoCount, historyBeforeAdd + 1);

  await harness.transactions.undo();
  groups = await harness.capabilities.request('groups.list@1');
  nodes = await harness.capabilities.request('content.summaries@1');
  assert.equal(groups[0].memberIds.includes(third.id), false);
  assert.equal(nodes.find((node) => node.id === third.id)?.x, 1000);
  await harness.transactions.redo();

  // Ctrl means remove for a current member even while the pointer is still
  // inside the group. Releasing Ctrl is handled by the ephemeral canvas state.
  const removePointer = { x: 300, y: 300 };
  const removeTarget = await harness.capabilities.request<{ action: 'remove'; groupId: string }>(
    'group.dropTarget@1', { nodeId: third.id, pointer: removePointer },
  );
  assert.deepEqual(removeTarget, { action: 'remove', groupId: group.id });
  const historyBeforeRemove = harness.history.getState().undoCount;
  await harness.router.dispatch('group.membership.drop', {
    nodeId: third.id,
    positions: [{ id: third.id, x: 1160, y: 240 }],
    pointer: removePointer,
    target: removeTarget,
  }, 'core.test');
  groups = await harness.capabilities.request('groups.list@1');
  nodes = await harness.capabilities.request('content.summaries@1');
  assert.equal(groups[0].memberIds.includes(third.id), false);
  assert.equal(nodes.find((node) => node.id === third.id)?.x, 1160);
  assert.equal(harness.history.getState().undoCount, historyBeforeRemove + 1);

  await harness.transactions.undo();
  groups = await harness.capabilities.request('groups.list@1');
  nodes = await harness.capabilities.request('content.summaries@1');
  assert.equal(groups[0].memberIds.includes(third.id), true);
  assert.equal(nodes.find((node) => node.id === third.id)?.x, 300);
});

test('group containers and their member nodes resolve as independent direct selections', async () => {
  const harness = createHarness();
  let pointer = { x: 200, y: 150 };
  const pointerProvider = {
    manifest: defineManifest('test-canvas-pointer', '测试画布指针', {
      providesCapabilities: ['canvas.pointer@1'],
    }),
    start(context: Parameters<ReturnType<typeof createGroupsPlugin>['start']>[0]) {
      context.capabilities.provide({
        key: 'canvas.pointer@1',
        invoke: () => ({ point: pointer }),
      });
    },
  };
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createGroupsPlugin());
  harness.plugins.register(pointerProvider);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('groups');
  await harness.plugins.start('test-canvas-pointer');

  const first = await harness.router.dispatch<{ id: string }>('node.create', { title: '组内一', x: 100, y: 100 }, 'core.test');
  const second = await harness.router.dispatch<{ id: string }>('node.create', { title: '组内二', x: 500, y: 100 }, 'core.test');
  const outside = await harness.router.dispatch<{ id: string }>('node.create', { title: '组外', x: 1200, y: 100 }, 'core.test');
  await harness.router.dispatch('selection.set', { ids: [first.id, second.id], mode: 'replace' }, 'core.test');
  const group = await harness.router.dispatch<{ id: string }>('group.create', {}, 'core.test');

  await harness.router.dispatch('selection.all', undefined, 'core.test');
  let scopedSelection = await harness.capabilities.request<SelectionSnapshot>('selection.read@1');
  assert.deepEqual(new Set(scopedSelection.ids), new Set([first.id, second.id]));
  assert.equal(scopedSelection.ids.includes(group.id), false);
  pointer = { x: 2000, y: 2000 };
  await harness.router.dispatch('selection.all', undefined, 'core.test');
  scopedSelection = await harness.capabilities.request<SelectionSnapshot>('selection.read@1');
  assert.equal(scopedSelection.ids.includes(group.id), true);
  assert.equal(scopedSelection.ids.includes(outside.id), true);
  assert.equal(scopedSelection.ids.includes(first.id), false);
  assert.equal(scopedSelection.ids.includes(second.id), false);

  await harness.router.dispatch('selection.set', { ids: [first.id, second.id], mode: 'replace' }, 'core.test');
  await assert.rejects(
    harness.router.dispatch('group.ungroupSelection', undefined, 'core.test'),
    /直接选择一个群组/,
  );
  await assert.rejects(
    harness.router.dispatch('group.toggleSelection', undefined, 'core.test'),
    /只能属于一个群组/,
  );
  assert.equal((await harness.capabilities.request<unknown[]>('groups.list@1')).length, 1);

  await harness.router.dispatch('selection.set', { ids: [group.id], mode: 'replace' }, 'core.test');
  await harness.router.dispatch('selection.set', { ids: [outside.id], mode: 'add' }, 'core.test');

  const resolution = await harness.capabilities.request<{
    ids: string[];
    items: Array<{ id: string; kind: string }>;
    expandedIds: string[];
  }>('selection.resolve@1', {
    items: [{ id: first.id, kind: 'text-node' }],
    mode: 'replace',
    preserveIfSelected: true,
  });
  assert.deepEqual(resolution.ids, [first.id]);
  assert.deepEqual(resolution.expandedIds, [first.id]);
  const groupResolution = await harness.capabilities.request<{
    ids: string[];
    expandedIds: string[];
  }>('selection.resolve@1', {
    items: [{ id: group.id, kind: 'group' }],
    mode: 'replace',
  });
  assert.deepEqual(groupResolution.ids, [group.id]);
  assert.deepEqual(new Set(groupResolution.expandedIds), new Set([group.id, first.id, second.id]));

  const memberDragResolution = await harness.capabilities.request<{
    ids: string[];
    items: Array<{ id: string; kind: string }>;
    expandedIds: string[];
  }>('selection.resolve@1', {
    items: [{ id: first.id, kind: 'text-node' }],
    mode: 'replace',
    preserveIfSelected: true,
    moveContainedItemsDirectly: true,
  });
  assert.deepEqual(memberDragResolution.ids, [first.id]);
  assert.deepEqual(memberDragResolution.expandedIds, [first.id]);
});

test('copying one selected group member pastes only that node and preserves the original group', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createGroupsPlugin());
  harness.plugins.register(createClipboardPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('groups');
  await harness.plugins.start('clipboard');

  const first = await harness.router.dispatch<{ id: string }>('node.create', { title: '组内复制目标' }, 'core.test');
  const second = await harness.router.dispatch<{ id: string }>('node.create', { title: '组内保留节点' }, 'core.test');
  await harness.router.dispatch('selection.set', { ids: [first.id, second.id], mode: 'replace' }, 'core.test');
  const group = await harness.router.dispatch<{ id: string }>('group.create', {}, 'core.test');
  const countBeforePaste = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1')).length;

  await harness.router.dispatch('selection.set', { ids: [first.id], mode: 'replace' }, 'core.test');
  await harness.router.dispatch('clipboard.copy', undefined, 'core.test');
  await harness.router.dispatch('clipboard.paste', undefined, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const nodes = await harness.capabilities.request<ContentSummary[]>('content.summaries@1');
  assert.equal(nodes.length, countBeforePaste + 1);
  const groups = await harness.capabilities.request<Array<{ id: string; memberIds: string[] }>>('groups.list@1');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, group.id);
  assert.deepEqual(groups[0].memberIds, [first.id, second.id]);
  const selection = await harness.capabilities.request<{ ids: string[] }>('selection.read@1');
  assert.equal(selection.ids.length, 1);
  assert.notEqual(selection.ids[0], first.id);
  assert.notEqual(selection.ids[0], second.id);

  await harness.router.dispatch('selection.set', { ids: [first.id, second.id], mode: 'replace' }, 'core.test');
  await harness.router.dispatch('clipboard.copy', undefined, 'core.test');
  await harness.router.dispatch('clipboard.paste', undefined, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await harness.capabilities.request<ContentSummary[]>('content.summaries@1')).length, countBeforePaste + 3);
  const groupsAfterMemberCopy = await harness.capabilities.request<Array<{ id: string }>>('groups.list@1');
  assert.deepEqual(groupsAfterMemberCopy.map((item) => item.id), [group.id]);
});

test('group layout uses one uniform member-only frame', () => {
  const nodes: ContentSummary[] = [
    {
      id: 'node-a', title: 'A', preview: '', x: 100, y: 200, width: 280, height: 180,
      titleColor: '#111111', textColor: '#111111', presentation: 'card',
      resizeLimits: { minWidth: 220, maxWidth: 1600, minHeight: 120, maxHeight: 1200 },
      revision: 1, length: 0,
    },
    {
      id: 'node-b', title: 'B', preview: '', x: 440, y: 200, width: 280, height: 180,
      titleColor: '#111111', textColor: '#111111', presentation: 'card',
      resizeLimits: { minWidth: 220, maxWidth: 1600, minHeight: 120, maxHeight: 1200 },
      revision: 1, length: 0,
    },
  ];
  const bounds = computeGroupBounds(nodes);
  assert.deepEqual(bounds, { x: 75, y: 175, width: 670, height: 230 });
});

test('clipboard paste remaps node, connection and group identities in one history entry', async () => {
  const harness = createHarness();
  const selectionPlugin = createSelectionPlugin();
  const connectionsPlugin = createConnectionsPlugin();
  const groupsPlugin = createGroupsPlugin();
  const clipboardPlugin = createClipboardPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(selectionPlugin);
  harness.plugins.register(connectionsPlugin);
  harness.plugins.register(groupsPlugin);
  harness.plugins.register(clipboardPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');
  await harness.plugins.start('groups');
  await harness.plugins.start('clipboard');
  const initialNodeCount = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1')).length;

  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '复制源 A', body: '正文 A', x: 100, y: 100 },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '复制源 B', body: '正文 B', x: 500, y: 100 },
    'core.test',
  );
  const sourceConnection = await harness.router.dispatch<{ id: string }>(
    'connection.create',
    { from: { nodeId: first.id, side: 'right' }, to: { nodeId: second.id, side: 'left' } },
    'core.test',
  );
  await harness.router.dispatch('connection.setLabel', {
    id: sourceConnection.id,
    label: '复制的关系',
    expectedRevision: 1,
  }, 'core.test');
  await harness.router.dispatch('connection.resizeLabel', {
    id: sourceConnection.id,
    width: 304,
    height: 88,
    expectedRevision: 2,
  }, 'core.test');
  await harness.router.dispatch(
    'selection.set',
    { ids: [first.id, second.id], mode: 'replace' },
    'core.test',
  );
  await harness.router.dispatch('group.create', { title: '复制源群组' }, 'core.test');
  const sourceGroup = (await harness.capabilities.request<Array<{ id: string }>>('groups.list@1'))[0];
  await harness.router.dispatch('selection.set', {
    items: [{ id: sourceGroup.id, kind: 'group' }],
    mode: 'replace',
  }, 'core.test');
  const historyBeforeCopy = harness.history.getState().undoCount;
  await harness.router.dispatch('clipboard.copy', undefined, 'core.test');
  assert.equal(harness.history.getState().undoCount, historyBeforeCopy);

  const historyBeforePaste = harness.history.getState().undoCount;
  await harness.router.dispatch('clipboard.paste', undefined, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const nodesAfterPaste = await harness.capabilities.request<Array<{ id: string; x: number; y: number }>>(
    'content.summaries@1',
  );
  const connectionsAfterPaste = await harness.capabilities.request<Array<{
    id: string;
    from: { nodeId: string };
    to: { nodeId: string };
    label?: string;
    labelWidth: number;
    labelHeight: number;
    revision: number;
  }>>('connections.list@1');
  const groupsAfterPaste = await harness.capabilities.request<Array<{ id: string; memberIds: string[] }>>(
    'groups.list@1',
  );
  assert.equal(nodesAfterPaste.length, initialNodeCount + 4);
  assert.equal(connectionsAfterPaste.length, 2);
  assert.ok(connectionsAfterPaste.every((connection) => connection.label === '复制的关系'));
  assert.ok(connectionsAfterPaste.every((connection) => connection.labelWidth === 304));
  assert.ok(connectionsAfterPaste.every((connection) => connection.labelHeight === 88));
  assert.equal(
    connectionsAfterPaste.find((connection) => connection.id !== sourceConnection.id)?.revision,
    1,
  );
  assert.equal(groupsAfterPaste.length, 2);
  const originalIds = new Set([first.id, second.id]);
  const pastedGroup = groupsAfterPaste.find((group) => group.memberIds.every((id) => !originalIds.has(id)));
  assert.ok(pastedGroup);
  assert.ok(pastedGroup.memberIds.every((id) => !originalIds.has(id)));
  assert.ok(connectionsAfterPaste.some(
    (connection) =>
      pastedGroup.memberIds.includes(connection.from.nodeId) &&
      pastedGroup.memberIds.includes(connection.to.nodeId),
  ));
  assert.equal(harness.history.getState().undoCount, historyBeforePaste + 1);

  await harness.transactions.undo();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    (await harness.capabilities.request<unknown[]>('content.summaries@1')).length,
    initialNodeCount + 2,
  );
  assert.equal((await harness.capabilities.request<unknown[]>('connections.list@1')).length, 1);
  assert.equal((await harness.capabilities.request<unknown[]>('groups.list@1')).length, 1);
});

test('cut stores clipboard data first and then deletes through the normal selection transaction', async () => {
  const harness = createHarness();
  const selectionPlugin = createSelectionPlugin();
  const clipboardPlugin = createClipboardPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(selectionPlugin);
  harness.plugins.register(clipboardPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('clipboard');

  const node = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '待剪切', body: '应当可恢复' },
    'core.test',
  );
  await harness.router.dispatch('selection.set', { ids: [node.id], mode: 'replace' }, 'core.test');
  const historyBeforeCut = harness.history.getState().undoCount;
  await harness.router.dispatch('clipboard.cut', undefined, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1'))
      .some((item) => item.id === node.id),
    false,
  );
  assert.equal(harness.history.getState().undoCount, historyBeforeCut + 1);
  assert.equal(
    (await harness.capabilities.request<{ hasContent: boolean }>('clipboard.state@1')).hasContent,
    true,
  );

  await harness.transactions.undo();
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1'))
      .some((item) => item.id === node.id),
    true,
  );
});

test('literal search finds a case-insensitive match split across content chunks', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const chunkSize = 64 * 1024;
  const body = `${'x'.repeat(chunkSize - 3)}AbCdE tail`;
  const node = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '跨块正文', body },
    'core.test',
  );

  const result = await harness.capabilities.request<{
    hits: Array<{ nodeId: string; start: number; matchedText: string; revision: number }>;
    truncated: boolean;
  }>('content.search@1', {
    query: 'abcde',
    nodeIds: [node.id],
    matchCase: false,
    wholeWord: false,
    maxResults: 20,
  });
  assert.equal(result.truncated, false);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].start, chunkSize - 3);
  assert.equal(result.hits[0].matchedText, 'AbCdE');
});

test('legacy inline text chunks migrate through a broadcast command without entering document history', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const nodeId = 'node:legacy-storage';
  const contentId = 'content:legacy-storage';
  await harness.transactions.replaceDocument({
    revision: 1,
    namespaces: {
      textNode: {
        [nodeId]: {
          id: nodeId,
          contentId,
          title: '旧正文',
          x: 0,
          y: 0,
          width: 280,
          titleColor: '#202124',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      textContent: {
        [contentId]: { id: contentId, chunks: ['旧格式', '仍可恢复'], length: 9, revision: 3 },
      },
    },
  }, { undo: [], redo: [] }, testEnvelope('legacy-open'));
  const migrated = await waitFor(async () => {
    const content = harness.store.readValue<Record<string, unknown>>('document', 'textContent', contentId);
    return content?.storageVersion === 2 ? content : undefined;
  });
  assert.equal('chunks' in migrated, false);
  assert.ok(harness.store.countNamespace('document', 'textContentChunk') > 0);
  assert.equal(harness.history.getState().undoCount, 0);
  const body = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId,
    start: 0,
    length: 20,
  });
  assert.equal(body.text, '旧格式仍可恢复');
});

test('twenty-million-character text stays independently chunked, locally undoable and file-roundtrippable', { timeout: 20_000 }, async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const body = '0123456789'.repeat(2_000_000);
  const createStarted = performance.now();
  const node = await harness.router.dispatch<{ id: string }>(
    'node.seed',
    { title: '两千万字符基准', body },
    'core.test',
  );
  const createMs = performance.now() - createStarted;
  assert.ok(createMs < 5_000, `20M create took ${createMs.toFixed(1)}ms`);
  const storage = await harness.capabilities.request<{
    revision: number;
    length: number;
    storageVersion: number;
    chunkSize: number;
    chunkCount: number;
    largestChunk: number;
  }>('content.storageInfo@1', { nodeId: node.id });
  assert.equal(storage.length, 20_000_000);
  assert.equal(storage.storageVersion, 2);
  assert.equal(storage.chunkSize, 64 * 1024);
  assert.ok(storage.chunkCount >= 305 && storage.chunkCount <= 306);
  assert.ok(storage.largestChunk <= storage.chunkSize);

  const editAt = 10_000_003;
  const editStarted = performance.now();
  await harness.router.dispatch(
    'content.applyDelta',
    { nodeId: node.id, start: editAt, deleteCount: 1, insert: 'Z', expectedRevision: storage.revision },
    'core.test',
  );
  const editMs = performance.now() - editStarted;
  assert.ok(editMs < 1_000, `20M local edit took ${editMs.toFixed(1)}ms`);
  const historyEntry = harness.history.export().undo.at(-1)!;
  const chunkPatches = historyEntry.forward.filter((patch) => patch.namespace === 'textContentChunk');
  assert.equal(chunkPatches.length, 2);
  assert.ok(JSON.stringify(historyEntry.forward).length < 200_000);
  const changed = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: node.id,
    start: editAt - 3,
    length: 7,
  });
  assert.equal(changed.text, `${body.slice(editAt - 3, editAt)}Z${body.slice(editAt + 1, editAt + 4)}`);
  await harness.transactions.undo();
  assert.equal(
    (await harness.capabilities.request<{ text: string }>('content.read@1', {
      nodeId: node.id,
      start: editAt - 3,
      length: 7,
    })).text,
    body.slice(editAt - 3, editAt + 4),
  );
  await harness.transactions.redo();

  const saveStarted = performance.now();
  const snapshot = harness.store.snapshot();
  const blob = await serializeProject({
    document: snapshot.document,
    history: harness.history.export(),
    plugins: harness.plugins.projectCatalog(),
  });
  const saveMs = performance.now() - saveStarted;
  assert.ok(saveMs < 5_000, `20M save took ${saveMs.toFixed(1)}ms`);
  const openStarted = performance.now();
  const parsed = await parseProject(blob);
  const openMs = performance.now() - openStarted;
  assert.ok(openMs < 5_000, `20M open took ${openMs.toFixed(1)}ms`);

  const restored = createHarness();
  restored.plugins.register(textNodePlugin);
  await restored.plugins.start('text-node');
  await restored.transactions.replaceDocument(parsed.document, parsed.history, testEnvelope('huge-open'));
  const restoredRange = await restored.capabilities.request<{ text: string; totalLength: number }>('content.read@1', {
    nodeId: node.id,
    start: editAt - 3,
    length: 7,
  });
  assert.equal(restoredRange.totalLength, 20_000_000);
  assert.equal(restoredRange.text, changed.text);
  assert.equal(
    (await restored.capabilities.request<{ text: string }>('content.read@1', {
      nodeId: node.id,
      start: 19_999_968,
      length: 32,
    })).text,
    body.slice(-32),
  );
});

test('canvas-wide search scans two thousand ordinary nodes without materializing a combined corpus', { timeout: 10_000 }, async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const initialNodeCount = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1')).length;
  for (let index = 0; index < 2000; index += 1) {
    await harness.router.dispatch(
      'node.create',
      { title: `负载节点 ${index}`, body: index % 100 === 0 ? `load-marker ${index}` : `ordinary ${index}` },
      'core.test',
    );
  }
  const result = await harness.capabilities.request<{
    hits: unknown[];
    scannedNodes: number;
    truncated: boolean;
  }>('content.search@1', {
    query: 'load-marker',
    matchCase: true,
    wholeWord: false,
    maxResults: 100,
  });
  assert.equal(result.scannedNodes, initialNodeCount + 2000);
  assert.equal(result.hits.length, 20);
  assert.equal(result.truncated, false);

  const aiRetrieval = await harness.capabilities.request<{
    hits: unknown[];
    scanned: number;
  }>('context.search@1', { terms: ['load-marker'], maxResults: 50 });
  assert.equal(aiRetrieval.scanned, 2000);
  assert.equal(aiRetrieval.hits.length, 20);
});

test('viewport culling keeps two thousand canvas entities out of the DOM-sized working set', () => {
  const entities: WorldBounds[] = Array.from({ length: 2000 }, (_, index) => ({
    x: (index % 50) * 420,
    y: Math.floor(index / 50) * 260,
    width: 320,
    height: 158,
  }));
  let largestVisibleSet = 0;
  const started = performance.now();
  for (let frame = 0; frame < 600; frame += 1) {
    const camera = {
      x: -((frame * 137) % 16_000),
      y: -((frame * 83) % 8_000),
      zoom: 0.65 + (frame % 8) * 0.1,
    };
    const viewport = worldViewport(camera, { width: 1440, height: 900 }, 360);
    const visible = entities.filter((bounds) => boundsIntersect(viewport, bounds));
    largestVisibleSet = Math.max(largestVisibleSet, visible.length);
  }
  const elapsed = performance.now() - started;
  assert.ok(largestVisibleSet < 100, `culling left ${largestVisibleSet} entities in the visible set`);
  assert.ok(elapsed < 1_000, `600 culling frames took ${elapsed.toFixed(1)}ms`);
});

test('canvas node detail drops body previews below the distant zoom threshold', () => {
  assert.equal(canvasNodeDetail(NODE_PREVIEW_MIN_ZOOM - 0.01), 'title-only');
  assert.equal(canvasNodeDetail(NODE_PREVIEW_MIN_ZOOM), 'preview');
  assert.equal(canvasNodeDetail(1), 'preview');
});

test('canvas zoom clamps every entry path to the 40–240 percent range', () => {
  assert.equal(MIN_ZOOM, 0.4);
  assert.equal(MAX_ZOOM, 2.4);
  assert.equal(clampCanvasZoom(0.05), MIN_ZOOM);
  assert.equal(clampCanvasZoom(1.25), 1.25);
  assert.equal(clampCanvasZoom(9), MAX_ZOOM);
});

test('long titles keep only their beginning and mark omitted trailing characters', () => {
  const title = '这是一个需要保留开头并且同时保留结尾的超长标题';
  const compact = endEllipsis(title, 9);
  assert.equal(compact, '这是一个需要保留…');
  assert.equal(compact.startsWith(title.slice(0, 8)), true);
  assert.equal(compact.endsWith(title.slice(-4)), false);
});

test('interaction-frame capabilities stay synchronous and reject async providers', () => {
  const capabilities = new CapabilityRegistry();
  capabilities.register('sync-owner', { key: 'layout.sync-test@1', invoke: () => 42 });
  capabilities.register('async-owner', { key: 'layout.async-test@1', invoke: async () => 42 });
  assert.equal(capabilities.requestSync<number>('layout.sync-test@1'), 42);
  assert.throws(
    () => capabilities.requestSync('layout.async-test@1'),
    /asynchronous and cannot run in an interaction frame/,
  );
});

test('smart guides strongly snap node edges, centres and repeated spacing in world coordinates', () => {
  const aligned = snapDraggedBounds(
    { x: 492, y: 100, width: 100, height: 80 },
    [{ id: 'reference', x: 500, y: 0, width: 100, height: 80 }],
    18,
  );
  assert.equal(aligned.offsetX, 8);
  assert.equal(aligned.offsetY, 0);
  assert.equal(aligned.guides.some((guide) => guide.orientation === 'vertical' && guide.kind === 'edge'), true);

  const spaced = snapDraggedBounds(
    { x: 282, y: 0, width: 100, height: 80 },
    [
      { id: 'left', x: 0, y: 0, width: 100, height: 80 },
      { id: 'middle', x: 140, y: 0, width: 100, height: 80 },
    ],
    18,
  );
  assert.equal(spaced.offsetX, -2);
  assert.equal(spaced.guides.filter((guide) => guide.kind === 'spacing').length, 2);
});

test('resize smart guides snap only the moving frame edges and return edge guides', () => {
  const snapped = snapResizedBounds(
    { x: 100, y: 100, width: 292, height: 152 },
    [{ id: 'reference', x: 400, y: 180, width: 120, height: 80 }],
    18,
  );
  assert.equal(snapped.width, 300);
  assert.equal(snapped.height, 160);
  assert.deepEqual(
    snapped.guides.map((guide) => [guide.orientation, guide.position, guide.kind]),
    [['vertical', 400, 'edge'], ['horizontal', 260, 'edge']],
  );
});

test('smart-layout hot toggle snaps against a whole group frame and releases its operations', async () => {
  const harness = createHarness();
  const groups = createGroupsPlugin();
  const smartLayout = createSmartLayoutPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(groups);
  harness.plugins.register(smartLayout);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('groups');
  const first = await harness.router.dispatch<{ id: string }>(
    'node.create', { title: '组内左', x: 0, y: 0 }, 'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create', { title: '组内右', x: 320, y: 0 }, 'core.test',
  );
  await harness.router.dispatch('selection.set', { ids: [first.id, second.id], mode: 'replace' }, 'core.test');
  await harness.router.dispatch('group.create', {}, 'core.test');
  await harness.plugins.start('smart-layout');
  assert.equal(harness.capabilities.has('layout.resizeSnap@1'), true);

  const snapped = harness.capabilities.requestSync<{
    offsetX: number;
    guides: Array<{ position: number; kind: string }>;
  }>('layout.snap@1', {
    dragged: { x: 633, y: 0, width: 100, height: 100 },
    movingIds: ['moving-group'],
    mode: 'group',
    threshold: 18,
  });
  assert.equal(snapped.offsetX, -8);
  assert.equal(snapped.guides.some((guide) => guide.position === 625 && guide.kind === 'edge'), true);
  assert.equal(harness.router.isCommandAvailable('node.arrangeSelectedGrid'), true);
  assert.deepEqual(
    harness.ui.list('top.primary').filter((item) =>
      item.group === 'appearance' && item.owner === 'smart-layout').map((item) => item.id),
    ['smart-layout.arrange-grid'],
  );

  await harness.plugins.stop('smart-layout');
  assert.equal(harness.capabilities.has('layout.snap@1'), false);
  assert.equal(harness.capabilities.has('layout.resizeSnap@1'), false);
  assert.equal(harness.router.isCommandAvailable('node.arrangeSelectedGrid'), false);
  assert.equal(harness.ui.list('top.primary').some((item) => item.id === 'smart-layout.arrange-grid'), false);
});

test('search result rows are unique and put active and open editor nodes first', () => {
  const hit = (nodeId: string, title: string, start: number) => ({
    nodeId,
    title,
    start,
    length: 2,
    matchedText: '目标',
    preview: `${title} 目标`,
    revision: 1,
  });
  const rows = groupHitsByNode([
    hit('closed-a', '关闭 A', 2),
    hit('open-b', '打开 B', 4),
    hit('active-c', '活动 C', 6),
    hit('closed-a', '关闭 A', 12),
    hit('open-d', '打开 D', 8),
  ], {
    openPanes: ['open-d', 'active-c', 'open-b'],
    activePane: 'active-c',
  });
  assert.deepEqual(rows.map((row) => row.nodeId), ['active-c', 'open-d', 'open-b', 'closed-a']);
  assert.equal(rows.find((row) => row.nodeId === 'closed-a')?.hits.length, 2);
});

test('search navigation stays inside the active editor and wraps in document order', () => {
  const hit = (nodeId: string, start: number): SearchHit => ({
    nodeId,
    title: nodeId,
    start,
    length: 2,
    matchedText: '目标',
    preview: '目标',
    revision: 1,
  });
  const hits = [hit('active', 12), hit('closed', 1), hit('active', 2), hit('active', 7)];
  const first = resolveSearchNavigation(hits, 'active', undefined, 1);
  assert.deepEqual(first, {
    hit: hits[2],
    state: { nodeId: 'active', index: 0, total: 3 },
  });
  const second = resolveSearchNavigation(hits, 'active', first?.state, 1);
  assert.equal(second?.hit.start, 7);
  const wrappedPrevious = resolveSearchNavigation(hits, 'active', first?.state, -1);
  assert.equal(wrappedPrevious?.hit.start, 12);
  assert.equal(resolveSearchNavigation(hits, 'missing', undefined, 1), undefined);
});

test('search query previews debounce through the task scheduler and only run the latest query', async () => {
  const harness = createHarness();
  const searchPlugin = createSearchReplacePlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(searchPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('search-replace');
  await harness.router.dispatch(
    'node.create',
    { title: '自动查找', body: 'first-query second-query' },
    'core.test',
  );

  const results: SearchResult[] = [];
  const latestResult = new Promise<SearchResult>((resolve) => {
    harness.router.subscribeSignal('core.test', 'search.results', (message) => {
      const result = message.payload as SearchResult;
      results.push(result);
      if (result.query === 'second-query') resolve(result);
    });
  });
  harness.router.emitSignal('search.query.preview', {
    query: 'first-query',
    matchCase: true,
    wholeWord: false,
    composing: false,
  }, 'core.test');
  harness.router.emitSignal('search.query.preview', {
    query: 'second-query',
    matchCase: true,
    wholeWord: false,
    composing: false,
  }, 'core.test');

  const result = await latestResult;
  assert.equal(result.query, 'second-query');
  assert.equal(result.hits.length, 1);
  assert.deepEqual(results.map((item) => item.query), ['second-query']);
});

test('replace changes one selected editor hit or every hit in selected result nodes, then searches again', async () => {
  const harness = createHarness();
  const editorPlugin = createEditorPlugin();
  const searchPlugin = createSearchReplacePlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(editorPlugin);
  harness.plugins.register(searchPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  await harness.plugins.start('search-replace');

  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '活动节点', body: 'current-token middle current-token select-token' },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '列表节点', body: 'current-token select-token' },
    'core.test',
  );
  await harness.router.dispatch('editor.open', { id: first.id }, 'core.test');
  const context = await harness.capabilities.request<{ openPanes: string[]; activePane?: string }>('editor.context@1');
  assert.deepEqual(context, { openPanes: [first.id], activePane: first.id });

  const waitForSearch = (query: string) => new Promise<SearchResult>((resolve) => {
    const unsubscribe = harness.router.subscribeSignal('core.test', 'search.results', (message) => {
      const result = message.payload as SearchResult;
      if (result.query !== query) return;
      unsubscribe();
      resolve(result);
    });
  });
  let refreshed = waitForSearch('current-token');
  await harness.router.dispatch('search.run', {
    query: 'current-token', scope: 'canvas', matchCase: true, wholeWord: false,
  }, 'core.test');
  const currentResult = await refreshed;
  const currentHits = { hits: currentResult.hits } as { hits: Array<{
    nodeId: string;
    title: string;
    start: number;
    length: number;
    matchedText: string;
    preview: string;
    revision: number;
  }> };
  const currentHit = currentHits.hits.find((hit) => hit.nodeId === first.id)!;
  const navigation = await Promise.race([
    harness.router.dispatch<SearchNavigationSignal>('search.next', undefined, 'core.test'),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('search.next blocked the serialized command queue')), 250);
      timer.unref?.();
    }),
  ]);
  assert.deepEqual(navigation, { nodeId: first.id, index: 0, total: 2 });
  const manualReveal = await waitFor(async () => {
    const state = await harness.router.ask<{
      revealRequest?: { id: string; start: number; end: number };
    }>('editor.state', undefined, 'core.test');
    return state.revealRequest?.id === first.id && state.revealRequest.start === currentHit.start
      ? state.revealRequest
      : undefined;
  });
  assert.equal(manualReveal.end, currentHit.start + currentHit.length);
  harness.router.emitSignal('editor.selection.preview', {
    id: first.id,
    start: currentHit.start,
    end: currentHit.start + currentHit.length,
  }, 'editor');
  refreshed = waitForSearch('current-token');
  await harness.router.dispatch('search.replaceTargets', {
    hits: currentHits.hits,
    selectedNodeIds: [],
    currentHit,
    replacement: 'CURRENT',
  }, 'core.test');
  const refreshedCurrent = await refreshed;
  assert.equal(refreshedCurrent.hits.filter((hit) => hit.nodeId === first.id).length, 1);
  const nextCurrentHit = refreshedCurrent.hits.find((hit) => hit.nodeId === first.id)!;
  const automaticReveal = await waitFor(async () => {
    const state = await harness.router.ask<{
      revealRequest?: { id: string; start: number; end: number; requestId: string };
    }>('editor.state', undefined, 'core.test');
    return state.revealRequest?.id === first.id && state.revealRequest.start === nextCurrentHit.start
      ? state.revealRequest
      : undefined;
  });
  assert.equal(automaticReveal.end, nextCurrentHit.start + nextCurrentHit.length);
  let firstBody = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: first.id, start: 0, length: 100,
  });
  let secondBody = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: second.id, start: 0, length: 100,
  });
  assert.equal(firstBody.text, 'CURRENT middle current-token select-token');
  assert.equal(secondBody.text, 'current-token select-token');

  let selectedRefresh = waitForSearch('select-token');
  await harness.router.dispatch('search.run', {
    query: 'select-token', scope: 'canvas', matchCase: true, wholeWord: false,
  }, 'core.test');
  const selectedHits = await selectedRefresh;
  selectedRefresh = waitForSearch('select-token');
  await harness.router.dispatch('search.replaceTargets', {
    hits: selectedHits.hits,
    selectedNodeIds: [second.id],
    replacement: 'SELECTED',
  }, 'core.test');
  const refreshedSelected = await selectedRefresh;
  assert.equal(refreshedSelected.hits.some((hit) => hit.nodeId === second.id), false);
  const afterBatchReplace = await harness.router.ask<{
    revealRequest?: { requestId: string };
  }>('editor.state', undefined, 'core.test');
  assert.equal(afterBatchReplace.revealRequest?.requestId, automaticReveal.requestId);
  firstBody = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: first.id, start: 0, length: 100,
  });
  secondBody = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: second.id, start: 0, length: 100,
  });
  assert.equal(firstBody.text, 'CURRENT middle current-token select-token');
  assert.equal(secondBody.text, 'current-token SELECTED');
});

test('global replace validates revisions and commits all matched nodes as one history entry', async () => {
  const harness = createHarness();
  const searchPlugin = createSearchReplacePlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(searchPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('search-replace');
  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '替换 A', body: 'unique-token and unique-token' },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '替换 B', body: 'prefix unique-token suffix' },
    'core.test',
  );
  const result = await harness.capabilities.request<{ hits: Array<{
    nodeId: string;
    title: string;
    start: number;
    length: number;
    matchedText: string;
    preview: string;
    revision: number;
  }> }>('content.search@1', {
    query: 'unique-token',
    nodeIds: [first.id, second.id],
    matchCase: true,
    wholeWord: false,
    maxResults: 20,
  });
  assert.equal(result.hits.length, 3);
  const historyBefore = harness.history.getState().undoCount;

  await harness.router.dispatch(
    'search.replace',
    { hits: result.hits, replacement: '替换完成' },
    'core.test',
  );
  assert.equal(harness.history.getState().undoCount, historyBefore + 1);
  const firstBody = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: first.id,
    start: 0,
    length: 100,
  });
  const secondBody = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: second.id,
    start: 0,
    length: 100,
  });
  assert.equal(firstBody.text, '替换完成 and 替换完成');
  assert.equal(secondBody.text, 'prefix 替换完成 suffix');

  await harness.transactions.undo();
  const restored = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: first.id,
    start: 0,
    length: 100,
  });
  assert.equal(restored.text, 'unique-token and unique-token');
});

test('replace rejects stale search hits without partially changing any node', async () => {
  const harness = createHarness();
  const searchPlugin = createSearchReplacePlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(searchPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('search-replace');
  const node = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '陈旧检查', body: 'before stale-target after' },
    'core.test',
  );
  const result = await harness.capabilities.request<{ hits: Array<{
    nodeId: string;
    title: string;
    start: number;
    length: number;
    matchedText: string;
    preview: string;
    revision: number;
  }> }>('content.search@1', {
    query: 'stale-target',
    nodeIds: [node.id],
    matchCase: true,
    wholeWord: false,
    maxResults: 20,
  });
  await harness.router.dispatch(
    'content.applyDelta',
    { nodeId: node.id, start: 0, deleteCount: 0, insert: 'new ' },
    'core.test',
  );
  const historyBefore = harness.history.getState().undoCount;

  await assert.rejects(
    () => harness.router.dispatch('search.replace', { hits: result.hits, replacement: 'changed' }, 'core.test'),
    /已修改，请重新查找/,
  );
  assert.equal(harness.history.getState().undoCount, historyBefore);
  const body = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: node.id,
    start: 0,
    length: 100,
  });
  assert.equal(body.text, 'new before stale-target after');
});

test('statistics distinguish graphemes, non-whitespace characters and words', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const before = await harness.capabilities.request<{
    nodeCount: number;
    graphemes: number;
    nonWhitespaceGraphemes: number;
    words: number;
    lines: number;
  }>('content.statistics@1');
  const sample = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '统计样本', body: '你好 world 👨‍👩‍👧‍👦\nA' },
    'core.test',
  );
  const after = await harness.capabilities.request<typeof before>('content.statistics@1');
  assert.equal(after.nodeCount - before.nodeCount, 1);
  assert.equal(after.graphemes - before.graphemes, 12);
  assert.equal(after.nonWhitespaceGraphemes - before.nonWhitespaceGraphemes, 9);
  assert.equal(after.words - before.words, 3);
  assert.equal(after.lines - before.lines, 2);

  const bounded = await harness.capabilities.request<{
    nodeCount: number;
    utf16Units: number;
    graphemes: number;
    nonWhitespaceGraphemes: number;
    byNode: Record<string, {
      nodeId: string;
      utf16Units: number;
      graphemes: number;
      nonWhitespaceGraphemes: number;
    }>;
  }>('content.metrics@2', { nodeIds: [sample.id] });
  assert.equal(bounded.nodeCount, 1);
  assert.equal(bounded.utf16Units, '你好 world 👨‍👩‍👧‍👦\nA'.length);
  assert.equal(bounded.graphemes, 12);
  assert.equal(bounded.nonWhitespaceGraphemes, 9);
  assert.equal(bounded.byNode[sample.id]?.nonWhitespaceGraphemes, 9);

  const writingMetrics = await harness.capabilities.request<{
    writingUnits: number;
    byNode: Record<string, { writingUnits: number }>;
  }>('content.metrics@3', { nodeIds: [sample.id] });
  assert.equal(writingMetrics.writingUnits, 4);
  assert.equal(writingMetrics.byNode[sample.id]?.writingUnits, 4);
});

test('statistics plugin recomputes module counts through cancellable background tasks', async () => {
  const harness = createHarness();
  const selectionPlugin = createSelectionPlugin();
  const connectionsPlugin = createConnectionsPlugin();
  const groupsPlugin = createGroupsPlugin();
  const statisticsPlugin = createStatisticsPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(selectionPlugin);
  harness.plugins.register(connectionsPlugin);
  harness.plugins.register(groupsPlugin);
  harness.plugins.register(statisticsPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');
  await harness.plugins.start('groups');
  await harness.plugins.start('statistics');
  const initialNodeCount = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1')).length;
  const first = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '统计 A', body: '你 好' },
    'core.test',
  );
  const second = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '统计 B', body: '👨‍👩‍👧‍👦\nA' },
    'core.test',
  );
  await harness.router.dispatch(
    'connection.create',
    { from: { nodeId: first.id, side: 'right' }, to: { nodeId: second.id, side: 'left' } },
    'core.test',
  );
  await harness.router.dispatch(
    'selection.set',
    { ids: [first.id, second.id], mode: 'replace' },
    'core.test',
  );
  await harness.router.dispatch('group.create', {}, 'core.test');

  const snapshot = await waitFor(async () => {
    const current = await harness.capabilities.request<{
      status: string;
      modules: Array<{ kind: string; count: number }>;
    }>('statistics.current@1');
    return current.status === 'ready' ? current : undefined;
  });
  assert.equal(snapshot.modules.find((item) => item.kind === 'text-nodes')?.count, initialNodeCount + 2);
  assert.equal(snapshot.modules.find((item) => item.kind === 'connections')?.count, 1);
  assert.equal(snapshot.modules.find((item) => item.kind === 'groups')?.count, 1);

  const selected = await harness.capabilities.request<{
    nodeCount: number;
    utf16Units: number;
    graphemes: number;
    nonWhitespaceGraphemes: number;
  }>('statistics.selected@1');
  assert.equal(selected.nodeCount, 2);
  assert.equal(selected.utf16Units, '你 好'.length + '👨‍👩‍👧‍👦\nA'.length);
  assert.equal(selected.graphemes, 6);
  assert.equal(selected.nonWhitespaceGraphemes, 4);
});

test('document formatting is text-owned, revision checked, undoable and copied with the node', async () => {
  const harness = createHarness();
  const selectionPlugin = createSelectionPlugin();
  const clipboardPlugin = createClipboardPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(selectionPlugin);
  harness.plugins.register(clipboardPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('clipboard');
  const node = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '格式节点', body: '第一段\n第二段' },
    'core.test',
  );
  const initial = await harness.capabilities.request<{
    revision: number;
    format: { fontSize: number; fontWeight: number; firstLineIndent: number; paragraphSpacing: number };
  }>('content.formatting@1', { nodeId: node.id });
  const historyBefore = harness.history.getState().undoCount;
  await harness.router.dispatch(
    'content.setDocumentFormat',
    {
      nodeId: node.id,
      expectedRevision: initial.revision,
      patch: { fontSize: 20, fontWeight: 700, firstLineIndent: 2, paragraphSpacing: 1 },
    },
    'core.test',
  );
  assert.equal(harness.history.getState().undoCount, historyBefore + 1);
  const formatted = await harness.capabilities.request<typeof initial>('content.formatting@1', { nodeId: node.id });
  assert.deepEqual(
    {
      fontSize: formatted.format.fontSize,
      fontWeight: formatted.format.fontWeight,
      firstLineIndent: formatted.format.firstLineIndent,
      paragraphSpacing: formatted.format.paragraphSpacing,
    },
    { fontSize: 20, fontWeight: 700, firstLineIndent: 2, paragraphSpacing: 1 },
  );
  await assert.rejects(
    () => harness.router.dispatch(
      'content.setDocumentFormat',
      { nodeId: node.id, expectedRevision: initial.revision, patch: { fontSize: 18 } },
      'core.test',
    ),
    /格式版本已变化/,
  );

  await harness.router.dispatch('selection.set', { ids: [node.id], mode: 'replace' }, 'core.test');
  await harness.router.dispatch('clipboard.copy', undefined, 'core.test');
  await harness.router.dispatch('clipboard.paste', undefined, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const nodes = await harness.capabilities.request<Array<{ id: string; title: string }>>('content.summaries@1');
  const pasted = nodes.find((item) => item.title === '格式节点 2' && item.id !== node.id);
  assert.ok(pasted);
  const pastedFormat = await harness.capabilities.request<typeof initial>('content.formatting@1', { nodeId: pasted.id });
  assert.equal(pastedFormat.format.fontSize, 20);
  assert.equal(pastedFormat.format.fontWeight, 700);

  await harness.transactions.undo();
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1'))
      .some((item) => item.id === pasted.id),
    false,
  );
  await harness.transactions.undo();
  const restoredFormat = await harness.capabilities.request<typeof initial>('content.formatting@1', { nodeId: node.id });
  assert.equal(restoredFormat.format.fontSize, initial.format.fontSize);
  assert.equal(restoredFormat.format.fontWeight, initial.format.fontWeight);
});

test('range formatting uses stable biased anchors, follows edits, survives copy and shares global undo', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createClipboardPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('clipboard');
  const node = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '区间格式', body: 'abcdef' },
    'core.test',
  );
  const initial = await harness.capabilities.request<{
    revision: number;
    contentRevision: number;
    marks: Array<{ id: string; start: { offset: number }; end: { offset: number }; format: { fontWeight?: number } }>;
  }>('content.formatting@2', { nodeId: node.id });
  await harness.router.dispatch('content.setRangeFormat', {
    nodeId: node.id,
    expectedRevision: initial.revision,
    expectedContentRevision: initial.contentRevision,
    start: 1,
    end: 4,
    scope: 'selection',
    patch: { fontWeight: 700 },
  }, 'core.test');
  const marked = await harness.capabilities.request<typeof initial>('content.formatting@2', { nodeId: node.id });
  assert.equal(marked.marks.length, 1);
  assert.deepEqual([marked.marks[0].start.offset, marked.marks[0].end.offset], [1, 4]);

  await harness.router.dispatch('content.applyDelta', {
    nodeId: node.id,
    expectedRevision: marked.contentRevision,
    start: 2,
    deleteCount: 0,
    insert: 'ZZ',
    typingSessionId: 'stable-anchor-test',
  }, 'core.test');
  const shifted = await harness.capabilities.request<typeof initial>('content.formatting@2', { nodeId: node.id });
  assert.deepEqual([shifted.marks[0].start.offset, shifted.marks[0].end.offset], [1, 6]);

  await harness.transactions.undo();
  const restored = await harness.capabilities.request<typeof initial>('content.formatting@2', { nodeId: node.id });
  assert.deepEqual([restored.marks[0].start.offset, restored.marks[0].end.offset], [1, 4]);
  const restoredBody = await harness.capabilities.request<{ text: string; totalLength: number }>(
    'content.read@1',
    { nodeId: node.id, start: 0, length: 100 },
  );
  assert.deepEqual(restoredBody, { nodeId: node.id, start: 0, text: 'abcdef', totalLength: 6, revision: 1 });

  await harness.router.dispatch('selection.set', { ids: [node.id], mode: 'replace' }, 'core.test');
  await harness.router.dispatch('clipboard.copy', undefined, 'core.test');
  await harness.router.dispatch('clipboard.paste', undefined, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const nodes = await harness.capabilities.request<Array<{ id: string; title: string }>>('content.summaries@1');
  const pasted = nodes.find((item) => item.id !== node.id && item.title === '区间格式 2');
  assert.ok(pasted);
  const pastedFormatting = await harness.capabilities.request<typeof initial>(
    'content.formatting@2',
    { nodeId: pasted.id },
  );
  assert.ok(pastedFormatting.marks[0], JSON.stringify(pastedFormatting));
  assert.equal(pastedFormatting.marks[0].format.fontWeight, 700);
  assert.deepEqual(
    [pastedFormatting.marks[0].start.offset, pastedFormatting.marks[0].end.offset],
    [1, 4],
  );
});

test('dropped text inherits the cursor format in the same content transaction', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const node = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '拖入继承格式', body: 'abcdef' },
    'core.test',
  );
  const initial = await harness.capabilities.request<{
    revision: number;
    contentRevision: number;
  }>('content.formatting@2', { nodeId: node.id });
  await harness.router.dispatch('content.setRangeFormat', {
    nodeId: node.id,
    expectedRevision: initial.revision,
    expectedContentRevision: initial.contentRevision,
    start: 1,
    end: 4,
    scope: 'selection',
    patch: { fontSize: 20, fontWeight: 700 },
  }, 'core.test');
  const beforeDrop = await harness.capabilities.request<{
    contentRevision: number;
  }>('content.formatting@2', { nodeId: node.id });
  const historyBefore = harness.history.getState().undoCount;
  const result = await harness.router.dispatch<{ revision: number; formatRevision?: number }>(
    'content.applyDelta',
    {
      nodeId: node.id,
      expectedRevision: beforeDrop.contentRevision,
      start: 2,
      deleteCount: 0,
      insert: 'ZZ',
      typingSessionId: 'drop-format-test',
      inheritFormat: { ...DEFAULT_TEXT_DOCUMENT_FORMAT, fontSize: 20, fontWeight: 700 },
    },
    'core.test',
  );
  assert.ok(result.formatRevision !== undefined);
  assert.equal(harness.history.getState().undoCount, historyBefore + 1);
  const formatted = await harness.capabilities.request<{
    marks: Array<{ start: { offset: number }; end: { offset: number }; format: { fontSize?: number; fontWeight?: number } }>;
  }>('content.formatting@2', { nodeId: node.id });
  const inherited = formatted.marks.find((mark) => mark.start.offset === 2 && mark.end.offset === 4);
  assert.deepEqual(inherited?.format, { fontSize: 20, fontWeight: 700 });
  const body = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: node.id,
    start: 0,
    length: 20,
  });
  assert.equal(body.text, 'abZZcdef');

  await harness.transactions.undo();
  const restoredBody = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: node.id,
    start: 0,
    length: 20,
  });
  assert.equal(restoredBody.text, 'abcdef');
  const restoredFormat = await harness.capabilities.request<typeof formatted>('content.formatting@2', { nodeId: node.id });
  assert.equal(restoredFormat.marks.some((mark) => mark.start.offset === 2 && mark.end.offset === 4), false);
});

test('moving an editor text range is one undoable content transaction that carries formatting and anchors', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createAnnotationsPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('annotations');
  const node = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '拖拽移动正文',
    body: 'abcdef',
  }, 'core.test');
  const initial = await harness.capabilities.request<{
    revision: number;
    contentRevision: number;
  }>('content.formatting@2', { nodeId: node.id });
  await harness.router.dispatch('content.setRangeFormat', {
    nodeId: node.id,
    expectedRevision: initial.revision,
    expectedContentRevision: initial.contentRevision,
    start: 1,
    end: 3,
    scope: 'selection',
    patch: { fontWeight: 700 },
  }, 'core.test');
  const annotation = await harness.router.dispatch<{ id: string }>('annotation.create', {
    target: { kind: 'text-range', targetId: node.id, offset: 2 },
    body: '跟随所选文字',
  }, 'core.test');
  const beforeMove = await harness.capabilities.request<{ contentRevision: number }>(
    'content.formatting@2',
    { nodeId: node.id },
  );
  const historyBefore = harness.history.getState().undoCount;

  await harness.router.dispatch('content.moveRange', {
    nodeId: node.id,
    start: 1,
    end: 3,
    target: 6,
    expectedRevision: beforeMove.contentRevision,
  }, 'core.test');

  assert.equal(harness.history.getState().undoCount, historyBefore + 1);
  assert.equal((await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: node.id, start: 0, length: 20,
  })).text, 'adefbc');
  const movedFormat = await harness.capabilities.request<{
    marks: Array<{ start: { offset: number }; end: { offset: number }; format: { fontWeight?: number } }>;
  }>('content.formatting@2', { nodeId: node.id });
  assert.ok(movedFormat.marks.some((mark) =>
    mark.start.offset === 4 && mark.end.offset === 6 && mark.format.fontWeight === 700));
  const movedAnnotations = await harness.capabilities.request<Array<{
    id: string;
    target: { offset?: number };
  }>>('annotations.list@1');
  assert.equal(movedAnnotations.find((item) => item.id === annotation.id)?.target.offset, 5);

  await harness.transactions.undo();
  assert.equal((await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: node.id, start: 0, length: 20,
  })).text, 'abcdef');
  const restoredAnnotations = await harness.capabilities.request<typeof movedAnnotations>('annotations.list@1');
  assert.equal(restoredAnnotations.find((item) => item.id === annotation.id)?.target.offset, 2);
});

test('editor format scope uses selection when present and otherwise updates document defaults', () => {
  const document = {
    length: 7,
    body: '甲乙丙\n丁戊己',
    windowStart: 0,
    format: { ...DEFAULT_TEXT_DOCUMENT_FORMAT },
    marks: [
      {
        id: 'paragraph-mark',
        nodeId: 'node',
        scope: 'paragraph' as const,
        start: { offset: 0, bias: 'after' as const },
        end: { offset: 4, bias: 'before' as const },
        format: { fontSize: 20 },
        revision: 1,
      },
      {
        id: 'selection-mark',
        nodeId: 'node',
        scope: 'selection' as const,
        start: { offset: 0, bias: 'after' as const },
        end: { offset: 2, bias: 'before' as const },
        format: { fontWeight: 700 },
        revision: 1,
      },
    ],
  };
  assert.equal(inferFormatTarget(document, { start: 1, end: 1 }), 'document');
  assert.equal(inferFormatTarget(document, { start: 1, end: 3 }), 'selection');
  assert.equal(inferFormatTarget(document, { start: 0, end: 7 }), 'document');
  assert.deepEqual(resolveFormatRange(document, 'paragraph', { start: 1, end: 1 }), { start: 0, end: 4 });
  const effective = resolveActiveFormat(document, { start: 1, end: 1 });
  assert.equal(effective.fontSize, DEFAULT_TEXT_DOCUMENT_FORMAT.fontSize);
  assert.equal(effective.fontWeight, DEFAULT_TEXT_DOCUMENT_FORMAT.fontWeight);
  assert.equal(resolveActiveFormat(document, { start: 3, end: 3 }).fontWeight, DEFAULT_TEXT_DOCUMENT_FORMAT.fontWeight);
  assert.equal(resolveActiveFormat(document, { start: 0, end: 7 }).fontSize, DEFAULT_TEXT_DOCUMENT_FORMAT.fontSize);
  assert.deepEqual(resolveFormatBrushRange(document, { start: 1, end: 3 }), { start: 1, end: 3 });
  const clickedWord = resolveFormatBrushRange(document, { start: 1, end: 1 });
  assert.ok(clickedWord && clickedWord.start <= 1 && clickedWord.end > 1);
});

test('text color preview targets the exact selection and never mutates the document default', () => {
  const document = {
    id: 'node-preview',
    revision: 7,
    formatRevision: 3,
    format: { ...DEFAULT_TEXT_DOCUMENT_FORMAT, color: '#111111' },
    marks: [],
  };
  const selected = applyTextColorPreview(document, {
    kind: 'text-color',
    color: '#ef4444',
    entityIds: [document.id],
    textRange: { start: 4, end: 11, scope: 'selection', contentRevision: 7 },
  });
  assert.equal(selected.format.color, '#111111');
  assert.deepEqual(selected.marks.at(-1), {
    id: 'preview:text-color:node-preview',
    nodeId: document.id,
    scope: 'selection',
    start: { offset: 4, bias: 'after' },
    end: { offset: 11, bias: 'before' },
    format: { color: '#ef4444' },
    revision: 3,
  });
  assert.equal(document.marks.length, 0);
  assert.equal(applyTextColorPreview(document, {
    kind: 'text-color',
    color: '#22c55e',
    entityIds: [document.id],
    textRange: { start: 0, end: 3, scope: 'paragraph', contentRevision: 6 },
  }), document);
});

test('editor workspace requires an explicit fourth-pane replacement and stays outside document history', async () => {
  const harness = createHarness();
  const editorPlugin = createEditorPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(editorPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  const ids: string[] = [];
  for (const title of ['编辑 A', '编辑 B', '编辑 C', '编辑 D']) {
    ids.push((await harness.router.dispatch<{ id: string }>('node.create', { title }, 'core.test')).id);
  }
  const historyBefore = harness.history.getState().undoCount;
  await harness.router.dispatch('editor.open', { id: ids[0] }, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 2));
  await harness.router.dispatch('editor.open', { id: ids[1] }, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 2));
  await harness.router.dispatch('editor.open', { id: ids[2] }, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 2));
  await harness.router.dispatch('editor.activate', { id: ids[0] }, 'core.test');
  await new Promise((resolve) => setTimeout(resolve, 2));
  const fourth = await harness.router.dispatch<{ status: string; openPanes: string[] }>(
    'editor.open',
    { id: ids[3] },
    'core.test',
  );
  assert.equal(fourth.status, 'limit');
  assert.deepEqual(fourth.openPanes, [ids[0], ids[1], ids[2]]);
  const pending = await harness.router.ask<{ pendingPane?: string }>('editor.state', undefined, 'core.test');
  assert.equal(pending.pendingPane, ids[3]);
  await harness.router.dispatch('editor.replacePane', { replaceId: ids[1] }, 'core.test');
  assert.equal(harness.history.getState().undoCount, historyBefore);

  const paneMinimum = await harness.router.dispatch<{ width: number }>(
    'editor.setDockWidth',
    { width: 100, boundaryWidth: 2560 },
    'core.test',
  );
  assert.equal(paneMinimum.width, 1092);
  const viewportBound = await harness.router.dispatch<{ width: number }>(
    'editor.setDockWidth',
    { width: 5000, boundaryWidth: 1440 },
    'core.test',
  );
  assert.equal(viewportBound.width, 1440);
  const productBound = await harness.router.dispatch<{ width: number }>(
    'editor.setDockWidth',
    { width: 5000, boundaryWidth: 2560 },
    'core.test',
  );
  assert.equal(productBound.width, 1800);
  await harness.router.dispatch('editor.setPaneRatios', {
    ratios: { [ids[0]]: 2, [ids[2]]: 1, [ids[3]]: 1 },
  }, 'core.test');
  await harness.router.dispatch('editor.setWindow', { id: ids[3], start: 262_144 }, 'core.test');
  await harness.router.dispatch('editor.enterImmersive', { id: ids[3] }, 'core.test');
  const state = await harness.router.ask<{
    dockWidth: number;
    immersivePane?: string;
    activePane?: string;
    paneWindows: Record<string, number>;
    paneRatios: Record<string, number>;
  }>('editor.state', undefined, 'core.test');
  assert.equal(state.dockWidth, 1800);
  assert.deepEqual(state.paneRatios, { [ids[0]]: 1.5, [ids[2]]: 0.75, [ids[3]]: 0.75 });
  assert.equal(state.immersivePane, ids[3]);
  assert.equal(state.activePane, ids[3]);
  assert.equal(state.paneWindows[ids[3]], 262_144);
  assert.equal(harness.history.getState().undoCount, historyBefore);
});

test('search navigation stays inside the active open editor and never opens another pane', async () => {
  const harness = createHarness();
  const editorPlugin = createEditorPlugin();
  const searchPlugin = createSearchReplacePlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(editorPlugin);
  harness.plugins.register(searchPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  await harness.plugins.start('search-replace');

  const openIds: string[] = [];
  for (const title of ['已开 A', '已开 B', '已开 C']) {
    openIds.push((await harness.router.dispatch<{ id: string }>('node.create', { title }, 'core.test')).id);
  }
  const markerStart = 1_100_000;
  const target = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '定位目标', body: `${'x'.repeat(markerStart)}跨窗口定位` },
    'core.test',
  );
  for (const id of openIds) await harness.router.dispatch('editor.open', { id }, 'core.test');
  const search = await harness.capabilities.request<{ hits: Array<{
    nodeId: string;
    title: string;
    start: number;
    length: number;
    matchedText: string;
    preview: string;
    revision: number;
  }> }>('content.search@1', {
    query: '跨窗口定位',
    nodeIds: [target.id],
    matchCase: true,
    wholeWord: false,
    maxResults: 10,
  });
  const historyBefore = harness.history.getState().undoCount;
  const revealPayload = {
      id: search.hits[0].nodeId,
      start: search.hits[0].start,
      end: search.hits[0].start + search.hits[0].length,
      revision: search.hits[0].revision,
  };
  await assert.rejects(
    () => harness.router.dispatch('editor.revealRange', revealPayload, 'search-replace'),
    /只对当前正在使用的文本编辑区生效/,
  );
  const unopenedState = await harness.router.ask<{ openPanes: string[]; pendingPane?: string }>(
    'editor.state', undefined, 'core.test',
  );
  assert.deepEqual(unopenedState.openPanes, openIds);
  assert.equal(unopenedState.pendingPane, undefined);

  await harness.router.dispatch('editor.close', { id: openIds[2] }, 'core.test');
  await harness.router.dispatch('editor.open', { id: target.id }, 'search-replace');
  const navigation = await harness.router.dispatch<{ status: string }>(
    'editor.revealRange', revealPayload, 'search-replace',
  );
  assert.equal(navigation.status, 'revealed');
  const revealedState = await harness.router.ask<{
    activePane?: string;
    paneWindows: Record<string, number>;
    revealRequest?: { id: string; start: number; end: number; requestId: string };
  }>('editor.state', undefined, 'core.test');
  assert.equal(revealedState.activePane, target.id);
  assert.ok(revealedState.paneWindows[target.id] > 0 && revealedState.paneWindows[target.id] < markerStart);
  assert.equal(revealedState.revealRequest?.id, target.id);
  assert.equal(revealedState.revealRequest?.start, markerStart);
  assert.equal(revealedState.revealRequest?.end, markerStart + '跨窗口定位'.length);
  assert.ok(revealedState.revealRequest?.requestId);

  await harness.router.dispatch('editor.activate', { id: openIds[0] }, 'core.test');
  await assert.rejects(
    () => harness.router.dispatch('editor.revealRange', revealPayload, 'search-replace'),
    /只对当前正在使用的文本编辑区生效/,
  );
  const finalState = await harness.router.ask<{ activePane?: string }>('editor.state', undefined, 'core.test');
  assert.equal(finalState.activePane, openIds[0]);
  assert.equal(harness.history.getState().undoCount, historyBefore);
});

test('editor pane dividers cascade across neighbouring panes and keep a 360px minimum when space permits', () => {
  const draggedLeft = resizePaneWidths([500, 500, 500], 1, -200, 360);
  assert.deepEqual(draggedLeft, [440, 360, 700]);
  assert.equal(draggedLeft.reduce((sum, width) => sum + width, 0), 1500);

  const draggedRight = resizePaneWidths([500, 500, 500], 0, 200, 360);
  assert.deepEqual(draggedRight, [700, 360, 440]);
  assert.equal(draggedRight.reduce((sum, width) => sum + width, 0), 1500);

  assert.deepEqual(resizePaneWidths([300, 300, 300], 1, -200, 360), [300, 300, 300]);

  const expanded = resizePaneLayout([500, 500, 500], 1, -400, 360, 1512, 1800);
  assert.deepEqual(expanded, { widths: [360, 360, 900], dockWidth: 1632 });
  const maximized = resizePaneLayout([500, 500, 500], 1, -2000, 360, 1512, 1800);
  assert.deepEqual(maximized, { widths: [360, 360, 1068], dockWidth: 1800 });
});

test('closing panes preserves the rendered widths of the panes that remain open', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createEditorPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  const ids: string[] = [];
  for (const title of ['尺寸 A', '尺寸 B', '尺寸 C']) {
    ids.push((await harness.router.dispatch<{ id: string }>('node.create', { title }, 'core.test')).id);
  }
  for (const id of ids) await harness.router.dispatch('editor.open', { id }, 'core.test');
  await harness.router.dispatch('editor.setDockWidth', { width: 1500, boundaryWidth: 1500 }, 'core.test');
  await harness.router.dispatch('editor.close', { id: ids[1], currentDockWidth: 1500 }, 'core.test');
  let state = await harness.router.ask<{ dockWidth: number; paneRatios: Record<string, number> }>(
    'editor.state', undefined, 'core.test',
  );
  assert.equal(state.dockWidth, 998);
  assert.deepEqual(state.paneRatios, { [ids[0]]: 1, [ids[2]]: 1 });
  await harness.router.dispatch('editor.close', { id: ids[0], currentDockWidth: 998 }, 'core.test');
  state = await harness.router.ask('editor.state', undefined, 'core.test');
  assert.equal(state.dockWidth, 496);
  assert.deepEqual(state.paneRatios, { [ids[2]]: 1 });
});

test('text-node resize commits once, exposes dynamic bounds and is globally undoable', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const body = '正文预览内容'.repeat(2_000);
  const created = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '可缩放节点', body },
    'core.test',
  );
  const before = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  assert.equal(before.width, 280);
  assert.equal(before.height, 158);
  assert.ok(before.preview.length > 180);
  assert.ok(before.preview.length < body.length);
  await harness.router.dispatch('node.resize', {
    id: created.id,
    width: 431.6,
    height: 302.2,
    expectedRevision: before.nodeRevision,
  }, 'core.test');
  const resized = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  assert.equal(resized.width, 432);
  assert.equal(resized.height, 302);
  assert.ok(resized.preview.length > before.preview.length);
  assert.equal(resized.preview, body.slice(0, resized.preview.length));
  await harness.transactions.undo();
  const restored = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  assert.equal(restored.width, 280);
  assert.equal(restored.height, 158);
  assert.equal(restored.preview, before.preview);
});

test('text nodes and text boxes convert without losing body or either remembered size', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const body = '转换后仍需保留的正文。'.repeat(80);
  const created = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '可转换节点', body },
    'core.test',
  );
  let summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;

  await harness.router.dispatch('node.resize', {
    id: created.id,
    width: 432,
    height: 302,
    expectedRevision: summary.nodeRevision,
  }, 'core.test');
  summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  await harness.router.dispatch('node.presentation.set', {
    id: created.id,
    presentation: 'text-box',
    expectedRevision: summary.nodeRevision,
  }, 'core.test');
  summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  assert.deepEqual(
    [summary.presentation, summary.width, summary.height, summary.preview],
    ['text-box', 240, 64, ''],
  );
  assert.deepEqual(summary.resizeLimits, {
    minWidth: 120,
    maxWidth: 1600,
    minHeight: 48,
    maxHeight: 1200,
  });

  await harness.router.dispatch('node.resize', {
    id: created.id,
    width: 361,
    height: 89,
    expectedRevision: summary.nodeRevision,
  }, 'core.test');
  summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  await harness.router.dispatch('node.presentation.set', {
    id: created.id,
    presentation: 'card',
    expectedRevision: summary.nodeRevision,
  }, 'core.test');
  summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  assert.deepEqual([summary.presentation, summary.width, summary.height], ['card', 432, 302]);
  assert.equal(summary.preview, body.slice(0, summary.preview.length));
  assert.ok(summary.preview.length > 0);

  await harness.router.dispatch('node.presentation.set', {
    id: created.id,
    presentation: 'text-box',
    expectedRevision: summary.nodeRevision,
  }, 'core.test');
  summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  assert.deepEqual([summary.presentation, summary.width, summary.height], ['text-box', 361, 89]);
  await harness.transactions.undo();
  summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  assert.deepEqual([summary.presentation, summary.width, summary.height], ['card', 432, 302]);
  await harness.transactions.redo();
  summary = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .find((node) => node.id === created.id)!;
  assert.deepEqual([summary.presentation, summary.width, summary.height], ['text-box', 361, 89]);
  const stored = harness.store.readValue<Record<string, unknown>>('document', 'textNode', created.id)!;
  assert.equal(stored.presentation, 'text-box');
  assert.deepEqual(stored.cardSize, { width: 432, height: 302 });
  assert.deepEqual(stored.textBoxSize, { width: 361, height: 89 });
});

test('text-box presentation is registered as a customizable shortcut and toggles selected nodes', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  const created = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '快捷键文本框' },
    'core.test',
  );
  await harness.router.dispatch('selection.set', { ids: [created.id], mode: 'replace' }, 'core.test');

  const shortcut = harness.ui.listShortcuts().find((item) =>
    item.owner === 'text-node' && item.id === 'text-node.toggle-selected-presentation-shortcut');
  assert.equal(shortcut?.label, '文本框与文字节点相互转换');
  assert.equal(shortcut?.chord, '');
  assert.equal(shortcut?.disabled, true);
  const action = harness.ui.listActions().find((item) =>
    item.owner === 'text-node' && item.id === 'text-node.toggle-selected-presentation-action');
  assert.equal(action?.label, '文本框与文字节点相互转换');
  assert.equal(action?.command, 'node.toggleSelectedPresentation');
  const toolbar = harness.ui.list('top.primary').find((item) =>
    item.owner === 'text-node' && item.id === 'text-node.toggle-selected-presentation');
  assert.deepEqual({
    kind: toolbar?.kind,
    label: toolbar?.label,
    icon: toolbar?.icon,
    tone: toolbar?.tone,
    group: toolbar?.group,
    command: toolbar?.command,
    priority: toolbar?.priority,
  }, {
    kind: 'button',
    label: '文本框与文字节点相互转换',
    icon: 'replace',
    tone: 'primary',
    group: 'appearance',
    command: 'node.toggleSelectedPresentation',
    priority: 30,
  });

  const toggled = await harness.router.dispatch(
    'node.toggleSelectedPresentation',
    undefined,
    'core.test',
  );
  assert.deepEqual(toggled, { changed: 1 });
  const summary = (await harness.capabilities.request<ContentSummary[]>('content.summariesById@1', {
    nodeIds: [created.id],
  }))[0];
  assert.equal(summary?.presentation, 'text-box');
});

test('text-node data migration initializes legacy cards and their remembered size', async () => {
  const migration = textNodePlugin.migrations?.find((candidate) => candidate.from === 1);
  assert.ok(migration);
  const migrated = await migration.migrate({
    textNode: {
      legacy: {
        id: 'legacy',
        contentId: 'content-legacy',
        title: '旧节点',
        x: 10,
        y: 20,
        width: 440,
        height: 260,
        titleColor: '#202124',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  });
  assert.deepEqual(migrated.textNode?.legacy, {
    id: 'legacy',
    contentId: 'content-legacy',
    title: '旧节点',
    x: 10,
    y: 20,
    width: 440,
    height: 260,
    titleColor: '#202124',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    presentation: 'card',
    cardSize: { width: 440, height: 260 },
  });
});

test('selected text nodes reset size and arrange into one undoable square grid transaction', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createSmartLayoutPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('smart-layout');
  const inputs = [
    { title: 'A', x: 500, y: 500, width: 460, height: 260 },
    { title: 'B', x: 100, y: 100, width: 300, height: 190 },
    { title: 'C', x: 900, y: 120, width: 520, height: 340 },
    { title: 'D', x: 120, y: 800, width: 380, height: 220 },
  ];
  const ids: string[] = [];
  for (const input of inputs) {
    ids.push((await harness.router.dispatch<{ id: string }>('node.create', input, 'core.test')).id);
  }
  const before = new Map(
    (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
      .filter((node) => ids.includes(node.id))
      .map((node) => [node.id, node]),
  );
  await harness.router.dispatch('selection.set', { ids, mode: 'replace' }, 'core.test');
  const historyBefore = harness.history.getState().undoCount;
  const result = await harness.router.dispatch<{ selected: number; changed: number; columns: number }>(
    'node.arrangeSelectedGrid',
    undefined,
    'core.test',
  );
  assert.deepEqual(result, { selected: 4, changed: 4, columns: 2 });
  assert.equal(harness.history.getState().undoCount, historyBefore + 1);
  const arranged = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .filter((node) => ids.includes(node.id))
    .sort((left, right) => left.y - right.y || left.x - right.x);
  assert.deepEqual(arranged.map((node) => [node.x, node.y]), [
    [100, 100],
    [420, 100],
    [100, 298],
    [420, 298],
  ]);
  assert.equal(arranged.every((node) => node.width === 280 && node.height === 158), true);

  await harness.transactions.undo();
  const restored = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .filter((node) => ids.includes(node.id));
  for (const node of restored) {
    const original = before.get(node.id)!;
    assert.deepEqual(
      [node.x, node.y, node.width, node.height],
      [original.x, original.y, original.width, original.height],
    );
  }

  const gridCycle = await harness.router.dispatch<{ mode: string }>(
    'node.arrangeSelectedCycle', undefined, 'core.test',
  );
  const horizontalCycle = await harness.router.dispatch<{ mode: string }>(
    'node.arrangeSelectedCycle', undefined, 'core.test',
  );
  const verticalCycle = await harness.router.dispatch<{ mode: string }>(
    'node.arrangeSelectedCycle', undefined, 'core.test',
  );
  assert.deepEqual(
    [gridCycle.mode, horizontalCycle.mode, verticalCycle.mode],
    ['grid', 'horizontal', 'vertical'],
  );
  const vertical = (await harness.capabilities.request<ContentSummary[]>('content.summaries@1'))
    .filter((node) => ids.includes(node.id))
    .sort((left, right) => left.y - right.y || left.x - right.x);
  assert.deepEqual(vertical.map((node) => [node.x, node.y]), [
    [100, 100],
    [100, 298],
    [100, 496],
    [100, 694],
  ]);
});

test('writing metrics count graphemes, exclude paste from speed and remain outside undo history', async () => {
  const harness = createHarness();
  const editorPlugin = createEditorPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(editorPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  const node = await harness.router.dispatch<{ id: string }>('node.create', { title: '码字节点' }, 'core.test');
  const historyBefore = harness.history.getState().undoCount;
  await harness.router.dispatch(
    'editor.recordActivity',
    { nodeId: node.id, kind: 'insert', insertedText: '你好👨‍👩‍👧‍👦', deletedText: '' },
    'core.test',
  );
  await harness.router.dispatch(
    'editor.recordActivity',
    { nodeId: node.id, kind: 'composition', insertedText: '中文', deletedText: '' },
    'core.test',
  );
  await harness.router.dispatch(
    'editor.recordActivity',
    { nodeId: node.id, kind: 'paste', insertedText: '粘贴', deletedText: '' },
    'core.test',
  );
  await harness.router.dispatch(
    'editor.recordActivity',
    { nodeId: node.id, kind: 'delete', insertedText: '', deletedText: '你' },
    'core.test',
  );
  const metrics = await harness.capabilities.request<{
    byNode: Record<string, { typedGraphemes: number; deletedGraphemes: number; pastedUtf16Units: number }>;
  }>('editor.metrics@1', { nodeIds: [node.id] });
  assert.equal(metrics.byNode[node.id].typedGraphemes, 5);
  assert.equal(metrics.byNode[node.id].deletedGraphemes, 1);
  assert.equal(metrics.byNode[node.id].pastedUtf16Units, 2);
  const stored = harness.store.readValue<Record<string, unknown>>(
    'workspace',
    'editorMetrics',
    `metrics:${node.id}`,
  )!;
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'recentBuckets'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'recentWindowMs'), false);
  assert.equal(harness.history.getState().undoCount, historyBefore);
});

test('editor hot-stop releases runtime surfaces and restores personal layout on restart', async () => {
  const harness = createHarness();
  const editorPlugin = createEditorPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(editorPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  const node = await harness.router.dispatch<{ id: string }>('node.create', { title: '热拔插编辑器' }, 'core.test');
  await harness.router.dispatch('editor.open', { id: node.id }, 'core.test');
  await harness.router.dispatch('editor.setDockWidth', { width: 612 }, 'core.test');
  assert.ok(harness.resources.count('editor') > 0);

  await harness.plugins.stop('editor');
  assert.equal(harness.resources.count('editor'), 0);
  assert.equal(harness.capabilities.has('editor.activeNode@1'), false);
  assert.equal(harness.ui.list('right.editor').length, 0);
  assert.equal(harness.ui.list('overlay.modal').length, 0);

  await harness.plugins.start('editor');
  const state = await harness.router.ask<{ openPanes: string[]; dockWidth: number }>(
    'editor.state',
    undefined,
    'core.test',
  );
  assert.deepEqual(state.openPanes, [node.id]);
  assert.equal(state.dockWidth, 612);
});

test('content deltas reject a stale editor revision before changing text', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const node = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '并发保护', body: 'abc' },
    'core.test',
  );
  const summary = (await harness.capabilities.request<Array<{ id: string; revision: number }>>('content.summaries@1'))
    .find((item) => item.id === node.id);
  assert.ok(summary);
  await harness.router.dispatch(
    'content.applyDelta',
    { nodeId: node.id, start: 3, deleteCount: 0, insert: 'd', expectedRevision: summary.revision },
    'core.test',
  );
  await assert.rejects(
    () => harness.router.dispatch(
      'content.applyDelta',
      { nodeId: node.id, start: 0, deleteCount: 1, insert: 'z', expectedRevision: summary.revision },
      'core.test',
    ),
    /正文版本已变化/,
  );
  const body = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: node.id,
    start: 0,
    length: 20,
  });
  assert.equal(body.text, 'abcd');
});

test('legacy privacy metadata is scrubbed and all text sources remain readable and searchable', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  await harness.plugins.start('text-node');
  const publicNode = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '公开资料', body: 'privacy-search-token 公开内容' },
    'core.test',
  );
  const secondNode = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '第二份资料', body: 'privacy-search-token 第二份内容' },
    'core.test',
  );
  const storedNode = harness.store.readValue<Record<string, unknown>>('document', 'textNode', secondNode.id)!;
  await harness.transactions.commit({
    label: '注入旧版字段',
    history: false,
    patches: [{
      op: 'set',
      domain: 'document',
      namespace: 'textNode',
      key: secondNode.id,
      value: { ...storedNode, private: true },
      schemaOwner: 'text-node',
    }],
  }, testEnvelope('legacy-privacy'), 'text-node');
  await harness.router.dispatch('content.migrateStorage', undefined, 'core.test');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      harness.store.readValue<Record<string, unknown>>('document', 'textNode', secondNode.id)!,
      'private',
    ),
    false,
  );
  const result = await harness.capabilities.request<{
    hits: Array<{ source: { sourceId: string } }>;
  }>('context.search@1', { terms: ['privacy-search-token'], maxResults: 20 });
  assert.deepEqual(new Set(result.hits.map((hit) => hit.source.sourceId)), new Set([publicNode.id, secondNode.id]));

  const readable = await harness.capabilities.request<{ text?: string }>(
    'context.read@1',
    { sourceId: secondNode.id, start: 0, length: 100 },
  );
  assert.equal(readable.text, 'privacy-search-token 第二份内容');
});

test('retired privacy and recent-speed fields are removed from snapshots, history and clipboard fragments', () => {
  const store = scrubRetiredStore({
    formatVersion: 1,
    document: {
      revision: 1,
      namespaces: {
        textNode: { node: { id: 'node', title: '旧节点', private: true } },
        aiProposals: { proposal: { id: 'proposal', sourceRefs: [{ sourceId: 'node', private: true }] } },
      },
    },
    workspace: {
      revision: 1,
      namespaces: {
        editor: { 'metrics:node': { nodeId: 'node', recentBuckets: [], recentWindowMs: 300_000 } },
        clipboard: {
          bundle: {
            fragments: [{ owner: 'text-node', payload: { nodes: [{ node: { id: 'node', private: true } }] } }],
          },
        },
      },
    },
  });
  const history = scrubRetiredHistory({
    undo: [{
      id: 'old',
      label: '旧操作',
      timestamp: 1,
      forward: [{ op: 'set', domain: 'document', namespace: 'textNode', key: 'node', value: { private: true } }],
      inverse: [{ op: 'set', domain: 'document', namespace: 'aiProposals', key: 'proposal', value: { sourceRefs: [{ private: true }] } }],
    }],
    redo: [],
  });
  assert.equal(store.changed, true);
  assert.equal(history.changed, true);
  assert.doesNotMatch(JSON.stringify(store.value), /"private"|"recentBuckets"|"recentWindowMs"/u);
  assert.doesNotMatch(JSON.stringify(history.value), /"private"/u);
});

test('search index is rebuildable, covers all sources and invalidates by content revision', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  const indexPlugin = createSearchIndexPlugin();
  harness.plugins.register(indexPlugin);
  await harness.plugins.start('text-node');
  const publicNode = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '索引公开', body: 'alpha-index-token 可公开检索' },
    'core.test',
  );
  const secondNode = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '索引补充', body: 'alpha-index-token 也应进入索引' },
    'core.test',
  );
  await harness.plugins.start('search-index');
  const first = await harness.capabilities.request<{
    hits: Array<{ source: { sourceId: string } }>;
    scanned: number;
  }>('context.search@2', { terms: ['alpha', 'index', 'token'], maxResults: 10 });
  assert.deepEqual(new Set(first.hits.map((hit) => hit.source.sourceId)), new Set([publicNode.id, secondNode.id]));
  const status = await harness.capabilities.request<{
    state: string;
    indexedSources: number;
    totalSources: number;
    approximateBytes: number;
  }>('search.index.status@1');
  assert.equal(status.state, 'ready');
  assert.equal(status.indexedSources, status.totalSources);
  assert.ok(status.approximateBytes > 0);

  const broadNode = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '普通故障记录', body: '服务故障出现过多次，故障原因仍在排查。' },
    'core.test',
  );
  const exactNode = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '生产环境 502 故障', body: '上游服务返回 502，随后发现内存溢出。' },
    'core.test',
  );
  const ranked = await harness.capabilities.request<{
    hits: Array<{ source: { sourceId: string }; retrievalMethod?: string; matchedTerms?: string[] }>;
  }>('context.search@3', { query: '服务器发生502故障', terms: ['故障', '502'], maxResults: 10 });
  assert.equal(ranked.hits[0]?.source.sourceId, exactNode.id);
  assert.equal(ranked.hits.some((hit) => hit.source.sourceId === broadNode.id), true);
  assert.equal(ranked.hits[0]?.retrievalMethod, 'bm25');
  assert.equal(ranked.hits[0]?.matchedTerms?.includes('502'), true);

  const summary = (await harness.capabilities.request<Array<{ id: string; revision: number; length: number }>>(
    'content.summaries@1',
  )).find((item) => item.id === publicNode.id)!;
  await harness.router.dispatch('content.applyDelta', {
    nodeId: publicNode.id,
    expectedRevision: summary.revision,
    start: summary.length,
    deleteCount: 0,
    insert: ' beta-reindexed-token',
  }, 'core.test');
  const rebuilt = await harness.capabilities.request<typeof first>(
    'context.search@2',
    { terms: ['beta', 'reindexed'], maxResults: 10 },
  );
  assert.deepEqual(rebuilt.hits.map((hit) => hit.source.sourceId), [publicNode.id]);

  await harness.plugins.stop('search-index');
  assert.equal(harness.resources.count('search-index'), 0);
});

test('AI provider parses OpenAI-compatible SSE without waiting for one JSON response', async () => {
  const harness = createHarness();
  const provider = createAIProviderPlugin();
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"流式"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"结果"},"finish_reason":"length"}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  }) as typeof fetch;
  try {
    harness.plugins.register(provider);
    await harness.plugins.start('ai-provider');
    await harness.router.dispatch('aiProvider.setPreferences', {
      endpoint: 'https://stream.example.test/v1/chat/completions',
      model: 'stream-model',
      authentication: 'none',
    }, 'core.test');
    const stream = await harness.capabilities.request<AIGenerateStream>('ai.generate.stream@1', {
      messages: [{ role: 'user', content: '开始' }],
      temperature: 0.2,
      maxOutputTokens: 512,
    } satisfies AIGenerateRequest);
    let text = '';
    let outputTokens: number | undefined;
    let finishReason: string | undefined;
    for await (const event of stream.events) {
      if (event.type === 'delta') text += event.delta;
      else if (event.type === 'complete') {
        outputTokens = event.usage?.outputTokens;
        finishReason = event.finishReason;
      }
    }
    assert.equal(text, '流式结果');
    assert.equal(outputTokens, 4);
    assert.equal(finishReason, 'length');
    assert.equal(requestBody?.stream, true);
    assert.equal(requestBody?.stream_options, undefined);
    await harness.plugins.stop('ai-provider');
    assert.equal(harness.resources.count('ai-provider'), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI provider preserves bounded provider errors from HTTP and SSE responses', async () => {
  const harness = createHarness();
  harness.plugins.register(createAIProviderPlugin());
  await harness.plugins.start('ai-provider');
  await harness.router.dispatch('aiProvider.setPreferences', {
    endpoint: 'https://api.example.com/v1/chat/completions',
    model: 'example-chat',
    authentication: 'none',
  }, 'core.test');
  const request = {
    messages: [{ role: 'user' as const, content: '开始' }],
    temperature: 0.2,
    maxOutputTokens: 512,
  } satisfies AIGenerateRequest;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { message: '模型密钥无效', type: 'provider_error' },
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await assert.rejects(
      () => harness.capabilities.request('ai.generate@1', request),
      /HTTP 401：模型密钥无效/u,
    );

    const encoder = new TextEncoder();
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"error":{"message":"模型服务暂不可用"}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    const stream = await harness.capabilities.request<AIGenerateStream>('ai.generate.stream@1', request);
    await assert.rejects(async () => {
      for await (const event of stream.events) {
        assert.fail(`Provider error was exposed as ${event.type} instead of failing the stream`);
      }
    }, /模型服务暂不可用/u);
  } finally {
    globalThis.fetch = originalFetch;
    await harness.plugins.stop('ai-provider');
  }
});

test('AI provider forwards bounded local tool definitions and normalizes streamed tool calls', async () => {
  const harness = createHarness();
  const provider = createAIProviderPlugin();
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_memory","type":"function","function":{"name":"search_memory","arguments":"{\\"query\\":\\""}}]}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"发布窗口\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    harness.plugins.register(provider);
    await harness.plugins.start('ai-provider');
    await harness.router.dispatch('aiProvider.setPreferences', {
      endpoint: 'https://tool.example.test/v1/chat/completions',
      model: 'tool-model', authentication: 'none', apiStyle: 'openai',
    }, 'core.test');
    const tools: AIToolDefinition[] = [{
      type: 'function',
      function: {
        name: 'search_memory', description: '本地只读检索',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    }];
    const stream = await harness.capabilities.request<AIGenerateStream>('ai.generate.stream@1', {
      messages: [{ role: 'user', content: '回忆发布窗口' }],
      tools, temperature: 0.2, maxOutputTokens: 512,
    } satisfies AIGenerateRequest);
    const calls: Array<{ id?: string; name?: string; argumentsDelta?: string }> = [];
    for await (const event of stream.events) {
      if (event.type === 'tool-call') {
        calls.push({ id: event.id, name: event.name, argumentsDelta: event.argumentsDelta });
      }
    }
    assert.equal(requestBody?.tool_choice, 'auto');
    assert.deepEqual((requestBody?.tools as Array<{ function: { name: string } }>)[0]?.function.name, 'search_memory');
    assert.deepEqual(calls, [
      { id: 'call_memory', name: 'search_memory', argumentsDelta: '{"query":"' },
      { id: undefined, name: undefined, argumentsDelta: '发布窗口"}' },
    ]);
    await harness.plugins.stop('ai-provider');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI provider refuses to turn reasoning-only content into a user-visible answer', async () => {
  const harness = createHarness();
  harness.plugins.register(createAIProviderPlugin());
  await harness.plugins.start('ai-provider');
  await harness.router.dispatch('aiProvider.setPreferences', {
    endpoint: 'https://reasoning.example.test/v1/chat/completions',
    model: 'reasoning-model',
    authentication: 'none',
  }, 'core.test');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: null, reasoning_content: '这是模型唯一返回的可见内容。' } }],
  }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    await assert.rejects(
      () => harness.capabilities.request<AIGenerateResult>('ai.generate@1', {
        messages: [{ role: 'user', content: '请回答' }],
        temperature: 0.2,
        maxOutputTokens: 512,
      } satisfies AIGenerateRequest),
      /只返回了思考过程/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI provider presets fill current official-compatible connection shapes without storing keys', () => {
  assert.deepEqual(AI_PROVIDER_PRESETS.map((preset) => preset.id), [
    'deepseek', 'openai', 'kimi', 'qwen', 'doubao', 'gemini',
  ]);
  assert.equal(applyAIProviderPreset('openai')?.endpoint, 'https://api.openai.com/v1/chat/completions');
  assert.equal(applyAIProviderPreset('kimi')?.endpoint, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(
    applyAIProviderPreset('qwen')?.endpoint,
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  );
  assert.equal(
    applyAIProviderPreset('doubao')?.endpoint,
    'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  );
  assert.equal(applyAIProviderPreset('gemini')?.apiStyle, 'gemini');
  assert.equal(JSON.stringify(AI_PROVIDER_PRESETS).toLocaleLowerCase().includes('api key'), true);
  assert.equal(JSON.stringify(AI_PROVIDER_PRESETS).includes('sk-'), false);
  assert.deepEqual(
    AI_PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek')?.suggestedModels,
    ['deepseek-chat', 'deepseek-reasoner'],
  );
});

test('session-only AI provider keys are excluded from personal backup', async () => {
  const harness = createHarness();
  const preferences = new Map<string, unknown>();
  harness.router.registerQuery('core.preferences', {
    type: 'system.preferences.get',
    validate: (payload): payload is { key: string } =>
      typeof payload === 'object' && payload !== null && typeof (payload as { key?: unknown }).key === 'string',
    handle: (payload) => preferences.get(payload.key),
  });
  harness.router.registerCommand('core.preferences', {
    type: 'system.preferences.set',
    validate: (payload): payload is { key: string; value: unknown } =>
      typeof payload === 'object' && payload !== null && typeof (payload as { key?: unknown }).key === 'string' &&
      Object.prototype.hasOwnProperty.call(payload, 'value'),
    handle: (payload) => {
      preferences.set(payload.key, payload.value);
      return { result: { saved: true } };
    },
  });
  harness.plugins.register(createAIProviderPlugin());
  await harness.plugins.start('ai-provider');
  const profile = await harness.router.dispatch<{ id: string }>('aiProvider.profile.save', {
    platform: '临时模型服务',
    label: '临时会话连接',
    endpoint: 'https://api.example.com/v1/chat/completions',
    model: 'example-chat',
    authentication: 'bearer',
    apiStyle: 'openai',
    secretPersistence: 'session-only',
  }, 'core.test');
  await harness.router.dispatch('aiProvider.setSessionKey', {
    profileId: profile.id,
    apiKey: 'temporary-api-key-must-not-persist',
  }, 'core.test');
  let serialized = '';
  const handle = {
    name: 'Echo-8-AI-个人配置.txt',
    createWritable: async () => ({
      write: async (blob: Blob) => { serialized = await blob.text(); },
      close: async () => undefined,
    }),
    getFile: async () => new File([serialized], 'Echo-8-AI-个人配置.txt', { type: 'text/plain' }),
  };
  await harness.router.dispatch('aiProvider.personalBackup.bind', { handle }, 'core.test');
  assert.match(serialized, /密钥保存：仅当前会话/u);
  assert.match(serialized, /当前平台 KEY：\s*$/mu);
  assert.doesNotMatch(serialized, /temporary-api-key-must-not-persist/u);
});

test('AI provider accepts an arbitrary model id and adds verified native web-search parameters', async () => {
  const harness = createHarness();
  harness.plugins.register(createAIProviderPlugin());
  await harness.plugins.start('ai-provider');
  const profile = await harness.router.dispatch<{ id: string }>('aiProvider.profile.save', {
    platform: '阿里云百炼',
    label: '自定义模型',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-my-private-model',
    authentication: 'none',
    apiStyle: 'openai',
  }, 'core.test');
  const catalog = await harness.capabilities.request<AIProviderCatalog>('ai.provider.catalog@1');
  assert.equal(catalog.options[0]?.model, 'qwen-my-private-model');
  assert.equal(catalog.options[0]?.webSearchSupported, true);
  assert.equal(catalog.options[0]?.toolCallingSupported, false);
  await harness.router.dispatch('aiProvider.profile.save', {
    id: profile.id,
    platform: '阿里云百炼',
    label: '自定义模型',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-my-private-model',
    authentication: 'none',
    apiStyle: 'openai',
    memoryToolEnabled: true,
  }, 'core.test');
  const toolEnabledCatalog = await harness.capabilities.request<AIProviderCatalog>('ai.provider.catalog@1');
  assert.equal(toolEnabledCatalog.options[0]?.toolCallingSupported, true);

  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: '联网结果' } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const result = await harness.capabilities.request<AIGenerateResult>('ai.generate@1', {
      providerId: profile.id,
      webSearch: true,
      messages: [{ role: 'user', content: '今天有什么新消息？' }],
      temperature: 0.2,
      maxOutputTokens: 512,
    } satisfies AIGenerateRequest);
    assert.equal(result.text, '联网结果');
    assert.equal(requestBody?.model, 'qwen-my-private-model');
    assert.equal(requestBody?.enable_search, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic provider presets expose only real embedding endpoints and mark chat-only platforms unavailable', () => {
  assert.equal(applySemanticProviderPreset('openai')?.endpoint, 'https://api.openai.com/v1/embeddings');
  assert.equal(applySemanticProviderPreset('qwen')?.model, 'qwen3.7-text-embedding');
  assert.equal(applySemanticProviderPreset('doubao')?.endpoint.endsWith('/embeddings'), true);
  assert.equal(applySemanticProviderPreset('gemini')?.apiStyle, 'gemini');
  assert.equal(applySemanticProviderPreset('deepseek'), undefined);
  assert.equal(applySemanticProviderPreset('kimi'), undefined);
  assert.equal(SEMANTIC_PROVIDER_PRESETS.find((item) => item.id === 'deepseek')?.available, false);
  assert.equal(SEMANTIC_PROVIDER_PRESETS.find((item) => item.id === 'kimi')?.available, false);
  assert.equal(JSON.stringify(SEMANTIC_PROVIDER_PRESETS).includes('sk-'), false);
});

test('AI provider rejects oversized declared bodies and unbounded streaming lines', async () => {
  const harness = createHarness();
  harness.plugins.register(createAIProviderPlugin());
  await harness.plugins.start('ai-provider');
  await harness.router.dispatch('aiProvider.setPreferences', {
    endpoint: 'https://limits.example.test/v1/chat/completions',
    model: 'limit-model',
    authentication: 'none',
  }, 'core.test');
  const request = {
    messages: [{ role: 'user' as const, content: '开始' }],
    temperature: 0.2,
    maxOutputTokens: 512,
  } satisfies AIGenerateRequest;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': String(9 * 1024 * 1024) },
    })) as typeof fetch;
    await assert.rejects(
      () => harness.capabilities.request('ai.generate@1', request),
      /8 MB 安全上限/u,
    );

    const oversizedLine = new TextEncoder().encode(`data: ${'x'.repeat(1024 * 1024 + 1)}`);
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedLine);
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    const stream = await harness.capabilities.request<AIGenerateStream>('ai.generate.stream@1', request);
    await assert.rejects(async () => {
      for await (const event of stream.events) {
        throw new Error(`Oversized line was exposed as ${JSON.stringify(event).length} characters`);
      }
    }, /单行数据超过安全上限/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI chat and semantic connections round-trip without leaking Prompt templates into the personal TXT', async () => {
  const installPreferences = (harness: ReturnType<typeof createHarness>) => {
    const preferences = new Map<string, unknown>();
    harness.router.registerQuery('core.preferences', {
      type: 'system.preferences.get',
      validate: (payload): payload is { key: string } =>
        typeof payload === 'object' && payload !== null && typeof (payload as { key?: unknown }).key === 'string',
      handle: (payload) => preferences.get(payload.key),
    });
    harness.router.registerCommand('core.preferences', {
      type: 'system.preferences.set',
      validate: (payload): payload is { key: string; value: unknown } =>
        typeof payload === 'object' && payload !== null && typeof (payload as { key?: unknown }).key === 'string' &&
        Object.prototype.hasOwnProperty.call(payload, 'value'),
      handle: (payload) => {
        preferences.set(payload.key, payload.value);
        return { result: { saved: true } };
      },
    });
  };
  const sourceHarness = createHarness();
  installPreferences(sourceHarness);
  sourceHarness.plugins.register(textNodePlugin);
  sourceHarness.plugins.register(createAIAssistantPlugin());
  sourceHarness.plugins.register(createSemanticProviderPlugin());
  sourceHarness.plugins.register(createAIProviderPlugin());
  await sourceHarness.plugins.start('text-node');
  await sourceHarness.plugins.start('ai-assistant');
  await sourceHarness.plugins.start('semantic-provider');
  await sourceHarness.plugins.start('ai-provider');
  const profile = await sourceHarness.router.dispatch<{ id: string }>('aiProvider.profile.save', {
    platform: 'Gemini',
    label: '长文复核',
    endpoint: 'https://generativelanguage.googleapis.com',
    model: 'gemini-test',
    authentication: 'api-key',
    apiStyle: 'gemini',
  }, 'core.test');
  await sourceHarness.router.dispatch('aiProvider.setSessionKey', {
    profileId: profile.id,
    apiKey: 'personal-test-key',
  }, 'core.test');
  const semanticProfile = await sourceHarness.router.dispatch<{ id: string }>(SEMANTIC_PROVIDER_COMMANDS.saveProfile, {
    platform: 'OpenAI',
    label: '长文语义检索',
    endpoint: 'https://semantic.example.test/v1/embeddings',
    model: 'text-embedding-test',
    authentication: 'bearer',
    apiStyle: 'openai-compatible',
    allowRemoteContent: true,
    maxBatchSize: 17,
  }, 'core.test');
  await sourceHarness.router.dispatch(SEMANTIC_PROVIDER_COMMANDS.setSessionKey, {
    profileId: semanticProfile.id,
    apiKey: 'semantic-test-key',
  }, 'core.test');
  await sourceHarness.router.dispatch('ai.promptTemplate.save', {
    name: '内容审校',
    systemInstruction: '只核对用户提供的事实。',
    userInstruction: '处理 {{operation}}，不要增加无关说明。',
  }, 'core.test');
  let serialized = '';
  const handle = {
    name: 'Echo-8-AI-个人配置.txt',
    createWritable: async () => ({
      write: async (blob: Blob) => { serialized = await blob.text(); },
      close: async () => undefined,
    }),
    getFile: async () => new File([serialized], 'Echo-8-AI-个人配置.txt', { type: 'text/plain' }),
  };
  await sourceHarness.router.dispatch('aiProvider.personalBackup.bind', { handle }, 'core.test');
  assert.match(serialized, /^【模型连接】\n平台名称：Gemini/mu);
  assert.match(serialized, /完整接口地址：https:\/\/generativelanguage\.googleapis\.com/u);
  assert.match(serialized, /当前平台 KEY：personal-test-key/u);
  assert.match(serialized, /【语义检索连接】\n平台名称：OpenAI/u);
  assert.match(serialized, /完整接口地址：https:\/\/semantic\.example\.test\/v1\/embeddings/u);
  assert.match(serialized, /模型名称：text-embedding-test/u);
  assert.match(serialized, /允许发送画布片段：是/u);
  assert.match(serialized, /单批片段数量：17/u);
  assert.match(serialized, /当前平台 KEY：semantic-test-key/u);
  assert.doesNotMatch(serialized, /【Prompt 模板】/u);
  assert.doesNotMatch(serialized, /只核对用户提供的事实/u);
  assert.equal(serialized.trimStart().startsWith('{'), false);
  assert.doesNotMatch(serialized, /"(?:id|kind|version|savedAt)"\s*:/u);

  const targetHarness = createHarness();
  installPreferences(targetHarness);
  targetHarness.plugins.register(textNodePlugin);
  targetHarness.plugins.register(createAIAssistantPlugin());
  targetHarness.plugins.register(createSemanticProviderPlugin());
  targetHarness.plugins.register(createAIProviderPlugin());
  await targetHarness.plugins.start('text-node');
  await targetHarness.plugins.start('ai-assistant');
  await targetHarness.plugins.start('semantic-provider');
  await targetHarness.plugins.start('ai-provider');
  await targetHarness.router.dispatch('ai.promptTemplate.save', {
    name: '目标环境原有模板',
    systemInstruction: '这个模板不应被个人连接配置覆盖。',
    userInstruction: '继续保留。',
  }, 'core.test');
  await targetHarness.router.dispatch('aiProvider.personalBackup.import', { handle }, 'core.test');
  const providerState = await targetHarness.router.ask<{
    profiles: Array<{ platform: string; label: string; model: string; hasSessionKey: boolean }>;
  }>('aiProvider.state', undefined, 'core.test');
  assert.deepEqual(providerState.profiles.map((item) => ({
    platform: item.platform,
    label: item.label,
    model: item.model,
    hasSessionKey: item.hasSessionKey,
  })), [{ platform: 'Gemini', label: '长文复核', model: 'gemini-test', hasSessionKey: true }]);
  const semanticConnections = await targetHarness.router.ask<SemanticProviderPersonalConnections>(
    SEMANTIC_PROVIDER_PERSONAL_QUERY,
    undefined,
    'core.test',
  );
  assert.deepEqual(semanticConnections.configuration.profiles.map((item) => ({
    platform: item.platform,
    label: item.label,
    endpoint: item.endpoint,
    model: item.model,
    authentication: item.authentication,
    apiStyle: item.apiStyle,
    allowRemoteContent: item.allowRemoteContent,
    maxBatchSize: item.maxBatchSize,
  })), [{
    platform: 'OpenAI',
    label: '长文语义检索',
    endpoint: 'https://semantic.example.test/v1/embeddings',
    model: 'text-embedding-test',
    authentication: 'bearer',
    apiStyle: 'openai-compatible',
    allowRemoteContent: true,
    maxBatchSize: 17,
  }]);
  assert.deepEqual(Object.values(semanticConnections.apiKeys), ['semantic-test-key']);
  const templates = await targetHarness.router.ask<AIPromptTemplateCatalog>('ai.promptTemplates', undefined, 'core.test');
  assert.deepEqual(templates.templates.map((template) => template.name), ['目标环境原有模板']);
});

test('AI provider startup checks a persisted backup handle without reading or prompting for the file', async () => {
  const harness = createHarness();
  let queried = 0;
  let read = 0;
  const handle = {
    name: 'Echo-8-AI-个人配置.txt',
    async queryPermission() {
      queried += 1;
      return 'prompt' as const;
    },
    async getFile() {
      read += 1;
      return new File(['不应在启动时读取'], 'Echo-8-AI-个人配置.txt');
    },
    async createWritable() {
      throw new Error('不应在启动时写入');
    },
  };
  harness.router.registerQuery('core.preferences', {
    type: 'system.preferences.get',
    handle: (payload: { key: string }) => payload.key === 'ai-personal-backup-handle@1' ? handle : undefined,
  });
  harness.router.registerCommand('core.preferences', {
    type: 'system.preferences.set',
    handle: () => ({ result: { saved: true } }),
  });
  harness.plugins.register(createAIProviderPlugin());
  await harness.plugins.start('ai-provider');
  await waitFor(async () => queried > 0 ? true : undefined);
  assert.equal(read, 0);
  assert.equal(queried, 1);
  await harness.plugins.stop('ai-provider');
});

test('AI assistant streams ordinary answers without creating a write-back proposal', async () => {
  const harness = createHarness();
  let capturedRequest: AIGenerateRequest | undefined;
  const fakeProvider = {
    manifest: defineManifest('test-stream-provider', '测试流式模型', {
      providesCapabilities: ['ai.generate.stream@1', 'ai.provider.info@1'],
    }),
    start(context: Parameters<ReturnType<typeof createAIAssistantPlugin>['start']>[0]) {
      context.capabilities.provide({
        key: 'ai.provider.info@1',
        invoke: () => ({ id: 'stream-test', label: '测试流式模型', configured: true, model: 'stream-fixture', secretPersistence: 'session-only' }),
      });
      context.capabilities.provide<AIGenerateRequest, AIGenerateStream>({
        key: 'ai.generate.stream@1',
        invoke: (request) => {
          capturedRequest = request;
          return {
            provider: 'stream-test',
            model: 'stream-fixture',
            events: (async function* () {
              yield { type: 'delta' as const, channel: 'reasoning' as const, delta: '内部分析' };
              yield { type: 'delta' as const, delta: '逐字' };
              await Promise.resolve();
              yield { type: 'delta' as const, delta: '生成完成 [来源 1]' };
              yield { type: 'complete' as const, usage: { outputTokens: 6 } };
            })(),
          };
        },
      });
    },
  };
  const aiPlugin = createAIAssistantPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(fakeProvider);
  harness.plugins.register(aiPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('test-stream-provider');
  await harness.plugins.start('ai-assistant');

  const historyBefore = harness.history.getState().undoCount;
  const savedTemplate = await harness.router.dispatch<{ id: string }>('ai.promptTemplate.save', {
    name: '结构审查',
    systemInstruction: '作为结构审查员处理 {{operation}}；来源类型={{sourceKinds}}。',
    userInstruction: '本次共有 {{sourceCount}} 个来源。',
  }, 'core.test');
  assert.equal(harness.history.getState().undoCount, historyBefore);
  const promptCatalog = await harness.router.ask<AIPromptTemplateCatalog>('ai.promptTemplates', undefined, 'core.test');
  assert.equal(promptCatalog.activeTemplateId, savedTemplate.id);

  const source = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '结构资料',
    body: '这是需要总结的结构资料。',
  }, 'core.test');
  await harness.router.dispatch('ai.open', undefined, 'core.test');
  const state = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.activeSessionId ? next : undefined;
  });
  let prepared: AIPreparedContext | undefined;
  const deltas: string[] = [];
  const reasoningDeltas: string[] = [];
  const removeContext = harness.router.subscribeSignal('core.test', 'ai.context.ready', (message) => {
    prepared = message.payload as AIPreparedContext;
  });
  const removeDelta = harness.router.subscribeSignal('core.test', 'ai.generation.delta', (message) => {
    const payload = message.payload as { delta: string; channel?: 'answer' | 'reasoning' };
    (payload.channel === 'reasoning' ? reasoningDeltas : deltas).push(payload.delta);
  });
  await harness.router.dispatch('ai.context.prepare', {
    sessionId: state.activeSessionId,
    prompt: `@总结 请处理 @[结构资料](${source.id})`,
    operation: 'general',
    promptTemplateId: savedTemplate.id,
  }, 'core.test');
  const ready = await waitFor(async () => prepared);
  await harness.router.dispatch('ai.generation.start', { preparationId: ready.id }, 'core.test');
  await waitFor(async () => {
    const next = await harness.router.ask<{ text: string }>(
      'ai.transcript', { sessionId: state.activeSessionId }, 'core.test',
    );
    return next.text.includes('逐字生成完成') ? true : undefined;
  });
  const generated = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  assert.equal(deltas.join(''), '逐字生成完成 [来源 1]');
  assert.equal(reasoningDeltas.join(''), '内部分析');
  assert.equal(generated.proposals.length, 0);
  assert.equal(generated.responseDetails.some((detail) =>
    detail.sessionId === state.activeSessionId && detail.reasoning === '内部分析'), true);
  assert.deepEqual(
    generated.responseDetails.find((detail) => detail.sessionId === state.activeSessionId)?.citations,
    [{ ordinal: 1, sourceId: source.id, title: '结构资料', kind: 'text', revision: 1 }],
  );
  assert.match(capturedRequest?.messages[0]?.content ?? '', /回答必须先给核心结论或直接成品/);
  assert.match(capturedRequest?.messages[1]?.content ?? '', /结构审查员处理 总结；来源类型=text/);
  assert.match(capturedRequest?.messages[2]?.content ?? '', /本次共有 1 个来源/);
  assert.match(
    (await harness.router.ask<{ text: string }>('ai.transcript', { sessionId: state.activeSessionId }, 'core.test')).text,
    /逐字生成完成/,
  );
  assert.doesNotMatch(
    (await harness.router.ask<{ text: string }>('ai.transcript', { sessionId: state.activeSessionId }, 'core.test')).text,
    /内部分析/,
  );
  removeContext();
  removeDelta();

  await harness.plugins.stop('ai-assistant');
  await harness.plugins.start('ai-assistant');
  assert.equal(
    (await harness.router.ask<AIPromptTemplateCatalog>('ai.promptTemplates', undefined, 'core.test')).activeTemplateId,
    savedTemplate.id,
  );
});

test('AI assistant retries a failed send and repeats a successful answer without duplicating the original question', async () => {
  const harness = createHarness();
  let attempts = 0;
  const fakeProvider = {
    manifest: defineManifest('test-retry-stream-provider', '测试重试模型', {
      providesCapabilities: ['ai.generate.stream@1', 'ai.provider.info@1'],
    }),
    start(context: Parameters<ReturnType<typeof createAIAssistantPlugin>['start']>[0]) {
      context.capabilities.provide({
        key: 'ai.provider.info@1',
        invoke: () => ({
          id: 'retry-test',
          label: '测试重试模型',
          configured: true,
          model: 'retry-fixture',
          secretPersistence: 'session-only',
        }),
      });
      context.capabilities.provide<AIGenerateRequest, AIGenerateStream>({
        key: 'ai.generate.stream@1',
        invoke: () => {
          attempts += 1;
          const attempt = attempts;
          return {
            provider: 'retry-test',
            model: 'retry-fixture',
            events: (async function* () {
              if (attempt === 1) throw new Error('模拟发送失败');
              yield { type: 'delta' as const, delta: attempt === 2 ? '重试后的回答' : '再来一次的回答' };
              yield { type: 'complete' as const, finishReason: 'stop' as const };
            })(),
          };
        },
      });
    },
  };
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(fakeProvider);
  harness.plugins.register(createAIAssistantPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('test-retry-stream-provider');
  await harness.plugins.start('ai-assistant');
  await harness.router.dispatch('ai.open', undefined, 'core.test');
  const state = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.activeSessionId ? next : undefined;
  });
  const sessionId = state.activeSessionId!;
  let prepared: AIPreparedContext | undefined;
  const removeContext = harness.router.subscribeSignal('core.test', 'ai.context.ready', (message) => {
    prepared = message.payload as AIPreparedContext;
  });
  const originalQuestion = '这个问题只应该在对话里记录一次';
  await harness.router.dispatch('ai.context.prepare', {
    sessionId,
    prompt: originalQuestion,
    operation: 'general',
  }, 'core.test');
  const ready = await waitFor(async () => prepared);
  await harness.router.dispatch('ai.generation.start', { preparationId: ready.id }, 'core.test');
  await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.generationActionBySession[sessionId]?.kind === 'retry' ? true : undefined;
  });
  const failedTranscript = await harness.router.ask<{ text: string }>(
    'ai.transcript', { sessionId }, 'core.test',
  );
  assert.equal(failedTranscript.text.split(originalQuestion).length - 1, 1);
  assert.doesNotMatch(failedTranscript.text, /重试后的回答/u);

  assert.deepEqual(
    await harness.router.dispatch('ai.generation.retry', { sessionId }, 'core.test'),
    { queued: true, mode: 'retry' },
  );
  await waitFor(async () => {
    const transcript = await harness.router.ask<{ text: string }>('ai.transcript', { sessionId }, 'core.test');
    return transcript.text.includes('重试后的回答') ? transcript : undefined;
  });
  const afterRetry = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  assert.equal(afterRetry.generationActionBySession[sessionId]?.kind, 'repeat');
  assert.ok((afterRetry.generationActionBySession[sessionId]?.expiresAt ?? 0) - Date.now() > 23 * 60 * 60_000);

  assert.deepEqual(
    await harness.router.dispatch('ai.generation.retry', { sessionId }, 'core.test'),
    { queued: true, mode: 'repeat' },
  );
  const finalTranscript = await waitFor(async () => {
    const transcript = await harness.router.ask<{ text: string }>('ai.transcript', { sessionId }, 'core.test');
    return transcript.text.includes('再来一次的回答') ? transcript : undefined;
  });
  assert.equal(finalTranscript.text.split(originalQuestion).length - 1, 1);
  assert.match(finalTranscript.text, /\n重试\n/u);
  assert.match(finalTranscript.text, /\n再来一次\n/u);
  assert.equal(attempts, 3);
  assert.equal(
    (await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test'))
      .generationActionBySession[sessionId]?.kind,
    'repeat',
  );
  assert.equal(
    await harness.router.ask('ai.pendingPreparation', { sessionId }, 'core.test'),
    undefined,
  );
  removeContext();
});

test('AI assistant retry survives an unchanged current-conversation memory range advancing during save', async () => {
  const harness = createHarness();
  let attempts = 0;
  const fakeProvider = {
    manifest: defineManifest('test-memory-retry-provider', '测试记忆重试模型', {
      providesCapabilities: ['ai.generate.stream@1', 'ai.provider.info@1'],
    }),
    start(context: Parameters<ReturnType<typeof createAIAssistantPlugin>['start']>[0]) {
      context.capabilities.provide({
        key: 'ai.provider.info@1',
        invoke: () => ({
          id: 'memory-retry-test',
          label: '测试记忆重试模型',
          configured: true,
          model: 'memory-retry-fixture',
          secretPersistence: 'session-only',
        }),
      });
      context.capabilities.provide<AIGenerateRequest, AIGenerateStream>({
        key: 'ai.generate.stream@1',
        invoke: () => {
          attempts += 1;
          const attempt = attempts;
          return {
            provider: 'memory-retry-test',
            model: 'memory-retry-fixture',
            events: (async function* () {
              if (attempt === 2) throw new Error('模拟模型限流');
              yield {
                type: 'delta' as const,
                delta: attempt === 1 ? '用于建立当前对话记忆的回答' : '镜像更新后重试成功',
              };
              yield { type: 'complete' as const, finishReason: 'stop' as const };
            })(),
          };
        },
      });
    },
  };
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(fakeProvider);
  harness.plugins.register(createAIAssistantPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('test-memory-retry-provider');
  await harness.plugins.start('ai-assistant');
  await harness.router.dispatch('ai.open', undefined, 'core.test');
  const initial = await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    const assistant = state.assistants.find((item) => item.sessionId === session?.id);
    return session && assistant ? { session, assistant } : undefined;
  });
  let prepared: AIPreparedContext | undefined;
  const removeContext = harness.router.subscribeSignal('core.test', 'ai.context.ready', (message) => {
    prepared = message.payload as AIPreparedContext;
  });

  await harness.router.dispatch('ai.context.prepare', {
    sessionId: initial.session.id,
    prompt: '先建立一轮可保存的对话',
    operation: 'general',
  }, 'core.test');
  const first = await waitFor(async () => prepared);
  await harness.router.dispatch('ai.generation.start', { preparationId: first.id }, 'core.test');
  await waitFor(async () => {
    const transcript = await harness.router.ask<{ text: string }>('ai.transcript', {
      sessionId: initial.session.id,
    }, 'core.test');
    return transcript.text.includes('用于建立当前对话记忆的回答') ? transcript : undefined;
  });

  await harness.router.dispatch('ai.session.save', { sessionId: initial.session.id }, 'core.test');
  const memory = await waitFor(async () => {
    const memories = await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test');
    return memories.find((item) => item.sessionId === initial.session.id);
  });
  await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return state.assistants.find((item) => item.id === initial.assistant.id)
      ?.memorySourceIds?.includes(memory.sourceId) ? true : undefined;
  });

  prepared = undefined;
  await harness.router.dispatch('ai.context.prepare', {
    sessionId: initial.session.id,
    assistantId: initial.assistant.id,
    prompt: '让第二次请求先失败，再重试',
    operation: 'general',
  }, 'core.test');
  const second = await waitFor(async () => prepared);
  assert.equal(second.sources.some((source) =>
    source.sourceId === memory.sourceId && source.reason === 'conversation-memory'), true);
  await harness.router.dispatch('ai.generation.start', { preparationId: second.id }, 'core.test');
  await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return state.generationActionBySession[initial.session.id]?.kind === 'retry' ? true : undefined;
  });

  await harness.router.dispatch('ai.session.save', { sessionId: initial.session.id }, 'core.test');
  await waitFor(async () => {
    const memories = await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test');
    const updated = memories.find((item) => item.sourceId === memory.sourceId);
    return (updated?.sourceRevision ?? 0) > memory.sourceRevision ? updated : undefined;
  });

  assert.deepEqual(
    await harness.router.dispatch('ai.generation.retry', { sessionId: initial.session.id }, 'core.test'),
    { queued: true, mode: 'retry' },
  );
  await waitFor(async () => {
    const transcript = await harness.router.ask<{ text: string }>('ai.transcript', {
      sessionId: initial.session.id,
    }, 'core.test');
    return transcript.text.includes('镜像更新后重试成功') ? transcript : undefined;
  });
  assert.equal(attempts, 3);
  removeContext();
});

test('cancelling streamed AI output discards the incomplete assistant turn', async () => {
  const harness = createHarness();
  const fakeProvider = {
    manifest: defineManifest('test-cancellable-stream-provider', '可取消流式模型', {
      providesCapabilities: ['ai.generate.stream@1', 'ai.provider.info@1'],
    }),
    start(context: Parameters<ReturnType<typeof createAIAssistantPlugin>['start']>[0]) {
      context.capabilities.provide({
        key: 'ai.provider.info@1',
        invoke: () => ({ id: 'cancel-test', label: '可取消流式模型', configured: true, model: 'cancel-fixture', secretPersistence: 'session-only' }),
      });
      context.capabilities.provide<AIGenerateRequest, AIGenerateStream>({
        key: 'ai.generate.stream@1',
        invoke: (_request, signal) => ({
          provider: 'cancel-test',
          model: 'cancel-fixture',
          events: (async function* () {
            yield { type: 'delta' as const, delta: '不完整内容' };
            await new Promise<void>((resolve, reject) => {
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
              void resolve;
            });
          })(),
        }),
      });
    },
  };
  const aiPlugin = createAIAssistantPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(fakeProvider);
  harness.plugins.register(aiPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('test-cancellable-stream-provider');
  await harness.plugins.start('ai-assistant');
  const source = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '取消测试资料',
    body: '这是取消流式生成时使用的资料。',
  }, 'core.test');
  await harness.router.dispatch('ai.open', undefined, 'core.test');
  const state = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.activeSessionId ? next : undefined;
  });
  let prepared: AIPreparedContext | undefined;
  let receivedDelta = false;
  const removeContext = harness.router.subscribeSignal('core.test', 'ai.context.ready', (message) => {
    prepared = message.payload as AIPreparedContext;
  });
  const removeDelta = harness.router.subscribeSignal('core.test', 'ai.generation.delta', () => {
    receivedDelta = true;
  });
  await harness.router.dispatch('ai.context.prepare', {
    sessionId: state.activeSessionId,
    prompt: `请处理 @[取消测试资料](${source.id})`,
    operation: 'general',
  }, 'core.test');
  const ready = await waitFor(async () => prepared);
  await harness.router.dispatch('ai.generation.start', { preparationId: ready.id }, 'core.test');
  await waitFor(async () => receivedDelta || undefined);
  assert.deepEqual(
    await harness.router.dispatch('ai.generation.cancel', undefined, 'core.test'),
    { cancelled: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelledState = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  const transcript = await harness.router.ask<{ text: string }>(
    'ai.transcript',
    { sessionId: state.activeSessionId },
    'core.test',
  );
  assert.equal(cancelledState.proposals.length, 0);
  assert.doesNotMatch(transcript.text, /不完整内容/);
  removeContext();
  removeDelta();
});

test('AI evidence keeps complete Markdown tables and lists and estimates Chinese token pressure', async () => {
  assert.equal(estimateAITokens('中文测试'), 4);
  assert.ok(estimateAITokens('中文测试') > estimateAITokens('test'));
  const harness = createHarness();
  const aiPlugin = createAIAssistantPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(aiPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('ai-assistant');
  const table = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '部署矩阵',
    body: '| 环境 | 项目 | 状态 |\n| --- | --- | --- |\n| 生产 | ProjectZephyr | 已上线 |',
  }, 'core.test');
  const list = await harness.router.dispatch<{ id: string }>('node.create', {
    title: '回滚步骤',
    body: '- 停止 ProjectNimbus 流量\n- 恢复上一版本\n  - 核对数据库版本\n- 重新放量',
  }, 'core.test');
  await harness.router.dispatch('ai.open', undefined, 'core.test');
  const state = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.activeSessionId ? next : undefined;
  });
  let latest: AIPreparedContext | undefined;
  const remove = harness.router.subscribeSignal('core.test', 'ai.context.ready', (message) => {
    latest = message.payload as AIPreparedContext;
  });
  await harness.router.dispatch('ai.context.prepare', {
    sessionId: state.activeSessionId,
    prompt: 'ProjectZephyr 当前状态是什么',
    operation: 'general',
  }, 'core.test');
  const tableContext = await waitFor(async () => latest?.sources.some((source) => source.sourceId === table.id) ? latest : undefined);
  assert.equal(tableContext.sources.find((source) => source.sourceId === table.id)?.boundary, 'markdown-table');
  assert.equal(tableContext.sources.find((source) => source.sourceId === table.id)?.complete, true);
  assert.ok(tableContext.estimatedTokens > 0);
  latest = undefined;
  await harness.router.dispatch('ai.context.prepare', {
    sessionId: state.activeSessionId,
    prompt: 'ProjectNimbus 回滚步骤是什么',
    operation: 'general',
  }, 'core.test');
  const listContext = await waitFor(async () => latest?.sources.some((source) => source.sourceId === list.id) ? latest : undefined);
  assert.equal(listContext.sources.find((source) => source.sourceId === list.id)?.boundary, 'markdown-list');
  assert.equal(listContext.sources.find((source) => source.sourceId === list.id)?.complete, true);
  remove();
});

test('AI keeps exact transcript, creates reviewable proposals and accepts output as one undoable transaction', async () => {
  const harness = createHarness();
  const fakeProvider = {
    manifest: defineManifest('test-ai-provider', '测试模型', {
      providesCapabilities: ['ai.generate@1', 'ai.provider.info@1'],
    }),
    start(context: Parameters<ReturnType<typeof createAIAssistantPlugin>['start']>[0]) {
      context.capabilities.provide({
        key: 'ai.provider.info@1',
        invoke: () => ({ id: 'test', label: '测试模型', configured: true, model: 'fixture-model', secretPersistence: 'session-only' }),
      });
      context.capabilities.provide({
        key: 'ai.generate@1',
        invoke: async () => ({ text: '模型返回原文：整理完成。', provider: 'test', model: 'fixture-model' }),
      });
    },
  };
  const aiPlugin = createAIAssistantPlugin();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSelectionPlugin());
  harness.plugins.register(createConnectionsPlugin());
  harness.plugins.register(fakeProvider);
  harness.plugins.register(aiPlugin);
  await harness.plugins.start('text-node');
  await harness.plugins.start('selection');
  await harness.plugins.start('connections');
  await harness.plugins.start('test-ai-provider');
  await harness.plugins.start('ai-assistant');
  const projectNode = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '项目资料', body: '这是要被引用的项目事实。' },
    'core.test',
  );
  assert.equal(aiPlugin.manifest.commands.includes('ai.session.create'), false);
  const nodesBeforeAssistantOpen = (await harness.capabilities.request<Array<{ id: string }>>(
    'content.summaries@1',
  )).length;
  await harness.router.dispatch('ai.open', undefined, 'core.test');
  const active = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.activeSessionId ? next : undefined;
  });
  const session = active.sessions.find((item) => item.id === active.activeSessionId)!;
  assert.equal(session.transcriptSourceId, undefined);
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1')).length,
    nodesBeforeAssistantOpen,
  );
  let prepared: AIPreparedContext | undefined;
  const unsubscribe = harness.router.subscribeSignal('core.test', 'ai.context.ready', (message) => {
    prepared = message.payload as AIPreparedContext;
  });
  const originalPrompt = `@改写 请处理 ProjectOrchid @[项目资料](${projectNode.id})，不要增加事实。\n@确认 项目交付日期：2030-10-20`;
  await harness.router.dispatch(
    'ai.context.prepare',
    { sessionId: session.id, prompt: originalPrompt, operation: 'general' },
    'core.test',
  );
  const firstContext = await waitFor(async () => prepared);
  assert.equal(firstContext.operation, 'rewrite');
  assert.equal(firstContext.review?.reason, 'memory-state-change');
  assert.equal(firstContext.sources.some((source) => source.title === '项目资料' && source.reason === 'explicit-reference'), true);
  assert.ok(firstContext.totalCharacters <= 12_000 + originalPrompt.length);
  await harness.router.dispatch('ai.generation.start', { preparationId: firstContext.id }, 'core.test');
  const generated = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.proposals.length === 1 ? next : undefined;
  });
  const proposal = generated.proposals[0];
  const transcript = await harness.router.ask<{ text: string }>(
    'ai.transcript',
    { sessionId: session.id },
    'core.test',
  );
  assert.match(transcript.text, new RegExp(originalPrompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(transcript.text, /模型返回原文：整理完成。/);
  const persistence = await harness.router.ask<PersistenceSnapshot>('system.persistence', undefined, 'core.test');
  const autosaveTask = await waitFor(async () => harness.tasks.snapshot().tasks.find((task) =>
    task.category === 'ai-conversation-autosave-delay'));
  assert.equal(autosaveTask.delayMs, persistence.autosaveIntervalMs);
  await harness.router.dispatch('system.persistence.setAutosaveInterval', { intervalMs: 120_000 }, 'core.test');
  const rescheduledAutosave = await waitFor(async () => harness.tasks.snapshot().tasks.find((task) =>
    task.category === 'ai-conversation-autosave-delay' && task.id !== autosaveTask.id));
  assert.equal(rescheduledAutosave.delayMs, 120_000);
  await harness.router.dispatch(
    'system.persistence.setAutosaveInterval',
    { intervalMs: AUTOSAVE_DISABLED_INTERVAL_MS },
    'core.test',
  );
  await waitFor(async () => harness.tasks.snapshot().tasks.some((task) =>
    task.category === 'ai-conversation-autosave-delay') ? undefined : true);
  const nodesBefore = (await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1')).length;
  const historyBefore = harness.history.getState().undoCount;
  await assert.rejects(
    () => harness.router.dispatch('ai.proposal.accept', {
      proposalId: proposal.id,
      target: { mode: 'new', title: '不应创建的节点' },
    }, 'core.test'),
    /Invalid command payload/u,
  );
  const accepted = await harness.router.dispatch<{ nodeId: string }>(
    'ai.proposal.accept',
    { proposalId: proposal.id },
    'core.test',
  );
  assert.equal(harness.history.getState().undoCount, historyBefore + 1);
  assert.equal((await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1')).length, nodesBefore);
  assert.equal(accepted.nodeId, projectNode.id);
  await harness.transactions.undo();
  assert.match((await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: projectNode.id, start: 0, length: 1000,
  })).text, /这是要被引用的项目事实/u);
  const afterUndo = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  assert.equal(afterUndo.proposals.find((item) => item.id === proposal.id)?.status, 'pending');

  prepared = undefined;
  await harness.router.dispatch(
    'ai.context.prepare',
    {
      sessionId: session.id,
      prompt: `继续整理 @[项目资料](${projectNode.id})。\n@修改 项目交付日期：2030-10-20 -> 2030-11-05`,
      operation: 'rewrite',
    },
    'core.test',
  );
  const secondContext = await waitFor(async () => prepared);
  assert.equal(secondContext.sources.some((source) => source.reason === 'recent-conversation'), true);
  await harness.router.dispatch('ai.generation.start', { preparationId: secondContext.id }, 'core.test');
  const secondProposal = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.proposals.length === 2 ? next.proposals[0] : undefined;
  });
  const projectRevision = (await harness.capabilities.request<Array<{ id: string; revision: number; length: number }>>(
    'content.summaries@1',
  )).find((item) => item.id === projectNode.id)!;
  await assert.doesNotReject(() => harness.router.dispatch(
    'ai.proposal.accept',
    {
      proposalId: secondProposal.id,
      target: { mode: 'append', nodeId: projectNode.id, expectedRevision: projectRevision.revision },
    },
    'core.test',
  ));
  assert.match(
    (await harness.capabilities.request<{ text: string }>('content.read@1', {
      nodeId: projectNode.id,
      start: 0,
      length: 1000,
    })).text,
    /模型返回原文：整理完成。/,
  );
  await harness.transactions.undo();
  const replaceRevision = (await harness.capabilities.request<Array<{ id: string; revision: number; length: number }>>(
    'content.summaries@1',
  )).find((item) => item.id === projectNode.id)!;
  await harness.router.dispatch('ai.proposal.accept', {
    proposalId: secondProposal.id,
    target: {
      mode: 'replace',
      nodeId: projectNode.id,
      expectedRevision: replaceRevision.revision,
      start: 0,
      end: replaceRevision.length,
    },
  }, 'core.test');
  assert.equal(
    (await harness.capabilities.request<{ text: string }>('content.read@1', {
      nodeId: projectNode.id,
      start: 0,
      length: 1000,
    })).text,
    '模型返回原文：整理完成。',
  );

  const historyBeforeMemorySave = harness.history.getState().undoCount;
  const nodesBeforeMemorySave = (await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1')).length;
  let memoryCatalogInvalidated = false;
  const removeMemoryCatalogInvalidation = harness.router.subscribeSignal(
    'core.test',
    'ai.memory.invalidated',
    () => { memoryCatalogInvalidated = true; },
  );
  await harness.router.dispatch('ai.session.save', { sessionId: session.id }, 'core.test');
  const memoryIndex = await waitFor(async () => {
    const indexes = await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test');
    return indexes[0];
  });
  await waitFor(async () => memoryCatalogInvalidated ? true : undefined);
  removeMemoryCatalogInvalidation();
  assert.equal(memoryIndex.keywords.includes('projectorchid'), true);
  assert.notEqual(memoryIndex.sourceId, session.transcriptSourceId);
  assert.ok(memoryIndex.indexNodeId);
  assert.equal(memoryIndex.hubNodeId, undefined);
  assert.equal(memoryIndex.connectionIds, undefined);
  assert.equal(memoryIndex.enabled, true);
  assert.equal(memoryIndex.claims?.some((claim) => claim.kind === 'confirm' && claim.value === '2030-10-20'), true);
  assert.equal(memoryIndex.claims?.some((claim) => claim.kind === 'modify' && claim.value === '2030-11-05'), true);
  assert.equal(harness.history.getState().undoCount, historyBeforeMemorySave + 1);
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1')).length,
    nodesBeforeMemorySave,
  );
  assert.equal((await harness.capabilities.request<Array<unknown>>('connections.list@1')).length, 0);
  const archivedTranscript = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: memoryIndex.sourceId,
    start: 0,
    length: memoryIndex.sourceLength,
  });
  assert.match(archivedTranscript.text, new RegExp(originalPrompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(archivedTranscript.text, /模型返回原文：整理完成。/);
  const readableIndex = await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: memoryIndex.indexNodeId!,
    start: 0,
    length: 20_000,
  });
  assert.match(readableIndex.text, /AI 对话记忆索引 v2/);
  assert.match(readableIndex.text, /\[修改\] 项目交付日期：2030-10-20 → 2030-11-05/);
  const initialMemoryCatalog = await harness.router.ask<AIMemoryCatalogSnapshot>(
    'ai.memoryCatalog', undefined, 'core.test',
  );
  assert.equal(initialMemoryCatalog.entries[0]?.status, 'ready');
  assert.deepEqual(initialMemoryCatalog.counts, { total: 1, ready: 1, paused: 0, attention: 0 });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      (await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test')).sessions
        .find((item) => item.id === session.id) ?? {},
      'memoryIndex',
    ),
    false,
  );
  assert.doesNotMatch(
    (await harness.router.ask<{ text: string }>('ai.transcript', { sessionId: session.id }, 'core.test')).text,
    /当前对话已保存为原文记忆节点[\s\S]*索引节点：[\s\S]*关键索引：/,
  );

  const memoryAssistant = (await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test'))
    .assistants.find((assistant) => assistant.sessionId === session.id)!;
  const memorySelectionHistory = harness.history.getState().undoCount;
  await harness.router.dispatch('ai.assistant.setMemories', {
    assistantId: memoryAssistant.id,
    sourceIds: [memoryIndex.sourceId],
  }, 'core.test');
  assert.deepEqual(
    (await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test')).assistants
      .find((assistant) => assistant.id === memoryAssistant.id)?.memorySourceIds,
    [memoryIndex.sourceId],
  );
  assert.equal(harness.history.getState().undoCount, memorySelectionHistory);
  prepared = undefined;
  await harness.router.dispatch('ai.context.prepare', {
    sessionId: session.id,
    prompt: '这是一个没有索引关键词的追问',
    operation: 'general',
    memorySourceIds: [memoryIndex.sourceId],
  }, 'core.test');
  const manuallyScoped = await waitFor(async () => prepared);
  assert.deepEqual(manuallyScoped.selectedMemorySourceIds, [memoryIndex.sourceId]);
  const manuallySelectedEvidence = manuallyScoped.sources.find((source) =>
    source.sourceId === memoryIndex.sourceId && source.reason === 'conversation-memory');
  assert.ok(manuallySelectedEvidence);
  assert.match(manuallySelectedEvidence.text, /ProjectOrchid/u);
  assert.match(manuallySelectedEvidence.text, /\[用户/u);
  await harness.router.dispatch('ai.close', { assistantId: memoryAssistant.id }, 'core.test');
  const minimized = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  assert.equal(minimized.assistants.length, 1);
  assert.equal(minimized.assistants[0]?.minimized, true);
  assert.equal(minimized.open, false);
  await harness.router.dispatch('ai.assistant.openSession', { sessionId: session.id }, 'core.test');
  const reopenedMemoryAssistant = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.assistants[0]?.memorySourceIds?.[0] === memoryIndex.sourceId ? next.assistants[0] : undefined;
  });
  assert.equal(reopenedMemoryAssistant.sessionId, session.id);

  prepared = undefined;
  await harness.router.dispatch(
    'ai.context.prepare',
    { sessionId: session.id, prompt: '请回忆 ProjectOrchid 的讨论', operation: 'general' },
    'core.test',
  );
  const remembered = await waitFor(async () => prepared);
  assert.equal(
    remembered.sources.some((source) =>
      source.sourceId === memoryIndex.sourceId && source.reason === 'conversation-memory'),
    true,
  );
  const rememberedEvidence = remembered.sources.find((source) =>
    source.sourceId === memoryIndex.sourceId && source.reason === 'conversation-memory')!;
  assert.equal(rememberedEvidence.complete, true);
  assert.notEqual(rememberedEvidence.boundary, 'range');
  assert.match(rememberedEvidence.text, /ProjectOrchid/u);
  prepared = undefined;
  await harness.router.dispatch(
    'ai.context.prepare',
    { sessionId: session.id, prompt: '项目当前交付日期是什么？', operation: 'general' },
    'core.test',
  );
  const conflictChecked = await waitFor(async () => prepared);
  assert.equal(conflictChecked.memoryConflicts?.[0]?.resolution, 'resolved-by-explicit-modification');
  assert.equal(conflictChecked.memoryConflicts?.[0]?.currentValue, '2030-11-05');
  await harness.transactions.undo();
  assert.equal(
    (await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test')).length,
    0,
  );
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1'))
      .some((item) => item.id === memoryIndex.sourceId),
    false,
  );
  assert.equal((await harness.capabilities.request<Array<unknown>>('connections.list@1')).length, 0);
  await harness.transactions.redo();
  assert.equal(
    (await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test'))[0]?.sourceId,
    memoryIndex.sourceId,
  );
  prepared = undefined;
  await harness.router.dispatch(
    'ai.context.prepare',
    { sessionId: session.id, prompt: '@确认 项目交付日期：2030-12-01', operation: 'general' },
    'core.test',
  );
  const thirdContext = await waitFor(async () => prepared);
  const beforeThirdGeneration = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  const thirdSessionRevision = beforeThirdGeneration.sessions.find((item) => item.id === session.id)!.revision;
  const proposalCountBeforeThirdGeneration = beforeThirdGeneration.proposals.length;
  await harness.router.dispatch('ai.generation.start', { preparationId: thirdContext.id }, 'core.test');
  await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return (next.sessions.find((item) => item.id === session.id)?.revision ?? 0) > thirdSessionRevision + 1
      ? next
      : undefined;
  });
  assert.equal(
    (await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test')).proposals.length,
    proposalCountBeforeThirdGeneration,
  );
  const nodeCountBeforeOverwrite = (await harness.capabilities.request<Array<{ id: string }>>(
    'content.summaries@1',
  )).length;
  await harness.router.dispatch('ai.session.save', { sessionId: session.id }, 'core.test');
  const overwrittenMemory = await waitFor(async () => {
    const indexes = await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test');
    return indexes.length === 1 && (indexes[0].updatedAt ?? 0) > (memoryIndex.updatedAt ?? 0)
      ? indexes[0]
      : undefined;
  });
  assert.equal(overwrittenMemory.sourceId, memoryIndex.sourceId);
  assert.equal(overwrittenMemory.indexNodeId, memoryIndex.indexNodeId);
  assert.equal(overwrittenMemory.hubNodeId, memoryIndex.hubNodeId);
  assert.equal((await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1')).length,
    nodeCountBeforeOverwrite);
  assert.equal((await harness.capabilities.request<Array<unknown>>('connections.list@1')).length, 0);
  assert.match((await harness.capabilities.request<{ text: string }>('content.read@1', {
    nodeId: overwrittenMemory.sourceId,
    start: 0,
    length: overwrittenMemory.sourceLength,
  })).text, /2030-12-01/);
  const archivedBeforeEdit = (await harness.capabilities.request<Array<{ id: string; revision: number; length: number }>>(
    'content.summariesById@1', { nodeIds: [overwrittenMemory.sourceId] },
  ))[0]!;
  await harness.router.dispatch('content.applyDelta', {
    nodeId: overwrittenMemory.sourceId,
    expectedRevision: archivedBeforeEdit.revision,
    start: archivedBeforeEdit.length,
    deleteCount: 0,
    insert: '\n修订原文存档',
  }, 'core.test');
  prepared = undefined;
  await harness.router.dispatch(
    'ai.context.prepare',
    { sessionId: session.id, prompt: '完整回忆所有 ProjectOrchid 资料', operation: 'general' },
    'core.test',
  );
  const staleChecked = await waitFor(async () => prepared);
  assert.equal(staleChecked.memoryIssues?.some((issue) =>
    issue.sourceId === overwrittenMemory.sourceId && issue.reason === 'source-revision-changed'), true);
  assert.equal(staleChecked.sources.some((source) =>
    source.sourceId === overwrittenMemory.sourceId && source.staleIndexRevision === overwrittenMemory.sourceRevision), true);
  assert.equal(staleChecked.memoryRetrieval?.staleCandidatesRecovered, 1);
  assert.equal((await harness.router.ask<AIMemoryCatalogSnapshot>(
    'ai.memoryCatalog', undefined, 'core.test',
  )).entries.find((entry) => entry.memory.sourceId === overwrittenMemory.sourceId)?.status, 'source-revision-changed');
  const rebuiltCatalog = await waitFor(async () => {
    const next = await harness.router.ask<AIMemoryCatalogSnapshot>('ai.memoryCatalog', undefined, 'core.test');
    return next.entries.find((entry) => entry.memory.sourceId === overwrittenMemory.sourceId)?.status === 'ready'
      ? next : undefined;
  }, 4_000);
  const rebuiltMemory = rebuiltCatalog.entries.find((entry) => entry.memory.sourceId === overwrittenMemory.sourceId)!.memory;
  assert.ok((rebuiltMemory.updatedAt ?? 0) > rebuiltMemory.createdAt);
  await harness.router.dispatch('ai.memory.setScope', {
    sourceId: memoryIndex.sourceId,
    scope: '客户A · 正式环境',
  }, 'core.test');
  assert.equal((await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test'))
    .find((item) => item.sourceId === memoryIndex.sourceId)?.scope, '客户A · 正式环境');
  prepared = undefined;
  await harness.router.dispatch(
    'ai.context.prepare',
    { sessionId: session.id, prompt: '客户A · 正式环境 ProjectOrchid', operation: 'general' },
    'core.test',
  );
  const scopedChecked = await waitFor(async () => prepared);
  assert.equal(scopedChecked.sources.some((source) =>
    source.sourceId === memoryIndex.sourceId && source.reason === 'conversation-memory'), true);
  prepared = undefined;
  await harness.router.dispatch('ai.context.prepare', {
    sessionId: session.id,
    prompt: '@确认 测试环境｜超时时间：5秒\n@确认 生产环境｜超时时间：30秒\n' +
      '@确认 项目=客户A；环境=生产｜重试次数：3次\n@确认 环境=生产；项目=客户A｜重试次数：5次',
    operation: 'general',
  }, 'core.test');
  const scopedClaimContext = await waitFor(async () => prepared);
  const beforeScopedClaimGeneration = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  const scopedClaimSessionRevision = beforeScopedClaimGeneration.sessions
    .find((item) => item.id === session.id)!.revision;
  const scopedClaimProposalCount = beforeScopedClaimGeneration.proposals.length;
  await harness.router.dispatch('ai.generation.start', { preparationId: scopedClaimContext.id }, 'core.test');
  await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return (next.sessions.find((item) => item.id === session.id)?.revision ?? 0) > scopedClaimSessionRevision + 1
      ? next
      : undefined;
  });
  assert.equal(
    (await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test')).proposals.length,
    scopedClaimProposalCount,
  );
  await harness.router.dispatch('ai.session.save', { sessionId: session.id }, 'core.test');
  const scopedMemory = await waitFor(async () => {
    const indexes = await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test');
    return indexes.find((index) =>
      index.claims?.some((claim) => claim.subject === '超时时间' && claim.scope === '测试环境'));
  });
  assert.equal(scopedMemory.claims?.some((claim) =>
    claim.subject === '超时时间' && claim.scope === '生产环境'), true);
  prepared = undefined;
  await harness.router.dispatch(
    'ai.context.prepare',
    { sessionId: session.id, prompt: '测试环境和生产环境的超时时间分别是什么？', operation: 'general' },
    'core.test',
  );
  const scopedConflictChecked = await waitFor(async () => prepared);
  assert.equal(scopedConflictChecked.memoryConflicts?.some((conflict) => conflict.subject === '超时时间'), false);
  assert.equal(scopedConflictChecked.memoryConflicts?.some((conflict) =>
    conflict.subject === '重试次数' && conflict.resolution === 'unresolved'), true);
  await harness.router.dispatch('ai.memory.setEnabled', { sourceId: memoryIndex.sourceId, enabled: false }, 'core.test');
  prepared = undefined;
  await harness.router.dispatch(
    'ai.context.prepare',
    { sessionId: session.id, prompt: '客户A · 正式环境 ProjectOrchid', operation: 'general' },
    'core.test',
  );
  const pausedChecked = await waitFor(async () => prepared);
  assert.equal(pausedChecked.sources.some((source) =>
    source.sourceId === memoryIndex.sourceId && source.reason === 'conversation-memory'), false);
  await harness.transactions.undo();
  assert.equal((await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test'))
    .find((item) => item.sourceId === memoryIndex.sourceId)?.enabled, true);
  const viewHistoryBefore = harness.history.getState().undoCount;
  await harness.router.dispatch('ai.setView', 'memory', 'core.test');
  assert.equal((await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test')).view, 'memory');
  assert.equal(harness.history.getState().undoCount, viewHistoryBefore);
  await harness.router.dispatch('ai.setComposerHeight', { height: 240 }, 'core.test');
  assert.equal(
    (await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test')).composerHeight,
    240,
  );
  assert.equal(harness.history.getState().undoCount, viewHistoryBefore);
  await assert.rejects(
    () => harness.router.dispatch('ai.setComposerHeight', { height: 40 }, 'core.test'),
    /Invalid command payload/u,
  );
  await assert.rejects(
    () => harness.router.dispatch('ai.setView', 'guide', 'core.test'),
    /Invalid command payload/u,
  );
  await harness.router.dispatch('ai.close', undefined, 'core.test');
  await harness.router.dispatch('ai.open', undefined, 'core.test');
  assert.equal(
    (await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test')).sessions.length,
    1,
  );
  unsubscribe();

  const proposalCountBeforeRestart = (await harness.router.ask<AIAssistantState>(
    'ai.state', undefined, 'core.test',
  )).proposals.length;
  await harness.plugins.stop('ai-assistant');
  assert.equal(harness.resources.count('ai-assistant'), 0);
  await harness.plugins.start('ai-assistant');
  const restored = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.proposals.length, proposalCountBeforeRestart);
  assert.equal(restored.composerHeight, 240);
});

test('AI assistant opens independent windows without mixing workspace state', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createAIAssistantPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('ai-assistant');

  await harness.router.dispatch('ai.open', undefined, 'core.test');
  const initial = await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return state.assistants.length === 1 ? state : undefined;
  });
  await harness.router.dispatch('ai.setComposerHeight', {
    assistantId: initial.assistants[0].id,
    height: 320,
  }, 'core.test');
  await harness.router.dispatch('ai.setPanelRect', {
    assistantId: initial.assistants[0].id,
    rect: { x: 120, y: 90, width: 680, height: 760 },
  }, 'core.test');
  await harness.router.dispatch('ai.assistant.setProvider', {
    assistantId: initial.assistants[0].id,
    resourceId: 'provider:first',
  }, 'core.test');
  await harness.router.dispatch('ai.assistant.setWebSearch', {
    assistantId: initial.assistants[0].id,
    enabled: true,
  }, 'core.test');
  await harness.router.dispatch('ai.assistant.setPromptTemplate', {
    assistantId: initial.assistants[0].id,
    resourceId: 'prompt:first',
  }, 'core.test');
  const historyBefore = harness.history.getState().undoCount;
  const created = await harness.router.dispatch<{ assistantId: string; sessionId: string }>(
    'ai.assistant.openNew',
    undefined,
    'core.test',
  );
  const opened = await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return state.assistants.length === 2 ? state : undefined;
  });
  assert.equal(opened.assistants.length, 2);
  assert.equal(opened.sessions.length, 2);
  assert.notEqual(created.sessionId, initial.activeSessionId);
  assert.equal(opened.assistants.some((assistant) => assistant.id === created.assistantId), true);
  const independent = opened.assistants.find((assistant) => assistant.id === created.assistantId)!;
  assert.equal(independent.composerHeight, 76);
  assert.notEqual(independent.rect.x, 120);
  assert.notEqual(independent.rect.width, 680);
  assert.equal(independent.providerProfileId, undefined);
  assert.equal(independent.promptTemplateId, undefined);
  assert.equal(independent.webSearchEnabled, undefined);
  assert.equal(harness.history.getState().undoCount, historyBefore);

  await harness.router.dispatch('ai.assistant.setProvider', {
    assistantId: created.assistantId,
    resourceId: 'provider:second',
  }, 'core.test');
  await harness.router.dispatch('ai.assistant.setPromptTemplate', {
    assistantId: created.assistantId,
    resourceId: 'prompt:second',
  }, 'core.test');
  await harness.router.dispatch('ai.setComposerHeight', {
    assistantId: created.assistantId,
    height: 260,
  }, 'core.test');
  const resized = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  assert.equal(resized.assistants.find((assistant) => assistant.id === created.assistantId)?.composerHeight, 260);
  assert.notEqual(resized.assistants[0].composerHeight, 260);
  assert.equal(resized.assistants[0].providerProfileId, 'provider:first');
  assert.equal(resized.assistants[0].webSearchEnabled, true);
  assert.equal(resized.assistants[0].promptTemplateId, 'prompt:first');
  assert.equal(resized.assistants.find((assistant) => assistant.id === created.assistantId)?.providerProfileId, 'provider:second');
  assert.equal(resized.assistants.find((assistant) => assistant.id === created.assistantId)?.promptTemplateId, 'prompt:second');
  assert.equal(resized.assistants.find((assistant) => assistant.id === created.assistantId)?.webSearchEnabled, undefined);

  await harness.router.dispatch('ai.assistant.delete', { assistantId: created.assistantId }, 'core.test');
  const deleted = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.assistants.length === 1 && next.sessions.length === 1 ? next : undefined;
  });
  assert.equal(deleted.assistants.length, 1);
  assert.equal(deleted.sessions.length, 1);
  assert.equal(deleted.assistants[0].sessionId, initial.activeSessionId);
  assert.equal(deleted.assistants[0].providerProfileId, 'provider:first');
  assert.equal(deleted.assistants[0].promptTemplateId, 'prompt:first');
});

test('a deleted assistant can be restored from its memory card with exact prior transcript evidence', async () => {
  const harness = createHarness(4);
  let prepared: AIPreparedContext | undefined;
  const provider: PluginDefinition = {
    manifest: defineManifest('restore-memory-provider', '记忆恢复模型', {
      providesCapabilities: ['ai.generate@1'],
    }),
    start(context) {
      context.capabilities.provide({
        key: 'ai.generate@1',
        invoke: async () => ({ text: '原始回答：发布窗口是周五。', provider: 'fixture', model: 'fixture' }),
      });
    },
  };
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createAIAssistantPlugin());
  harness.plugins.register(provider);
  await harness.plugins.start('text-node');
  await harness.plugins.start('ai-assistant');
  await harness.plugins.start('restore-memory-provider');
  const removePrepared = harness.router.subscribeSignal(
    'core.test',
    'ai.context.ready',
    (message) => { prepared = message.payload as AIPreparedContext; },
  );

  await harness.router.dispatch('ai.open', undefined, 'core.test');
  const initial = await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return state.assistants[0] && state.sessions[0]
      ? { assistant: state.assistants[0], session: state.sessions[0] }
      : undefined;
  });
  await harness.router.dispatch('ai.context.prepare', {
    assistantId: initial.assistant.id,
    sessionId: initial.session.id,
    prompt: '我们之前确定的发布窗口是什么？',
    operation: 'general',
  }, 'core.test');
  const firstPreparation = await waitFor(async () => prepared);
  await harness.router.dispatch('ai.generation.start', { preparationId: firstPreparation.id }, 'core.test');
  await waitFor(async () => {
    const transcript = await harness.router.ask<{ text: string }>(
      'ai.transcript', { sessionId: initial.session.id }, 'core.test',
    );
    return transcript.text.includes('原始回答') ? transcript : undefined;
  });
  await harness.router.dispatch('ai.session.save', { sessionId: initial.session.id }, 'core.test');
  const memory = await waitFor(async () => (
    await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test')
  )[0]);
  const spare = await harness.router.dispatch<{ assistantId: string; sessionId: string }>(
    'ai.assistant.openNew', undefined, 'core.test',
  );
  await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return state.assistants.some((assistant) => assistant.id === spare.assistantId) ? true : undefined;
  });
  await harness.router.dispatch('ai.assistant.delete', { assistantId: initial.assistant.id }, 'core.test');
  await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return state.sessions.some((session) => session.id === memory.sessionId) ? undefined : true;
  });

  const restored = await harness.router.dispatch<{ assistantId: string; restored?: boolean }>(
    'ai.assistant.continueMemory',
    { assistantId: spare.assistantId, sourceId: memory.sourceId },
    'core.test',
  );
  assert.equal(restored.restored, true);
  const restoredState = await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    const assistant = state.assistants.find((item) => item.id === restored.assistantId);
    const session = state.sessions.find((item) => item.id === memory.sessionId);
    return assistant && session ? { assistant, session } : undefined;
  });
  assert.equal(restoredState.session.transcriptSourceId, memory.sourceId);
  assert.deepEqual(restoredState.assistant.memorySourceIds, [memory.sourceId]);
  assert.match((await harness.router.ask<{ text: string }>(
    'ai.transcript', { sessionId: memory.sessionId }, 'core.test',
  )).text, /我们之前确定的发布窗口/u);

  prepared = undefined;
  await harness.router.dispatch('ai.context.prepare', {
    assistantId: restored.assistantId,
    sessionId: memory.sessionId,
    prompt: '我刚才问过什么？',
    operation: 'general',
  }, 'core.test');
  const followUp = await waitFor(async () => prepared);
  assert.deepEqual(followUp.selectedMemorySourceIds, [memory.sourceId]);
  assert.equal(followUp.sources.some((source) => source.sourceId === memory.sourceId &&
    source.text.includes('我们之前确定的发布窗口')), true);
  removePrepared();
});

test('AI Prompt templates round-trip through a readable local TXT file without carrying internal metadata', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createAIAssistantPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('ai-assistant');
  const saved = await harness.router.dispatch<{ id: string }>('ai.promptTemplate.save', {
    name: '本地模板',
    systemInstruction: '严格核对事实。',
    userInstruction: '执行 {{operation}}。',
  }, 'core.test');
  let serialized = '';
  const destination = {
    name: '本地模板.txt',
    createWritable: async () => ({
      write: async (blob: Blob) => { serialized = await blob.text(); },
      close: async () => undefined,
    }),
  };
  await harness.router.dispatch('ai.promptTemplate.export', {
    templateId: saved.id,
    destination,
  }, 'core.test');
  assert.match(serialized, /^模板名称：本地模板/u);
  assert.match(serialized, /系统工作方式：\n严格核对事实。/u);
  assert.match(serialized, /本次任务前缀：\n执行 \{\{operation\}\}。/u);
  assert.equal(serialized.trimStart().startsWith('{'), false);
  assert.equal(serialized.includes(saved.id), false);

  const source = {
    ...destination,
    getFile: async () => ({
      size: new TextEncoder().encode(serialized).byteLength,
      text: async () => serialized,
    }),
  };
  const imported = await harness.router.dispatch<{ id: string }>('ai.promptTemplate.import', {
    source,
  }, 'core.test');
  assert.notEqual(imported.id, saved.id);
  const catalog = await harness.router.ask<AIPromptTemplateCatalog>('ai.promptTemplates', undefined, 'core.test');
  assert.equal(catalog.templates.length, 2);
  assert.equal(catalog.activeTemplateId, imported.id);
  assert.equal(catalog.templates.find((template) => template.id === imported.id)?.name, '本地模板 (2)');
});

test('AI memories relink from paired TXT files and overwrite the same local original and index files', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createEditorPlugin());
  harness.plugins.register(createAIAssistantPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('editor');
  await harness.plugins.start('ai-assistant');
  const originalText = '[用户 · 通用]\n请记住项目代号 ProjectAurora。\n\n[助手 · 通用]\n已经记录。';
  const indexText = [
    'AI 对话记忆索引 v2',
    '',
    '原文记忆：极光项目讨论',
    '',
    '关键词',
    'ProjectAurora、极光项目',
    '',
    '目录摘要（仅用于定位，不是记忆原文）',
    '讨论了极光项目的代号。',
    '',
    '用户明确记忆指令',
    '暂无。',
  ].join('\n');
  const sourceHandle = (name: string, text: string) => ({
    name,
    createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
    getFile: async () => new File([text], name, { type: 'text/plain' }),
  });
  await harness.router.dispatch('ai.memory.importFiles', {
    sources: [
      sourceHandle('极光-memory01-对话原文.txt', originalText),
      sourceHandle('极光-memory01-检索索引.txt', indexText),
    ],
  }, 'core.test');
  const memory = await waitFor(async () => {
    const records = await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test');
    return records[0];
  });
  assert.equal(memory.title, '极光项目讨论');
  assert.equal(memory.localFileStem, '极光-memory01');
  assert.equal(memory.keywords.includes('ProjectAurora'), true);
  const importedSession = (await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test'))
    .sessions.find((session) => session.id === memory.sessionId)!;
  assert.equal(importedSession.turns, 2);
  assert.equal(
    (await harness.router.ask<{ text: string }>('ai.transcript', { sessionId: memory.sessionId }, 'core.test')).text,
    originalText,
  );

  const files = new Map<string, string>();
  const directory = {
    name: '画布文件夹',
    getFileHandle: async (name: string) => ({
      name,
      createWritable: async () => {
        let next = '';
        return {
          write: async (blob: Blob) => { next += await blob.text(); },
          close: async () => { files.set(name, next); },
          abort: async () => undefined,
        };
      },
    }),
    removeEntry: async (name: string) => { files.delete(name); },
  };
  await harness.router.dispatch('ai.memory.linkDirectory', { directory }, 'core.test');
  await waitFor(async () => files.size === 2 ? true : undefined);
  assert.equal(files.get('极光-memory01-对话原文.txt'), originalText);
  assert.match(files.get('极光-memory01-检索索引.txt') ?? '', /ProjectAurora/u);
  const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  assert.equal(state.memoryFiles.linked, true);
  assert.equal(state.memoryFiles.directoryName, '画布文件夹');

  await harness.router.dispatch('editor.open', { id: memory.sourceId }, 'core.test');
  let renamedEditorMetadata = false;
  const removeInvalidation = harness.router.subscribeSignal(
    'core.test',
    'editor.document.invalidated',
    (message) => {
      const metadataIds = (message.payload as { metadataIds?: string[] }).metadataIds ?? [];
      if (metadataIds.includes(memory.sourceId)) renamedEditorMetadata = true;
    },
  );
  await harness.router.dispatch('ai.memory.rename', {
    sourceId: memory.sourceId,
    title: '极光计划',
  }, 'core.test');
  const renamedMemory = await waitFor(async () => {
    const record = (await harness.router.ask<AIMemoryIndexRecord[]>(
      'ai.memoryIndexes', undefined, 'core.test',
    ))[0];
    return record?.title === '极光计划' ? record : undefined;
  });
  const renamedSummaries = await harness.capabilities.request<ContentSummary[]>('content.summariesById@1', {
    nodeIds: [renamedMemory.sourceId, renamedMemory.indexNodeId],
  });
  assert.equal(renamedSummaries.find((summary) => summary.id === renamedMemory.sourceId)?.title, '极光计划');
  assert.equal(
    renamedSummaries.find((summary) => summary.id === renamedMemory.indexNodeId)?.title,
    '极光计划 · 记忆索引',
  );
  assert.equal(renamedEditorMetadata, true);
  await waitFor(async () => (
    files.has(`${renamedMemory.localFileStem}-对话原文.txt`) &&
    files.has(`${renamedMemory.localFileStem}-检索索引.txt`) &&
    !files.has('极光-memory01-对话原文.txt') &&
    !files.has('极光-memory01-检索索引.txt')
  ) ? true : undefined, 3_000);
  assert.match(files.get(`${renamedMemory.localFileStem}-检索索引.txt`) ?? '', /原文记忆：极光计划/u);
  removeInvalidation();

  const historyBeforeDeleteRequest = harness.history.getState().undoCount;
  await harness.router.dispatch('ai.memory.delete.request', { sourceId: renamedMemory.sourceId }, 'core.test');
  assert.deepEqual(
    await harness.router.ask('ai.memory.deleteConfirmation', undefined, 'core.test'),
    { sourceId: renamedMemory.sourceId, title: '极光计划' },
  );
  assert.equal(harness.ui.topSurface(['overlay.modal'])?.id, 'ai.memory.deleteConfirm');
  assert.equal(harness.history.getState().undoCount, historyBeforeDeleteRequest);
  await harness.router.dispatch('ai.memory.delete.cancel', undefined, 'core.test');
  assert.equal(await harness.router.ask('ai.memory.deleteConfirmation', undefined, 'core.test'), undefined);
  assert.equal(harness.ui.topSurface(['overlay.modal']), undefined);

  await harness.router.dispatch('ai.memory.delete.request', { sourceId: renamedMemory.sourceId }, 'core.test');
  await harness.router.dispatch('ai.memory.delete.confirm', { sourceId: renamedMemory.sourceId }, 'core.test');
  assert.equal((await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test')).length, 0);
  assert.equal(harness.ui.topSurface(['overlay.modal']), undefined);
  assert.equal(harness.history.getState().undoCount, historyBeforeDeleteRequest + 1);
  await harness.transactions.undo();
  assert.equal((await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test'))[0]?.sourceId, renamedMemory.sourceId);
});

test('AI assistant keeps concurrent generation tasks and stream signals scoped to each session', async () => {
  const harness = createHarness(4);
  const fakeProvider = {
    manifest: defineManifest('test-multi-assistant-provider', '多助手测试模型', {
      providesCapabilities: ['ai.generate.stream@1', 'ai.provider.info@1'],
    }),
    start(context: Parameters<ReturnType<typeof createAIAssistantPlugin>['start']>[0]) {
      context.capabilities.provide({
        key: 'ai.provider.info@1',
        invoke: () => ({
          id: 'multi-test', label: '多助手测试模型', configured: true,
          model: 'parallel-fixture', secretPersistence: 'session-only',
        }),
      });
      context.capabilities.provide<AIGenerateRequest, AIGenerateStream>({
        key: 'ai.generate.stream@1',
        invoke: (request) => {
          const label = request.messages.some((message) => message.content.includes('第二助手')) ? '第二结果' : '第一结果';
          return {
            provider: 'multi-test',
            model: 'parallel-fixture',
            events: (async function* () {
              await new Promise((resolve) => setTimeout(resolve, 60));
              yield { type: 'delta' as const, delta: label };
              yield { type: 'complete' as const };
            })(),
          };
        },
      });
    },
  };
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(fakeProvider);
  harness.plugins.register(createAIAssistantPlugin());
  harness.plugins.register(createImportExportPlugin());
  harness.router.registerQuery<undefined, ProjectSource>('core.persistence', {
    type: 'system.project.source',
    handle: () => ({
      document: harness.store.snapshot().document,
      history: harness.history.export(),
      plugins: [],
    }),
  });
  await harness.plugins.start('text-node');
  await harness.plugins.start('test-multi-assistant-provider');
  await harness.plugins.start('ai-assistant');
  await harness.plugins.start('import-export');

  await harness.router.dispatch('ai.open', undefined, 'core.test');
  await harness.router.dispatch('ai.assistant.openNew', undefined, 'core.test');
  const state = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.assistants.length === 2 ? next : undefined;
  });
  const [first, second] = state.assistants;
  const prepared = new Map<string, AIPreparedContext>();
  const deltas = new Map<string, string>();
  const removePrepared = harness.router.subscribeSignal('core.test', 'ai.context.ready', (message) => {
    const payload = message.payload as AIPreparedContext;
    prepared.set(payload.sessionId, payload);
  });
  const removeDelta = harness.router.subscribeSignal('core.test', 'ai.generation.delta', (message) => {
    const payload = message.payload as { sessionId: string; delta: string };
    deltas.set(payload.sessionId, (deltas.get(payload.sessionId) ?? '') + payload.delta);
  });
  await harness.router.dispatch('ai.context.prepare', {
    sessionId: first.sessionId, prompt: '第一助手任务', operation: 'general',
  }, 'core.test');
  await harness.router.dispatch('ai.context.prepare', {
    sessionId: second.sessionId, prompt: '第二助手任务', operation: 'general',
  }, 'core.test');
  await waitFor(async () => prepared.size === 2 ? true : undefined);
  await harness.router.dispatch('ai.generation.start', {
    preparationId: prepared.get(first.sessionId)!.id,
  }, 'core.test');
  await harness.router.dispatch('ai.generation.start', {
    preparationId: prepared.get(second.sessionId)!.id,
  }, 'core.test');
  const savedProject: Blob[] = [];
  let projectClosed = false;
  await harness.router.dispatch('file.saveProject', {
    destination: {
      name: '并发保存.echo8',
      createWritable: async () => ({
        write: async (part: Blob) => { savedProject.push(part); },
        close: async () => { projectClosed = true; },
      }),
    },
  }, 'core.test');
  await harness.router.dispatch('ai.close', { assistantId: first.id }, 'core.test');
  const minimizedDuringGeneration = await waitFor(async () => {
    const next = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return next.generationRuntimeBySession[first.sessionId]?.state === 'generating' ? next : undefined;
  });
  assert.equal(minimizedDuringGeneration.assistants.length, 2);
  assert.equal(minimizedDuringGeneration.assistants.find((assistant) => assistant.id === first.id)?.minimized, true);
  assert.equal(minimizedDuringGeneration.generationRuntimeBySession[first.sessionId]?.state, 'generating');
  await harness.router.dispatch('ai.assistant.focus', { assistantId: first.id }, 'core.test');
  const saveSnapshotDuringGeneration = structuredClone(harness.store.snapshot());
  assert.ok(saveSnapshotDuringGeneration.document.namespaces.aiSessions);
  await waitFor(async () => {
    const [firstTranscript, secondTranscript] = await Promise.all([
      harness.router.ask<{ text: string }>('ai.transcript', { sessionId: first.sessionId }, 'core.test'),
      harness.router.ask<{ text: string }>('ai.transcript', { sessionId: second.sessionId }, 'core.test'),
    ]);
    return firstTranscript.text.includes('第一结果') && secondTranscript.text.includes('第二结果') ? true : undefined;
  });
  await waitFor(async () => projectClosed ? true : undefined);
  assert.equal((await parseProject(new Blob(savedProject))).manifest.kind, PROJECT_KIND);
  const completed = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
  assert.equal(completed.proposals.filter((proposal) =>
    proposal.sessionId === first.sessionId || proposal.sessionId === second.sessionId).length, 0);
  assert.equal(deltas.get(first.sessionId), '第一结果');
  assert.equal(deltas.get(second.sessionId), '第二结果');

  await harness.router.dispatch('ai.session.save', { sessionId: first.sessionId }, 'core.test');
  await harness.router.dispatch('ai.session.save', { sessionId: second.sessionId }, 'core.test');
  const memories = await waitFor(async () => {
    const next = await harness.router.ask<AIMemoryIndexRecord[]>('ai.memoryIndexes', undefined, 'core.test');
    return next.length === 2 ? next : undefined;
  });
  const firstMemory = memories.find((memory) => memory.sessionId === first.sessionId)!;
  const secondMemory = memories.find((memory) => memory.sessionId === second.sessionId)!;
  await harness.router.dispatch('ai.assistant.setMemories', {
    assistantId: first.id,
    sourceIds: [firstMemory.sourceId],
  }, 'core.test');
  const previousPreparationId = prepared.get(first.sessionId)!.id;
  await harness.router.dispatch('ai.context.prepare', {
    assistantId: first.id,
    sessionId: first.sessionId,
    prompt: '请根据第二结果说明内容',
    operation: 'general',
  }, 'core.test');
  const strictlyScoped = await waitFor(async () => {
    const next = prepared.get(first.sessionId);
    return next && next.id !== previousPreparationId ? next : undefined;
  });
  assert.deepEqual(strictlyScoped.selectedMemorySourceIds, [firstMemory.sourceId]);
  assert.equal(strictlyScoped.sources.some((source) =>
    source.sourceId === secondMemory.sourceId || source.sourceId === secondMemory.indexNodeId), false);
  removePrepared();
  removeDelta();
});

test('AI model settings are embedded in the assistant slot and never claim the right rail', async () => {
  const harness = createHarness();
  const assistant = createAIAssistantPlugin();
  const provider = createAIProviderPlugin({});
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(assistant);
  harness.plugins.register(provider);
  await harness.plugins.start('text-node');
  await harness.plugins.start('ai-assistant');
  await harness.plugins.start('ai-provider');
  const nodeCountBeforeOpen = (await harness.capabilities.request<Array<{ id: string }>>(
    'content.summaries@1',
  )).length;

  assert.deepEqual(harness.ui.list('ai.settings').map((item) => item.owner), ['ai-provider']);
  assert.deepEqual(harness.ui.list('ai.retrieval'), []);
  assert.equal(harness.ui.list('right.primary').some((item) => item.owner === 'ai-provider'), false);
  await harness.router.dispatch('ai.openProviderSettings', undefined, 'core.test');
  const opened = await waitFor(async () => {
    const state = await harness.router.ask<AIAssistantState>('ai.state', undefined, 'core.test');
    return state.open && state.view === 'provider' ? state : undefined;
  });
  assert.ok(opened.activeSessionId);
  assert.equal(
    (await harness.capabilities.request<Array<{ id: string }>>('content.summaries@1')).length,
    nodeCountBeforeOpen,
  );
  assert.equal(harness.ui.topSurface(['right.primary']), undefined);

  await harness.plugins.stop('ai-provider');
  assert.equal(harness.ui.list('ai.settings').length, 0);
  assert.equal(harness.ui.list('ai.retrieval').length, 0);
  assert.equal(harness.resources.count('ai-provider'), 0);
});

test('AI inline @ commands and references resolve without UI dropdown state', () => {
  assert.equal(new Set(AI_OPERATION_DEFINITIONS.map((definition) => definition.operation)).size, AI_OPERATION_DEFINITIONS.length);
  assert.equal(new Set(AI_OPERATION_DEFINITIONS.map((definition) => definition.label)).size, AI_OPERATION_DEFINITIONS.length);
  for (const definition of AI_OPERATION_DEFINITIONS) {
    assert.equal(explicitAtOperation(`@${definition.label} 示例要求`), definition.operation);
  }
  assert.equal(explicitAtOperation('@润色 保留事实'), 'polish');
  assert.equal(explicitAtOperation('@对比 三套采购方案'), 'compare');
  assert.equal(explicitAtOperation('@规划 产品发布流程'), 'plan');
  assert.equal(explicitAtOperation('@决策 是否迁移服务'), 'decide');
  assert.equal(explicitAtOperation('@翻译 成英文'), 'translate');
  assert.equal(explicitAtOperation('@查错 核对数字和引用'), 'verify');
  assert.equal(explicitAtOperation('@确认 发布日期：10月20日'), undefined);
  assert.equal(inferMemorySuggestion('将发布日期从10月20日改为11月5日')?.directive,
    '@修改 发布日期：10月20日 -> 11月5日');
  assert.equal(inferMemorySuggestion('确认交付负责人为林工')?.directive, '@确认 交付负责人：林工');
  assert.equal(inferMemorySuggestion('不再使用旧版登录方案')?.directive, '@废弃 旧版登录方案');
  assert.equal(inferMemorySuggestion('@确认 发布日期：10月20日'), undefined);
  assert.equal(inferAtOperation('普通问题'), 'general');
  assert.equal(stripOperationCommands('@扩写 文章结构'), '文章结构');
  const query = atQueryAt('请处理 @项', '请处理 @项'.length);
  assert.deepEqual(query, { start: 4, end: 6, query: '项' });
  assert.deepEqual(
    replaceAtQuery('请处理 @项', query!, '@[项目资料](node:fixture)'),
    { text: '请处理 @[项目资料](node:fixture) ', caret: 26 },
  );
  const compact = compactReferenceToken('项目资料', 'node:4bd19e84-49bb-4c32-90e6-98ae28497baf');
  assert.equal(compact, '@[项目资料]');
  assert.equal(compact.includes('4bd19e84'), false);
  assert.deepEqual(
    activeInlineReferences(`请处理 ${compact}`, [
      { token: compact, sourceId: 'node:fixture' },
      { token: '@[已经删除]', sourceId: 'node:removed' },
    ]),
    [{ token: compact, sourceId: 'node:fixture' }],
  );
  const sources = [
    { sourceId: 'node:exact', provider: 'text-node', kind: 'text', title: '项目资料', revision: 1, length: 120 },
    { sourceId: 'node:prefix', provider: 'text-node', kind: 'text', title: '项目资料补充', revision: 1, length: 80 },
    { sourceId: 'node:contains', provider: 'text-node', kind: 'text', title: '旧项目资料', revision: 1, length: 60 },
    { sourceId: 'node:duplicate', provider: 'text-node', kind: 'text', title: '项目资料', revision: 1, length: 20 },
  ];
  const nodeMatches = buildAIMentionSuggestions('项目资料', sources);
  assert.deepEqual(nodeMatches.slice(0, 4).map((item) => item.id), [
    'source:node:exact',
    'source:node:duplicate',
    'source:node:prefix',
    'source:node:contains',
  ]);
  assert.equal(nodeMatches[0].token.includes('node:exact'), false);
  assert.notEqual(nodeMatches[0].token, nodeMatches[1].token);
  assert.equal(buildAIMentionSuggestions('润', sources)[0]?.label, '@润色');
  assert.equal(buildAIMentionSuggestions('改善表达', sources)[0]?.label, '@润色');
  assert.equal(buildAIMentionSuggestions('完全不存在', sources).length, 0);
  assert.equal(buildAIMentionSuggestions('', sources, 3).length, 3);
});

test('AI provider supports multiple platforms while keeping every API key outside persisted namespaces', async () => {
  const harness = createHarness();
  const provider = createAIProviderPlugin();
  harness.plugins.register(provider);
  await harness.plugins.start('ai-provider');
  await harness.router.dispatch(
    'aiProvider.setPreferences',
    { endpoint: 'https://example.test/v1/chat/completions', model: 'example-model', authentication: 'bearer' },
    'core.test',
  );
  await harness.router.dispatch('aiProvider.setSessionKey', { apiKey: 'never-persist-this-secret' }, 'core.test');
  const firstState = await harness.router.ask<{
    activeProfileId?: string;
    profiles: Array<{ id: string; configured: boolean }>;
  }>('aiProvider.state', undefined, 'core.test');
  const firstProfileId = firstState.activeProfileId!;
  const second = await harness.router.dispatch<{ id: string }>(
    'aiProvider.profile.save',
    {
      platform: '第二平台',
      label: '长文本连接',
      endpoint: 'https://second.example.test/v1/chat/completions',
      model: 'second-model',
      authentication: 'bearer',
    },
    'core.test',
  );
  await harness.router.dispatch(
    'aiProvider.setSessionKey',
    { profileId: second.id, apiKey: 'second-session-secret' },
    'core.test',
  );
  const catalog = await harness.capabilities.request<{
    activeId?: string;
    options: Array<{ id: string; configured: boolean }>;
  }>('ai.provider.catalog@1');
  assert.equal(catalog.options.length, 2);
  assert.equal(catalog.activeId, second.id);
  assert.equal(catalog.options.every((profile) => profile.configured), true);
  await harness.router.dispatch(
    'aiProvider.profile.activate',
    { profileId: firstProfileId },
    'core.test',
  );
  assert.equal(
    (await harness.router.ask<{ configured: boolean }>('aiProvider.state', undefined, 'core.test')).configured,
    true,
  );
  const storedProviderState = JSON.stringify(harness.store.readNamespace('workspace', AI_PROVIDER_NAMESPACE));
  assert.equal(storedProviderState.includes('never-persist-this-secret'), false);
  assert.equal(storedProviderState.includes('second-session-secret'), false);
  assert.equal(storedProviderState.includes('第二平台'), true);
  await harness.plugins.stop('ai-provider');
  assert.equal(harness.resources.count('ai-provider'), 0);
  await harness.plugins.start('ai-provider');
  assert.equal(
    (await harness.router.ask<{ configured: boolean }>('aiProvider.state', undefined, 'core.test')).configured,
    false,
  );
});

test('remote semantic provider retrieves related wording, keeps secrets transient, and degrades when consent is absent', async () => {
  const harness = createHarness();
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createSemanticProviderPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('semantic-provider');
  const incident = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '事故记录', body: '网关持续返回 502，排查后确认是内存溢出导致服务不可用。' },
    'core.test',
  );
  await harness.router.dispatch(
    'node.create',
    { title: '旅行计划', body: '周末去海边看日落，记得带上相机和防晒霜。' },
    'core.test',
  );
  const longNode = await harness.router.dispatch<{ id: string }>(
    'node.create',
    { title: '长资料', body: '甲'.repeat(4_000) },
    'core.test',
  );
  const profile = await harness.router.dispatch<{ id: string }>(
    'semanticProvider.profile.save',
    {
      platform: '测试语义平台',
      label: '中文检索',
      endpoint: 'https://semantic.example.test/v1/embeddings',
      model: 'fixture-embedding',
      apiStyle: 'openai-compatible',
      authentication: 'bearer',
      allowRemoteContent: false,
      maxBatchSize: 8,
    },
    'core.test',
  );
  await harness.router.dispatch(
    'semanticProvider.setSessionKey',
    { profileId: profile.id, apiKey: 'semantic-session-secret' },
    'core.test',
  );

  const originalFetch = globalThis.fetch;
  let fetches = 0;
  let documentEmbeddingInputs = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    fetches += 1;
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    documentEmbeddingInputs += body.input.filter((text) => text !== '服务器崩了').length;
    const data = body.input.map((text, index) => ({
      index,
      embedding: text.includes('服务器崩了') || text.includes('502')
        ? [1, 0]
        : text.includes('海边') ? [0, 1] : [0.2, 0.8],
    }));
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  try {
    const disabled = await harness.capabilities.request<AIContextSearchContribution>(
      'context.semanticSearch@1',
      { query: '服务器崩了', terms: ['服务器', '崩了'], maxResults: 5 },
    );
    assert.deepEqual(disabled.hits, []);
    assert.equal(fetches, 0);

    await harness.router.dispatch(
      'semanticProvider.profile.save',
      {
        id: profile.id,
        platform: '测试语义平台',
        label: '中文检索',
        endpoint: 'https://semantic.example.test/v1/embeddings',
        model: 'fixture-embedding',
        apiStyle: 'openai-compatible',
        authentication: 'bearer',
        allowRemoteContent: true,
        maxBatchSize: 8,
      },
      'core.test',
    );
    const result = await harness.capabilities.request<AIContextSearchContribution>(
      'context.semanticSearch@1',
      { query: '服务器崩了', terms: ['服务器', '崩了'], maxResults: 5 },
    );
    assert.equal(result.hits[0]?.source.title, '事故记录');
    assert.equal(result.hits[0]?.source.sourceId, incident.id);
    assert.equal(result.hits[0]?.retrievalMethod, 'semantic');
    assert.ok(fetches >= 2);

    const documentInputsBeforeLocalEdit = documentEmbeddingInputs;
    const longSummary = (await harness.capabilities.request<Array<{ id: string; revision: number }>>(
      'content.summaries@1',
    )).find((item) => item.id === longNode.id)!;
    await harness.router.dispatch(
      'content.applyDelta',
      { nodeId: longNode.id, expectedRevision: longSummary.revision, start: 10, deleteCount: 1, insert: '乙' },
      'core.test',
    );
    await harness.capabilities.request<AIContextSearchContribution>(
      'context.semanticSearch@1',
      { query: '服务器崩了', terms: ['服务器', '崩了'], maxResults: 5 },
    );
    assert.equal(documentEmbeddingInputs - documentInputsBeforeLocalEdit, 1);
    assert.notEqual(semanticBlockFingerprint('长资料', '甲'.repeat(1_200)),
      semanticBlockFingerprint('长资料', `${'甲'.repeat(10)}乙${'甲'.repeat(1_189)}`));

    const storedNamespace = harness.store.readNamespace('workspace', SEMANTIC_PROVIDER_NAMESPACE);
    const stored = JSON.stringify(storedNamespace);
    assert.equal(stored.includes('semantic-session-secret'), false);
    assert.deepEqual(Object.keys(storedNamespace), ['configuration']);
    assert.equal(stored.includes('测试语义平台'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  await harness.plugins.stop('semantic-provider');
  assert.equal(harness.resources.count('semantic-provider'), 0);
  await harness.plugins.start('semantic-provider');
  const restarted = await harness.router.ask<{ profiles: Array<{ configured: boolean }> }>(
    'semanticProvider.state', undefined, 'core.test',
  );
  assert.equal(restarted.profiles[0]?.configured, false);
});

test('local semantic provider keeps canvas text on-device, indexes through the managed worker and releases its runtime', async () => {
  let embeddings = 0;
  const workerFactory: ManagedWorkerFactory = () => {
    const listeners = new Set<(event: MessageEvent<WorkerResponseMessage>) => void>();
    return {
      postMessage(message) {
        if (message.type === 'core.worker.cancel') return;
        const request = message as WorkerRequestMessage;
        let result: unknown = { disposed: true };
        if (request.type === 'local-semantic-provider.model.load@1') result = { inputNames: ['input_ids', 'attention_mask'] };
        if (request.type === 'local-semantic-provider.embed@1') {
          const texts = (request.payload as { texts: string[] }).texts;
          embeddings += texts.length;
          result = {
            dimensions: 2,
            vectors: texts.map((text) => Float32Array.from(text.includes('服务器') || text.includes('502') ? [1, 0] : [0, 1])),
          };
        }
        if (request.type === LOCAL_SEMANTIC_ENCODE_CACHE_JOB) {
          result = encodeLocalSemanticCache(request.payload as LocalSemanticEncodeCacheRequest);
        }
        if (request.type === LOCAL_SEMANTIC_DECODE_CACHE_JOB) {
          result = decodeLocalSemanticCache(request.payload as LocalSemanticDecodeCacheRequest);
        }
        setTimeout(() => {
          for (const listener of listeners) listener({ data: { id: request.id, ok: true, result } } as MessageEvent<WorkerResponseMessage>);
        }, 0);
      },
      addEventListener(type, listener) {
        if (type === 'message') listeners.add(listener as (event: MessageEvent<WorkerResponseMessage>) => void);
      },
      removeEventListener(type, listener) {
        if (type === 'message') listeners.delete(listener as (event: MessageEvent<WorkerResponseMessage>) => void);
      },
      terminate() {},
    };
  };
  const harness = createHarness(1, workerFactory);
  let personalAsset: unknown;
  harness.router.registerQuery('core.personal-assets', {
    type: 'system.personalAssets.get',
    handle: () => personalAsset,
  });
  harness.router.registerCommand('core.personal-assets', {
    type: 'system.personalAssets.set',
    handle: (payload) => {
      personalAsset = (payload as { asset: unknown }).asset;
      return { result: { saved: true } };
    },
  });
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createLocalSemanticProviderPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('local-semantic-provider');
  await harness.router.dispatch(
    'node.create',
    { title: '事故记录', body: '网关持续返回 502，排查后确认是内存溢出导致服务不可用。' },
    'core.test',
  );
  await harness.router.dispatch(
    'node.create',
    { title: '旅行计划', body: '周末去海边看日落，记得带上相机和防晒霜。' },
    'core.test',
  );
  const originalFetch = globalThis.fetch;
  const downloads: Array<{ url: string; body?: BodyInit | null }> = [];
  globalThis.fetch = (async (input, init) => {
    downloads.push({ url: String(input), body: init?.body });
    return new Response(new Uint8Array([1]), { headers: { 'content-length': '1' } });
  }) as typeof globalThis.fetch;
  try {
    const result = await harness.capabilities.request<AIContextSearchContribution>(
      'context.semanticSearch@1',
      { query: '服务器崩了', terms: ['服务器', '崩了'], maxResults: 5 },
    );
    assert.equal(result.hits[0]?.source.title, '事故记录');
    assert.equal(result.hits[0]?.retrievalMethod, 'semantic');
    assert.equal(downloads.length, 6);
    assert.equal(downloads.filter((download) => download.url.startsWith('https://huggingface.co/Xenova/bge-small-zh-v1.5/')).length, 3);
    assert.equal(downloads.filter((download) => download.url.startsWith('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/')).length, 3);
    assert.equal(downloads.every((download) => download.body === undefined), true);
    assert.ok(embeddings >= 3);
    assert.equal(JSON.stringify(personalAsset).includes('事故记录'), false);
    assert.equal(JSON.stringify(personalAsset).includes('网关持续返回'), false);

    const embeddingsBeforeRestart = embeddings;
    await harness.plugins.stop('local-semantic-provider');
    await harness.plugins.start('local-semantic-provider');
    const restored = await harness.capabilities.request<AIContextSearchContribution>(
      'context.semanticSearch@1',
      { query: '服务器崩了', terms: ['服务器', '崩了'], maxResults: 5 },
    );
    assert.equal(restored.hits[0]?.source.title, '事故记录');
    assert.equal(embeddings - embeddingsBeforeRestart, 1, 'restart should embed only the new query');

    await harness.router.dispatch('localSemanticProvider.setEnabled', { enabled: false }, 'core.test');
    const state = await harness.router.ask<{ enabled: boolean; modelLoaded: boolean }>(
      'localSemanticProvider.state', undefined, 'core.test',
    );
    assert.equal(state.enabled, false);
    assert.equal(state.modelLoaded, false);
    assert.deepEqual(harness.store.readNamespace('document', LOCAL_SEMANTIC_PROVIDER_NAMESPACE), {});
    assert.equal(harness.history.getState().undoCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await harness.plugins.stop('local-semantic-provider');
  assert.equal(harness.resources.count('local-semantic-provider'), 0);
});

test('local semantic model download exposes its current asset and can be cancelled without retaining a partial index', async () => {
  const workerFactory: ManagedWorkerFactory = () => ({
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    terminate() {},
  });
  const harness = createHarness(1, workerFactory);
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createLocalSemanticProviderPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('local-semantic-provider');
  await harness.router.dispatch(
    'node.create',
    { title: '待索引', body: '这段内容用于验证可取消的本地语义模型下载。' },
    'core.test',
  );
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = ((_, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true;
      reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  })) as typeof globalThis.fetch;
  try {
    await harness.router.dispatch('localSemanticProvider.index.rebuild', { force: true }, 'core.test');
    const downloading = await waitFor(async () => {
      const state = await harness.router.ask<{
        cache: { status: string; download?: { current: number; total: number; label: string } };
      }>('localSemanticProvider.state', undefined, 'core.test');
      return state.cache.status === 'downloading' ? state : undefined;
    });
    assert.deepEqual(downloading.cache.download, { current: 1, total: 6, label: '中文语义模型' });

    const cancelled = await harness.router.dispatch<{ cancelled: boolean }>(
      'localSemanticProvider.index.cancel', undefined, 'core.test',
    );
    assert.equal(cancelled.cancelled, true);
    await waitFor(() => Promise.resolve(aborted ? true : undefined));
    const after = await harness.router.ask<{
      modelLoaded: boolean;
      cache: { status: string; indexedChunks: number; download?: unknown };
    }>('localSemanticProvider.state', undefined, 'core.test');
    assert.equal(after.modelLoaded, false);
    assert.equal(after.cache.status, 'idle');
    assert.equal(after.cache.indexedChunks, 0);
    assert.equal(after.cache.download, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await harness.plugins.stop('local-semantic-provider');
  assert.equal(harness.resources.count('local-semantic-provider'), 0);
});

test('local semantic model download retains its asynchronous failure reason for the settings panel', async () => {
  const workerFactory: ManagedWorkerFactory = () => ({
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    terminate() {},
  });
  const harness = createHarness(1, workerFactory);
  harness.plugins.register(textNodePlugin);
  harness.plugins.register(createLocalSemanticProviderPlugin());
  await harness.plugins.start('text-node');
  await harness.plugins.start('local-semantic-provider');
  await harness.router.dispatch(
    'node.create',
    { title: '下载失败测试', body: '保留失败原因以便用户排查本地模型下载。' },
    'core.test',
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('模型下载网络不可用'); }) as typeof globalThis.fetch;
  try {
    await harness.router.dispatch('localSemanticProvider.index.rebuild', { force: true }, 'core.test');
    const failed = await waitFor(async () => {
      const state = await harness.router.ask<{
        cache: { status: string; error?: string; download?: unknown };
      }>('localSemanticProvider.state', undefined, 'core.test');
      return state.cache.status === 'error' ? state : undefined;
    });
    assert.match(failed.cache.error ?? '', /模型下载网络不可用/);
    assert.equal(failed.cache.download, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await harness.plugins.stop('local-semantic-provider');
});

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for asynchronous state');
}

function waitForFileStatus(
  harness: ReturnType<typeof createHarness>,
  operation: string,
  state: string,
): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = harness.router.subscribeSignal('core.test', 'file.status', (message) => {
      const status = message.payload as { operation?: string; state?: string };
      if (status.operation !== operation || status.state !== state) return;
      unsubscribe();
      resolve();
    });
  });
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function testEnvelope(id: string): MessageEnvelope {
  return {
    id,
    type: 'test.document.replace',
    schemaVersion: 1,
    sourcePlugin: 'core.test',
    correlationId: id,
    timestamp: Date.now(),
    priority: 50,
    depth: 0,
    payload: undefined,
  };
}
