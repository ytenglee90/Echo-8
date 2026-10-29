import type { DomainSnapshot, PatchOperation } from './state.ts';
import type { CommandContract } from './commands.ts';

export const PROJECT_KIND = 'echo-8-project' as const;
export const PROJECT_FORMAT_VERSION = 2 as const;
export const PROJECT_FILE_EXTENSION = '.echo8' as const;
/** Compact project exports are gzip-compressed NDJSON snapshots. */
export const PROJECT_MEDIA_TYPE = 'application/x-echo-8-canvas+gzip' as const;
export const LEGACY_PROJECT_MEDIA_TYPE = 'application/x-echo-8-canvas+ndjson' as const;
/** Opens a user-confirmed writable directory, preferring the current book's location. */
export const PROJECT_RELATED_DIRECTORY_CAPABILITY = 'file.chooseDirectoryNearProject@1' as const;
export const PROJECT_OPEN_ACCEPT = [
  PROJECT_FILE_EXTENSION,
  '.eco8',
  PROJECT_MEDIA_TYPE,
  LEGACY_PROJECT_MEDIA_TYPE,
].join(',');

/** `eco8` is accepted as a forgiving import alias; new files are always saved as `.echo8`. */
export function isEcho8ProjectFile(file: Pick<File, 'name' | 'type'>): boolean {
  const name = file.name.toLocaleLowerCase();
  return name.endsWith(PROJECT_FILE_EXTENSION) || name.endsWith('.eco8') ||
    file.type === PROJECT_MEDIA_TYPE || file.type === LEGACY_PROJECT_MEDIA_TYPE;
}

/** Produces a bounded cross-platform filename stem without changing document data. */
export function safeLocalFilename(value: string, fallback = '未命名节点'): string {
  const sanitized = (value.trim() || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .slice(0, 120) || fallback;
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(sanitized)
    ? `_${sanitized}`
    : sanitized;
}

export interface ProjectPluginDescriptor {
  id: string;
  version: string;
  /** Missing in older books and interpreted as version 1. */
  dataVersion?: number;
  namespaces: string[];
  available: boolean;
}

export interface ProjectHistoryEntry {
  id: string;
  label: string;
  timestamp: number;
  forward: PatchOperation[];
  inverse: PatchOperation[];
  mergeKey?: string;
  mergeWindowMs?: number;
}

export interface ProjectHistorySnapshot {
  undo: ProjectHistoryEntry[];
  redo: ProjectHistoryEntry[];
}

export interface ProjectSource {
  document: DomainSnapshot;
  plugins: ProjectPluginDescriptor[];
  /**
   * Accepted only for legacy callers. Compact v2 exports deliberately omit
   * undo/redo history so a shared book is a current document snapshot.
   */
  history?: ProjectHistorySnapshot;
}

export interface DocumentRevisionSnapshot {
  revision: number;
}

export interface FileRuntimeState {
  open: boolean;
  savedDocumentRevision?: number;
  hasProjectDestination: boolean;
  /** A hosted cloud book is the active primary save target. */
  cloudProjectActive: boolean;
  saveLocationRequired: boolean;
  pendingOpenName?: string;
  pendingOpen?: {
    kind: 'picker' | 'file';
    phase: 'needs-decision' | 'ready-to-choose';
    fileName?: string;
  };
}

export interface ProjectOpenRequestResult {
  openPicker: boolean;
}

export interface PendingProjectOpenProceedResult {
  openPicker: boolean;
  authorizationId?: string;
  openedDroppedFile?: boolean;
}

/** A file explicitly selected from the book-library switching surface. */
export interface LibraryProjectOpenPayload {
  file: Blob & { name?: string };
  destination?: FileSaveTarget;
}

export interface ProjectManifestV1 {
  type: 'manifest';
  kind: typeof PROJECT_KIND;
  formatVersion: 1;
  coreVersion: '0.1.0';
  savedAt: number;
  documentRevision: number;
  plugins: ProjectPluginDescriptor[];
}

export interface ProjectManifestV2 {
  type: 'manifest';
  kind: typeof PROJECT_KIND;
  formatVersion: typeof PROJECT_FORMAT_VERSION;
  coreVersion: '0.1.0';
  savedAt: number;
  documentRevision: number;
  /** Undo history stays in this browser's recovery store, never in shared books. */
  historyMode: 'none';
  plugins: ProjectPluginDescriptor[];
}

export type ProjectManifest = ProjectManifestV1 | ProjectManifestV2;

export interface ProjectFooterV1 {
  type: 'footer';
  algorithm: 'crc32';
  checksum: string;
  entryCount: number;
}

export interface ProjectOpenPayload {
  manifest: ProjectManifest;
  document: DomainSnapshot;
  history: ProjectHistorySnapshot;
  /** Identifies the coordinator that requested this exclusive replacement. */
  origin?: 'file' | 'cloud' | 'new' | 'recovery' | 'external';
}

export interface RecoveryPointSummary {
  id: string;
  label: string;
  createdAt: number;
  documentRevision: number;
  recordCount: number;
}

export interface RecoveryPreview {
  id: string;
  label: string;
  createdAt: number;
  currentDocumentRevision: number;
  targetDocumentRevision: number;
  currentRecordCount: number;
  targetRecordCount: number;
  currentNamespaceCount: number;
  targetNamespaceCount: number;
  targetUndoEntries: number;
  targetRedoEntries: number;
  targetPluginCount: number;
}

export interface PersistenceSnapshot {
  state: 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'memory-only';
  lastSavedAt?: number;
  checkpointAt?: number;
  error?: string;
  journalEntries: number;
  recoveryPoints: number;
  autosaveIntervalMs: number;
  checkpointPerformance?: CheckpointPerformanceSnapshot;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'system.document.new': CommandContract<undefined, { id: string }>;
    'file.saveProjectAs': CommandContract<undefined, unknown>;
    'file.chooseOpenProject': CommandContract<undefined, ProjectOpenRequestResult>;
    'file.openProjectFromLibrary': CommandContract<LibraryProjectOpenPayload, { taskId: string }>;
    'file.requestOpenProject': CommandContract<undefined, ProjectOpenRequestResult>;
    'file.proceedPendingOpen': CommandContract<
      { authorizationId?: string } | undefined,
      PendingProjectOpenProceedResult
    >;
    'system.persistence.checkpoint': CommandContract<{ label?: string } | undefined, RecoveryPointSummary>;
    'system.persistence.setAutosaveInterval': CommandContract<{ intervalMs: number }, PersistenceSnapshot>;
  }
}

