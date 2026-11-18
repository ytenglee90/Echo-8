'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { IconButton } from '../../ui/Icon.tsx';

interface MembershipState {
  open: boolean;
}

export function GroupMembershipPanel({ client }: { client: ViewClient }) {
  const workspaceVersion = useSyncExternalStore(
    client.subscribeState,
    client.getWorkspaceVersion,
    () => 0,
  );
  const uiVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion('groupMembershipUI'),
    () => 0,
  );
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [nodes, setNodes] = useState<ContentSummary[]>([]);
  const [selection, setSelection] = useState<SelectionSnapshot>({ ids: [], items: [] });
  const [error, setError] = useState<string>();
  const [groupsVersion, setGroupsVersion] = useState(0);
  const [contentVersion, setContentVersion] = useState(0);
  const [newTitle, setNewTitle] = useState('');
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});

  useEffect(
    () => client.subscribeSignal('groups.invalidated', () => setGroupsVersion((version) => version + 1)),
    [client],
  );
  useEffect(
    () => client.subscribeSignal('content.catalog.invalidated', () =>
      setContentVersion((version) => version + 1)),
    [client],
  );

  useEffect(() => {
    let current = true;
    void client.request<MembershipState>('group.membership.state@1').then((state) => {
      if (current) setOpen(state.open);
    }).catch(() => current && setOpen(false));
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, uiVersion]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void (async () => {
      try {
        const [nextGroups, nextSelection] = await Promise.all([
          client.request<GroupRecord[]>('groups.list@1'),
          client.request<SelectionSnapshot>('selection.read@1'),
        ]);
        const nodeIds = [...new Set([
          ...nextSelection.ids,
          ...nextGroups.flatMap((group) => group.memberIds),
        ])];
        const nextNodes = await client.request<ContentSummary[]>('content.summariesById@1', { nodeIds });
        if (!current) return;
        setGroups(nextGroups);
        setNodes(nextNodes);
        setSelection(nextSelection);
        setError(undefined);
      } catch (reason) {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      current = false;
    };
  }, [client, contentVersion, groupsVersion, open, workspaceVersion]);

  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const groupMap = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const groupNumber = useMemo(
    () => new Map(groups.map((group, index) => [group.id, index + 1])),
    [groups],
  );
  const ownerByNode = useMemo(() => new Map(
    groups.flatMap((group) => group.memberIds.map((nodeId) => [nodeId, group.id] as const)),
  ), [groups]);
  const selectedNodeIds = selection.ids.filter((id) => nodeMap.has(id));
  const ungroupedNodeIds = selectedNodeIds.filter((id) => !ownerByNode.has(id));
  const groupedSelections = [...new Set(
    selectedNodeIds.map((id) => ownerByNode.get(id)).filter(Boolean) as string[],
  )];
  const selectedGroups = selection.ids.map((id) => groupMap.get(id)).filter(Boolean) as GroupRecord[];

  if (!open) return null;

  const close = () => void client.dispatch('group.membership.close');
  const add = (groupId: string) => {
    void (async () => {
      try {
        setError(undefined);
        await client.dispatch('group.membership.add', { groupId, nodeIds: ungroupedNodeIds });
        await client.dispatch('selection.set', { ids: [groupId], mode: 'replace' });
        await client.dispatch('group.membership.close');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
  };
  const remove = (groupId: string, nodeIds: string[]) => {
    void (async () => {
      try {
        setError(undefined);
        await client.dispatch('group.membership.remove', { groupId, nodeIds });
        await client.dispatch('selection.set', { ids: nodeIds, mode: 'replace' });
        await client.dispatch('group.membership.close');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
  };

  const selectedGroup = selectedGroups.length === 1 ? selectedGroups[0] : undefined;
  const hasOperation = ungroupedNodeIds.length > 0 || groupedSelections.length > 0 || Boolean(selectedGroup);

  return (
    <div
      className="group-membership-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section className="group-membership-dialog" role="dialog" aria-modal="true" aria-label="加入或移出已有群组">
        <header>
          <div>
            <span className="eyebrow">群组成员</span>
            <h2>群组管理</h2>
          </div>
          <IconButton icon="close" label="关闭群组成员管理" onClick={close} />
        </header>

        <div className="group-membership-content">
          {ungroupedNodeIds.length >= 2 && <form className="group-management-create" onSubmit={event => {
            event.preventDefault(); setError(undefined);
            void client.dispatch('group.create', { title: newTitle.trim() || '新群组' }).then(() => setNewTitle(''))
              .catch(reason => setError(String(reason)));
          }}><label>新群组名称<input aria-label="新群组名称" value={newTitle} maxLength={300} onChange={event => setNewTitle(event.target.value)} placeholder="例如：人物组" /></label>
            <button type="submit">将选中 {ungroupedNodeIds.length} 个节点建组</button></form>}
          {groups.length > 0 && <section aria-label="全部群组"><strong>全部群组 · {groups.length}</strong>
            {groups.map(group => <form key={group.id} className="group-management-row" aria-label={`管理群组 ${group.title}`} onSubmit={event => {
              event.preventDefault(); setError(undefined);
              void client.dispatch('group.rename@1', { id: group.id, title: renameDrafts[group.id] ?? group.title, expectedRevision: group.revision })
                .then(() => setRenameDrafts(current => { const next = { ...current }; delete next[group.id]; return next; }))
                .catch(reason => setError(String(reason)));
            }}><label>名称<input aria-label={`群组 ${groupNumber.get(group.id)} 名称`} value={renameDrafts[group.id] ?? group.title} maxLength={300}
              onChange={event => setRenameDrafts(current => ({ ...current, [group.id]: event.target.value }))} /></label>
              <small>{group.memberIds.length} 个节点</small><button type="submit">保存名称</button>
              <button type="button" onClick={() => { void client.dispatch('selection.set', { ids: [group.id], mode: 'replace' })
                .then(() => client.dispatch('canvas.focusSelection')).then(() => close()).catch(reason => setError(String(reason))); }}>定位</button>
            </form>)}
          </section>}
          {ungroupedNodeIds.length > 0 && (
            <section>
              <strong>将 {ungroupedNodeIds.length} 个选中文字节点加入</strong>
              <p>选择一个已有群组。一个文字节点只能属于一个群组。</p>
              <div className="group-membership-options">
                {groups.map((group) => (
                  <button type="button" key={group.id} onClick={() => add(group.id)}>
                    <span>{group.title}</span>
                    <small>{group.memberIds.length} 个节点</small>
                  </button>
                ))}
              </div>
            </section>
          )}

          {groupedSelections.map((groupId) => {
            const group = groupMap.get(groupId);
            const members = selectedNodeIds.filter((id) => ownerByNode.get(id) === groupId);
            if (!group || members.length === 0) return null;
            return (
              <section key={groupId}>
                <strong>从「{group.title}」踢出 {members.length} 个选中文字节点</strong>
                <button className="primary-button" type="button" onClick={() => remove(groupId, members)}>
                  踢出选中节点
                </button>
              </section>
            );
          })}

          {selectedGroup && groupedSelections.length === 0 && ungroupedNodeIds.length === 0 && (
            <section>
              <strong>从「{selectedGroup.title}」选择要踢出的节点</strong>
              <p>群组在画布上保持独立选择；在这里选择具体成员。</p>
              <div className="group-membership-options member-list">
                {selectedGroup.memberIds.map((nodeId) => (
                  <button type="button" key={nodeId} onClick={() => remove(selectedGroup.id, [nodeId])}>
                    <span>{nodeMap.get(nodeId)?.title ?? '缺失的文字节点'}</span>
                    <small>踢出</small>
                  </button>
                ))}
              </div>
            </section>
          )}

          {!hasOperation && (
            <div className="group-membership-empty">
              <strong>没有可处理的选中项</strong>
              <span>可以先查看、改名或定位已有群组；选择文字节点后可创建群组或调整成员。</span>
            </div>
          )}
          {groups.length === 0 && (
            <div className="group-membership-empty">
              <strong>画布上还没有群组</strong>
              <span>请先选择至少两个文字节点并创建群组。</span>
            </div>
          )}
          {error && <div className="group-membership-error" role="alert">{error}</div>}
        </div>
      </section>
    </div>
  );
}
