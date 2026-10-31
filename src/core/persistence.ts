import type { PatchOperation, StoreSnapshot, TaskHandle } from './contracts.ts';
import {
  assertNotAborted as throwIfAborted,
  yieldToMainThread,
} from '../services/async-control.ts';
import { HistoryService, type HistorySnapshot } from './history.ts';
import { DiagnosticsService } from './diagnostics.ts';
import { StateStore } from './store.ts';
import { TaskScheduler } from './task-scheduler.ts';
import { WorkerService, WorkerUnavailableError } from './worker-service.ts';
import { CheckpointPerformanceMonitor } from './checkpoint-performance.ts';
import type { PersonalTextAssetRecord } from '../protocols/personal-assets.ts';
import {
  CONTENT_CHUNK_NAMESPACE,
  CONTENT_CHUNK_REFERENCE,
  externalizeContentChunks,
  validateExternalizedCheckpoint,
  type ChunkExternalizedApplication,
  type ExternalizedCheckpoint,
  type StoredPersistedApplication,
} from './checkpoint-preparation.ts';
import { PERSISTENCE_PREPARE_CHECKPOINT_JOB } from './persistence-worker-jobs.ts';
import { canMergePatchEntries, composePatchPairs } from './patch-composition.ts';
import type { WorkspacePersistencePolicy } from './workspace-persistence.ts';

export { externalizeContentChunks } from './checkpoint-preparation.ts';
import type { TransactionCommitRecord } from '../protocols/state.ts';
import {
  AUTOSAVE_DISABLED_INTERVAL_MS,
  AUTOSAVE_INTERVAL_OPTIONS,
  AUTOSAVE_REALTIME_INTERVAL_MS,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  type PersistenceSnapshot,
  type ProjectPluginDescriptor,
  type RecoveryPointSummary,
} from '../protocols/files.ts';
import {
  RetiredDataRegistry,
} from './retired-data-registry.ts';

export interface PersistedApplication {
  formatVersion: 1;
  savedAt: number;
  store: StoreSnapshot;
  history: HistorySnapshot;
  projectPlugins?: ProjectPluginDescriptor[];
}

interface RecoveryPointRecord {
  summary: RecoveryPointSummary;
  snapshot: StoredPersistedApplication;
}

export type PersistenceStatus = PersistenceSnapshot;
type PersistenceStatusInput = Omit<PersistenceStatus, 'autosaveIntervalMs'> & {
  autosaveIntervalMs?: number;
};

export type PersistenceLaunchPolicy = 'restore-session' | 'fresh-session' | 'memory-only';
export interface AutomaticCheckpointEvent {
  savedAt: number;
  documentRevision: number;
}

export interface AutomaticSaveRequestEvent {
  requestedAt: number;
  documentRevision: number;
}

const RECOVERY_CHECKPOINT_INTERVAL_MS = 60_000;
const AUTOSAVE_INTERVAL_META_KEY = 'autosave-interval-ms';
const PERSONAL_PREFERENCE_PREFIX = 'preference:';
const PERSONAL_ASSET_PREFIX = 'asset:';
const MAX_PERSONAL_TEXT_ASSET_LENGTH = 16 * 1024 * 1024;
const RECOVERY_LIMIT = 8;
const CHECKPOINT_MAIN_THREAD_WARNING_MS = 50;

export class PersistenceService {
  private readonly store: StateStore;
  private readonly history: HistoryService;
  private readonly diagnostics: DiagnosticsService;
  private readonly tasks: TaskScheduler;
  private readonly workers?: WorkerService;
  private database?: IDBDatabase;
  private journalTimer?: ReturnType<typeof setTimeout>;
  private autosaveTimer?: ReturnType<typeof setTimeout>;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private checkpointTask?: TaskHandle<void>;
  private ioTail: Promise<void> = Promise.resolve();
  private pendingRecords: TransactionCommitRecord[] = [];
  private projectPlugins: ProjectPluginDescriptor[] = [];
  private readonly memoryPreferences = new Map<string, unknown>();
  private readonly memoryPersonalAssets = new Map<string, PersonalTextAssetRecord>();
  private readonly persistedContentChunkIds = new Set<string>();
  private autosaveIntervalMs = DEFAULT_AUTOSAVE_INTERVAL_MS;
  private autosaveDirty = false;
  private status: PersistenceStatus = {
    state: 'idle',
    journalEntries: 0,
    recoveryPoints: 0,
    autosaveIntervalMs: DEFAULT_AUTOSAVE_INTERVAL_MS,
  };
  private readonly listeners = new Set<() => void>();
  private readonly onAutomaticCheckpoint?: (event: AutomaticCheckpointEvent) => void;
  private readonly onAutomaticSaveRequest?: (event: AutomaticSaveRequestEvent) => void;
  private readonly workspacePersistence: WorkspacePersistencePolicy;
  private readonly retiredData: RetiredDataRegistry;

