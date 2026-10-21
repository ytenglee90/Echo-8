import type {
  DomainSnapshot,
  PluginDefinition,
  PluginSnapshot,
  RegisteredAction,
  RegisteredShortcut,
  UIContribution,
  UISlot,
  ViewClient,
} from './contracts.ts';
import { isRecord } from './contracts.ts';
import {
  AUTOSAVE_INTERVAL_OPTIONS,
  PROJECT_KIND,
  type DocumentRevisionSnapshot,
  type PersistenceSnapshot,
  type ProjectOpenPayload,
  type ProjectPluginDescriptor,
  type ProjectSource,
  type RecoveryPointSummary,
  type RecoveryPreview,
} from '../protocols/files.ts';
import type { RuntimeSnapshot } from '../protocols/runtime.ts';
import type {
  PersonalPreferenceReadRequest,
  PersonalPreferenceWriteRequest,
} from '../protocols/preferences.ts';
import type {
  PersonalTextAssetReadRequest,
  PersonalTextAssetRecord,
  PersonalTextAssetWriteRequest,
} from '../protocols/personal-assets.ts';
import { CapabilityRegistry } from './capability-registry.ts';
import { DiagnosticsService } from './diagnostics.ts';
import { HistoryService } from './history.ts';
import { InteractionStateMachine } from './interaction-machine.ts';
import {
  isInteractionMode,
  type InteractionBeginRequest,
  type InteractionEndRequest,
} from '../protocols/interactions.ts';
import { MessageRouter } from './message-router.ts';
import { PersistenceService, type PersistenceLaunchPolicy } from './persistence.ts';
import { PluginManager } from './plugin-manager.ts';
import { ResourceRegistry } from './resource-registry.ts';
import { StateStore } from './store.ts';
import { TaskScheduler } from './task-scheduler.ts';
import { TransactionManager } from './transaction-manager.ts';
import { UIRuntime } from './ui-runtime.ts';
import { UISurfaceArbiter } from './ui-surface-arbiter.ts';
import { WorkerService, type ManagedWorkerFactory } from './worker-service.ts';
import { NetworkAccessService } from './network-access.ts';
import type { TextAssetReadRequest, TextAssetReadResult } from '../protocols/assets.ts';

export class ApplicationKernel {
  readonly diagnostics = new DiagnosticsService();
  readonly resources = new ResourceRegistry();
  readonly capabilities = new CapabilityRegistry();
  readonly history = new HistoryService(2400);
  // Network generation spends most of its lifetime awaiting remote bytes.
  // Four admission slots let two assistants and one save/checkpoint coexist;
  // the cost budget still prevents several heavy CPU jobs from competing.
  readonly tasks = new TaskScheduler(4);
  readonly ui = new UIRuntime();
  readonly interactions = new InteractionStateMachine();
  readonly workers: WorkerService;
  readonly network = new NetworkAccessService();
  readonly store: StateStore;
  readonly transactions: TransactionManager;
  readonly router: MessageRouter;
  readonly persistence: PersistenceService;
  readonly plugins: PluginManager;
  readonly uiSurfaces: UISurfaceArbiter;
  private readonly definitions: PluginDefinition[];
  private readonly persistenceLaunchPolicy: PersistenceLaunchPolicy;
  private readonly writeToken = Symbol('kernel-store-write');
  private readonly viewClients = new Map<string, ViewClient>();
  private started = false;

