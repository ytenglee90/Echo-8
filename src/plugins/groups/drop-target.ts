import type { ContentSummary } from '../../protocols/content.ts';
import type {
  GroupDropTarget,
  GroupDropTargetRequest,
  GroupRecord,
} from '../../protocols/groups.ts';
import { computeGroupBounds } from './layout.ts';

export function resolveGroupDropTarget(
  groups: readonly GroupRecord[],
  nodes: readonly ContentSummary[],
  request: GroupDropTargetRequest,
): GroupDropTarget | undefined {
  if (!isDropTargetRequest(request) || !nodes.some((node) => node.id === request.nodeId)) {
    return undefined;
  }
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const currentGroup = groups.find((group) => group.memberIds.includes(request.nodeId));

  // Ctrl explicitly means "remove" for an existing member. Pointer location no
  // longer latches or vetoes the operation; releasing Ctrl cancels the preview.
  if (currentGroup) return { action: 'remove', groupId: currentGroup.id };

  const candidates = groups.flatMap((group) => {
    const members = group.memberIds.map((id) => nodeMap.get(id)).filter(Boolean) as ContentSummary[];
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