  constructor(
    store: StateStore,
    history: HistoryService,
    diagnostics: DiagnosticsService,
    tasks: TaskScheduler,
    onAutomaticCheckpoint?: (event: AutomaticCheckpointEvent) => void,
    onAutomaticSaveRequest?: (event: AutomaticSaveRequestEvent) => void,
    workers?: WorkerService,
    workspacePersistence?: WorkspacePersistencePolicy,
    retiredData = new RetiredDataRegistry([]),
  ) {
    this.store = store;
    this.history = history;
    this.diagnostics = diagnostics;
    this.tasks = tasks;
    this.workers = workers;
    this.onAutomaticCheckpoint = onAutomaticCheckpoint;
    this.onAutomaticSaveRequest = onAutomaticSaveRequest;
    this.workspacePersistence = workspacePersistence ?? {
      isSessionOnly: () => false,
      scrubStore: () => false,
      scrubRecord: (record) => record,
    };
    this.retiredData = retiredData;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PersistenceStatus {
    return structuredClone(this.status);
  }

  getProjectPlugins(): ProjectPluginDescriptor[] {
    return structuredClone(this.projectPlugins);
  }

  setProjectPlugins(plugins: ProjectPluginDescriptor[]): void {
    this.projectPlugins = structuredClone(plugins);
  }

  async open(policy: PersistenceLaunchPolicy = 'restore-session'): Promise<PersistedApplication | undefined> {
    if (policy === 'memory-only' || typeof indexedDB === 'undefined') {
      this.setStatus({ state: 'memory-only', journalEntries: 0, recoveryPoints: 0 });
      if (policy === 'memory-only') {
        this.diagnostics.record('warn', 'core.persistence', 'Started without opening browser recovery storage');
      }
      return undefined;
    }
    this.database = await openDatabase();
    this.persistedContentChunkIds.clear();
    for (const key of await readAllKeys(this.database, 'contentChunks')) {
      if (typeof key === 'string') this.persistedContentChunkIds.add(key);
    }
    const storedInterval = await readValue<number>(this.database, 'meta', AUTOSAVE_INTERVAL_META_KEY);
    if (isAutosaveInterval(storedInterval)) this.autosaveIntervalMs = storedInterval;
    if (policy === 'fresh-session') {
      await clearPreviousSession(this.database);
      this.persistedContentChunkIds.clear();
      this.pendingRecords = [];
      this.projectPlugins = [];
      const baseline = await this.buildPersistedApplication();
      await writeCheckpoint(
        this.database,
        externalizeContentChunks(baseline),
        this.persistedContentChunkIds,
      );
      this.setStatus({
        state: 'idle',
        checkpointAt: baseline.savedAt,
        journalEntries: 0,
        recoveryPoints: 0,
      });
      this.diagnostics.record('info', 'core.persistence', 'Previous local session data was discarded');
      return undefined;
    }
    await scrubRetiredPersistentData(this.database, this.retiredData);
    const storedSnapshot = await readValue<StoredPersistedApplication>(this.database, 'snapshots', 'latest');
    const snapshot = storedSnapshot
      ? await hydrateStoredApplication(this.database, storedSnapshot)
      : undefined;
    const journal = await readAll<TransactionCommitRecord>(this.database, 'journal');
    const recoveryPoints = (await readAll<RecoveryPointRecord>(this.database, 'recovery')).length;
    if (!snapshot) {
      const baseline = await this.buildPersistedApplication();
      await writeCheckpoint(
        this.database,
        externalizeContentChunks(baseline),
        this.persistedContentChunkIds,
      );
      this.setStatus({ state: 'idle', checkpointAt: baseline.savedAt, journalEntries: 0, recoveryPoints });
      return undefined;
    }
    const outstanding = journal.filter((record) => record.timestamp > snapshot.savedAt);
    const recovered = replayApplication(snapshot, outstanding, this.retiredData);
    this.workspacePersistence.scrubStore(recovered.store);
    this.projectPlugins = structuredClone(recovered.projectPlugins ?? []);
    this.setStatus({
      state: 'saved',
      lastSavedAt: outstanding.length > 0
        ? Math.max(snapshot.savedAt, ...outstanding.map((item) => item.timestamp))
        : snapshot.savedAt,
      checkpointAt: snapshot.savedAt,
      journalEntries: outstanding.length,
      recoveryPoints,
    });
    this.scheduleCheckpointDeadline();
    return recovered;
  }

  /**
   * Explicit startup-recovery escape hatch. This is intentionally destructive
   * and is only called after the recovery UI receives a second confirmation.
   * Personal preferences and associated text assets are retained.
   */
  async discardLocalSession(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    await this.ioTail;
    if (this.journalTimer) clearTimeout(this.journalTimer);
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.journalTimer = undefined;
    this.autosaveTimer = undefined;
    this.checkpointTimer = undefined;
    this.checkpointTask?.cancel();
    this.checkpointTask = undefined;

    const database = this.database ?? await openDatabase();
    await clearPreviousSession(database);
    database.close();
    if (database === this.database) this.database = undefined;
    this.pendingRecords = [];
    this.projectPlugins = [];
    this.persistedContentChunkIds.clear();
    this.autosaveDirty = false;
    this.setStatus({ state: 'memory-only', journalEntries: 0, recoveryPoints: 0 });
    this.diagnostics.record('warn', 'core.persistence', 'Local recovery session was explicitly discarded');
  }

  enqueue(record: TransactionCommitRecord): void {
    const next = this.workspacePersistence.scrubRecord(structuredClone(record));
    if (!next) return;
    const previous = this.pendingRecords.at(-1);
    const merged = previous ? mergePendingJournalRecords(previous, next) : undefined;
    if (merged) {
      this.pendingRecords[this.pendingRecords.length - 1] = merged;
    } else {
      this.pendingRecords.push(next);
    }
    if (next.forward.some((patch) => patch.domain === 'document')) {
      this.autosaveDirty = true;
      this.scheduleAutomaticSaveRequest();
    }
    this.setStatus({ ...this.status, state: this.database ? 'pending' : 'memory-only', error: undefined });
    if (!this.database) return;
    if (this.journalTimer) clearTimeout(this.journalTimer);
    this.journalTimer = setTimeout(() => void this.flush(), 320);
  }

  async flush(): Promise<void> {
    await this.flushJournal(true);
  }

  async checkpoint(): Promise<void> {
    this.clearCheckpointDeadline();
    await this.flushJournal(false);
    if (!this.database) return;
    if (this.checkpointTask) {
      this.checkpointTask.cancel();
      try {
        await this.checkpointTask.result;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
      }
      this.checkpointTask = undefined;
    }
    await this.writeCheckpointNow(this.database);
  }

  private async flushJournal(allowAutomaticCheckpoint: boolean): Promise<void> {
    if (!this.database || this.pendingRecords.length === 0) return;
    if (this.journalTimer) clearTimeout(this.journalTimer);
    this.journalTimer = undefined;
    const records = this.pendingRecords;
    this.pendingRecords = [];
    this.setStatus({ ...this.status, state: 'saving', error: undefined });
    try {
      await this.queueIO(() => writeJournal(this.database!, records));
      const savedAt = Date.now();
      const journalEntries = this.status.journalEntries + records.length;
      this.setStatus({ ...this.status, state: 'saved', lastSavedAt: savedAt, journalEntries, error: undefined });
      if (allowAutomaticCheckpoint && isAutosaveCheckpointDue(
        this.status.checkpointAt,
        savedAt,
        RECOVERY_CHECKPOINT_INTERVAL_MS,
      )) {
        try {
          await this.scheduleCheckpoint();
        } catch {
          // scheduleCheckpoint records the failure and keeps the journal intact.
        }
      } else if (allowAutomaticCheckpoint) {
        this.scheduleCheckpointDeadline();
      }
    } catch (error) {
      this.pendingRecords.unshift(...records);
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ ...this.status, state: 'error', error: message });
      this.diagnostics.record('error', 'core.persistence', 'Autosave journal failed', error);
    }
  }

  async createRecoveryPoint(label: string): Promise<RecoveryPointSummary> {
    await this.flushJournal(false);
    const snapshot = await this.buildPersistedApplication();
    const summary: RecoveryPointSummary = {
      id: `recovery:${snapshot.savedAt}:${Math.random().toString(36).slice(2)}`,
      label: label.trim().slice(0, 80) || '手动恢复点',
      createdAt: snapshot.savedAt,
      documentRevision: snapshot.store.document.revision,
      recordCount: Object.values(snapshot.store.document.namespaces)
        .reduce((total, namespace) => total + Object.keys(namespace).length, 0),
    };
    if (this.database) {
      const prepared = await this.prepareCheckpoint(snapshot);
      validateExternalizedCheckpoint(prepared.checkpoint);
      const recoveryPoints = await this.queueIO(async () => {
        await writeRecoveryPoint(
          this.database!,
          summary,
          prepared.checkpoint,
          this.persistedContentChunkIds,
        );
        await pruneRecovery(this.database!, RECOVERY_LIMIT);
        await collectContentChunkGarbage(this.database!, this.persistedContentChunkIds);
        return (await readAll<RecoveryPointRecord>(this.database!, 'recovery')).length;
      });
      this.setStatus({ ...this.status, recoveryPoints });
    }
    return summary;
  }

  async listRecoveryPoints(): Promise<RecoveryPointSummary[]> {
    if (!this.database) return [];
    await this.ioTail;
    return (await readAll<RecoveryPointRecord>(this.database, 'recovery'))
      .map((record) => record.summary)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async readRecoveryPoint(id: string): Promise<PersistedApplication> {
    if (!this.database) throw new Error('当前浏览器不支持本地恢复点');
    await this.ioTail;
    const record = await readValue<RecoveryPointRecord>(this.database, 'recovery', id);
    if (!record) throw new Error('恢复点已经不存在');
    const application = await hydrateStoredApplication(this.database, record.snapshot);
    this.workspacePersistence.scrubStore(application.store);
    return application;
  }

  async setAutosaveInterval(intervalMs: number): Promise<PersistenceStatus> {
    if (!isAutosaveInterval(intervalMs)) throw new Error('不支持的自动保存间隔');
    if (this.database) await writeValue(this.database, 'meta', AUTOSAVE_INTERVAL_META_KEY, intervalMs);
    this.autosaveIntervalMs = intervalMs;
    this.setStatus({ ...this.status });
    this.clearAutomaticSaveRequest();
    this.scheduleAutomaticSaveRequest();
    return this.snapshot();
  }

  async readPersonalPreference<TValue = unknown>(key: string): Promise<TValue | undefined> {
    const storageKey = personalPreferenceKey(key);
    if (!this.database) {
      const value = this.memoryPreferences.get(storageKey);
      return value === undefined ? undefined : structuredClone(value) as TValue;
    }
    await this.ioTail;
    const value = await readValue<TValue>(this.database, 'meta', storageKey);
    return value === undefined ? undefined : structuredClone(value);
  }

  async writePersonalPreference(key: string, value: unknown): Promise<void> {
    const storageKey = personalPreferenceKey(key);
    const cloned = validatePersonalPreferenceValue(value);
    this.memoryPreferences.set(storageKey, cloned);
    if (this.database) {
      await this.queueIO(() => writeValue(this.database!, 'meta', storageKey, cloned));
    }
  }

  async readPersonalTextAsset(key: string): Promise<PersonalTextAssetRecord | undefined> {
    const storageKey = personalAssetKey(key);
    if (!this.database) {
      const value = this.memoryPersonalAssets.get(storageKey);
      return value ? { ...value } : undefined;
    }
    await this.ioTail;
    const value = await readValue<unknown>(this.database, 'personalAssets', storageKey);
    return isPersonalTextAssetRecord(value) ? { ...value } : undefined;
  }

  async writePersonalTextAsset(key: string, value: PersonalTextAssetRecord): Promise<void> {
    const storageKey = personalAssetKey(key);
    const validated = validatePersonalTextAsset(value);
    this.memoryPersonalAssets.set(storageKey, validated);
    if (this.database) {
      await this.queueIO(() => writeValue(this.database!, 'personalAssets', storageKey, validated));
    }
  }

  private async scheduleCheckpoint(): Promise<void> {
    if (!this.database) return;
    if (this.checkpointTask) return this.checkpointTask.result;
    this.clearCheckpointDeadline();
    const database = this.database;
    const task = this.tasks.schedule<void>('core.persistence', {
      category: 'persistence-checkpoint',
      label: '正在更新本机恢复副本',
      priority: 30,
      timeoutMs: 5 * 60_000,
      noticeAfterMs: 0,
      estimatedCost: Math.max(1, this.store.summary()
        .reduce((total, domain) => total + domain.recordCount, 0)),
      run: async (signal, report) => {
        report(0.05);
        await yieldToMainThread();
        await this.writeCheckpointNow(database, signal, report);
        const snapshot = this.snapshot();
        this.onAutomaticCheckpoint?.({
          savedAt: snapshot.checkpointAt ?? Date.now(),
          documentRevision: this.store.getDomainRevision('document'),
        });
      },
    });
    this.checkpointTask = task;
    try {
      await task.result;
    } finally {
      if (this.checkpointTask === task) this.checkpointTask = undefined;
    }
  }

  private async writeCheckpointNow(
    database: IDBDatabase,
    signal?: AbortSignal,
    report: (progress: number) => void = () => undefined,
  ): Promise<void> {
    const monitor = new CheckpointPerformanceMonitor();
    const prepareStarted = performanceNow();
    let usedWorker = false;
    let performanceSnapshot;
    if (signal) throwIfAborted(signal);
    try {
      const persisted = await this.buildPersistedApplication(signal);
      report(0.25);
      this.setStatus({ ...this.status, state: 'saving', error: undefined });
      const synchronousPhaseStarted = performanceNow();
      const prepared = await this.prepareCheckpoint(persisted, signal);
      usedWorker = prepared.usedWorker;
      if (!usedWorker) monitor.recordSynchronousPhase(performanceNow() - synchronousPhaseStarted);
      const externalized = prepared.checkpoint;
      validateExternalizedCheckpoint(externalized);
      report(0.55);
      await this.queueIO(async () => {
        await writeCheckpoint(database, externalized, this.persistedContentChunkIds);
        await collectContentChunkGarbage(database, this.persistedContentChunkIds);
      });
      performanceSnapshot = monitor.finish(performanceNow() - prepareStarted, usedWorker);
      report(1);
      this.setStatus({
        ...this.status,
        state: 'saved',
        lastSavedAt: persisted.savedAt,
        checkpointAt: persisted.savedAt,
        journalEntries: 0,
        checkpointPerformance: performanceSnapshot,
        error: undefined,
      });
      if (performanceSnapshot.longestMainThreadBlockMs >= CHECKPOINT_MAIN_THREAD_WARNING_MS) {
        this.diagnostics.record('warn', 'core.persistence', 'Checkpoint caused a long main-thread block', {
          durationMs: performanceSnapshot.durationMs,
          prepareMs: performanceSnapshot.prepareMs,
          longestMainThreadBlockMs: performanceSnapshot.longestMainThreadBlockMs,
          usedWorker: performanceSnapshot.usedWorker,
        });
      }
      this.clearCheckpointDeadline();
    } catch (error) {
      performanceSnapshot ??= monitor.finish(performanceNow() - prepareStarted, usedWorker);
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ ...this.status, state: 'error', checkpointPerformance: performanceSnapshot, error: message });
      this.diagnostics.record('error', 'core.persistence', 'Checkpoint failed', error);
      throw error;
    }
  }

  private async prepareCheckpoint(
    persisted: PersistedApplication,
    signal?: AbortSignal,
  ): Promise<{ checkpoint: ExternalizedCheckpoint; usedWorker: boolean }> {
    // Externalize immutable chunk values before crossing the worker boundary.
    // The worker receives only the structural snapshot, so message cloning
    // never duplicates every large正文 string on the way in and out.
    const externalized = externalizeContentChunks(persisted);
    if (!this.workers?.isAvailable()) {
      return { checkpoint: externalized, usedWorker: false };
    }
    try {
      const stored = await this.workers.run<ChunkExternalizedApplication>(
        'core.persistence',
        PERSISTENCE_PREPARE_CHECKPOINT_JOB,
        externalized.stored,
        signal,
      );
      const checkpoint = { stored, chunks: externalized.chunks };
      validateExternalizedCheckpoint(checkpoint);
      return { checkpoint, usedWorker: true };
    } catch (error) {
      if (error instanceof WorkerUnavailableError) {
        return { checkpoint: externalized, usedWorker: false };
      }
      throw error;
    }
  }

  private queueIO<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.ioTail.then(operation, operation);
    this.ioTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async buildPersistedApplication(signal?: AbortSignal): Promise<PersistedApplication> {
    const savedAt = Date.now();
    const preserved = new Set([CONTENT_CHUNK_NAMESPACE]);
    const storePromise = this.store.snapshotAsync(signal, { preserveImmutableNamespaces: preserved });
    const historyPromise = this.history.exportAsync(signal, { preserveImmutableNamespaces: preserved });
    const [store, history] = await Promise.all([storePromise, historyPromise]);
    // snapshotAsync/exportAsync already return private deep clones. Scrub them
    // in place so a checkpoint does not clone every large immutable chunk and
    // historical patch for a second time before worker preparation.
    this.retiredData.scrubStoreInPlace(store);
    this.retiredData.scrubHistoryInPlace(history);
    this.workspacePersistence.scrubStore(store);
    return {
      formatVersion: 1,
      savedAt,
      store,
      history,
      projectPlugins: structuredClone(this.projectPlugins),
    };
  }

  private setStatus(status: PersistenceStatusInput): void {
    this.status = { ...status, autosaveIntervalMs: this.autosaveIntervalMs };
    for (const listener of this.listeners) listener();
  }

  private scheduleCheckpointDeadline(): void {
    this.clearCheckpointDeadline();
    if (!this.database || this.status.journalEntries <= 0) return;
    const checkpointAt = this.status.checkpointAt ?? Date.now();
    const delay = Math.max(0, checkpointAt + RECOVERY_CHECKPOINT_INTERVAL_MS - Date.now());
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      void this.scheduleCheckpoint().catch((error) => {
        this.diagnostics.record('error', 'core.persistence', 'Scheduled autosave checkpoint failed', error);
      });
    }, delay);
  }

  private clearCheckpointDeadline(): void {
    if (!this.checkpointTimer) return;
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
  }

  private scheduleAutomaticSaveRequest(): void {
    if (!this.autosaveDirty || this.autosaveIntervalMs === AUTOSAVE_DISABLED_INTERVAL_MS) return;
    if (this.autosaveTimer) {
      if (this.autosaveIntervalMs !== AUTOSAVE_REALTIME_INTERVAL_MS) return;
      clearTimeout(this.autosaveTimer);
    }
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = undefined;
      if (!this.autosaveDirty || this.autosaveIntervalMs === AUTOSAVE_DISABLED_INTERVAL_MS) return;
      this.autosaveDirty = false;
      this.onAutomaticSaveRequest?.({
        requestedAt: Date.now(),
        documentRevision: this.store.getDomainRevision('document'),
      });
    }, this.autosaveIntervalMs);
    (this.autosaveTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }

  private clearAutomaticSaveRequest(): void {
    if (!this.autosaveTimer) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = undefined;
  }
}

