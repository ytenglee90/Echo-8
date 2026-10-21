import type { DomainSnapshot } from '../core/contracts.ts';
import type { ProjectPluginDescriptor } from '../protocols/files.ts';
import type { TransactionCommitRecord } from '../core/transaction-manager.ts';

export const CLOUD_API_VERSION = 1 as const;
/**
 * Deployment/schema release of the user-owned data Worker. Increment this
 * only when existing installations must republish that Worker or apply D1
 * migrations. It is intentionally separate from the browser wire protocol.
 */
export const CLOUD_DATA_WORKER_VERSION = 3 as const;
export const CLOUD_CONTENT_CHUNK_NAMESPACE = 'textContentChunk';

export function cloudDataWorkerUpgradeAvailable(installedVersion: number): boolean {
  return Number.isSafeInteger(installedVersion) && installedVersion > 0 &&
    installedVersion < CLOUD_DATA_WORKER_VERSION;
}

export type CloudConnectionPhase =
  | 'disabled'
  | 'signed-out'
  | 'needs-installation'
  | 'connecting'
  | 'ready'
  | 'syncing'
  | 'read-only'
  | 'offline'
  | 'conflict'
  | 'error';

export interface CloudAccountSummary {
  id: string;
  name: string;
}

export interface CloudInstallationSummary {
  id: string;
  accountId: string;
  accountName: string;
  workerUrl: string;
  workerVersion: number;
  latestWorkerVersion: number;
  upgradeAvailable: boolean;
  status: 'provisioning' | 'ready' | 'error' | 'revoked';
  error?: string;
}

export interface CloudControlStatus {
  configured: boolean;
  authenticated: boolean;
  user?: { id: string; email?: string; name?: string };
  accounts: CloudAccountSummary[];
  installations: CloudInstallationSummary[];
}

export interface CloudDataAccess {
  installationId: string;
  workerUrl: string;
  token: string;
  expiresAt: number;
}

export interface CloudProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  headRevision: number;
}

/** Ephemeral confirmation state owned by cloud-sync, never persisted with a book. */
export interface CloudProjectDeleteConfirmation {
  projectId: string;
  name: string;
  active: boolean;
}

/**
 * Shared books intentionally omit undo/redo history. Large immutable text
 * chunks are uploaded separately and stitched back in during bootstrap.
 */
export interface CloudCheckpoint {
  formatVersion: typeof CLOUD_API_VERSION;
  savedAt: number;
  document: DomainSnapshot;
  plugins: ProjectPluginDescriptor[];
  contentChunkIds: string[];
}

export interface CloudOperation {
  revision: number;
  commit: TransactionCommitRecord;
}

export interface CloudBootstrap {
  project: CloudProjectSummary;
  checkpointRevision: number;
  checkpoint?: CloudCheckpoint;
  chunks: Array<{ id: string; value: unknown }>;
  operations: CloudOperation[];
  lease?: CloudLease;
}

export interface CloudLease {
  id: string;
  deviceId: string;
  expiresAt: number;
  owned: boolean;
}

export interface CloudSyncState {
  panelOpen: boolean;
  phase: CloudConnectionPhase;
  configured: boolean;
  authenticated: boolean;
  user?: CloudControlStatus['user'];
  accounts: CloudAccountSummary[];
  installations: CloudInstallationSummary[];
  activeInstallationId?: string;
  activeProjectId?: string;
  activeProjectName?: string;
  headRevision: number;
  pendingCommits: number;
  upgradeAvailable: boolean;
  lastSyncedAt?: number;
  leaseExpiresAt?: number;
  otherDeviceId?: string;
  error?: string;
}
