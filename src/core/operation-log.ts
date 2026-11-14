import type { OperationDetail, OperationLogEntry, OperationLogEntryV2, OperationLogSnapshot, OperationLogSnapshotV2, OperationStageUpdateV2, OperationStatus } from '../protocols/operation-log.ts';
import { isAbortError } from '../services/abort.ts';

const HISTORY_LIMIT = 240;
const OPEN_STAGE_LIMIT = 120;
const STAGES = new Set(['ai-routing', 'ai-context-review', 'ai-model-response', 'ai-answer', 'ai-writeback', 'canvas-targets', 'canvas-read', 'canvas-validation', 'canvas-verification', 'canvas-plan', 'canvas-background']);
const STAGE_STATES = new Set<OperationStatus>(['waiting', 'running', 'pending', 'completed', 'applied', 'failed', 'timed-out', 'cancelled', 'dismissed', 'expired']);
const TERMINAL = new Set<OperationStatus>(['completed', 'applied', 'failed', 'timed-out', 'cancelled', 'dismissed', 'expired']);
const safeCode = (value: unknown): value is string => typeof value === 'string' && /^[a-z\d][a-z\d:@._-]{0,199}$/iu.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const DETAIL_ENUMS = {
  step: ['route', 'targets', 'read', 'model', 'validate', 'review', 'commit', 'verify', 'done'],
  queryMode: ['state', 'selection', 'recent', 'search', 'all', 'relations'],
  route: ['local', 'model', 'conversation'],
  intent: ['create', 'content', 'connect', 'arrange', 'move', 'color', 'presentation', 'group', 'find', 'other'],
  scope: ['canvas', 'selection', 'named', 'conversation'],
  reason: ['local-rule', 'model-plan', 'needs-target', 'ambiguous-target', 'empty-targets', 'review-existing', 'review-preference', 'ready-direct', 'invalid-plan', 'stale-target', 'plugin-unavailable', 'scope-limit', 'commit-failed', 'model-http-error', 'model-timeout', 'verified', 'verification-mismatch', 'verification-unavailable', 'no-change', 'cancelled', 'expired', 'applied'],
} as const;
const ACTIONS = ['create-node', 'update-node', 'create-group', 'update-group', 'create-connection', 'update-connection', 'delete'];

function safeDetail(value: unknown): OperationDetail | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const detail: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(DETAIL_ENUMS)) if ((values as readonly unknown[]).includes(input[key])) detail[key] = input[key];
  for (const key of ['matched', 'candidates', 'checked', 'mismatchCount', 'readCharacters']) if (finite(input[key]) && Number.isSafeInteger(input[key]) && input[key] <= 1_000_000) detail[key] = input[key];
  if (finite(input.httpStatus) && Number.isSafeInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) detail.httpStatus = input.httpStatus;
  if (Array.isArray(input.actions)) detail.actions = input.actions.slice(0, 7).flatMap(item => item && ACTIONS.includes(item.type) && finite(item.count) && Number.isSafeInteger(item.count) && item.count <= 100 ? [{ type: item.type, count: item.count }] : []);
  return Object.keys(detail).length ? detail as OperationDetail : undefined;
}

/** Session-only metadata. No message bodies, labels, errors, or patch values are retained here. */
export class OperationLog {
  private readonly active = new Map<string, OperationLogEntryV2>();
  private readonly history = new Map<string, OperationLogEntryV2>();
  private sequence = 0;
  private readonly changed: () => void;

  constructor(changed: () => void) { this.changed = changed; }

  record(entry: OperationLogEntry): void {
    if (!safeCode(entry.code) || !safeCode(entry.owner) || !safeCode(entry.id) ||
      (entry.relatedId !== undefined && !safeCode(entry.relatedId))) return;
    const finished = entry.finishedAt !== undefined;
    const target = finished ? this.history : this.active;
    if (finished) this.active.delete(entry.id);
    else this.history.delete(entry.id);
    target.delete(entry.id);
    target.set(entry.id, entry);
    if (finished && target.size > HISTORY_LIMIT) target.delete(target.keys().next().value!);
    this.changed();
  }