export function mergePendingJournalRecords(
  previous: TransactionCommitRecord,
  next: TransactionCommitRecord,
): TransactionCommitRecord | undefined {
  if (previous.historyAction !== 'record' || next.historyAction !== 'record' ||
    !canMergePatchEntries(previous, next)) return undefined;
  const compacted = composePatchPairs(
    previous.forward,
    previous.inverse,
    next.forward,
    next.inverse,
  );
  return {
    ...previous,
    label: next.label,
    timestamp: next.timestamp,
    forward: compacted.forward,
    inverse: compacted.inverse,
  };
}

function isAutosaveInterval(value: unknown): value is number {
  return typeof value === 'number' && AUTOSAVE_INTERVAL_OPTIONS.includes(
    value as (typeof AUTOSAVE_INTERVAL_OPTIONS)[number],
  );
}

export function isAutosaveCheckpointDue(
  checkpointAt: number | undefined,
  now: number,
  intervalMs: number,
): boolean {
  return checkpointAt === undefined || now - checkpointAt >= intervalMs;
}

function personalPreferenceKey(key: string): string {
  const normalized = key.trim();
  if (!/^[a-z0-9][a-z0-9._:@/-]{0,127}$/iu.test(normalized)) {
    throw new Error('个人偏好键不正确');
  }
  return `${PERSONAL_PREFERENCE_PREFIX}${normalized}`;
}

