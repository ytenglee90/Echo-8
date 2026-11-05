export interface LocalStorageUsage {
  measuredAt: number;
  originUsedBytes?: number;
  originQuotaBytes?: number;
  categories: Array<{ id: string; label: string; bytes: number; records: number }>;
  lastCleanupAt?: number;
}
export interface LocalCleanupResult { removedRecords: number; usage: LocalStorageUsage }

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'system.storage.cleanup': CommandContract<{ includeBackedUpRecovery?: boolean } | undefined, LocalCleanupResult>;
    'system.persistence.confirmBackup': CommandContract<{ documentRevision: number }, { confirmed: boolean }>;
  }
}