  forget(id: string): void {
    if (this.active.delete(id)) this.changed();
  }

  cancelStages(owner?: string): void {
    const now = Date.now();
    for (const entry of [...this.active.values()]) {
      if (entry.kind !== 'stage' || (owner !== undefined && entry.owner !== owner)) continue;
      const status = entry.status === 'pending' ? 'expired' : 'cancelled';
      this.record({ ...entry, status, updatedAt: now, finishedAt: now });
    }
  }

  stage(owner: string, update: unknown): void {
    if (!update || typeof update !== 'object') return;
    const { id, phase, state, relatedId, elapsedMs, expiresAt, count, detail: rawDetail } = update as OperationStageUpdateV2;
    if (!safeCode(id) || !STAGES.has(phase) || !STAGE_STATES.has(state)) return;
    if (phase.startsWith('ai-') ? owner !== 'ai-assistant' : owner !== 'canvas-control') return;
    const key = `stage:${owner}:${phase}:${id}`;
    const existing = this.active.get(key) ?? this.history.get(key);
    if (existing?.finishedAt !== undefined && !(['failed', 'timed-out'].includes(existing.status) && ['running', 'completed', 'applied', 'dismissed', 'expired'].includes(state))) return;
    const now = Date.now();
    const detail = safeDetail(rawDetail);
    const steps = [...existing?.steps ?? [], { at: now, status: state, ...(detail ? { detail } : {}) }].slice(-24);
    this.record({
      id: key, kind: 'stage', owner, code: phase, status: state,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
      ...(safeCode(relatedId) ? { relatedId } : existing?.relatedId ? { relatedId: existing.relatedId } : {}),
      ...(finite(elapsedMs) ? { elapsedMs } : existing?.elapsedMs !== undefined ? { elapsedMs: existing.elapsedMs } : {}),
      ...(finite(expiresAt) ? { expiresAt } : existing?.expiresAt !== undefined ? { expiresAt: existing.expiresAt } : {}),
      ...(finite(count) ? { count } : existing?.count !== undefined ? { count: existing.count } : {}),
      ...((detail || existing?.detail) ? { detail: { ...existing?.detail, ...detail }, steps } : {}),
      ...(TERMINAL.has(state) ? { finishedAt: now } : {}),
    } as OperationLogEntryV2);
    let openStages = 0;
    for (const [activeKey, entry] of [...this.active].reverse()) {
      if (entry.kind === 'stage' && ++openStages > OPEN_STAGE_LIMIT) this.active.delete(activeKey);
    }
  }

  transaction(owner: string, code: string, createdAt: number, startedAt?: number): void {
    const now = Date.now();
    this.record({ id: `transaction:${++this.sequence}`, kind: 'transaction', owner, code, status: 'applied',
      createdAt, startedAt, updatedAt: now, finishedAt: now,
      ...(startedAt !== undefined ? { queueMs: Math.max(0, startedAt - createdAt) } : {}) });
  }

  snapshot(): OperationLogSnapshot {
    const result = this.snapshotDetailed();
    return { ...result, entries: result.entries.map(entry => {
      const copy = { ...entry };
      delete copy.detail;
      delete copy.steps;
      return copy;
    }) };
  }

  snapshotDetailed(): OperationLogSnapshotV2 {
    const now = Date.now();
    return { generatedAt: now, entries: [...this.active.values(), ...this.history.values()].map(entry => (
      (entry.status === 'pending' || entry.status === 'waiting') && entry.expiresAt !== undefined && entry.expiresAt <= now
        ? { ...structuredClone(entry), status: 'expired' as const, finishedAt: entry.expiresAt, updatedAt: entry.expiresAt }
        : structuredClone(entry)
    )).sort((a, b) => Number(a.finishedAt !== undefined) - Number(b.finishedAt !== undefined) || b.updatedAt - a.updatedAt) };
  }
}

export function operationFailure(error: unknown): 'failed' | 'timed-out' | 'cancelled' {
  if (error instanceof Error && (error.name === 'TimeoutError' || /(?:\btimed? out\b|超时)/iu.test(error.message))) return 'timed-out';
  if (isAbortError(error)) return 'cancelled';
  return 'failed';
}