function personalAssetKey(key: string): string {
  const normalized = key.trim();
  if (!/^[a-z0-9][a-z0-9._:@/-]{0,127}$/iu.test(normalized)) {
    throw new Error('个人资源键不正确');
  }
  return `${PERSONAL_ASSET_PREFIX}${normalized}`;
}

function isPersonalTextAssetRecord(value: unknown): value is PersonalTextAssetRecord {
  return typeof value === 'object' && value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    typeof (value as { text?: unknown }).text === 'string' &&
    (value as { text: string }).text.length <= MAX_PERSONAL_TEXT_ASSET_LENGTH &&
    ((value as { fileName?: unknown }).fileName === undefined ||
      typeof (value as { fileName?: unknown }).fileName === 'string') &&
    typeof (value as { updatedAt?: unknown }).updatedAt === 'number' &&
    Number.isFinite((value as { updatedAt: number }).updatedAt);
}

function validatePersonalTextAsset(value: PersonalTextAssetRecord): PersonalTextAssetRecord {
  if (!isPersonalTextAssetRecord(value)) {
    throw new Error('个人文本资源不正确或超过 16 MiB 安全上限');
  }
  if (value.fileName && value.fileName.length > 240) throw new Error('个人文本资源文件名过长');
  return { ...value };
}

