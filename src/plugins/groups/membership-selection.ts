import type { GroupRecord } from '../../protocols/groups.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';

export function groupMembershipSelection(groups: readonly GroupRecord[], selection: SelectionSnapshot, nodeIds: readonly string[]) {
  const ids = new Set(selection.ids);
  const selectedGroups = groups.filter(group => ids.has(group.id));
  const known = new Set(nodeIds);
  const selectedNodes = selection.ids.filter(id => known.has(id));
  const owner = new Map(groups.flatMap(group => group.memberIds.map(id => [id, group.id] as const)));
  const target = selectedGroups.length === 1 ? selectedGroups[0] : undefined;
  const orderedTarget = target && selection.ids.at(-1) === target.id;
  const addIds = selectedNodes.filter(id => !owner.has(id));
  const conflicting = selectedNodes.some(id => owner.has(id) && owner.get(id) !== target?.id);
  const removeIds = selectedNodes.filter(id => owner.has(id));
  return {
    selectedNodes, selectedGroups, target,
    canAdd: Boolean(orderedTarget && addIds.length && !conflicting), addIds,
    canRemove: selectedGroups.length === 0 && removeIds.length > 0, removeIds,
    canCreate: selectedGroups.length === 0 && selectedNodes.length >= 2 && removeIds.length === 0,
  };
}
