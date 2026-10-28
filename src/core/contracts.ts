import type { LocalModelAsset, LocalModelAssetData } from './network-access.ts';
import type { ThemeDefinition, ThemeTokenOverrides } from '../protocols/theme.ts';
import type {
  CommandDeferrer,
  CommandDispatcher,
  CommandPayload,
  CommandResult,
  KnownCommandType,
} from '../protocols/commands.ts';

export type PluginStatus =
  | 'discovered'
  | 'validated'
  | 'installed'
  | 'starting'
  | 'active'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'uninstalling'
  | 'removed'
  | 'faulted';

export type StoreDomain = 'document' | 'workspace' | 'ephemeral' | 'derived';
export type WritableStoreDomain = Extract<StoreDomain, 'document' | 'workspace'>;

export interface DomainSnapshot {
  revision: number;
  namespaces: Record<string, Record<string, unknown>>;
}

export interface StoreSnapshot {
  formatVersion: 1;
  document: DomainSnapshot;
  workspace: DomainSnapshot;
}

export interface PatchOperation {
  op: 'set' | 'delete';
  domain: WritableStoreDomain;
  namespace: string;
  key: string;
  value?: unknown;
  schemaOwner?: string;
}

export interface EventDeclaration {
  type: string;
  payload: unknown;
}

export interface TransactionProposal {
  label: string;
  patches: PatchOperation[];
  events?: EventDeclaration[];
  history?: boolean;
  mergeKey?: string;
  mergeWindowMs?: number;
}

export interface MessageEnvelope<T = unknown> {
  id: string;
  type: string;
  schemaVersion: 1;
  sourcePlugin: string;
  transactionId?: string;
  causationId?: string;
  correlationId: string;
  timestamp: number;
  priority: number;
  depth: number;
  payload: T;
}

export interface CommandOutcome<TResult = unknown> {
  result?: TResult;
  transaction?: TransactionProposal;
}

export interface CommandRegistration<TPayload = unknown, TResult = unknown> {
  type: string;
  validate?: (payload: unknown) => payload is TPayload;
  handle: (
    payload: TPayload,
    envelope: MessageEnvelope<TPayload>,
  ) => Promise<CommandOutcome<TResult>> | CommandOutcome<TResult>;
}

export type TypedCommandRegistration<TType extends KnownCommandType> =
  Omit<CommandRegistration<CommandPayload<TType>, CommandResult<TType>>, 'type'> & {
    type: TType;
  };

export interface CommandRegistrar {
  <TType extends KnownCommandType>(registration: TypedCommandRegistration<TType>): void;
  <TPayload = unknown, TResult = unknown>(
    registration: CommandRegistration<TPayload, TResult>,
  ): void;
}

export interface QueryRegistration<TPayload = unknown, TResult = unknown> {
  type: string;
  validate?: (payload: unknown) => payload is TPayload;
  handle: (
    payload: TPayload,
    envelope: MessageEnvelope<TPayload>,
  ) => Promise<TResult> | TResult;
}

export interface CapabilityProvider<TInput = unknown, TResult = unknown> {
  key: string;
  priority?: number;
  invoke: (input: TInput, signal?: AbortSignal) => Promise<TResult> | TResult;
}

export type UISlot =
  | 'application.welcome'
  | 'top.primary'
  | 'top.contextual'
  | 'left.tools'
  | 'canvas.background'
  | 'canvas.empty'
  | 'canvas.entities'
  | 'canvas.groups'
  | 'canvas.content'
  | 'canvas.connections'
  | 'canvas.selection'
  | 'ai.settings'
  | 'ai.retrieval'
  | 'right.primary'
  | 'right.editor'
  | 'bottom.status'
  | 'overlay.floating'
  | 'overlay.modal'
  | 'editor.immersive.overlay'
  | 'command.palette';

export interface UIContribution {
  id: string;
  slot: UISlot;
  kind: 'button' | 'view' | 'status';
  label: string;
  command?: string;
  priority?: number;
  tooltip?: string;
  icon?: string;
  /** Semantic toolbar emphasis; the shell owns its theme-aware rendering. */
  tone?: 'default' | 'primary';
  /** Keeps the current editable selection alive while a toolbar command consumes it. */
  preserveEditableFocus?: boolean;
  group?:
    | 'file'
    | 'create'
    | 'assist'
    | 'history'
    | 'edit'
    | 'appearance'
    | 'clipboard'
    | 'status'
    | 'metrics'
    | 'organize'
    | 'tools'
    | 'system';
  component?: unknown;
}