function validatePersonalPreferenceValue(value: unknown): unknown {
  if (value === undefined) throw new Error('个人偏好值不能是 undefined');
  const cloned = structuredClone(value);
  const serialized = JSON.stringify(cloned);
  if (serialized === undefined || serialized.length > 256 * 1024) {
    throw new Error('个人偏好数据超过 256 KB 上限');
  }
  return cloned;
}

function performanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function replayApplication(
  baseline: PersistedApplication,
  records: TransactionCommitRecord[],
  retiredData = new RetiredDataRegistry([]),
): PersistedApplication {
  const cleanBaseline = scrubPersistedApplication(baseline, retiredData).value;
  const cleanRecords = records.map((record) => scrubCommitRecord(record, retiredData).value);
  const store = structuredClone(cleanBaseline.store);
  const history = new HistoryService(2400);
  history.import(cleanBaseline.history);
  let savedAt = cleanBaseline.savedAt;
  for (const record of [...cleanRecords].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  )) {
    applySnapshotPatches(store, record.forward);
    if (record.historyAction === 'record') {
      history.record({
        id: record.id,
        label: record.label,
        timestamp: record.timestamp,
        forward: record.forward,
        inverse: record.inverse,
        mergeKey: record.mergeKey,
        mergeWindowMs: record.mergeWindowMs,
      });
    } else if (record.historyAction === 'undo') history.markUndone();
    else if (record.historyAction === 'redo') history.markRedone();
    savedAt = Math.max(savedAt, record.timestamp);
  }
  return { ...structuredClone(cleanBaseline), savedAt, store, history: history.export() };
}