export interface CheckpointPerformanceSnapshot {
  measuredAt: number;
  durationMs: number;
  prepareMs: number;
  longestMainThreadBlockMs: number;
  usedWorker: boolean;
}

export const AUTOSAVE_DISABLED_INTERVAL_MS = 0;
export const AUTOSAVE_REALTIME_INTERVAL_MS = 1_000;
export const DEFAULT_AUTOSAVE_INTERVAL_MS = 60_000;

export const AUTOSAVE_INTERVAL_OPTIONS = [
  AUTOSAVE_REALTIME_INTERVAL_MS,
  30_000,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  120_000,
  300_000,
  600_000,
  1_800_000,
  AUTOSAVE_DISABLED_INTERVAL_MS,
] as const;

export interface FileArtifact {
  filename: string;
  mimeType: string;
  blob: Blob;
}

export interface FileWritableTarget {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface FileSaveTarget {
  name: string;
  createWritable(): Promise<FileWritableTarget>;
  /** Native file handles support reading; write-only test/download adapters may omit it. */
  getFile?(): Promise<File>;
  /** Supported by newer native file-system handles; absent in fallback/download adapters. */
  move?(name: string): Promise<void>;
  /** Persisted handles must be checked without prompting before background reuse. */
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface FileReadWriteTarget extends FileSaveTarget {
  getFile(): Promise<File>;
}

export interface FileDirectoryTarget {
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSaveTarget>;
  /** Required only by protocols that own a nested directory tree. */
  getDirectoryHandle?(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileDirectoryTarget>;
  /** Optional in non-browser adapters; native FileSystemDirectoryHandle supports it. */
  removeEntry?(name: string): Promise<void>;
  /** Native handles can prove that a newly selected directory is the previously bound one. */
  isSameEntry?(other: FileDirectoryTarget): Promise<boolean>;
  /** Checking must not request permission during application startup. */
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface FileOperationStatus {
  operation: 'project-save' | 'project-open' | 'text-export' | 'word-export' | 'document-import' | 'recovery';
  state: 'running' | 'ready' | 'error';
  message: string;
  progress?: number;
}

export type TextExportScope = 'current' | 'canvas';
