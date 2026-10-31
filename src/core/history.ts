import type { PatchOperation } from './contracts.ts';
import { assertNotAborted, yieldToMainThread } from '../services/async-control.ts';
import { canMergePatchEntries, composePatchPairs } from './patch-composition.ts';

export interface HistoryEntry {
  id: string;
  label: string;
  timestamp: number;
  forward: PatchOperation[];
  inverse: PatchOperation[];
  mergeKey?: string;
  mergeWindowMs?: number;
}

export interface HistorySnapshot {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

export interface HistoryExportOptions {
  /** Preserve immutable patch values that persistence immediately externalizes. */
  preserveImmutableNamespaces?: ReadonlySet<string>;
}

export class HistoryService {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly limit: number;

  constructor(limit = 2000) {
    this.limit = Math.max(1000, limit);
  }

  record(entry: HistoryEntry): void {
    const previous = this.undoStack.at(-1);
    const canMerge = previous && canMergePatchEntries(previous, entry);

    if (canMerge && previous) {
      const compacted = composePatchPairs(
        previous.forward,
        previous.inverse,
        entry.forward,
        entry.inverse,
      );
      previous.forward = compacted.forward;
      previous.inverse = compacted.inverse;
      previous.timestamp = entry.timestamp;
      previous.label = entry.label;
    } else {
      this.undoStack.push(structuredClone(entry));
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  peekUndo(): HistoryEntry | undefined {
    return this.undoStack.at(-1);
  }

  peekRedo(): HistoryEntry | undefined {
    return this.redoStack.at(-1);
  }

  markUndone(): void {
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
  }

  markRedone(): void {
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
  }

  getState(): { undoCount: number; redoCount: number; nextUndo?: string; nextRedo?: string } {
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      nextUndo: this.undoStack.at(-1)?.label,
      nextRedo: this.redoStack.at(-1)?.label,
    };
  }

  export(): HistorySnapshot {
    return structuredClone({ undo: this.undoStack, redo: this.redoStack });
  }

  async exportAsync(signal?: AbortSignal, options: HistoryExportOptions = {}): Promise<HistorySnapshot> {
    const undo = captureEntries(this.undoStack);
    const redo = captureEntries(this.redoStack);
    const [clonedUndo, clonedRedo] = await Promise.all([
      cloneCapturedEntries(undo, signal, options),
      cloneCapturedEntries(redo, signal, options),
    ]);
    return { undo: clonedUndo, redo: clonedRedo };
  }

  import(snapshot?: HistorySnapshot): void {
    validateHistorySnapshot(snapshot);
    this.undoStack = structuredClone(snapshot?.undo ?? []).slice(-this.limit);
    this.redoStack = structuredClone(snapshot?.redo ?? []).slice(-this.limit);
  }
}

interface CapturedHistoryEntry extends Omit<HistoryEntry, 'forward' | 'inverse'> {
  forward: PatchOperation[];
  inverse: PatchOperation[];
}

function captureEntries(entries: HistoryEntry[]): CapturedHistoryEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    timestamp: entry.timestamp,
    forward: [...entry.forward],
    inverse: [...entry.inverse],
    mergeKey: entry.mergeKey,
    mergeWindowMs: entry.mergeWindowMs,
  }));
}

async function cloneCapturedEntries(
  entries: CapturedHistoryEntry[],
  signal?: AbortSignal,
  options: HistoryExportOptions = {},
): Promise<HistoryEntry[]> {
  const result: HistoryEntry[] = [];
  let sliceStarted = now();
  let patchesInSlice = 0;
  for (const entry of entries) {
    const cloned: HistoryEntry = {
      id: entry.id,
      label: entry.label,
      timestamp: entry.timestamp,
      forward: [],
      inverse: [],
      mergeKey: entry.mergeKey,
      mergeWindowMs: entry.mergeWindowMs,
    };
    for (const source of [entry.forward, entry.inverse]) {
      const destination = source === entry.forward ? cloned.forward : cloned.inverse;
      for (const patch of source) {
        assertNotAborted(signal);
        destination.push(
          patch.op === 'set' && options.preserveImmutableNamespaces?.has(patch.namespace)
            ? { ...patch }
            : structuredClone(patch),
        );
        patchesInSlice += 1;
        if (patchesInSlice >= 128 || now() - sliceStarted >= 8) {
          await yieldToMainThread();
          sliceStarted = now();
          patchesInSlice = 0;
        }
      }
    }
    result.push(cloned);
  }
  return result;
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function validateHistorySnapshot(snapshot?: HistorySnapshot): void {
  if (snapshot === undefined) return;
  if (!snapshot || !Array.isArray(snapshot.undo) || !Array.isArray(snapshot.redo)) {
    throw new Error('Invalid history snapshot');
  }
  for (const entry of [...snapshot.undo, ...snapshot.redo]) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.label !== 'string' ||
      !Number.isFinite(entry.timestamp) || !Array.isArray(entry.forward) || !Array.isArray(entry.inverse)) {
      throw new Error('Invalid history entry');
    }
  }
}