export function hydrateExternalizedContentChunks(
  stored: ChunkExternalizedApplication,
  chunks: ReadonlyMap<string, unknown>,
): PersistedApplication {
  const namespace: Record<string, unknown> = {};
  for (const id of stored.activeContentChunkIds ?? stored.contentChunkIds) {
    if (!chunks.has(id)) throw new Error(`Local content chunk is missing: ${id}`);
    namespace[id] = chunks.get(id);
  }
  return {
    ...stored.application,
    history: {
      undo: stored.application.history.undo.map((entry) => ({
        ...entry,
        forward: hydrateChunkPatches(entry.forward, chunks),
        inverse: hydrateChunkPatches(entry.inverse, chunks),
      })),
      redo: stored.application.history.redo.map((entry) => ({
        ...entry,
        forward: hydrateChunkPatches(entry.forward, chunks),
        inverse: hydrateChunkPatches(entry.inverse, chunks),
      })),
    },
    store: {
      ...stored.application.store,
      document: {
        ...stored.application.store.document,
        namespaces: {
          ...stored.application.store.document.namespaces,
          [CONTENT_CHUNK_NAMESPACE]: namespace,
        },
      },
    },
  };
}

function hydrateChunkPatches(
  patches: PatchOperation[],
  chunks: ReadonlyMap<string, unknown>,
): PatchOperation[] {
  return patches.map((patch) => {
    if (patch.op !== 'set' || patch.domain !== 'document' || patch.namespace !== CONTENT_CHUNK_NAMESPACE ||
      !isChunkReference(patch.value)) return patch;
    const id = patch.value[CONTENT_CHUNK_REFERENCE];
    if (!chunks.has(id)) throw new Error(`Local history content chunk is missing: ${id}`);
    return { ...patch, value: chunks.get(id) };
  });
}

