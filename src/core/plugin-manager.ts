import {
  type ActionContribution,
  type CapabilityProvider,
  type CommandRegistration,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
  type PluginSnapshot,
  type PluginStatus,
  type ShortcutContribution,
  type ShortcutOverride,
  type TaskOptions,
  type UIContribution,
} from './contracts.ts';
import { CapabilityRegistry } from './capability-registry.ts';
import { DiagnosticsService } from './diagnostics.ts';
import { MessageRouter } from './message-router.ts';
import {
  assertCapabilityPermission,
  assertCommandPermission,
  assertKnownPermissions,
  assertPermission,
  assertSlotPermission,
  hasCommandPermission,
  hasPermission,
} from './permissions.ts';
import { ResourceRegistry } from './resource-registry.ts';
import { StateStore } from './store.ts';
import { TaskScheduler } from './task-scheduler.ts';
import { UIRuntime } from './ui-runtime.ts';
import { WorkerService } from './worker-service.ts';
import { NetworkAccessService } from './network-access.ts';
import {
  migrateProjectPluginData,
  validateStaticPluginMigrations,
} from './plugin-migrations.ts';
import type { ProjectOpenPayload, ProjectPluginDescriptor } from '../protocols/files.ts';

interface PluginRecord {
  definition: PluginDefinition;
  status: PluginStatus;
  installed: boolean;
  context: PluginContext;
  error?: string;
}

export class PluginManager {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly namespaceOwners = new Map<string, string>();
  private readonly resources: ResourceRegistry;
  private readonly router: MessageRouter;
  private readonly capabilities: CapabilityRegistry;
  private readonly store: StateStore;
  private readonly ui: UIRuntime;
  private readonly tasks: TaskScheduler;
  private readonly workers: WorkerService;
  private readonly network: NetworkAccessService;
  private readonly diagnostics: DiagnosticsService;
  private readonly listeners = new Set<() => void>();