  constructor(
    definitions: PluginDefinition[],
    options: {
      persistenceLaunchPolicy?: PersistenceLaunchPolicy;
      workerFactory?: ManagedWorkerFactory;
    } = {},
  ) {
    this.definitions = definitions;
    this.persistenceLaunchPolicy = options.persistenceLaunchPolicy ?? 'restore-session';
    this.store = new StateStore(this.writeToken);
    this.transactions = new TransactionManager(this.store, this.history, this.writeToken);
    this.router = new MessageRouter(this.transactions, this.diagnostics);
    this.workers = new WorkerService(options.workerFactory);
    this.persistence = new PersistenceService(
      this.store,
      this.history,
      this.diagnostics,
      this.tasks,
      (event) => this.router.emitSignal(
        'system.persistence.automaticCheckpoint.completed',
        event,
        'core.persistence',
      ),
      this.workers,
    );
    this.plugins = new PluginManager({
      resources: this.resources,
      router: this.router,
      capabilities: this.capabilities,
      store: this.store,
      ui: this.ui,
      tasks: this.tasks,
      workers: this.workers,
      network: this.network,
      diagnostics: this.diagnostics,
    });
    this.uiSurfaces = new UISurfaceArbiter(this.router, this.ui, this.diagnostics);
    this.uiSurfaces.start();
    this.capabilities.register<TextAssetReadRequest, TextAssetReadResult>('core.assets', {
      key: 'assets.readText@1',
      invoke: async (input, signal) => {
        if (!isRecord(input) || typeof input.path !== 'string' ||
          !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(input.path)) {
          throw new Error('Packaged text asset path is invalid');
        }
        const limit = typeof input.maxBytes === 'number'
          ? Math.max(1, Math.min(32 * 1024 * 1024, Math.trunc(input.maxBytes)))
          : 4 * 1024 * 1024;
        const assetUrl = new URL(input.path, globalThis.document?.baseURI);
        if (assetUrl.protocol === 'file:') {
          throw new Error(`Local text asset requires explicit association: ${input.path}`);
        }
        const response = await globalThis.fetch(assetUrl, { signal });
        if (!response.ok) throw new Error(`Packaged text asset failed: HTTP ${response.status}`);
        const text = await response.text();
        const bytes = new TextEncoder().encode(text).byteLength;
        if (bytes > limit) throw new Error(`Packaged text asset exceeds ${limit} bytes`);
        return { path: input.path, text, bytes };
      },
    });
    this.router.setAdmissionChecker(this.plugins.isAdmitted);
    this.transactions.setPersistenceSink((record) => this.persistence.enqueue(record));
    this.transactions.setNamespaceOwnerResolver(this.plugins.resolveNamespaceOwner);
    this.transactions.setWriteAuthorizer(this.plugins.canWriteOwnStore);
    this.registerSystemMessages();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const persisted = await this.persistence.open(this.persistenceLaunchPolicy);
    if (persisted) {
      this.store.hydrate(persisted.store, this.writeToken);
      this.history.import(persisted.history);
      this.diagnostics.record('info', 'core.persistence', 'Recovered the latest local snapshot');
    }
    for (const definition of this.definitions) this.plugins.register(definition);
    await this.plugins.startAutoPlugins();
    this.diagnostics.record('info', 'core.kernel', 'Application kernel is active');
  }