function isChunkReference(value: unknown): value is Record<typeof CONTENT_CHUNK_REFERENCE, string> {
  return typeof value === 'object' && value !== null &&
    CONTENT_CHUNK_REFERENCE in value &&
    typeof (value as Record<string, unknown>)[CONTENT_CHUNK_REFERENCE] === 'string';
}

async function hydrateStoredApplication(
  database: IDBDatabase,
  stored: StoredPersistedApplication,
): Promise<PersistedApplication> {
  if (!isChunkExternalized(stored)) return structuredClone(stored);
  const records = await readAll<unknown>(database, 'contentChunks');
  const keys = await readAllKeys(database, 'contentChunks');
  const chunks = new Map<string, unknown>();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'string') chunks.set(key, records[index]);
  }
  return hydrateExternalizedContentChunks(stored, chunks);
}

function isChunkExternalized(value: StoredPersistedApplication): value is ChunkExternalizedApplication {
  return 'persistenceStorageVersion' in value && value.persistenceStorageVersion === 2 &&
    Array.isArray(value.contentChunkIds);
}

function applySnapshotPatches(snapshot: StoreSnapshot, patches: PatchOperation[]): void {
  const touched = new Set<'document' | 'workspace'>();
  for (const patch of patches) {
    const domain = snapshot[patch.domain];
    const namespace = domain.namespaces[patch.namespace] ?? {};
    domain.namespaces[patch.namespace] = namespace;
    if (patch.op === 'set') namespace[patch.key] = structuredClone(patch.value);
    else delete namespace[patch.key];
    touched.add(patch.domain);
  }
  for (const domain of touched) snapshot[domain].revision += 1;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('infinite-canvas-framework', 5);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('snapshots')) database.createObjectStore('snapshots');
      if (!database.objectStoreNames.contains('journal')) database.createObjectStore('journal', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('recovery')) database.createObjectStore('recovery');
      if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta');
      if (!database.objectStoreNames.contains('contentChunks')) database.createObjectStore('contentChunks');
      if (!database.objectStoreNames.contains('personalAssets')) database.createObjectStore('personalAssets');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function scrubRetiredPersistentData(
  database: IDBDatabase,
  retiredData: RetiredDataRegistry,
): Promise<void> {
  if (await readValue<boolean>(database, 'meta', retiredData.migrationKey)) return;
  const [storedSnapshot, journal, recovery] = await Promise.all([
    readValue<StoredPersistedApplication>(database, 'snapshots', 'latest'),
    readAll<TransactionCommitRecord>(database, 'journal'),
    readAll<RecoveryPointRecord>(database, 'recovery'),
  ]);
  const snapshot = storedSnapshot ? await hydrateStoredApplication(database, storedSnapshot) : undefined;
  const cleanSnapshot = snapshot ? scrubPersistedApplication(snapshot, retiredData) : undefined;
  const cleanJournal = journal.map((record) => scrubCommitRecord(record, retiredData));
  const cleanRecovery = await Promise.all(recovery.map(async (record) => {
    const hydrated = await hydrateStoredApplication(database, record.snapshot);
    const snapshotResult = scrubPersistedApplication(hydrated, retiredData);
    return { value: { ...record, snapshot: snapshotResult.value }, changed: snapshotResult.changed };
  }));
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['snapshots', 'journal', 'recovery', 'meta'], 'readwrite');
    if (cleanSnapshot?.changed) transaction.objectStore('snapshots').put(cleanSnapshot.value, 'latest');
    const journalStore = transaction.objectStore('journal');
    for (const record of cleanJournal) if (record.changed) journalStore.put(record.value);
    const recoveryStore = transaction.objectStore('recovery');
    for (const record of cleanRecovery) {
      if (record.changed) recoveryStore.put(record.value, record.value.summary.id);
    }
    transaction.objectStore('meta').put(true, retiredData.migrationKey);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Legacy data cleanup aborted'));
  });
}

