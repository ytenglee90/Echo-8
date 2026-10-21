'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { useCommandTooltip } from '../../ui/runtime-hooks.ts';

export function GroupActions({ client }: { client: ViewClient }) {
  const workspaceVersion = useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [selection, setSelection] = useState<SelectionSnapshot>({ ids: [], items: [] });
  const [groupsVersion, setGroupsVersion] = useState(0);

  useEffect(
    () => client.subscribeSignal('groups.invalidated', () => setGroupsVersion((version) => version + 1)),
    [client],
  );

  useEffect(() => {
    let current = true;
    void Promise.all([
      client.request<GroupRecord[]>('groups.list@1'),
      client.request<SelectionSnapshot>('selection.read@1'),
    ]).then(([nextGroups, nextSelection]) => {
      if (!current) return;
      setGroups(nextGroups);
      setSelection(nextSelection);
    });
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, groupsVersion, workspaceVersion]);

  const exactGroup = useMemo(
    () => groups.find((group) => selection.ids.includes(group.id)),
    [groups, selection.ids],
  );
  const occupied = useMemo(
    () => new Set(groups.flatMap((group) => group.memberIds)),
    [groups],
  );

  const selectedNodeIds = selection.items
    .filter((item) => item.kind === 'text-node' || item.kind === 'unknown')
    .map((item) => item.id);
  const hasOccupiedNode = selectedNodeIds.some((id) => occupied.has(id));
  const canCreate = !exactGroup && selectedNodeIds.length >= 2 && !hasOccupiedNode;
  const canManageMembership = groups.length > 0 && selection.ids.length > 0;
  const toggleLabel = useCommandTooltip(
    client,
    'group.toggleSelection',
    exactGroup ? '取消群组' : hasOccupiedNode ? '选中节点已属于群组' : '创建群组',
  );
  const membershipLabel = useCommandTooltip(client, 'group.membership.open', '加入或踢出已有群组');
  return (
    <div className="group-context-actions" aria-label="群组操作">
      <IconButton
        icon={exactGroup ? 'ungroup' : 'group'}
        label={toggleLabel}
        disabled={!exactGroup && !canCreate}
        onClick={() => void client.dispatch('group.toggleSelection')}
      />
      <IconButton
        icon="group-membership"
        label={membershipLabel}
        disabled={!canManageMembership}
        onClick={() => void client.dispatch('group.membership.open')}
      />
    </div>
  );
}
