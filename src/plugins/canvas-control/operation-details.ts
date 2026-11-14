import type { CanvasControlAction } from '../../protocols/canvas-control.ts';
import type { OperationDetail, OperationReason } from '../../protocols/operation-log.ts';
import type { NaturalCanvasOperation } from '../../services/ai-task-route.ts';

export function actionCounts(actions: readonly CanvasControlAction[]): OperationDetail['actions'] {
  const counts = new Map<CanvasControlAction['type'], number>();
  for (const action of actions) counts.set(action.type, (counts.get(action.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ type, count }));
}

export function localOperationDetail(operation: NaturalCanvasOperation): OperationDetail {
  const intent = operation.kind;
  const known = ['create', 'content', 'connect', 'arrange', 'move', 'color', 'presentation', 'group', 'find'];
  return {
    route: intent === 'content' ? 'model' : 'local',
    intent: known.includes(intent) ? intent as OperationDetail['intent'] : 'other',
    scope: operation.names.some(name => /所有|全部|全画布/u.test(name)) ? 'canvas' :
      operation.names.some(name => /选中|选区/u.test(name)) ? 'selection' : 'named',
  };
}

export function controlFailureReason(error: unknown): OperationReason {
  const message = error instanceof Error ? error.message : '';
  if (/超过\s*80|超出.*范围/u.test(message)) return 'scope-limit';
  if (/已经变化|过期|失效/u.test(message)) return 'stale-target';
  if (/启用|Capability unavailable|No provider/u.test(message)) return 'plugin-unavailable';
  if (/计划|字段|范围外|JSON/u.test(message)) return 'invalid-plan';
  return 'commit-failed';
}
