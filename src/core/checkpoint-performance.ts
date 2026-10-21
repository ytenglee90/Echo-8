import type { CheckpointPerformanceSnapshot } from '../protocols/files.ts';

interface ObservedEntry {
  duration: number;
}

interface ObserverLike {
  observe(options: { type: string; buffered?: boolean }): void;
  takeRecords(): ObservedEntry[];
  disconnect(): void;
}

export interface CheckpointMonitorOptions {
  now?: () => number;
  createLongTaskObserver?: (listener: (entries: ObservedEntry[]) => void) => ObserverLike | undefined;
}

export class CheckpointPerformanceMonitor {
  private readonly now: () => number;
  private readonly startedAt: number;
  private longestMainThreadBlockMs = 0;
  private observer?: ObserverLike;

  constructor(options: CheckpointMonitorOptions = {}) {
    this.now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
    this.startedAt = this.now();
    const createObserver = options.createLongTaskObserver ?? browserLongTaskObserver;
    this.observer = createObserver((entries) => this.recordEntries(entries));
  }

  recordSynchronousPhase(durationMs: number): void {
    if (Number.isFinite(durationMs)) {
      this.longestMainThreadBlockMs = Math.max(this.longestMainThreadBlockMs, durationMs);
    }
  }

  finish(prepareMs: number, usedWorker: boolean): CheckpointPerformanceSnapshot {
    if (this.observer) {
      this.recordEntries(this.observer.takeRecords());
      this.observer.disconnect();
      this.observer = undefined;
    }
    return {
      measuredAt: Date.now(),
      durationMs: round(this.now() - this.startedAt),
      prepareMs: round(prepareMs),
      longestMainThreadBlockMs: round(this.longestMainThreadBlockMs),
      usedWorker,
    };
  }

  private recordEntries(entries: ObservedEntry[]): void {
    for (const entry of entries) this.recordSynchronousPhase(entry.duration);
  }
}

function browserLongTaskObserver(listener: (entries: ObservedEntry[]) => void): ObserverLike | undefined {
  if (typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return undefined;
  const observer = new PerformanceObserver((list) => listener(
    list.getEntries().map((entry) => ({ duration: entry.duration })),
  ));
  observer.observe({ type: 'longtask', buffered: false });
  return observer;
}

function round(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}
