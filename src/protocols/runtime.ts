import type { PluginSnapshot, RegisteredAction, RegisteredShortcut, StoreDomain } from '../core/contracts.ts';
import type { DiagnosticRecord } from '../core/diagnostics.ts';
import type { PersistenceSnapshot } from './files.ts';

export interface RuntimeStoreSummary {
  domain: StoreDomain;
  revision: number;
  namespaceCount: number;
  recordCount: number;
  namespaces: Array<{ id: string; records: number }>;
}

export interface RuntimeSnapshot {
  generatedAt: number;
  plugins: PluginSnapshot[];
  store: RuntimeStoreSummary[];
  history: { undoCount: number; redoCount: number; nextUndo?: string; nextRedo?: string };
  persistence: PersistenceSnapshot;
  tasks: {
    active: number;
    activeCost: number;
    costBudget: number;
    queued: number;
    paused: number;
    tasks: Array<{
      id: string;
      owner: string;
      category: string;
      label: string;
      priority: number;
      state: 'queued' | 'running' | 'paused' | 'retrying';
      progress: number;
      attempts: number;
      estimatedCost?: number;
      timeoutMs?: number;
      aborted: boolean;
      noticeVisible: boolean;
    }>;
  };
  resources: Array<{ owner: string; total: number; kinds: Record<string, number> }>;
  interaction: string;
  capabilities: Array<{ key: string; providers: string[] }>;
  actions: RegisteredAction[];
  shortcuts: RegisteredShortcut[];
  surfaces: Array<{ slot: string; active?: string; stack: string[] }>;
  diagnostics: {
    records: DiagnosticRecord[];
    plugins: Record<string, { status: string; error?: string }>;
    counters: Record<string, number>;
  };
  memory?: { used: number; total: number; limit: number };
}
