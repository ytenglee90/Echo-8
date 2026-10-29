import type { PluginStatus } from './contracts.ts';
import type { DiagnosticRecord } from '../protocols/diagnostics.ts';
export type { DiagnosticRecord } from '../protocols/diagnostics.ts';

export class DiagnosticsService {
  private sequence = 0;
  private version = 0;
  private readonly records: DiagnosticRecord[] = [];
  private readonly pluginStates = new Map<string, { status: PluginStatus; error?: string }>();
  private readonly counters = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion = (): number => this.version;

  record(
    level: DiagnosticRecord['level'],
    source: string,
    message: string,
    detail?: unknown,
  ): void {
    this.records.push({ id: ++this.sequence, timestamp: Date.now(), level, source, message, detail });
    if (this.records.length > 400) this.records.shift();
    this.bump();
  }

  setPluginStatus(pluginId: string, status: PluginStatus, error?: string): void {
    this.pluginStates.set(pluginId, { status, error });
    this.bump();
  }

  increment(counter: string): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + 1);
    this.bump(false);
  }

  snapshot() {
    return {
      records: this.records.slice(-40).map((record) => ({
        ...record,
        detail: sanitizeDetail(record.detail),
      })),
      plugins: Object.fromEntries(
        [...this.pluginStates].map(([pluginId, state]) => [
          pluginId,
          { status: state.status, error: state.error ? '已记录插件错误' : undefined },
        ]),
      ),
      counters: Object.fromEntries(this.counters),
    };
  }

  private bump(notify = true): void {
    this.version += 1;
    if (notify) for (const listener of this.listeners) listener();
  }
}

function sanitizeDetail(detail: unknown): unknown {
  if (detail === undefined || detail === null) return detail;
  if (detail instanceof Error) return { name: detail.name, message: '原始错误详情已省略' };
  if (typeof detail === 'string') return truncate(detail);
  if (typeof detail === 'number' || typeof detail === 'boolean') return detail;
  if (Array.isArray(detail)) return { kind: 'array', length: detail.length };
  if (typeof detail === 'object') {
    return { kind: 'object', keys: Object.keys(detail as Record<string, unknown>).slice(0, 20) };
  }
  return String(detail);
}

function truncate(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}…` : value;
}
