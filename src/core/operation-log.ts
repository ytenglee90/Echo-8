import type { OperationLogEntry, OperationLogSnapshot, OperationStageUpdate, OperationStatus } from '../protocols/operation-log.ts';
import { isAbortError } from '../services/abort.ts';

const HISTORY_LIMIT = 240;
const OPEN_STAGE_LIMIT = 120;
const STAGES = new Set(['ai-context-review', 'ai-model-response', 'ai-answer', 'ai-writeback', 'canvas-plan', 'canvas-background']);
const STAGE_STATES = new Set<OperationStatus>(['waiting', 'running', 'pending', 'completed', 'applied', 'failed', 'timed-out', 'cancelled', 'dismissed', 'expired']);
const TERMINAL = new Set<OperationStatus>(['completed', 'applied', 'failed', 'timed-out', 'cancelled', 'dismissed', 'expired']);
const safeCode = (value: unknown): value is string => typeof value === 'string' && /^[a-z\d][a-z\d:@._-]{0,199}$/iu.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Session-only metadata. No message bodies, labels, errors, or patch values are retained here. */
export class OperationLog {
  private readonly active = new Map<string, OperationLogEntry>();
  private readonly history = new Map<string, OperationLogEntry>();
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
    const { id, phase, state, relatedId, elapsedMs, expiresAt, count } = update as OperationStageUpdate;
    if (!safeCode(id) || !STAGES.has(phase) || !STAGE_STATES.has(state)) return;
    if (phase.startsWith('ai-') ? owner !== 'ai-assistant' : owner !== 'canvas-control') return;
    const key = `stage:${owner}:${phase}:${id}`;
    const existing = this.active.get(key) ?? this.history.get(key);
    if (existing?.finishedAt !== undefined && !(['failed', 'timed-out'].includes(existing.status) && ['running', 'applied', 'dismissed', 'expired'].includes(state))) return;
    const now = Date.now();
    this.record({
      id: key, kind: 'stage', owner, code: phase, status: state,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
      ...(safeCode(relatedId) ? { relatedId } : existing?.relatedId ? { relatedId: existing.relatedId } : {}),
      ...(finite(elapsedMs) ? { elapsedMs } : existing?.elapsedMs !== undefined ? { elapsedMs: existing.elapsedMs } : {}),
      ...(finite(expiresAt) ? { expiresAt } : existing?.expiresAt !== undefined ? { expiresAt: existing.expiresAt } : {}),
      ...(finite(count) ? { count } : existing?.count !== undefined ? { count: existing.count } : {}),
      ...(TERMINAL.has(state) ? { finishedAt: now } : {}),
    });
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
    const now = Date.now();
    return { generatedAt: now, entries: [...this.active.values(), ...this.history.values()].map(entry => (
      (entry.status === 'pending' || entry.status === 'waiting') && entry.expiresAt !== undefined && entry.expiresAt <= now
        ? { ...entry, status: 'expired' as const, finishedAt: entry.expiresAt, updatedAt: entry.expiresAt }
        : { ...entry }
    )).sort((a, b) => Number(a.finishedAt !== undefined) - Number(b.finishedAt !== undefined) || b.updatedAt - a.updatedAt) };
  }
}

export function operationFailure(error: unknown): 'failed' | 'timed-out' | 'cancelled' {
  if (error instanceof Error && (error.name === 'TimeoutError' || /(?:\btimed? out\b|超时)/iu.test(error.message))) return 'timed-out';
  if (isAbortError(error)) return 'cancelled';
  return 'failed';
}