  constructor(services: {
    resources: ResourceRegistry;
    router: MessageRouter;
    capabilities: CapabilityRegistry;
    store: StateStore;
    ui: UIRuntime;
    tasks: TaskScheduler;
    workers?: WorkerService;
    network?: NetworkAccessService;
    diagnostics: DiagnosticsService;
  }) {
    this.resources = services.resources;
    this.router = services.router;
    this.capabilities = services.capabilities;
    this.store = services.store;
    this.ui = services.ui;
    this.tasks = services.tasks;
    this.workers = services.workers ?? new WorkerService();
    this.network = services.network ?? new NetworkAccessService();
    this.diagnostics = services.diagnostics;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  register(definition: PluginDefinition): void {
    validateManifest(definition.manifest);
    validateStaticPluginMigrations(definition);
    if (this.plugins.has(definition.manifest.id)) throw new Error(`Duplicate plugin: ${definition.manifest.id}`);
    for (const namespace of definition.manifest.namespaces) {
      const domain = definition.manifest.namespaceDomains[namespace] ?? 'document';
      const key = `${domain}:${namespace}`;
      const owner = this.namespaceOwners.get(key);
      if (owner) throw new Error(`Namespace ${key} is already owned by ${owner}`);
      this.namespaceOwners.set(key, definition.manifest.id);
    }
    const context = this.createContext(definition.manifest);
    const record: PluginRecord = { definition, status: 'validated', installed: false, context };
    this.plugins.set(definition.manifest.id, record);
    const cycle = findExplicitDependencyCycle(
      [...this.plugins.values()].map((candidate) => candidate.definition.manifest),
    );
    if (cycle) {
      this.plugins.delete(definition.manifest.id);
      for (const namespace of definition.manifest.namespaces) {
        const domain = definition.manifest.namespaceDomains[namespace] ?? 'document';
        this.namespaceOwners.delete(`${domain}:${namespace}`);
      }
      throw new Error(`Plugin dependency cycle: ${cycle.join(' -> ')}`);
    }
    this.diagnostics.setPluginStatus(definition.manifest.id, 'validated');
    this.notify();
  }

  async startAutoPlugins(): Promise<void> {
    for (const id of this.planAutoStart()) await this.start(id);
  }

  planAutoStart(): string[] {
    return resolvePluginStartOrder(
      [...this.plugins.values()].map((record) => record.definition.manifest),
      new Set([...this.plugins].flatMap(([id, record]) => record.status === 'active' ? [id] : [])),
      new Set(this.capabilities.list().map((capability) => capability.key)),
    );
  }

  async start(id: string): Promise<void> {
    const record = this.require(id);
    if (record.status === 'active' || record.status === 'starting') return;
    for (const dependency of record.definition.manifest.dependencies) {
      if (!this.isActive(dependency)) throw new Error(`${id} requires active plugin ${dependency}`);
    }
    for (const capability of record.definition.manifest.requiresCapabilities) {
      if (!this.capabilities.has(capability)) {
        const providers = [...this.plugins.values()]
          .filter((candidate) => candidate.definition.manifest.providesCapabilities.includes(capability))
          .map((candidate) => candidate.definition.manifest.id);
        throw new Error(`${id} requires capability ${capability}${
          providers.length > 0 ? ` from active provider ${providers.join(' or ')}` : ' but no provider is registered'
        }`);
      }
    }
    this.setStatus(record, 'starting');
    this.capabilities.resumeOwner(id);
    try {
      if (!record.installed) {
        await record.definition.install?.(record.context);
        record.installed = true;
        this.setStatus(record, 'installed');
        this.setStatus(record, 'starting');
      }
      await record.definition.start(record.context);
      record.error = undefined;
      this.setStatus(record, 'active');
      await this.router.publishEvent('plugin.lifecycle.changed', { id, status: 'active' }, 'core.plugins');
    } catch (error) {
      await this.capabilities.suspendOwner(id);
      this.tasks.cancelOwner(id);
      this.workers.cancelOwner(id);
      try {
        await this.resources.releaseOwner(id);
      } catch {
        // The original startup failure remains primary; release errors are recorded below.
      }
      record.error = error instanceof Error ? error.message : String(error);
      this.setStatus(record, 'faulted', record.error);
      throw error;
    }
  }

  async pause(id: string): Promise<void> {
    const record = this.require(id);
    if (record.status === 'paused' || record.status === 'pausing') return;
    if (record.status !== 'active') throw new Error(`Plugin ${id} cannot pause from ${record.status}`);
    const blockers = this.stopBlockers(id, record.definition.manifest);
    if (blockers.length > 0) {
      throw new Error(`无法暂停 ${id}；仍被这些活动插件依赖：${blockers.join(', ')}`);
    }
    this.setStatus(record, 'pausing');
    await this.capabilities.suspendOwner(id);
    this.tasks.cancelOwner(id);
    this.workers.cancelOwner(id);
    let pauseError: unknown;
    try {
      if (record.definition.pause) await record.definition.pause(record.context);
      else await record.definition.stop?.(record.context);
    } catch (error) {
      pauseError = error;
    }
    try {
      await this.resources.releaseOwner(id);
    } catch (error) {
      pauseError ??= error;
    }
    if (pauseError) {
      record.error = pauseError instanceof Error ? pauseError.message : String(pauseError);
      this.setStatus(record, 'faulted', record.error);
      throw pauseError;
    }
    this.setStatus(record, 'paused');
    await this.router.publishEvent('plugin.lifecycle.changed', { id, status: 'paused' }, 'core.plugins');
  }

  async stop(id: string): Promise<void> {
    const record = this.require(id);
    if (record.status === 'stopped' || record.status === 'stopping' || record.status === 'removed') return;
    if (record.status === 'paused') {
      this.setStatus(record, 'stopped');
      await this.router.publishEvent('plugin.lifecycle.changed', { id, status: 'stopped' }, 'core.plugins');
      return;
    }
    if (record.status !== 'active' && record.status !== 'faulted') {
      throw new Error(`Plugin ${id} cannot stop from ${record.status}`);
    }
    if (record.status === 'active') {
      const blockers = this.stopBlockers(id, record.definition.manifest);
      if (blockers.length > 0) {
        throw new Error(`无法停用 ${id}；仍被这些活动插件依赖：${blockers.join(', ')}`);
      }
    }
    this.setStatus(record, 'stopping');
    await this.capabilities.suspendOwner(id);
    this.tasks.cancelOwner(id);
    this.workers.cancelOwner(id);
    let stopError: unknown;
    try {
      await record.definition.stop?.(record.context);
    } catch (error) {
      stopError = error;
    }
    try {
      await this.resources.releaseOwner(id);
    } catch (error) {
      stopError ??= error;
    }
    if (stopError) {
      record.error = stopError instanceof Error ? stopError.message : String(stopError);
      this.setStatus(record, 'faulted', record.error);
      throw stopError;
    }
    this.setStatus(record, 'stopped');
    await this.router.publishEvent('plugin.lifecycle.changed', { id, status: 'stopped' }, 'core.plugins');
  }

  async uninstall(id: string): Promise<void> {
    const record = this.require(id);
    if (record.status === 'removed' || record.status === 'uninstalling') return;
    if (record.status === 'active' || record.status === 'starting' || record.status === 'pausing' ||
      record.status === 'stopping') {
      throw new Error(`Plugin ${id} must be stopped or paused before uninstall`);
    }
    const blockers = this.stopBlockers(id, record.definition.manifest);
    if (blockers.length > 0) {
      throw new Error(`无法卸载 ${id}；仍被这些活动插件依赖：${blockers.join(', ')}`);
    }
    this.setStatus(record, 'uninstalling');
    await this.capabilities.suspendOwner(id);
    this.tasks.cancelOwner(id);
    this.workers.cancelOwner(id);
    try {
      await this.resources.releaseOwner(id);
      await record.definition.uninstall?.(record.context);
      record.installed = false;
      record.error = undefined;
      this.setStatus(record, 'removed');
      await this.router.publishEvent('plugin.lifecycle.changed', { id, status: 'removed' }, 'core.plugins');
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      this.setStatus(record, 'faulted', record.error);
      throw error;
    }
  }

  isAdmitted = (id: string): boolean => {
    if (id.startsWith('core')) return true;
    const status = this.plugins.get(id)?.status;
    return status === 'starting' || status === 'active';
  };

  isActive(id: string): boolean {
    return this.plugins.get(id)?.status === 'active';
  }

  canRequestCapability(id: string, key: string): boolean {
    if (id.startsWith('core')) return true;
    const manifest = this.plugins.get(id)?.definition.manifest;
    return Boolean(
      manifest &&
        (manifest.requiresCapabilities.includes(key) ||
          manifest.optionalCapabilities.includes(key) ||
          manifest.providesCapabilities.includes(key)) &&
        (!key.startsWith('context.') || hasPermission(manifest, 'content.context.read')),
    );
  }

  canDispatch(id: string, type: string): boolean {
    if (id.startsWith('core')) return true;
    const manifest = this.plugins.get(id)?.definition.manifest;
    return Boolean(
      manifest &&
      (manifest.commands.includes(type) || manifest.dispatches.includes(type)) &&
      hasCommandPermission(manifest, type),
    );
  }

  canWriteOwnStore = (id: string): boolean => {
    if (id.startsWith('core')) return true;
    const manifest = this.plugins.get(id)?.definition.manifest;
    return Boolean(manifest && hasPermission(manifest, 'store.own.write'));
  };

  canAsk(id: string, type: string): boolean {
    if (id.startsWith('core')) return true;
    const manifest = this.plugins.get(id)?.definition.manifest;
    return Boolean(manifest && (manifest.queries.includes(type) || manifest.asks.includes(type)));
  }

  canUseSignal(id: string, type: string): boolean {
    if (id.startsWith('core')) return true;
    return Boolean(this.plugins.get(id)?.definition.manifest.signals.includes(type));
  }

  resolveNamespaceOwner = (
    domain: 'document' | 'workspace',
    namespace: string,
  ): string | undefined => this.namespaceOwners.get(`${domain}:${namespace}`);

  list(): PluginSnapshot[] {
    const nameById = new Map([...this.plugins.values()].map((record) => [
      record.definition.manifest.id,
      record.definition.manifest.name,
    ]));
    return [...this.plugins.values()].map((record) => {
      const manifest = record.definition.manifest;
      const blockerIds = record.status === 'active' ? this.stopBlockers(manifest.id, manifest) : [];
      const category = pluginCategory(manifest.id);
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        status: record.status,
        category,
        toggleable: category !== 'core' && blockerIds.length === 0,
        blockers: blockerIds.map((id) => nameById.get(id) ?? id),
        resources: this.resources.count(manifest.id),
        permissions: [...manifest.permissions],
        error: record.error,
      };
    });
  }

