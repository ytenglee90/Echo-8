'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { groupMembershipSelection } from './membership-selection.ts';

export function GroupActions({ client }: { client: ViewClient }) {
  const workspaceVersion = useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  const capabilityVersion = useSyncExternalStore(client.subscribeCapabilities, client.getCapabilityVersion, () => 0);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [selection, setSelection] = useState<SelectionSnapshot>({ ids: [], items: [] });
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribeSignal('groups.invalidated', () => setVersion(value => value + 1)), [client]);
  useEffect(() => {
    let current = true;
    void Promise.all([client.request<GroupRecord[]>('groups.list@1'), client.request<SelectionSnapshot>('selection.read@1')]).then(([nextGroups, nextSelection]) => {
      if (current) { setGroups(nextGroups); setSelection(nextSelection); }
    }).catch(() => undefined);
    return () => { current = false; };
  }, [capabilityVersion, client, version, workspaceVersion]);
  const nodes = selection.items.filter(item => item.kind === 'text-node' || item.kind === 'unknown').map(item => item.id);
  const intent = groupMembershipSelection(groups, selection, nodes);
  const targetWithNodes = intent.selectedGroups.length > 0 && intent.selectedNodes.length > 0;
  const mode = targetWithNodes ? 'add' : intent.canRemove ? 'remove' : intent.selectedGroups.length === 1 ? 'ungroup' : 'create';
  const ready = mode === 'add' ? intent.canAdd : mode === 'remove' ? intent.canRemove : mode === 'ungroup' || intent.canCreate;
  const icon = mode === 'add' ? 'group-add' : mode === 'remove' ? 'group-remove' : mode === 'ungroup' ? 'ungroup' : 'group';
  const label = mode === 'add' ? '加入群组' : mode === 'remove' ? '踢出群组' : mode === 'ungroup' ? '取消群组' : '创建群组';
  const apply = (action: 'add' | 'remove') => void client.dispatch('group.membership.applySelected@1', { action });
  return <IconButton icon={icon} label={label} disabled={!ready} onClick={() => mode === 'add' || mode === 'remove' ? apply(mode) : void client.dispatch('group.toggleSelection')} />;
}
