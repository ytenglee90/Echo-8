import type { RecoveryPointSummary } from './files.ts';
import type { LocalStorageUsage } from './local-storage.ts';

export const RECOVERY_RETENTION_OPTIONS = [8, 20, 50, 100] as const;
export interface RecoveryCatalogRequest { before?: string }
export interface RecoveryCatalog {
  points: Array<RecoveryPointSummary & { storedBytes: number }>;
  nextCursor?: string;
  totalCount: number;
  listedAt: number;
  retentionLimit: number | null;
}
export type RecoveryDeleteRequest = { ids: string[]; through?: never } | { through: number; ids?: never };
export interface RecoveryMaintenanceResult {
  removedPoints: number;
  remainingPoints: number;
  usage: LocalStorageUsage;
}

export function isRecoveryRetentionLimit(value: unknown): value is number | null {
  return value === null || RECOVERY_RETENTION_OPTIONS.some((limit) => value === limit);
}

export function isRecoveryDeleteRequest(value: unknown): value is RecoveryDeleteRequest {
  if (!value || typeof value !== 'object') return false;
  if ('ids' in value) return !('through' in value) && Array.isArray(value.ids) &&
    value.ids.length > 0 && value.ids.length <= 1000 &&
    value.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200);
  return 'through' in value && typeof value.through === 'number' &&
    Number.isSafeInteger(value.through) && value.through >= 0;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'system.recovery.delete@1': CommandContract<RecoveryDeleteRequest, RecoveryMaintenanceResult>;
    'system.recovery.setRetention@1': CommandContract<{ limit: number | null }, RecoveryMaintenanceResult>;
  }
}

declare module './messages.ts' {
  interface ApplicationQueryMap {
    'system.recovery.catalog@1': MessageContract<RecoveryCatalogRequest | undefined, RecoveryCatalog>;
  }
}