  createViewClient(owner: string): ViewClient {
    const cached = this.viewClients.get(owner);
    if (cached) return cached;
    const client: ViewClient = {
      owner,
      dispatch: <TResult = unknown>(type: string, payload?: unknown): Promise<TResult> => {
        if (!this.plugins.canDispatch(owner, type) && !owner.startsWith('core')) {
          const error = new Error(`${owner} did not declare dispatched command ${type}`);
          this.reportViewActionFailure(owner, type, error);
          return Promise.reject(error);
        }
        try {
          return this.router.dispatch<TResult>(type, payload, owner).catch((error) => {
            this.reportViewActionFailure(owner, type, error);
            throw error;
          });
        } catch (error) {
          this.reportViewActionFailure(owner, type, error);
          return Promise.reject(error);
        }
      },
      isCommandAvailable: (type) =>
        (owner.startsWith('core') || this.plugins.canDispatch(owner, type)) &&
        this.router.isCommandAvailable(type),
      subscribeCommands: (listener) => {
        const dispose = this.router.subscribeCommands(listener);
        const untrack = this.resources.track(owner, 'listener', dispose);
        return () => {
          dispose();
          untrack();
        };
      },
      getCommandVersion: this.router.getCommandVersion,
      ask: (type, payload) => {
        if (!this.plugins.canAsk(owner, type) && !owner.startsWith('core')) {
          return Promise.reject(new Error(`${owner} did not declare consumed query ${type}`));
        }
        return this.router.ask(type, payload, owner);
      },
      request: (capability, input, signal) => {
        if (!this.plugins.canRequestCapability(owner, capability) && !owner.startsWith('core')) {
          return Promise.reject(new Error(`${owner} did not declare capability ${capability}`));
        }
        return this.capabilities.request(capability, input, signal);
      },
      requestAll: (capability, input, signal) => {
        if (!this.plugins.canRequestCapability(owner, capability) && !owner.startsWith('core')) {
          return Promise.reject(new Error(`${owner} did not declare capability ${capability}`));
        }
        return this.capabilities.requestAll(capability, input, signal);
      },
      requestSync: (capability, input) => {
        if (!this.plugins.canRequestCapability(owner, capability) && !owner.startsWith('core')) {
          throw new Error(`${owner} did not declare capability ${capability}`);
        }
        return this.capabilities.requestSync(capability, input);
      },
      emit: (type, payload) => {
        if (!this.plugins.canUseSignal(owner, type) && !owner.startsWith('core')) {
          throw new Error(`${owner} did not declare signal ${type}`);
        }
        this.router.emitSignal(type, payload, owner);
      },
      subscribeSignal: (type, listener) => {
        if (!this.plugins.canUseSignal(owner, type) && !owner.startsWith('core')) {
          throw new Error(`${owner} did not declare signal ${type}`);
        }
        const dispose = this.router.subscribeSignal(owner, type, listener as never);
        const untrack = this.resources.track(owner, 'signal', dispose);
        return () => {
          dispose();
          untrack();
        };
      },
      subscribeState: (listener) => {
        const dispose = this.store.subscribe(listener);
        const untrack = this.resources.track(owner, 'listener', dispose);
        return () => {
          dispose();
          untrack();
        };
      },
      getStateVersion: this.store.getVersion,
      getDocumentVersion: () => this.store.getDomainRevision('document'),
      getWorkspaceVersion: () => this.store.getDomainRevision('workspace'),
      getOwnStateVersion: (namespace) => {
        const documentOwner = this.plugins.resolveNamespaceOwner('document', namespace);
        if (documentOwner === owner) return this.store.getNamespaceRevision('document', namespace);
        const workspaceOwner = this.plugins.resolveNamespaceOwner('workspace', namespace);
        if (workspaceOwner === owner) return this.store.getNamespaceRevision('workspace', namespace);
        throw new Error(`${owner} cannot observe private namespace ${namespace}`);
      },
      subscribeCapabilities: (listener) => {
        const dispose = this.capabilities.subscribe(listener);
        const untrack = this.resources.track(owner, 'listener', dispose);
        return () => {
          dispose();
          untrack();
        };
      },
      getCapabilityVersion: this.capabilities.getVersion,
      subscribeClock: (listener) => {
        const dispose = this.ui.subscribeClock(listener);
        const untrack = this.resources.track(owner, 'timer', dispose);
        return () => {
          dispose();
          untrack();
        };
      },
      getClock: this.ui.getClock,
      subscribeUI: (listener) => {
        const dispose = this.ui.subscribe(listener);
        const untrack = this.resources.track(owner, 'listener', dispose);
        return () => {
          dispose();
          untrack();
        };
      },
      getUIVersion: this.ui.getVersion,
      getShortcutsForCommand: (command) => this.ui.listShortcuts().filter((shortcut) =>
        shortcut.owner === owner && shortcut.command === command),
      subscribeKeyboard: (listener) => {
        const dispose = this.ui.subscribeKeyboard(listener);
        const untrack = this.resources.track(owner, 'listener', dispose);
        return () => {
          dispose();
          untrack();
        };
      },
      getKeyboardVersion: this.ui.getKeyboardVersion,
      isKeyPressed: this.ui.isKeyPressed,
      isShortcutPressed: (id) => this.ui.isShortcutPressed(owner, id),
    };
    this.viewClients.set(owner, client);
    return client;
  }

  listUI(slot: UISlot): Array<UIContribution & { owner: string }> {
    return this.ui.list(slot);
  }

  listPlugins(): PluginSnapshot[] {
    return this.plugins.list();
  }