export interface ShortcutContribution {
  id: string;
  /** Omit the chord to expose an assignable operation without claiming a default key. */
  chord?: string;
  command?: string;
  label: string;
  category?: string;
  mode?: 'press' | 'hold';
  allowInEditable?: boolean;
  instruction?: string;
  priority?: number;
}

export interface ActionContribution {
  id: string;
  label: string;
  command: string;
  category: string;
  keywords?: string[];
  priority?: number;
}

export interface ShortcutOverride {
  targetOwner: string;
  targetId: string;
  chord?: string;
  /** Explicitly leaves this operation without a shortcut; removing the override restores its default. */
  disabled?: boolean;
}

export interface RegisteredAction extends ActionContribution {
  owner: string;
}

export interface RegisteredShortcut extends ShortcutContribution {
  owner: string;
  mode: 'press' | 'hold';
  chord: string;
  baseChord: string;
  overridden: boolean;
  disabled: boolean;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: '1';
  /** Version of this plugin's portable document namespaces; independent from code semver. */
  dataVersion: number;
  autoStart?: boolean;
  dependencies: string[];
  optionalDependencies: string[];
  requiresCapabilities: string[];
  optionalCapabilities: string[];
  providesCapabilities: string[];
  permissions: string[];
  namespaces: string[];
  namespaceDomains: Partial<Record<string, WritableStoreDomain>>;
  commands: string[];
  dispatches: string[];
  events: string[];
  signals: string[];
  queries: string[];
  asks: string[];
  ui: string[];
  actions: string[];
  shortcuts: string[];
  themes: string[];
  workerJobs: string[];
}

export type PluginDocumentData = Record<string, Record<string, unknown>>;

