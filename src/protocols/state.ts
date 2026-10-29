/** Stable state-transfer protocol shared by the kernel, persistence, and sync adapters. */
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

export interface TransactionCommitRecord {
  id: string;
  label: string;
  timestamp: number;
  forward: PatchOperation[];
  inverse: PatchOperation[];
  sourceMessageId: string;
  historyAction: 'record' | 'undo' | 'redo' | 'none';
  mergeKey?: string;
  mergeWindowMs?: number;
}