  private reportViewActionFailure(owner: string, type: string, error: unknown): void {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    const message = (error instanceof Error ? error.message : '操作没有完成').slice(0, 240);
    this.router.emitSignal('system.ui.action.failed', { owner, type, message }, 'core.ui');
  }

  private registerSystemMessages(): void {
    this.router.registerCommand('core.ui', {
      type: 'system.ui.escape',
      handle: () => {
        const surface = this.ui.closableSurfaces()[0];
        const fallback = surface ? undefined : this.ui.listShortcuts().find((shortcut) =>
          !shortcut.disabled && shortcut.chord === 'escape' && Boolean(shortcut.command));
        queueMicrotask(() => {
          const owner = surface?.owner ?? fallback?.owner;
          const command = surface?.closeCommand ?? fallback?.command;
          if (!owner || !command) return;
          void this.router.dispatch(command, undefined, owner).catch((error) => {
            this.diagnostics.record(
              'warn',
              owner,
              surface ? `Escape close failed: ${surface.id}` : `Escape fallback failed: ${command}`,
              error,
            );
          });
        });
        return { result: { requested: Boolean(surface ?? fallback), surfaces: surface ? 1 : 0 } };
      },
    });
    this.router.registerCommand('core.history', {
      type: 'history.undo',
      handle: async (_payload, envelope) => ({ result: await this.transactions.undo(envelope.id) }),
    });
    this.router.registerCommand('core.history', {
      type: 'history.redo',
      handle: async (_payload, envelope) => ({ result: await this.transactions.redo(envelope.id) }),
    });
    this.router.registerCommand('core.plugins', {
      type: 'plugin.start',
      validate: (payload): payload is { id: string } =>
        typeof payload === 'object' && payload !== null && typeof (payload as { id?: unknown }).id === 'string',
      handle: async (payload) => {
        await this.plugins.start((payload as { id: string }).id);
        return { result: true };
      },
    });
    this.router.registerCommand('core.plugins', {
      type: 'plugin.stop',
      validate: (payload): payload is { id: string } =>
        typeof payload === 'object' && payload !== null && typeof (payload as { id?: unknown }).id === 'string',
      handle: async (payload) => {
        await this.plugins.stop((payload as { id: string }).id);
        return { result: true };
      },
    });
    this.router.registerCommand('core.plugins', {
      type: 'plugin.pause',
      validate: (payload): payload is { id: string } =>
        typeof payload === 'object' && payload !== null && typeof (payload as { id?: unknown }).id === 'string',
      handle: async (payload) => {
        await this.plugins.pause((payload as { id: string }).id);
        return { result: true };
      },
    });
    this.router.registerCommand('core.plugins', {
      type: 'plugin.uninstall',
      validate: (payload): payload is { id: string } =>
        typeof payload === 'object' && payload !== null && typeof (payload as { id?: unknown }).id === 'string',
      handle: async (payload) => {
        await this.plugins.uninstall((payload as { id: string }).id);
        return { result: true };
      },
    });
    this.router.registerQuery('core.plugins', {
      type: 'system.plugins',
      handle: () => this.plugins.list(),
    });
    this.router.registerQuery<undefined, RegisteredAction[]>('core.actions', {
      type: 'system.actions',
      handle: () => this.ui.listActions(),
    });
    this.router.registerQuery<undefined, RegisteredShortcut[]>('core.shortcuts', {
      type: 'system.shortcuts',
      handle: () => this.ui.listShortcuts(),
    });
    this.router.registerCommand<{ owner: string; id: string }, { queued: true }>('core.actions', {
      type: 'system.action.execute',
      validate: (payload): payload is { owner: string; id: string } =>
        isRecord(payload) && typeof payload.owner === 'string' && typeof payload.id === 'string',
      handle: (payload, envelope) => {
        const action = this.ui.getAction(payload.owner, payload.id);
        if (!action) throw new Error(`Action unavailable: ${payload.owner}:${payload.id}`);
        this.router.defer(action.command, undefined, action.owner, envelope);
        return { result: { queued: true } };
      },
    });
    this.router.registerQuery('core.history', {
      type: 'history.state',
      handle: () => this.history.getState(),
    });
    this.router.registerQuery('core.diagnostics', {
      type: 'system.diagnostics',
      handle: () => this.diagnostics.snapshot(),
    });
    this.router.registerQuery<undefined, RuntimeSnapshot>('core.diagnostics', {
      type: 'system.runtime',
      handle: () => ({
        generatedAt: Date.now(),
        plugins: this.plugins.list().map((plugin) => ({
          ...plugin,
          error: plugin.error ? '已记录插件错误' : undefined,
        })),
        store: this.store.summary(),
        history: this.history.getState(),
        persistence: this.persistence.snapshot(),
        tasks: this.tasks.snapshot(),
        resources: this.resources.summary(),
        interaction: this.interactions.current(),
        capabilities: this.capabilities.list(),
        actions: this.ui.listActions(),
        shortcuts: this.ui.listShortcuts(),
        surfaces: this.ui.surfaceSnapshot(),
        diagnostics: this.diagnostics.snapshot(),
        memory: readMemorySnapshot(),
      }),
    });
    this.router.registerQuery('core.persistence', {
      type: 'system.persistence',
      handle: () => this.persistence.snapshot(),
    });
    this.router.registerQuery<undefined, DocumentRevisionSnapshot>('core.persistence', {
      type: 'system.document.revision',
      handle: () => ({ revision: this.store.getDomainRevision('document') }),
    });
    this.router.registerQuery<PersonalPreferenceReadRequest, unknown>('core.preferences', {
      type: 'system.preferences.get',
      validate: isPersonalPreferenceReadRequest,
      handle: (payload, envelope) => this.persistence.readPersonalPreference(
        `${envelope.sourcePlugin}:${payload.key}`,
      ),
    });
    this.router.registerCommand<PersonalPreferenceWriteRequest, { saved: true }>('core.preferences', {
      type: 'system.preferences.set',
      validate: isPersonalPreferenceWriteRequest,
      handle: async (payload, envelope) => {
        await this.persistence.writePersonalPreference(`${envelope.sourcePlugin}:${payload.key}`, payload.value);
        return { result: { saved: true } };
      },
    });
    this.router.registerQuery<PersonalTextAssetReadRequest, PersonalTextAssetRecord | undefined>('core.personal-assets', {
      type: 'system.personalAssets.get',
      validate: isPersonalTextAssetReadRequest,
      handle: (payload, envelope) => this.persistence.readPersonalTextAsset(
        `${envelope.sourcePlugin}:${payload.key}`,
      ),
    });
    this.router.registerCommand<PersonalTextAssetWriteRequest, { saved: true }>('core.personal-assets', {
      type: 'system.personalAssets.set',
      validate: isPersonalTextAssetWriteRequest,
      handle: async (payload, envelope) => {
        await this.persistence.writePersonalTextAsset(
          `${envelope.sourcePlugin}:${payload.key}`,
          payload.asset,
        );
        return { result: { saved: true } };
      },
    });
    this.router.registerCommand<{ intervalMs: number }, PersistenceSnapshot>('core.persistence', {
      type: 'system.persistence.setAutosaveInterval',
      validate: (payload): payload is { intervalMs: number } => isRecord(payload) &&
        typeof payload.intervalMs === 'number' &&
        AUTOSAVE_INTERVAL_OPTIONS.includes(
          payload.intervalMs as (typeof AUTOSAVE_INTERVAL_OPTIONS)[number],
        ),
      handle: async (payload) => {
        const result = await this.persistence.setAutosaveInterval(payload.intervalMs);
        this.router.emitSignal(
          'system.persistence.autosaveInterval.changed',
          { intervalMs: result.autosaveIntervalMs },
          'core.persistence',
        );
        return { result };
      },
    });
    this.router.registerQuery<undefined, ProjectSource>('core.persistence', {
      type: 'system.project.source',
      handle: async () => {
        const store = await this.store.snapshotAsync();
        return {
          document: store.document,
          plugins: mergeProjectCatalog(this.persistence.getProjectPlugins(), this.plugins.projectCatalog()),
        };
      },
    });
    this.router.registerQuery<undefined, RecoveryPointSummary[]>('core.persistence', {
      type: 'system.recovery.list',
      handle: () => this.persistence.listRecoveryPoints(),
    });
    this.router.registerQuery<{ id: string }, RecoveryPreview>('core.persistence', {
      type: 'system.recovery.preview',
      validate: (payload): payload is { id: string } => isRecord(payload) && typeof payload.id === 'string',
      handle: async (payload) => {
        const recovery = await this.persistence.readRecoveryPoint(payload.id);
        const current = this.store.snapshot().document;
        const summary = (await this.persistence.listRecoveryPoints()).find((point) => point.id === payload.id);
        if (!summary) throw new Error('恢复点已经不存在');
        return {
          id: summary.id,
          label: summary.label,
          createdAt: summary.createdAt,
          currentDocumentRevision: current.revision,
          targetDocumentRevision: recovery.store.document.revision,
          currentRecordCount: countDomainRecords(current),
          targetRecordCount: countDomainRecords(recovery.store.document),
          currentNamespaceCount: Object.keys(current.namespaces).length,
          targetNamespaceCount: Object.keys(recovery.store.document.namespaces).length,
          targetUndoEntries: recovery.history.undo.length,
          targetRedoEntries: recovery.history.redo.length,
          targetPluginCount: recovery.projectPlugins?.length ?? 0,
        };
      },
    });
    this.router.registerCommand<ProjectOpenPayload, { id: string }>('core.persistence', {
      type: 'system.document.replace',
      validate: isProjectOpenPayload,
      handle: async (payload, envelope) => {
        assertPortableHistory(payload);
        const migrated = await this.plugins.migrateProject(payload);
        await this.persistence.createRecoveryPoint('打开文件前');
        const id = await this.transactions.replaceDocument(
          migrated.document,
          migrated.history,
          envelope,
          payload.origin ?? 'external',
        );
        this.persistence.setProjectPlugins(migrated.manifest.plugins);
        await this.persistence.checkpoint();
        return { result: { id } };
      },
    });
    this.router.registerCommand<undefined, { id: string }>('core.persistence', {
      type: 'system.document.new',
      handle: async (_payload, envelope) => {
        await this.persistence.createRecoveryPoint('新建书籍前');
        const id = await this.transactions.replaceDocument(
          { revision: 0, namespaces: {} },
          { undo: [], redo: [] },
          envelope,
          'new',
        );
        this.persistence.setProjectPlugins(this.plugins.projectCatalog());
        await this.persistence.checkpoint();
        return { result: { id } };
      },
    });
    this.router.registerCommand<{ label?: string }, RecoveryPointSummary>('core.persistence', {
      type: 'system.persistence.checkpoint',
      validate: (payload): payload is { label?: string } => payload === undefined ||
        (isRecord(payload) && (payload.label === undefined || typeof payload.label === 'string')),
      handle: async (payload = {}) => {
        const summary = await this.persistence.createRecoveryPoint(payload.label ?? '手动恢复点');
        await this.persistence.checkpoint();
        return { result: summary };
      },
    });
    this.router.registerCommand<{ id: string }, { id: string }>('core.persistence', {
      type: 'system.recovery.restore',
      validate: (payload): payload is { id: string } => isRecord(payload) && typeof payload.id === 'string',
      handle: async (payload, envelope) => {
        const recovery = await this.persistence.readRecoveryPoint(payload.id);
        await this.persistence.createRecoveryPoint('恢复操作前');
        const id = await this.transactions.replaceDocument(
          recovery.store.document,
          recovery.history,
          envelope,
          'recovery',
        );
        this.persistence.setProjectPlugins(recovery.projectPlugins ?? []);
        await this.persistence.checkpoint();
        return { result: { id } };
      },
    });
    this.router.registerCommand<InteractionBeginRequest>('core.interactions', {
      type: 'interaction.begin',
      validate: (payload): payload is InteractionBeginRequest =>
        isRecord(payload) && payload.mode !== 'idle' && isInteractionMode(payload.mode) &&
        (payload.sessionId === undefined || typeof payload.sessionId === 'string'),
      handle: (payload, envelope) => {
        return { result: this.interactions.begin(payload.mode, envelope.sourcePlugin, payload.sessionId ?? envelope.id) };
      },
    });
    this.router.registerCommand<InteractionEndRequest | undefined>('core.interactions', {
      type: 'interaction.end',
      validate: (payload): payload is InteractionEndRequest | undefined =>
        payload === undefined ||
        (isRecord(payload) &&
          (payload.mode === undefined || (payload.mode !== 'idle' && isInteractionMode(payload.mode))) &&
          (payload.sessionId === undefined || typeof payload.sessionId === 'string')),
      handle: (payload = {}, envelope) => {
        const ended = this.interactions.end(envelope.sourcePlugin, payload.mode, payload.sessionId);
        return { result: { ...this.interactions.snapshot(), ended } };
      },
    });
  }
}

