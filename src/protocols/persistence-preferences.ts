import { AUTOSAVE_INTERVAL_OPTIONS } from './files.ts';
import { isRecoveryRetentionLimit } from './recovery-management.ts';

/** Personal policy only; never includes a book, recovery body or file permission. */
export interface PersistencePreferences {
  schemaVersion: 1;
  autosaveIntervalMs: number;
  recoveryRetentionLimit: number | null;
}

export function isPersistencePreferences(value: unknown): value is PersistencePreferences {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1 && AUTOSAVE_INTERVAL_OPTIONS.some(interval => interval === item.autosaveIntervalMs) &&
    isRecoveryRetentionLimit(item.recoveryRetentionLimit) &&
    Object.keys(item).every(key => ['schemaVersion', 'autosaveIntervalMs', 'recoveryRetentionLimit'].includes(key));
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'system.persistence.applyPreferences@1': CommandContract<PersistencePreferences, PersistencePreferences>;
    'cloudSync.syncPersistencePreferences': CommandContract<undefined, { synced: boolean }>;
    'cloudSync.resolvePersistencePreferences': CommandContract<{ choice: 'local' | 'account' }, { synced: boolean }>;
  }
}

declare module './messages.ts' {
  interface ApplicationQueryMap {
    'system.persistence.preferences@1': MessageContract<undefined, PersistencePreferences>;
  }
}
