'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { ConnectionRecord } from '../../protocols/connections.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { useCommandTooltip } from '../../ui/runtime-hooks.ts';

export function ConnectionToolbarAction({ client }: { client: ViewClient }) {
  const workspaceVersion = useSyncExternalStore(
    client.subscribeState,
    client.getWorkspaceVersion,
    () => 0,
  );
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [ready, setReady] = useState(false);
  const [connectionsVersion, setConnectionsVersion] = useState(0);
  const actionLabel = useCommandTooltip(
    client,
    'connection.toggleSelected',
    '连接两个节点，或断开一个选中节点的连线',
  );

  useEffect(
    () => client.subscribeSignal('connections.invalidated', () =>
      setConnectionsVersion((version) => version + 1)),
    [client],
  );

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const selection = await client.request<SelectionSnapshot>('selection.read@1');
        const [nodes, connections] = await Promise.all([
          client.request<ContentSummary[]>('content.summariesById@1', { nodeIds: selection.ids }),
          client.request<ConnectionRecord[]>('connections.list@1'),
        ]);
        if (!current) return;
        const selected = nodes.map((node) => node.id);
        const singleNodeCanDisconnect = selected.length === 1 && connections.some((connection) =>
          connection.from.nodeId === selected[0] || connection.to.nodeId === selected[0],
        );
        setReady(selected.length === 2 || singleNodeCanDisconnect);
      } catch {
        if (current) setReady(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, connectionsVersion, workspaceVersion]);

  return (
    <div className="connection-toolbar-action" aria-label="节点连线工具">
      <IconButton
        icon="link"
        label={actionLabel}
        disabled={!ready}
        onClick={() => void client.dispatch('connection.toggleSelected')}
      />
    </div>
  );
}