function countDomainRecords(domain: DomainSnapshot): number {
  return Object.values(domain.namespaces)
    .reduce((total, namespace) => total + Object.keys(namespace).length, 0);
}

function readMemorySnapshot(): RuntimeSnapshot['memory'] {
  const memory = (globalThis.performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  } | undefined)?.memory;
  return memory
    ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit }
    : undefined;
}

function isProjectOpenPayload(value: unknown): value is ProjectOpenPayload {
  return isRecord(value) &&
    isRecord(value.manifest) &&
    value.manifest.kind === PROJECT_KIND &&
    (value.manifest.formatVersion === 1 || value.manifest.formatVersion === 2) &&
    Array.isArray(value.manifest.plugins) && value.manifest.plugins.every(isProjectPluginDescriptor) &&
    isRecord(value.document) &&
    Number.isInteger(value.document.revision) &&
    isRecord(value.document.namespaces) &&
    isRecord(value.history) &&
    Array.isArray(value.history.undo) &&
    Array.isArray(value.history.redo) &&
    (value.origin === undefined || ['file', 'cloud', 'new', 'recovery', 'external'].includes(String(value.origin)));
}

function isProjectPluginDescriptor(value: unknown): value is ProjectPluginDescriptor {
  return isRecord(value) && typeof value.id === 'string' && typeof value.version === 'string' &&
    typeof value.available === 'boolean' && Array.isArray(value.namespaces) &&
    value.namespaces.every((namespace) => typeof namespace === 'string') &&
    (value.dataVersion === undefined ||
      (Number.isInteger(value.dataVersion) && (value.dataVersion as number) >= 1));
}