function scrubPersistedApplication(
  source: PersistedApplication,
  retiredData: RetiredDataRegistry,
): { value: PersistedApplication; changed: boolean } {
  const store = retiredData.scrubStore(source.store);
  const history = retiredData.scrubHistory(source.history);
  return {
    value: { ...structuredClone(source), store: store.value, history: history.value },
    changed: store.changed || history.changed,
  };
}

function scrubCommitRecord(
  source: TransactionCommitRecord,
  retiredData: RetiredDataRegistry,
): { value: TransactionCommitRecord; changed: boolean } {
  let changed = false;
  const scrub = (patches: PatchOperation[]) => patches.map((patch) => {
    const result = retiredData.scrubPatch(patch);
    changed ||= result.changed;
    return result.value;
  });
  return {
    value: { ...structuredClone(source), forward: scrub(source.forward), inverse: scrub(source.inverse) },
    changed,
  };
}

function readValue<T>(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

function readAll<T>(database: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

function readAllKeys(database: IDBDatabase, storeName: string): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writeValue(database: IDBDatabase, storeName: string, key: IDBValidKey, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Persistence write aborted'));
  });
}

function writeJournal(database: IDBDatabase, records: TransactionCommitRecord[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('journal', 'readwrite');
    const journal = transaction.objectStore('journal');
    for (const record of records) journal.put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Journal write aborted'));
  });
}

function writeCheckpoint(
  database: IDBDatabase,
  checkpoint: ExternalizedCheckpoint,
  persistedChunkIds: Set<string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['snapshots', 'journal', 'contentChunks'], 'readwrite');
    const chunks = transaction.objectStore('contentChunks');
    const newlyPersisted: string[] = [];
    for (const [id, value] of checkpoint.chunks) {
      if (persistedChunkIds.has(id)) continue;
      chunks.put(value, id);
      newlyPersisted.push(id);
    }
    transaction.objectStore('snapshots').put(checkpoint.stored, 'latest');
    transaction.objectStore('journal').clear();
    transaction.oncomplete = () => {
      for (const id of newlyPersisted) persistedChunkIds.add(id);
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Checkpoint write aborted'));
  });
}

function clearPreviousSession(database: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['snapshots', 'journal', 'recovery', 'contentChunks'], 'readwrite');
    transaction.objectStore('snapshots').clear();
    transaction.objectStore('journal').clear();
    transaction.objectStore('recovery').clear();
    transaction.objectStore('contentChunks').clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Session cleanup aborted'));
  });
}

function writeRecoveryPoint(
  database: IDBDatabase,
  summary: RecoveryPointSummary,
  checkpoint: ExternalizedCheckpoint,
  persistedChunkIds: Set<string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['recovery', 'contentChunks'], 'readwrite');
    const chunks = transaction.objectStore('contentChunks');
    const newlyPersisted: string[] = [];
    for (const [id, value] of checkpoint.chunks) {
      if (persistedChunkIds.has(id)) continue;
      chunks.put(value, id);
      newlyPersisted.push(id);
    }
    transaction.objectStore('recovery').put(
      { summary, snapshot: checkpoint.stored } satisfies RecoveryPointRecord,
      summary.id,
    );
    transaction.oncomplete = () => {
      for (const id of newlyPersisted) persistedChunkIds.add(id);
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Recovery point write aborted'));
  });
}

async function collectContentChunkGarbage(
  database: IDBDatabase,
  persistedChunkIds: Set<string>,
): Promise<void> {
  const [latest, recovery] = await Promise.all([
    readValue<StoredPersistedApplication>(database, 'snapshots', 'latest'),
    readAll<RecoveryPointRecord>(database, 'recovery'),
  ]);
  const retained = new Set<string>();
  if (latest && isChunkExternalized(latest)) {
    for (const id of latest.contentChunkIds) retained.add(id);
  }
  for (const record of recovery) {
    if (!isChunkExternalized(record.snapshot)) continue;
    for (const id of record.snapshot.contentChunkIds) retained.add(id);
  }
  const expired = [...persistedChunkIds].filter((id) => !retained.has(id));
  if (expired.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('contentChunks', 'readwrite');
    const chunks = transaction.objectStore('contentChunks');
    for (const id of expired) chunks.delete(id);
    transaction.oncomplete = () => {
      for (const id of expired) persistedChunkIds.delete(id);
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Content chunk cleanup aborted'));
  });
}

async function pruneRecovery(database: IDBDatabase, limit: number): Promise<void> {
  const records = (await readAll<RecoveryPointRecord>(database, 'recovery'))
    .sort((left, right) => right.summary.createdAt - left.summary.createdAt);
  const expired = records.slice(limit);
  if (expired.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('recovery', 'readwrite');
    const recovery = transaction.objectStore('recovery');
    for (const record of expired) recovery.delete(record.summary.id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Recovery cleanup aborted'));
  });
}