export interface PluginDataMigration {
  from: number;
  to: number;
  migrate(data: PluginDocumentData): PluginDocumentData | Promise<PluginDocumentData>;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  migrations?: PluginDataMigration[];
  /** Lazy wrappers may load migration code only when an older book requires it. */
  loadMigrations?: () => Promise<PluginDataMigration[]>;
  install?: (context: PluginContext) => Promise<void> | void;
  start: (context: PluginContext) => Promise<void> | void;
  pause?: (context: PluginContext) => Promise<void> | void;
  stop?: (context: PluginContext) => Promise<void> | void;
  uninstall?: (context: PluginContext) => Promise<void> | void;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly commands: {
    register: CommandRegistrar;
    dispatch: CommandDispatcher;
    /** Explicitly expands a child command inside the current command turn. Never use from UI or events. */
    invoke: CommandDispatcher;
    /** Queues a child command after the current turn without exposing an awaitable promise. */
    defer: CommandDeferrer;
  };
  readonly events: {
    subscribe<TPayload = unknown>(
      type: string,
      listener: (envelope: MessageEnvelope<TPayload>) => void | Promise<void>,
    ): void;
  };
  readonly queries: {
    register<TPayload = unknown, TResult = unknown>(
      registration: QueryRegistration<TPayload, TResult>,
    ): void;
    ask<TResult = unknown>(type: string, payload?: unknown): Promise<TResult>;
  };
  readonly signals: {
    emit(type: string, payload?: unknown, parent?: MessageEnvelope): void;
    subscribe<TPayload = unknown>(
      type: string,
      listener: (envelope: MessageEnvelope<TPayload>) => void,
    ): void;
  };
  readonly capabilities: {
    provide<TInput = unknown, TResult = unknown>(
      provider: CapabilityProvider<TInput, TResult>,
    ): void;
    request<TResult = unknown>(
      key: string,
      input?: unknown,
      signal?: AbortSignal,
    ): Promise<TResult>;
    requestAll<TResult = unknown>(
      key: string,
      input?: unknown,
      signal?: AbortSignal,
    ): Promise<TResult[]>;
  };
  /** Kernel-owned leases for resources that are not already represented by a scoped facade. */
  readonly resources: {
    track(
      kind: 'timer' | 'listener' | 'file' | 'other',
      dispose: () => void | Promise<void>,
    ): () => void;
    timeout(callback: () => void, delayMs: number): () => void;
    interval(callback: () => void, delayMs: number): () => void;
  };
  readonly store: {
    readNamespace<TRecord = Record<string, unknown>>(namespace: string): TRecord;
    readPrefix<TRecord = Record<string, unknown>>(namespace: string, prefix: string): TRecord;
    readKeyRange<TRecord = Record<string, unknown>>(
      namespace: string,
      startInclusive: string,
      endExclusive: string,
      includePrevious?: boolean,
    ): TRecord;
    readValue<TValue = unknown>(namespace: string, key: string): TValue | undefined;
    count(namespace: string): number;
    revision(namespace: string): number;
    changes(namespace: string, sinceRevision: number): {
      revision: number;
      reset: boolean;
      keys: string[];
    };
  };
  readonly ui: {
    contribute(contribution: UIContribution): void;
    action(contribution: ActionContribution): void;
    shortcut(contribution: ShortcutContribution): void;
    validateShortcutOverrides(overrides: ShortcutOverride[]): ShortcutOverride[];
    shortcutOverrides(overrides: ShortcutOverride[]): void;
    theme(definition: ThemeDefinition): void;
    activateTheme(id: string, overrides?: ThemeTokenOverrides): void;
    activateSurface(slot: UISlot, contributionId: string, closeCommand?: string): void;
    deactivateSurface(slot: UISlot, contributionId: string): void;
  };
  readonly tasks: {
    schedule<TResult>(options: TaskOptions<TResult>): TaskHandle<TResult>;
  };
  readonly workers: {
    available(): boolean;
    run<TResult = unknown>(
      type: string,
      payload?: unknown,
      signal?: AbortSignal,
      transfer?: Transferable[],
    ): Promise<TResult>;
  };
  readonly network: {
    configureOrigins(endpoints: Array<string | URL>): string[];
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    embed(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    sync(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    downloadLocalModelAsset(asset: LocalModelAsset, signal?: AbortSignal): Promise<LocalModelAssetData>;
  };
  readonly diagnostics: {
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
    error(message: string, detail?: unknown): void;
  };
}

export interface TaskOptions<TResult> {
  id?: string;
  category: string;
  label?: string;
  /** Wait before admitting the task to the runnable queue. The scheduler owns and cancels this delay. */
  delayMs?: number;
  noticeAfterMs?: number;
  priority: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  estimatedCost?: number;
  run: (
    signal: AbortSignal,
    report: (progress: number) => void,
    control: { waitIfPaused(): Promise<void> },
  ) => Promise<TResult>;
}

export interface TaskHandle<TResult> {
  id: string;
  result: Promise<TResult>;
  cancel(): void;
  pause(): void;
  resume(): void;
}

export interface PluginSnapshot {
  id: string;
  name: string;
  version: string;
  status: PluginStatus;
  category: 'core' | 'feature' | 'provider' | 'diagnostic';
  toggleable: boolean;
  blockers: string[];
  resources: number;
  permissions: string[];
  error?: string;
}

export interface ViewClient {
  readonly owner: string;
  dispatch: CommandDispatcher;
  isCommandAvailable(type: string): boolean;
  subscribeCommands(listener: () => void): () => void;
  getCommandVersion(): number;
  ask<TResult = unknown>(type: string, payload?: unknown): Promise<TResult>;
  request<TResult = unknown>(
    capability: string,
    input?: unknown,
    signal?: AbortSignal,
  ): Promise<TResult>;
  requestAll<TResult = unknown>(
    capability: string,
    input?: unknown,
    signal?: AbortSignal,
  ): Promise<TResult[]>;
  /** Bounded, pure interaction-frame capabilities only; asynchronous providers are rejected. */
  requestSync<TResult = unknown>(capability: string, input?: unknown): TResult;
  emit(type: string, payload?: unknown): void;
  subscribeSignal<TPayload = unknown>(
    type: string,
    listener: (envelope: MessageEnvelope<TPayload>) => void,
  ): () => void;
  subscribeState(listener: () => void): () => void;
  getStateVersion(): number;
  getDocumentVersion(): number;
  getWorkspaceVersion(): number;
  getOwnStateVersion(namespace: string): number;
  subscribeCapabilities(listener: () => void): () => void;
  getCapabilityVersion(): number;
  subscribeClock(listener: () => void): () => void;
  getClock(): number;
  subscribeUI(listener: () => void): () => void;
  getUIVersion(): number;
  /** Current effective shortcuts owned by this view's plugin for one command. */
  getShortcutsForCommand(command: string): RegisteredShortcut[];
  subscribeKeyboard(listener: () => void): () => void;
  getKeyboardVersion(): number;
  isKeyPressed(key: string): boolean;
  isShortcutPressed(id: string): boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}:${id}`;
}