function isPersonalPreferenceReadRequest(value: unknown): value is PersonalPreferenceReadRequest {
  return isRecord(value) && typeof value.key === 'string';
}

function isPersonalPreferenceWriteRequest(value: unknown): value is PersonalPreferenceWriteRequest {
  return isPersonalPreferenceReadRequest(value) && Object.prototype.hasOwnProperty.call(value, 'value');
}

function isPersonalTextAssetReadRequest(value: unknown): value is PersonalTextAssetReadRequest {
  return isRecord(value) && typeof value.key === 'string';
}

function isPersonalTextAssetWriteRequest(value: unknown): value is PersonalTextAssetWriteRequest {
  if (!isRecord(value) || typeof value.key !== 'string' || !isRecord(value.asset)) return false;
  const asset = value.asset;
  return asset.schemaVersion === 1 && typeof asset.text === 'string' &&
    (asset.fileName === undefined || typeof asset.fileName === 'string') &&
    typeof asset.updatedAt === 'number' && Number.isFinite(asset.updatedAt);
}

function assertPortableHistory(payload: ProjectOpenPayload): void {
  for (const entry of [...payload.history.undo, ...payload.history.redo]) {
    for (const patch of [...entry.forward, ...entry.inverse]) {
      if (patch.domain !== 'document') throw new Error('书籍文件不能把个人工作区状态写入撤销历史');
    }
  }
}

function mergeProjectCatalog(
  retained: ProjectPluginDescriptor[],
  current: ProjectPluginDescriptor[],
): ProjectPluginDescriptor[] {
  const catalog = new Map(retained.map((descriptor) => [descriptor.id, { ...descriptor, available: false }]));
  for (const descriptor of current) catalog.set(descriptor.id, descriptor);
  return [...catalog.values()].sort((left, right) => left.id.localeCompare(right.id));
}
