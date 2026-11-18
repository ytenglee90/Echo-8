import type { PluginContext, TaskHandle } from '../../core/contracts.ts';
import type { WorkspaceQueryTaskReceipt } from '../../protocols/workspace-actions.ts';

interface Entry { key: string; receipt: WorkspaceQueryTaskReceipt; task: TaskHandle<unknown> }
const contexts = new WeakMap<PluginContext, Map<string, Entry>>();

function entries(context: PluginContext): Map<string, Entry> {
  let map = contexts.get(context);
  if (!map) {
    map = new Map(); contexts.set(context, map);
    context.resources.track('other', () => {
      for (const entry of map!.values()) if (entry.receipt.state === 'running') entry.task.cancel();
      map!.clear(); contexts.delete(context);
    });
  }
  return map;
}

export function scheduleWorkspaceQuery(context: PluginContext, key: string, label: string, run: (signal: AbortSignal) => Promise<unknown>) {
  const map = entries(context);
  const cached = [...map.values()].find(entry => entry.key === key && ['running', 'completed'].includes(entry.receipt.state));
  if (cached?.receipt.state === 'completed') return { result: structuredClone(cached.receipt.result) };
  if (cached) return { status: 'waiting' as const, result: { workspaceTaskId: cached.task.id }, message: label };
  const task = context.tasks.schedule({ category: 'workspace-query', label, priority: 40, estimatedCost: 1, timeoutMs: 120_000, run });
  const receipt: WorkspaceQueryTaskReceipt = { id: task.id, state: 'running' };
  map.set(task.id, { key, receipt, task });
  while (map.size > 64) {
    const oldest = map.keys().next().value!;
    map.get(oldest)?.task.cancel(); map.delete(oldest);
  }
  void task.result.then(result => {
    if (receipt.state !== 'running') return;
    receipt.state = 'completed'; receipt.result = result;
  }, error => {
    if (receipt.state !== 'running') return;
    receipt.state = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
    receipt.message = error instanceof Error ? error.message : '本地查询失败';
  });
  return { status: 'waiting' as const, result: { workspaceTaskId: task.id }, message: label };
}

export function readWorkspaceQuery(context: PluginContext, id: string): WorkspaceQueryTaskReceipt | undefined {
  const receipt = contexts.get(context)?.get(id)?.receipt;
  return receipt && structuredClone(receipt);
}

export function cancelWorkspaceQuery(context: PluginContext, id: string): void {
  const entry = contexts.get(context)?.get(id);
  if (!entry || entry.receipt.state !== 'running') return;
  entry.receipt.state = 'cancelled'; entry.receipt.message = '本地查询已取消'; entry.task.cancel();
}

export function clearWorkspaceQueries(context: PluginContext): void {
  const map = contexts.get(context);
  if (!map) return;
  for (const entry of map.values()) if (entry.receipt.state === 'running') cancelWorkspaceQuery(context, entry.task.id);
  map.clear();
}
