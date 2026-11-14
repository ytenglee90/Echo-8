export const OPERATION_LOG_QUERY = 'system.operationLog@1';
export const OPERATION_LOG_CHANGED = 'system.operationLog.changed@1';
export const OPERATION_LOG_STAGE = 'system.operationLog.stage@1';

export type OperationStatus = 'queued' | 'running' | 'paused' | 'retrying' | 'waiting' | 'completed' |
  'pending' | 'applied' | 'failed' | 'timed-out' | 'cancelled' | 'dismissed' | 'expired';

export type OperationPhase = 'ai-context-review' | 'ai-model-response' | 'ai-answer' | 'ai-writeback' | 'canvas-plan' | 'canvas-background';

export interface OperationStageUpdate {
  id: string;
  phase: OperationPhase;
  state: OperationStatus;
  relatedId?: string;
  elapsedMs?: number;
  expiresAt?: number;
  count?: number;
}

export interface OperationLogEntry {
  id: string;
  kind: 'task' | 'command' | 'transaction' | 'stage';
  owner: string;
  code: string;
  status: OperationStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  nextRunAt?: number;
  finishedAt?: number;
  timeoutMs?: number;
  progress?: number;
  attempts?: number;
  queueMs?: number;
  elapsedMs?: number;
  expiresAt?: number;
  count?: number;
  relatedId?: string;
}

export interface OperationLogSnapshot {
  generatedAt: number;
  entries: OperationLogEntry[];
}

declare module './messages.ts' {
  interface ApplicationQueryMap {
    'system.operationLog@1': MessageContract<undefined, OperationLogSnapshot>;
  }
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'diagnostics.open': CommandContract<undefined, unknown>;
    'diagnostics.operationLog.open@1': CommandContract<undefined, unknown>;
  }
}
