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
function nodeMarker(node: ContentSummary): string {
  return JSON.stringify([node.revision, node.nodeRevision, node.title, node.x, node.y, node.width, node.height, node.titleColor, node.presentation, node.length]);
}
export async function readTaskMarkers(context: PluginContext, ids: string[], signal?: AbortSignal) {
  const [nodes, owners, annotations] = await Promise.all([
    context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: ids }, signal),
    readControlOwners(context, signal),
    ids.some(id => id.startsWith('annotation:')) ? context.capabilities.request<AnnotationRecord[]>('annotations.list@1', undefined, signal).catch(() => []) : [],
  ]);
  const markers: Record<string, string> = Object.fromEntries(ids.map(id => [id, 'absent']));
  for (const node of nodes) markers[node.id] = nodeMarker(node);
  for (const group of owners.groups ?? []) if (ids.includes(group.id)) markers[group.id] = JSON.stringify(group);
  for (const edge of owners.graph?.connections ?? []) if (ids.includes(edge.id)) markers[edge.id] = JSON.stringify(edge);
  for (const annotation of annotations) if (ids.includes(annotation.id)) markers[annotation.id] = String(annotation.revision);
  return { markers, nodes };
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
      actionCount: draft.native ? 1 : draft.review.actions.length, omittedActions: Math.max(0, draft.review.actions.length - 12),
      targets: current.nodes.map(node => ({ id: node.id, title: node.title.slice(0, 80), revision: node.revision })),
      ...(draft.review.error ? { error: draft.review.error } : {}),
    });
  }
  return { version: 1, plans };
}
