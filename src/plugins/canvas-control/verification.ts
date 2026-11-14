import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextReadContribution } from '../../protocols/ai.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { CanvasControlVerification } from '../../protocols/canvas-agent.ts';
import { isTitleConnection } from '../../protocols/connections.ts';
import { readControlOwners } from './context.ts';
import type { StoredControlReview } from './task-state.ts';

export async function verifyControlApplication(context: PluginContext, draft: StoredControlReview): Promise<CanvasControlVerification> {
  const mismatches: CanvasControlVerification['mismatches'] = [];
  let checked = 0;
  const resolve = (id: string) => draft.created?.[id] ?? id;
  try {
    const requestedIds = [...new Set(draft.review.actions.flatMap(action => 'ref' in action ? [resolve(action.ref)] :
      'id' in action ? [action.id] : action.ids))];
    const [nodes, owners] = await Promise.all([
      context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: requestedIds }),
      readControlOwners(context),
    ]);
    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    const groups = new Map((owners.groups ?? []).map(group => [group.id, group]));
    const edges = new Map((owners.graph?.connections ?? []).map(edge => [edge.id, edge]));
    const mismatch = (index: number, field: CanvasControlVerification['mismatches'][number]['field']) => mismatches.push({ index, field });
    const sameTitle = (actual: string, expected: string) => actual === expected ||
      (actual.startsWith(expected + ' ') && /^\d+$/u.test(actual.slice(expected.length + 1)));
    const sameMembers = (actual: string[], expected: string[]) => actual.length === expected.length && expected.every(id => actual.includes(resolve(id)));
    const bodyMatches = async (id: string, start: number, expected: string) => {
      for (let offset = 0; offset < expected.length; offset += 8192) {
        const size = Math.min(8192, expected.length - offset);
        const read = (await context.capabilities.requestAll<AIContextReadContribution>('context.read@1', { sourceId: id, start: start + offset, length: size })).find(part => part.handled);
        if (!read || read.source?.revision !== nodeMap.get(id)?.revision || read.text !== expected.slice(offset, offset + size)) return false;
      }
      return true;
    };
    for (const [index, action] of draft.review.actions.entries()) {
      checked += 1;
      if (action.type === 'delete') {
        if (action.ids.some(id => nodeMap.has(id) || groups.has(id) || edges.has(id))) mismatch(index, 'exists');
        continue;
      }
      const id = 'ref' in action ? resolve(action.ref) : action.id;
      if (action.type === 'create-node' || action.type === 'update-node') {
        const node = nodeMap.get(id);
        if (!node) { mismatch(index, 'exists'); continue; }
        if ((action.title !== undefined && !(action.type === 'create-node' ? sameTitle(node.title, action.title) : node.title === action.title)) ||
          (action.color !== undefined && node.titleColor.toLowerCase() !== action.color.toLowerCase()) ||
          (action.presentation !== undefined && (node.presentation ?? 'card') !== action.presentation) ||
          (['x', 'y', 'width', 'height'] as const).some(field => action[field] !== undefined && Math.abs(node[field] - action[field]!) > 0.01)) mismatch(index, 'metadata');
        const beforeLength = draft.snapshot.nodes.find(item => item.id === id)?.length ?? 0;
        if (action.text !== undefined) {
          if (node.length !== action.text.length || !await bodyMatches(id, 0, action.text)) mismatch(index, 'body');
        } else if (action.append !== undefined) {
          if (node.length !== beforeLength + action.append.length || !await bodyMatches(id, beforeLength, action.append)) mismatch(index, 'body');
        } else if (action.edit) {
          if (node.length !== beforeLength - action.edit.deleteCount + action.edit.insert.length ||
            !await bodyMatches(id, action.edit.start, action.edit.insert)) mismatch(index, 'body');
        }
      } else if (action.type === 'create-group' || action.type === 'update-group') {
        const group = groups.get(id);
        if (!group) { mismatch(index, 'exists'); continue; }
        if (action.members && !sameMembers(group.memberIds, action.members)) mismatch(index, 'members');
        if ((action.title !== undefined && group.title !== action.title) ||
          (action.color !== undefined && group.color?.toLowerCase() !== action.color.toLowerCase())) mismatch(index, 'metadata');
      } else {
        const edge = edges.get(id);
        if (!edge) { mismatch(index, 'exists'); continue; }
        if ((action.from !== undefined && edge.from.nodeId !== resolve(action.from)) ||
          (action.to !== undefined && edge.to.nodeId !== resolve(action.to)) ||
          (action.line !== undefined && isTitleConnection(edge) !== (action.line === 'dashed'))) mismatch(index, 'endpoints');
        if ((action.label !== undefined && edge.label !== action.label) ||
          (action.color !== undefined && edge.lineColor?.toLowerCase() !== action.color.toLowerCase())) mismatch(index, 'metadata');
      }
    }
    return { status: mismatches.length ? 'mismatch' : 'verified', checked, mismatches };
  } catch {
    return { status: 'unavailable', checked, mismatches };
  }
}