  projectCatalog(): ProjectPluginDescriptor[] {
    return [...this.plugins.values()].map((record) => ({
      id: record.definition.manifest.id,
      version: record.definition.manifest.version,
      dataVersion: record.definition.manifest.dataVersion,
      namespaces: record.definition.manifest.namespaces.filter(
        (namespace) => (record.definition.manifest.namespaceDomains[namespace] ?? 'document') === 'document',
      ),
      available: true,
    }));
  }

  async migrateProject(payload: ProjectOpenPayload): Promise<ProjectOpenPayload> {
    const result = await migrateProjectPluginData(
      payload,
      new Map([...this.plugins].map(([id, record]) => [id, record.definition])),
    );
    if (result.migratedPlugins.length > 0) {
      this.diagnostics.record('info', 'core.plugins', '书籍插件数据迁移完成', {
        plugins: result.migratedPlugins,
      });
    }
    return result.payload;
  }

  private createContext(manifest: PluginManifest): PluginContext {
    const owner = manifest.id;
    let activeMessage: Parameters<MessageRouter['dispatch']>[3];
    let shortcutOverridesTracked = false;
    let networkLeaseActive = false;
    const assertDeclared = (collection: string[], value: string, kind: string) => {
      if (!collection.includes(value)) throw new Error(`${owner} did not declare ${kind} ${value}`);
    };
    const track = (kind: Parameters<ResourceRegistry['track']>[1], dispose: () => void | Promise<void>) => {
      this.resources.track(owner, kind, dispose);
    };
    const trackedLease = (
      kind: 'timer' | 'listener' | 'file' | 'other',
      dispose: () => void | Promise<void>,
    ) => {
      let active = true;
      const untrack = this.resources.track(owner, kind, async () => {
        if (!active) return;
        active = false;
        await dispose();
      });
      return () => {
        if (!active) return;
        active = false;
        untrack();
        void Promise.resolve(dispose()).catch((error) => {
          this.diagnostics.record('error', owner, `Failed to release ${kind} resource`, error);
        });
      };
    };

    return {
      pluginId: owner,
      commands: {
        register: ((registration: CommandRegistration) => {
          assertDeclared(manifest.commands, registration.type, 'command');
          track('command', this.router.registerCommand(owner, {
            ...registration,
            // An omitted validator means a deliberately payload-free message,
            // never "accept arbitrary input".
            validate: registration.validate ?? ((payload: unknown): payload is undefined => payload === undefined),
            handle: (payload, envelope) => withActiveMessage(envelope, () =>
              registration.handle(payload as never, envelope as never)),
          }));
        }) as PluginContext['commands']['register'],
        dispatch: ((type: string, payload?: unknown) => {
          if (!this.canDispatch(owner, type)) throw new Error(`${owner} did not declare dispatched command ${type}`);
          return this.router.dispatch(type, payload, owner, activeMessage);
        }) as PluginContext['commands']['dispatch'],
        invoke: ((type: string, payload?: unknown) => {
          if (!this.canDispatch(owner, type)) throw new Error(`${owner} did not declare invoked command ${type}`);
          return this.router.invoke(type, payload, owner, activeMessage);
        }) as PluginContext['commands']['invoke'],
        defer: ((type: string, payload?: unknown) => {
          if (!this.canDispatch(owner, type)) throw new Error(`${owner} did not declare deferred command ${type}`);
          this.router.defer(type, payload, owner, activeMessage);
        }) as PluginContext['commands']['defer'],
      },
      events: {
        subscribe: (type, listener) => {
          assertDeclared(manifest.events, type, 'event subscription');
          track('event', this.router.subscribeEvent(owner, type, (envelope) =>
            withActiveMessage(envelope, () => listener(envelope as never))));
        },
      },
      queries: {
        register: (registration) => {
          assertDeclared(manifest.queries, registration.type, 'query');
          track('query', this.router.registerQuery(owner, {
            ...registration,
            validate: registration.validate ?? ((payload: unknown): payload is never => payload === undefined),
          }));
        },
        ask: (type, payload) => {
          if (!this.canAsk(owner, type)) throw new Error(`${owner} did not declare consumed query ${type}`);
          return this.router.ask(type, payload, owner);
        },
      },
      signals: {
        emit: (type, payload, parent) => {
          assertDeclared(manifest.signals, type, 'signal');
          this.router.emitSignal(type, payload, owner, parent ?? activeMessage);
        },
        subscribe: (type, listener) => {
          assertDeclared(manifest.signals, type, 'signal subscription');
          track('signal', this.router.subscribeSignal(owner, type, (envelope) =>
            withActiveMessage(envelope, () => listener(envelope as never))));
        },
      },
      capabilities: {
        provide: <TInput, TResult>(provider: CapabilityProvider<TInput, TResult>) => {
          assertDeclared(manifest.providesCapabilities, provider.key, 'capability');
          track('capability', this.capabilities.register(owner, provider));
        },
        request: (key, input, signal) => {
          if (!this.canRequestCapability(owner, key)) throw new Error(`${owner} did not declare capability ${key}`);
          assertCapabilityPermission(manifest, key);
          return this.capabilities.request(key, input, signal);
        },
        requestAll: (key, input, signal) => {
          if (!this.canRequestCapability(owner, key)) throw new Error(`${owner} did not declare capability ${key}`);
          assertCapabilityPermission(manifest, key);
          return this.capabilities.requestAll(key, input, signal);
        },
      },
      resources: {
        track: trackedLease,
        timeout: (callback, delayMs) => {
          let active = true;
          let untrack: () => void = () => undefined;
          const handle = setTimeout(() => {
            if (!active) return;
            active = false;
            untrack();
            callback();
          }, Math.max(0, delayMs));
          untrack = this.resources.track(owner, 'timer', () => {
            if (!active) return;
            active = false;
            clearTimeout(handle);
          });
          return () => {
            if (!active) return;
            active = false;
            clearTimeout(handle);
            untrack();
          };
        },
        interval: (callback, delayMs) => {
          let active = true;
          const handle = setInterval(() => {
            if (active) callback();
          }, Math.max(1, delayMs));
          const untrack = this.resources.track(owner, 'timer', () => {
            if (!active) return;
            active = false;
            clearInterval(handle);
          });
          return () => {
            if (!active) return;
            active = false;
            clearInterval(handle);
            untrack();
          };
        },
      },
      store: {
        readNamespace: (namespace) => {
          assertPermission(manifest, 'store.own.read', `read namespace ${namespace}`);
          assertDeclared(manifest.namespaces, namespace, 'namespace');
          return this.store.readNamespace(manifest.namespaceDomains[namespace] ?? 'document', namespace);
        },
        readPrefix: (namespace, prefix) => {
          assertPermission(manifest, 'store.own.read', `read namespace prefix ${namespace}`);
          assertDeclared(manifest.namespaces, namespace, 'namespace');
          return this.store.readNamespacePrefix(
            manifest.namespaceDomains[namespace] ?? 'document',
            namespace,
            prefix,
          );
        },
        readKeyRange: (namespace, startInclusive, endExclusive, includePrevious = false) => {
          assertPermission(manifest, 'store.own.read', `read namespace key range ${namespace}`);
          assertDeclared(manifest.namespaces, namespace, 'namespace');
          return this.store.readNamespaceKeyRange(
            manifest.namespaceDomains[namespace] ?? 'document',
            namespace,
            startInclusive,
            endExclusive,
            includePrevious,
          );
        },
        readValue: (namespace, key) => {
          assertPermission(manifest, 'store.own.read', `read ${namespace}.${key}`);
          assertDeclared(manifest.namespaces, namespace, 'namespace');
          return this.store.readValue(manifest.namespaceDomains[namespace] ?? 'document', namespace, key);
        },
        count: (namespace) => {
          assertPermission(manifest, 'store.own.read', `count namespace ${namespace}`);
          assertDeclared(manifest.namespaces, namespace, 'namespace');
          return this.store.countNamespace(manifest.namespaceDomains[namespace] ?? 'document', namespace);
        },
        revision: (namespace) => {
          assertPermission(manifest, 'store.own.read', `read namespace revision ${namespace}`);
          assertDeclared(manifest.namespaces, namespace, 'namespace');
          return this.store.getNamespaceRevision(manifest.namespaceDomains[namespace] ?? 'document', namespace);
        },
        changes: (namespace, sinceRevision) => {
          assertPermission(manifest, 'store.own.read', `read namespace changes ${namespace}`);
          assertDeclared(manifest.namespaces, namespace, 'namespace');
          return this.store.getNamespaceChanges(
            manifest.namespaceDomains[namespace] ?? 'document',
            namespace,
            sinceRevision,
          );
        },
      },
      ui: {
        contribute: (contribution: UIContribution) => {
          assertDeclared(manifest.ui, contribution.id, 'UI contribution');
          assertSlotPermission(manifest, contribution.slot);
          track('ui', this.ui.contribute(owner, contribution));
        },
        action: (contribution: ActionContribution) => {
          assertDeclared(manifest.actions, contribution.id, 'action contribution');
          assertPermission(manifest, 'ui.action.register', `register action ${contribution.id}`);
          track('action', this.ui.registerAction(owner, contribution));
        },
        shortcut: (shortcut: ShortcutContribution) => {
          assertDeclared(manifest.shortcuts, shortcut.id, 'shortcut');
          assertPermission(manifest, 'ui.shortcut.register', `register shortcut ${shortcut.id}`);
          track('shortcut', this.ui.registerShortcut(owner, shortcut));
        },
        validateShortcutOverrides: (overrides: ShortcutOverride[]) =>
          (assertPermission(manifest, 'ui.shortcut.override', 'validate shortcut overrides'),
          this.ui.validateShortcutOverrides(owner, overrides)),
        shortcutOverrides: (overrides: ShortcutOverride[]) => {
          assertPermission(manifest, 'ui.shortcut.override', 'set shortcut overrides');
          if (!shortcutOverridesTracked) {
            shortcutOverridesTracked = true;
            track('shortcut', () => {
              this.ui.clearShortcutOverrides(owner);
              shortcutOverridesTracked = false;
            });
          }
          this.ui.setShortcutOverrides(owner, overrides);
        },
        theme: (definition) => {
          assertDeclared(manifest.themes, definition.id, 'theme');
          assertPermission(manifest, 'ui.theme.manage', `register theme ${definition.id}`);
          track('ui', this.ui.registerTheme(owner, definition));
        },
        activateTheme: (id, overrides) => {
          assertDeclared(manifest.themes, id, 'theme');
          assertPermission(manifest, 'ui.theme.manage', `activate theme ${id}`);
          this.ui.activateTheme(owner, id, overrides);
        },
        activateSurface: (slot, contributionId, closeCommand, yieldCommand) => {
          assertDeclared(manifest.ui, contributionId, 'UI contribution');
          assertSlotPermission(manifest, slot);
          if (closeCommand && !this.canDispatch(owner, closeCommand)) {
            throw new Error(`${owner} did not declare close command ${closeCommand}`);
          }
          if (yieldCommand && !this.canDispatch(owner, yieldCommand)) {
            throw new Error(`${owner} did not declare yield command ${yieldCommand}`);
          }
          this.ui.activateSurface(owner, slot, contributionId, closeCommand, yieldCommand);
        },
        deactivateSurface: (slot, contributionId) => {
          assertDeclared(manifest.ui, contributionId, 'UI contribution');
          assertSlotPermission(manifest, slot);
          this.ui.deactivateSurface(owner, slot, contributionId);
        },
      },
      tasks: {
        schedule: <TResult>(options: TaskOptions<TResult>) => {
          assertPermission(manifest, 'tasks.schedule', `schedule task ${options.category}`);
          const handle = this.tasks.schedule(owner, options);
          const release = this.resources.track(owner, 'task', () => handle.cancel());
          void handle.result.then(release, release);
          return handle;
        },
      },
      workers: {
        available: () => this.workers.isAvailable(),
        run: <TResult>(type: string, payload?: unknown, signal?: AbortSignal, transfer?: Transferable[]) => {
          assertPermission(manifest, 'workers.run', `run background job ${type}`);
          assertDeclared(manifest.workerJobs, type, 'worker job');
          const controller = new AbortController();
          const relayAbort = () => controller.abort(signal?.reason);
          signal?.addEventListener('abort', relayAbort, { once: true });
          if (signal?.aborted) relayAbort();
          const release = this.resources.track(owner, 'worker', () => controller.abort());
          return this.workers.run<TResult>(owner, type, payload, controller.signal, transfer).finally(() => {
            signal?.removeEventListener('abort', relayAbort);
            release();
          });
        },
      },
      network: {
        configureOrigins: (endpoints) => {
          assertPermission(manifest, 'network.origin.manage', 'configure approved AI network origins');
          const origins = this.network.configureOrigins(owner, endpoints);
          if (!networkLeaseActive) {
            networkLeaseActive = true;
            this.resources.track(owner, 'network', () => {
              networkLeaseActive = false;
              this.network.clearOwner(owner);
            });
          }
          return origins;
        },
        fetch: (input, init) => {
          assertPermission(manifest, 'network.ai.generate', 'perform AI network request');
          return this.network.request(owner, 'generate', input, init);
        },
        embed: (input, init) => {
          assertPermission(manifest, 'network.ai.embed', 'perform remote embedding request');
          return this.network.request(owner, 'embed', input, init);
        },
        sync: (input, init) => {
          assertPermission(manifest, 'network.cloud.sync', 'perform cloud synchronization request');
          return this.network.request(owner, 'sync', input, init);
        },
        downloadLocalModelAsset: (asset, signal) => {
          assertPermission(manifest, 'network.ai.model', 'download an approved local AI model asset');
          return this.network.downloadLocalModelAsset(owner, asset, signal);
        },
      },
      diagnostics: {
        info: (message, detail) => this.diagnostics.record('info', owner, message, detail),
        warn: (message, detail) => this.diagnostics.record('warn', owner, message, detail),
        error: (message, detail) => this.diagnostics.record('error', owner, message, detail),
      },
    };

    function withActiveMessage<TResult>(
      envelope: Parameters<MessageRouter['dispatch']>[3],
      invoke: () => TResult,
    ): TResult {
      const previous = activeMessage;
      activeMessage = envelope;
      try {
        const result = invoke();
        if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).finally(() => {
            activeMessage = previous;
          }) as TResult;
        }
        activeMessage = previous;
        return result;
      } catch (error) {
        activeMessage = previous;
        throw error;
      }
    }
  }

  private require(id: string): PluginRecord {
    const record = this.plugins.get(id);
    if (!record) throw new Error(`Unknown plugin: ${id}`);
    return record;
  }

  private stopBlockers(id: string, manifest: PluginManifest): string[] {
    const capabilityOwners = new Map(
      this.capabilities.list().map((item) => [item.key, item.providers]),
    );
    const provided = new Set(manifest.providesCapabilities);
    const blockers: string[] = [];
    for (const [candidateId, candidate] of this.plugins) {
      if (candidateId === id || candidate.status !== 'active') continue;
      if (candidate.definition.manifest.dependencies.includes(id)) {
        blockers.push(candidateId);
        continue;
      }
      const losesRequiredCapability = candidate.definition.manifest.requiresCapabilities.some(
        (key) =>
          provided.has(key) &&
          (capabilityOwners.get(key) ?? []).every((owner) => owner === id),
      );
      if (losesRequiredCapability) blockers.push(candidateId);
    }
    return blockers.sort();
  }

  private setStatus(record: PluginRecord, status: PluginStatus, error?: string): void {
    record.status = status;
    this.diagnostics.setPluginStatus(record.definition.manifest.id, status, error);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

const FOUNDATIONAL_PLUGINS = new Set([
  'canvas',
  'text-node',
  'selection',
  'editor',
  'plugin-center',
  'command-palette',
]);

function pluginCategory(id: string): PluginSnapshot['category'] {
  if (FOUNDATIONAL_PLUGINS.has(id)) return 'core';
  if (id.includes('provider') || id === 'cloud-sync') return 'provider';
  if (id.includes('diagnostic') || id === 'shortcut-center') return 'diagnostic';
  return 'feature';
}

function validateManifest(manifest: PluginManifest): void {
  if (!/^[a-z0-9-]+$/.test(manifest.id)) throw new Error(`Invalid plugin id: ${manifest.id}`);
  if (!manifest.name.trim()) throw new Error(`Plugin ${manifest.id} has no name`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`Invalid plugin version: ${manifest.version}`);
  if (manifest.apiVersion !== '1') throw new Error(`Unsupported plugin API: ${manifest.apiVersion}`);
  if (!Number.isInteger(manifest.dataVersion) || manifest.dataVersion < 1) {
    throw new Error(`Invalid plugin data version: ${manifest.dataVersion}`);
  }
  if (manifest.dependencies.includes(manifest.id)) throw new Error(`Plugin ${manifest.id} cannot depend on itself`);
  assertKnownPermissions(manifest);
  if (manifest.actions.length > 0) {
    assertPermission(manifest, 'ui.action.register', 'declare actions');
  }
  if (manifest.shortcuts.length > 0) {
    assertPermission(manifest, 'ui.shortcut.register', 'declare shortcuts');
  }
  if (manifest.themes.length > 0) {
    assertPermission(manifest, 'ui.theme.manage', 'declare themes');
  }
  for (const [namespace, declaration] of Object.entries(manifest.sessionOnlyWorkspace)) {
    if (declaration === undefined) continue;
    if (!manifest.namespaces.includes(namespace)) {
      throw new Error(`Session-only workspace namespace ${namespace} is not owned by ${manifest.id}`);
    }
    if ((manifest.namespaceDomains[namespace] ?? 'document') !== 'workspace') {
      throw new Error(`Session-only namespace ${namespace} must belong to the workspace domain`);
    }
    if (declaration !== true) {
      if (declaration.length === 0 || declaration.some((key) => !key)) {
        throw new Error(`Session-only workspace keys for ${namespace} are invalid`);
      }
      if (new Set(declaration).size !== declaration.length) {
        throw new Error(`Duplicate session-only workspace key in ${manifest.id}.${namespace}`);
      }
    }
  }
  for (const command of manifest.dispatches) assertCommandPermission(manifest, command);
  const lists = [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.requiresCapabilities,
    manifest.optionalCapabilities,
    manifest.providesCapabilities,
    manifest.permissions,
    manifest.namespaces,
    manifest.commands,
    manifest.dispatches,
    manifest.events,
    manifest.signals,
    manifest.queries,
    manifest.asks,
    manifest.ui,
    manifest.actions,
    manifest.shortcuts,
    manifest.themes,
    manifest.workerJobs,
  ];
  for (const list of lists) {
    if (new Set(list).size !== list.length) throw new Error(`Duplicate declaration in ${manifest.id}`);
  }
  if (manifest.workerJobs.length > 0) assertPermission(manifest, 'workers.run', 'declare worker jobs');
  for (const job of manifest.workerJobs) {
    if (!job.startsWith(`${manifest.id}.`)) throw new Error(`Worker job ${job} is outside ${manifest.id}`);
  }
}

export function resolvePluginStartOrder(
  manifests: PluginManifest[],
  initiallyActive: ReadonlySet<string> = new Set(),
  initiallyProvidedCapabilities: ReadonlySet<string> = new Set(),
): string[] {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const pending = new Map(manifests
    .filter((manifest) => manifest.autoStart !== false && !initiallyActive.has(manifest.id))
    .map((manifest) => [manifest.id, manifest]));
  const active = new Set(initiallyActive);
  const capabilities = new Set(initiallyProvidedCapabilities);
  for (const id of active) {
    for (const capability of byId.get(id)?.providesCapabilities ?? []) capabilities.add(capability);
  }
  const order: string[] = [];
  while (pending.size > 0) {
    let next: PluginManifest | undefined;
    for (const manifest of pending.values()) {
      if (!manifest.dependencies.every((dependency) => active.has(dependency))) continue;
      if (!manifest.requiresCapabilities.every((capability) => capabilities.has(capability))) continue;
      next = manifest;
      break;
    }
    if (!next) throw new Error(describeUnresolvedDependencies(pending, byId, active, capabilities));
    pending.delete(next.id);
    active.add(next.id);
    for (const capability of next.providesCapabilities) capabilities.add(capability);
    order.push(next.id);
  }
  return order;
}

function describeUnresolvedDependencies(
  pending: ReadonlyMap<string, PluginManifest>,
  all: ReadonlyMap<string, PluginManifest>,
  active: ReadonlySet<string>,
  capabilities: ReadonlySet<string>,
): string {
  const cycle = findExplicitDependencyCycle([...pending.values()]);
  if (cycle) return `Plugin dependency cycle: ${cycle.join(' -> ')}`;
  const runtimeCycle = findPendingDependencyCycle(pending, capabilities);
  if (runtimeCycle) return `Plugin dependency/capability cycle: ${runtimeCycle.join(' -> ')}`;
  const details = [...pending.values()].map((manifest) => {
    const dependencies = manifest.dependencies.filter((dependency) => !active.has(dependency)).map((dependency) => {
      const provider = all.get(dependency);
      if (!provider) return `missing plugin ${dependency}`;
      if (provider.autoStart === false) return `disabled dependency ${dependency}`;
      return `waiting for plugin ${dependency}`;
    });
    const requiredCapabilities = manifest.requiresCapabilities
      .filter((capability) => !capabilities.has(capability))
      .map((capability) => {
        const providers = [...all.values()].filter((provider) =>
          provider.providesCapabilities.includes(capability));
        if (providers.length === 0) return `missing capability ${capability}`;
        const enabled = providers.filter((provider) => provider.autoStart !== false).map((provider) => provider.id);
        return enabled.length > 0
          ? `waiting for capability ${capability} from ${enabled.join(' or ')}`
          : `capability ${capability} is provided only by disabled plugins ${providers.map((provider) => provider.id).join(' or ')}`;
      });
    return `${manifest.id}: ${[...dependencies, ...requiredCapabilities].join(', ') || 'unresolved dependency'}`;
  });
  return `Plugin start order cannot be resolved; ${details.join('; ')}`;
}

function findExplicitDependencyCycle(manifests: PluginManifest[]): string[] | undefined {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(Math.max(0, start)), id];
    }
    if (visited.has(id)) return undefined;
    visiting.add(id);
    path.push(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const id of byId.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

function findPendingDependencyCycle(
  pending: ReadonlyMap<string, PluginManifest>,
  availableCapabilities: ReadonlySet<string>,
): string[] | undefined {
  const edges = new Map<string, Set<string>>();
  for (const manifest of pending.values()) {
    const targets = new Set(manifest.dependencies.filter((dependency) => pending.has(dependency)));
    for (const capability of manifest.requiresCapabilities) {
      if (availableCapabilities.has(capability)) continue;
      for (const provider of pending.values()) {
        if (provider.providesCapabilities.includes(capability)) targets.add(provider.id);
      }
    }
    edges.set(manifest.id, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(Math.max(0, start)), id];
    }
    if (visited.has(id)) return undefined;
    visiting.add(id);
    path.push(id);
    for (const target of edges.get(id) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const id of pending.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}
