import type { ConnectionNodeGeometry } from '../../protocols/connections.ts';
import type {
  GroupDropTarget,
  GroupDropTargetRequest,
  GroupRecord,
} from '../../protocols/groups.ts';
import { computeGroupBounds } from './layout.ts';

export function resolveGroupDropTarget(
  groups: readonly GroupRecord[],
  nodes: readonly ConnectionNodeGeometry[],
  request: GroupDropTargetRequest,
): GroupDropTarget | undefined {
  if (!isDropTargetRequest(request)) {
    return undefined;
  }
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const requested = new Set(request.nodeIds ?? [request.nodeId]);
  if ([...requested].some(id => !nodeMap.has(id))) return undefined;
  const currentGroup = groups.find(group => group.memberIds.includes(request.nodeId)) ??
    groups.find(group => group.memberIds.some(id => requested.has(id)));

  // Ctrl explicitly means "remove" for an existing member. Pointer location no
  // longer latches or vetoes the operation; releasing Ctrl cancels the preview.
  if (currentGroup) return { action: 'remove', groupId: currentGroup.id };

  const candidates = groups.flatMap((group) => {
    const members = group.memberIds.map((id) => nodeMap.get(id)).filter(Boolean) as ConnectionNodeGeometry[];
    if (members.length < 2) return [];
    const bounds = computeGroupBounds(members);
    return pointInside(request.pointer, bounds) ? [{ group, area: bounds.width * bounds.height }] : [];
  });
  candidates.sort((left, right) => left.area - right.area ||
    right.group.updatedAt - left.group.updatedAt || left.group.id.localeCompare(right.group.id));
  return candidates[0] ? { action: 'add', groupId: candidates[0].group.id } : undefined;
}

function isDropTargetRequest(value: GroupDropTargetRequest): boolean {
  return typeof value?.nodeId === 'string' &&
    (value.nodeIds === undefined || (Array.isArray(value.nodeIds) && value.nodeIds.length > 0 && value.nodeIds.length <= 10_000 &&
      value.nodeIds.every(id => typeof id === 'string') && new Set(value.nodeIds).size === value.nodeIds.length && value.nodeIds.includes(value.nodeId))) &&
    Number.isFinite(value.pointer?.x) &&
    Number.isFinite(value.pointer?.y);
}

function pointInside(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}
