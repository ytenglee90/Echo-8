import type { PluginContext } from '../../core/contracts.ts';
import type { CanvasControlReview, CanvasControlTaskState } from '../../protocols/canvas-control.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import { readControlOwners, type ControlSnapshot } from './context.ts';

export interface StoredControlReview {
  review: CanvasControlReview;
  snapshot: ControlSnapshot;
  replacement?: import('../../protocols/search.ts').ContentReplaceRequest;
  createdIds?: string[];
  created?: Record<string, string>;
  before?: Record<string, string>;
  after?: Record<string, string>;
}
function nodeMarker(node: ContentSummary): string {
  return JSON.stringify([node.revision, node.nodeRevision, node.title, node.x, node.y, node.width, node.height, node.titleColor, node.presentation, node.length]);
}
export async function readTaskMarkers(context: PluginContext, ids: string[], signal?: AbortSignal) {
  const [nodes, owners] = await Promise.all([
    context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: ids }, signal),
    readControlOwners(context, signal),
  ]);
  const markers: Record<string, string> = Object.fromEntries(ids.map(id => [id, 'absent']));
  for (const node of nodes) markers[node.id] = nodeMarker(node);
  for (const group of owners.groups ?? []) if (ids.includes(group.id)) markers[group.id] = JSON.stringify(group);
  for (const edge of owners.graph?.connections ?? []) if (ids.includes(edge.id)) markers[edge.id] = JSON.stringify(edge);
  return { markers, nodes };
}
export async function controlTaskState(context: PluginContext, drafts: StoredControlReview[], input: { sessionId: string; targetIds?: string[] }, signal?: AbortSignal): Promise<CanvasControlTaskState> {
  const draftIds = (draft: StoredControlReview) => [...new Set([...draft.snapshot.writable, ...Object.keys(draft.before ?? {}), ...(draft.createdIds ?? [])])];
  const relevant = drafts.filter(draft => draft.review.sessionId === input.sessionId && (!input.targetIds?.length ||
    draftIds(draft).some(id => input.targetIds!.includes(id)))).slice(-2);
  const plans: CanvasControlTaskState['plans'] = [];
  for (const draft of relevant) {
    const ids = draftIds(draft);
    const current = await readTaskMarkers(context, ids, signal);
    let status: CanvasControlTaskState['plans'][number]['status'] = draft.review.status;
    const matches = (expected: Record<string, string>) => ids.every(id => current.markers[id] === (expected[id] ?? 'absent'));
    if (status === 'applied' && draft.after && !matches(draft.after)) status = draft.before && matches(draft.before) ? 'undone' : 'changed';
    if (status === 'pending' && draft.review.error) status = 'failed';
    else if (status === 'pending' && draft.snapshot.expiresAt < Date.now()) status = 'expired';
    plans.push({ id: draft.review.id, goal: draft.snapshot.prompt.slice(0, 1_000), status,
      ...(draft.review.verification ? { verification: draft.review.verification } : {}),
      actions: draft.review.actions.slice(0, 12).map(action => ({ ...action, ...('text' in action && action.text ? { text: action.text.slice(0, 120), textLength: action.text.length } : {}),
        ...('append' in action && action.append ? { append: action.append.slice(0, 120), appendLength: action.append.length } : {}),
        ...('edit' in action && action.edit ? { edit: { ...action.edit, insert: action.edit.insert.slice(0, 120), insertLength: action.edit.insert.length } } : {}) })),
      actionCount: draft.review.actions.length, omittedActions: Math.max(0, draft.review.actions.length - 12),
      targets: current.nodes.map(node => ({ id: node.id, title: node.title.slice(0, 80), revision: node.revision })),
      ...(draft.review.error ? { error: draft.review.error } : {}),
    });
  }
  return { version: 1, plans };
}
