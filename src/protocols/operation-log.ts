export const OPERATION_LOG_QUERY = 'system.operationLog@1';
export const OPERATION_LOG_CHANGED = 'system.operationLog.changed@1';
export const OPERATION_LOG_STAGE = 'system.operationLog.stage@1';
export const OPERATION_LOG_QUERY_V2 = 'system.operationLog@2';
export const OPERATION_LOG_STAGE_V2 = 'system.operationLog.stage@2';

export type OperationStatus = 'queued' | 'running' | 'paused' | 'retrying' | 'waiting' | 'completed' |
  'pending' | 'applied' | 'failed' | 'timed-out' | 'cancelled' | 'dismissed' | 'expired';

export type OperationPhase = 'ai-routing' | 'ai-context-review' | 'ai-model-response' | 'ai-answer' | 'ai-writeback' | 'canvas-targets' | 'canvas-read' | 'canvas-validation' | 'canvas-verification' | 'canvas-plan' | 'canvas-background';

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

export type OperationStep = 'route' | 'targets' | 'read' | 'model' | 'validate' | 'review' | 'commit' | 'verify' | 'done';
export type OperationReason = 'local-rule' | 'model-plan' | 'needs-target' | 'ambiguous-target' | 'empty-targets' |
  'review-existing' | 'review-preference' | 'ready-direct' | 'invalid-plan' | 'stale-target' |
  'plugin-unavailable' | 'scope-limit' | 'commit-failed' | 'model-http-error' | 'model-timeout' | 'verified' | 'verification-mismatch' | 'verification-unavailable' | 'no-change' | 'cancelled' | 'expired' | 'applied';
export interface OperationDetail {
  step?: OperationStep;
  route?: 'local' | 'model' | 'conversation';
  intent?: 'create' | 'content' | 'connect' | 'arrange' | 'move' | 'color' | 'presentation' | 'group' | 'find' | 'other';
  scope?: 'canvas' | 'selection' | 'named' | 'conversation';
  reason?: OperationReason;
  matched?: number;
  candidates?: number;
  httpStatus?: number;
  checked?: number;
  mismatchCount?: number;
  readCharacters?: number;
  queryMode?: 'state' | 'selection' | 'recent' | 'search' | 'all' | 'relations';
  actions?: Array<{ type: 'create-node' | 'update-node' | 'create-group' | 'update-group' | 'create-connection' | 'update-connection' | 'delete'; count: number }>;
}
export interface OperationStageUpdateV2 extends OperationStageUpdate { detail?: OperationDetail }
export interface OperationLogEntryV2 extends OperationLogEntry {
  detail?: OperationDetail;
  steps?: Array<{ at: number; status: OperationStatus; detail?: OperationDetail }>;
}
export interface OperationLogSnapshotV2 { generatedAt: number; entries: OperationLogEntryV2[] }

declare module './messages.ts' {
  interface ApplicationQueryMap {
    'system.operationLog@1': MessageContract<undefined, OperationLogSnapshot>;
    'system.operationLog@2': MessageContract<undefined, OperationLogSnapshotV2>;
  }
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'diagnostics.open': CommandContract<undefined, unknown>;
    'diagnostics.operationLog.open@1': CommandContract<undefined, unknown>;
  }
}
