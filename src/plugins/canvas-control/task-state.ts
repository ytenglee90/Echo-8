import type { PluginContext } from '../../core/contracts.ts';
import type { CanvasControlReview, CanvasControlTaskState } from '../../protocols/canvas-control.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import { readControlOwners, type ControlSnapshot } from './context.ts';
import type { NativeCanvasAction } from './native-actions.ts';
import type { AnnotationRecord } from '../../protocols/annotations.ts';
import type { ControlArrangement } from './natural-operations.ts';
import type { ControlRelativePlacement } from './relative-placement.ts';

export interface StoredControlReview {
  review: CanvasControlReview;
  snapshot: ControlSnapshot;
  native?: NativeCanvasAction;
  arrangement?: ControlArrangement;
  replacement?: import('../../protocols/search.ts').ContentReplaceRequest;
  createdIds?: string[];
  created?: Record<string, string>;
  before?: Record<string, string>;
  after?: Record<string, string>;
  placement?: ControlRelativePlacement;
}
type MarkerScope = 'document' | 'membership';
function nodeMarker(node: ContentSummary, scope: MarkerScope): string {
  return JSON.stringify([scope === 'membership' ? null : node.revision, scope === 'membership' ? null : node.nodeRevision, node.title, node.x, node.y, node.width, node.height, node.titleColor, node.presentation, scope === 'membership' ? null : node.length]);
}
export async function readTaskMarkers(context: PluginContext, ids: string[], signal?: AbortSignal, scope: MarkerScope = 'document') {
  const [nodes, owners, annotations] = await Promise.all([
    context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: ids }, signal),
    readControlOwners(context, signal),
    ids.some(id => id.startsWith('annotation:')) ? context.capabilities.request<AnnotationRecord[]>('annotations.list@1', undefined, signal).catch(() => []) : [],
  ]);
  const markers: Record<string, string> = Object.fromEntries(ids.map(id => [id, 'absent']));
  const labels: Record<string, string> = {};
  for (const node of nodes) { markers[node.id] = nodeMarker(node, scope); labels[node.id] = `节点「${node.title.slice(0, 100)}」`; }
  for (const group of owners.groups ?? []) if (ids.includes(group.id)) { markers[group.id] = JSON.stringify(group); labels[group.id] = `群组「${group.title.slice(0, 100)}」`; }
  for (const edge of owners.graph?.connections ?? []) if (ids.includes(edge.id)) { markers[edge.id] = JSON.stringify(edge); labels[edge.id] = '连线'; }
  for (const annotation of annotations) if (ids.includes(annotation.id)) markers[annotation.id] = String(annotation.revision);
  return { markers, nodes, labels };
}

/** Describe changed metadata only; never include text bodies or marker payloads. */
export function taskMarkerChanges(before: string, after: string): string {
  if (after === 'absent') return '对象已不存在';
  if (before === 'absent') return '对象记录已重新出现';
  const previous: unknown = JSON.parse(before);
  const current: unknown = JSON.parse(after);
  if (Array.isArray(previous) && Array.isArray(current)) {
    const fields = ['正文修订', '对象属性修订', '标题', '横坐标', '纵坐标', '宽度', '高度', '颜色', '显示形式', '正文长度'];
    return fields.filter((_, index) => previous[index] !== current[index]).join('、') || '对象记录';
  }
  if (previous && current && typeof previous === 'object' && typeof current === 'object') {
    const labels: Record<string, string> = { title: '名称', memberIds: '成员列表', color: '颜色', titleStyle: '标题样式', titleMarks: '标题格式', from: '起点', to: '终点', revision: '记录修订', updatedAt: '更新时间' };
    const fields = [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter(key =>
      JSON.stringify(Reflect.get(previous, key)) !== JSON.stringify(Reflect.get(current, key)));
    const meaningful = fields.filter(key => !['revision', 'updatedAt'].includes(key));
    return (meaningful.length ? meaningful : fields).map(key => labels[key] ?? '对象属性').join('、') || '对象记录';
  }
  return '记录修订';
}
const draftIds = (draft: StoredControlReview) => [...new Set([...draft.snapshot.writable, ...Object.keys(draft.before ?? {}), ...(draft.createdIds ?? [])])];

function reviewStatus(draft: StoredControlReview, ids: string[], markers?: Record<string, string>): CanvasControlTaskState['plans'][number]['status'] {
  const status = draft.review.status;
  const matches = (expected: Record<string, string>) => ids.every(id => markers?.[id] === (expected[id] ?? 'absent'));
  if (status === 'applied' && draft.after && markers && !matches(draft.after)) return draft.before && matches(draft.before) ? 'undone' : 'changed';
  if (status === 'pending' && draft.review.error) return 'failed';
  if (status === 'pending' && draft.snapshot.expiresAt < Date.now()) return 'expired';
  return status;
}

export async function readControlReviewStatus(context: PluginContext, draft: StoredControlReview, signal?: AbortSignal) {
  if (draft.review.status !== 'applied' || !draft.after) return reviewStatus(draft, []);
  const ids = draftIds(draft);
  const current = await readTaskMarkers(context, ids, signal);
  return reviewStatus(draft, ids, current.markers);
}

export async function controlTaskState(context: PluginContext, drafts: StoredControlReview[], input: { sessionId: string; targetIds?: string[] }, signal?: AbortSignal): Promise<CanvasControlTaskState> {
  const relevant = drafts.filter(draft => draft.review.sessionId === input.sessionId && (!input.targetIds?.length ||
    draftIds(draft).some(id => input.targetIds!.includes(id)))).slice(-2);
  const plans: CanvasControlTaskState['plans'] = [];
  for (const draft of relevant) {
    const ids = draftIds(draft);
    const current = await readTaskMarkers(context, ids, signal);
    const status = reviewStatus(draft, ids, current.markers);
    plans.push({ id: draft.review.id, goal: draft.snapshot.prompt.slice(0, 1_000), status,
      ...(draft.review.verification ? { verification: draft.review.verification } : {}),
      actions: draft.review.actions.slice(0, 12).map(action => ({ ...action, ...('text' in action && action.text ? { text: action.text.slice(0, 120), textLength: action.text.length } : {}),
        ...('append' in action && action.append ? { append: action.append.slice(0, 120), appendLength: action.append.length } : {}),
        ...('edit' in action && action.edit ? { edit: { ...action.edit, insert: action.edit.insert.slice(0, 120), insertLength: action.edit.insert.length } } : {}) })),
      actionCount: draft.review.workspaceSteps?.length ?? (draft.native ? 1 : draft.review.actions.length), omittedActions: Math.max(0, draft.review.actions.length - 12),
      targets: current.nodes.map(node => ({ id: node.id, title: node.title.slice(0, 80), revision: node.revision })),
      ...(draft.review.error ? { error: draft.review.error } : {}),
    });
  }
  return { version: 1, plans };
}
