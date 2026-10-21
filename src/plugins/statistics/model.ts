import type { PluginDefinition, TaskHandle } from '../../core/contracts.ts';
import type { ContentMetricsSnapshotV2 } from '../../protocols/content.ts';
import type { SelectionResolution, SelectionSnapshot } from '../../protocols/selection.ts';
import type {
  ContentStatistics,
  SelectedTextStatistics,
  StatisticsContribution,
  StatisticsSnapshot,
} from '../../protocols/statistics.ts';
import { defineManifest } from '../manifest.ts';

const RECOMPUTE_EVENTS = [
  'node.created',
  'content.changed',
  'nodes.deleted',
  'nodes.pasted',
  'connection.created',
  'connections.deleted',
  'group.created',
  'group.ungrouped',
  'history.changed',
  'document.replaced',
] as const;

export function createStatisticsPlugin(statusView?: unknown): PluginDefinition {
  let activeTask: TaskHandle<StatisticsSnapshot> | undefined;
  let cached: StatisticsSnapshot = emptySnapshot();
  return {
    manifest: defineManifest('statistics', '统计', {
      requiresCapabilities: [
        'content.statistics@1',
        'content.metrics@2',
        'selection.read@1',
        'selection.resolve@1',
      ],
      optionalCapabilities: ['statistics.contribute@1'],
      providesCapabilities: ['statistics.current@1', 'statistics.selected@1'],
      events: [...RECOMPUTE_EVENTS, 'selection.changed'],
      signals: ['statistics.updated', 'statistics.selection.invalidated'],
      ui: ['statistics.status'],
      permissions: ['ui.top.contribute', 'tasks.schedule'],
    }),

    start(context) {
      activeTask = undefined;
      cached = emptySnapshot();

      const schedule = (immediate = false) => {
        activeTask?.cancel();
        cached = { ...cached, status: 'running', error: undefined };
        context.signals.emit('statistics.updated', cached);
        context.signals.emit('statistics.selection.invalidated');
        const task = context.tasks.schedule<StatisticsSnapshot>({
          category: 'content-statistics',
          label: '正在统计画布内容',
          priority: 10,
          timeoutMs: 2 * 60_000,
          estimatedCost: 1,
          run: async (signal, report) => {
            if (!immediate) await cancellableDelay(320, signal);
            report(0.05);
            const content = await context.capabilities.request<ContentStatistics>(
              'content.statistics@1',
              undefined,
              signal,
            );
            report(0.85);
            const contributions = await context.capabilities.requestAll<StatisticsContribution>(
              'statistics.contribute@1',
              undefined,
              signal,
            );
            report(1);
            return {
              ...content,
              modules: [
                { kind: 'text-nodes', label: '文本节点', count: content.nodeCount },
                ...contributions,
              ],
              computedAt: Date.now(),
              status: 'ready',
            };
          },
        });
        activeTask = task;
        void task.result.then(
          (result) => {
            if (activeTask?.id !== task.id) return;
            cached = result;
            context.signals.emit('statistics.updated', result);
          },
          (error) => {
            if (activeTask?.id !== task.id || isAbortError(error)) return;
            cached = {
              ...cached,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
              computedAt: Date.now(),
            };
            context.signals.emit('statistics.updated', cached);
          },
        );
      };

      for (const event of RECOMPUTE_EVENTS) context.events.subscribe(event, () => schedule(false));
      context.events.subscribe('selection.changed', () => context.signals.emit('statistics.selection.invalidated'));
      context.capabilities.provide({ key: 'statistics.current@1', invoke: () => cached });
      context.capabilities.provide<undefined, SelectedTextStatistics>({
        key: 'statistics.selected@1',
        invoke: async (_input, signal) => {
          const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
          const resolution = await context.capabilities.request<SelectionResolution>('selection.resolve@1', {
            items: selection.items,
            mode: 'replace',
          }, signal);
          const metrics = await context.capabilities.request<ContentMetricsSnapshotV2>('content.metrics@2', {
            nodeIds: resolution.expandedIds,
          }, signal);
          return {
            nodeCount: metrics.nodeCount,
            utf16Units: metrics.utf16Units,
            graphemes: metrics.graphemes,
            nonWhitespaceGraphemes: metrics.nonWhitespaceGraphemes,
          };
        },
      });
      context.ui.contribute({
        id: 'statistics.status',
        slot: 'top.primary',
        kind: 'view',
        label: '画布统计',
        group: 'metrics',
        component: statusView,
        priority: 20,
      });
      schedule(true);
    },

    stop() {
      activeTask?.cancel();
      activeTask = undefined;
    },
  };
}

function emptySnapshot(): StatisticsSnapshot {
  return {
    nodeCount: 0,
    utf16Units: 0,
    graphemes: 0,
    nonWhitespaceGraphemes: 0,
    words: 0,
    lines: 0,
    revisions: {},
    modules: [],
    computedAt: 0,
    status: 'idle',
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function cancellableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Task aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Task aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
