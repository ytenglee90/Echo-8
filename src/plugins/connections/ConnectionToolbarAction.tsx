'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { ConnectionGraphSnapshot, ConnectionNodeGeometry, ConnectionTarget } from '../../protocols/connections.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { ToolbarDropdown } from '../../ui/ToolbarDropdown.tsx';
import { connectionToolbarSelection } from './toolbar-selection.ts';

const EMPTY = connectionToolbarSelection([], { version: 1, connections: [], junctions: [] }, []);
export function ConnectionToolbarAction({ client }: { client: ViewClient }) {
  const workspaceVersion = useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  const capabilityVersion = useSyncExternalStore(client.subscribeCapabilities, client.getCapabilityVersion, () => 0);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState(EMPTY);
  useEffect(() => client.subscribeSignal('connections.invalidated', () => setVersion(value => value + 1)), [client]);
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const selection = await client.request<SelectionSnapshot>('selection.read@1');
        const [nodes, graph, targets] = await Promise.all([
          client.request<ContentSummary[]>('content.summariesById@1', { nodeIds: selection.ids }),
          client.request<ConnectionGraphSnapshot>('connections.graph@1'),
          client.requestAll<ConnectionTarget[]>('connections.targets@1'),
        ]);
        const endpoints: ConnectionNodeGeometry[] = [...nodes, ...targets.flat(), ...graph.junctions.map(point => ({ ...point, width: 0, height: 0, kind: 'junction' as const }))];
        if (current) setState(connectionToolbarSelection(selection.ids, graph, endpoints));
      } catch { if (current) setState(EMPTY); }
    })();
    return () => { current = false; };
  }, [capabilityVersion, client, version, workspaceVersion]);
  const run = (kind: 'body' | 'title' | 'junction' | 'disconnect') => void client.dispatch('connection.toolbarToggle@1', { kind });
  const primaryLabel = state.primary === 'junction' ? '删除中转点' : state.primary === 'disconnect' ? '断开选中连线' : state.primary === 'title' ? state.titleRemoves ? '断开标题连接' : '标题连接' : state.bodyRemoves ? '断开正文连接' : '正文连接';
  const primaryIcon = state.primary === 'junction' ? 'junction-remove' : state.primary === 'disconnect' ? 'unlink' : state.primary === 'title' ? state.titleRemoves ? 'unlink-title' : 'link-title' : state.bodyRemoves ? 'unlink' : 'link';
  return <ToolbarDropdown className="connection-toolbar-action" menuClassName="toolbar-icon-menu" label="连接选项" width="max-content"
    trigger={<IconButton icon={primaryIcon} label={primaryLabel} disabled={!state.ready} onClick={() => run(state.primary)} />}>
    <IconButton role="menuitem" disabled={!state.body} icon={state.bodyRemoves ? 'unlink' : 'link'} label={state.bodyRemoves ? '断开正文连接' : '正文连接'} onClick={() => run('body')} />
    <IconButton role="menuitem" disabled={!state.title} icon={state.titleRemoves ? 'unlink-title' : 'link-title'} label={state.titleRemoves ? '断开标题连接' : '标题连接'} onClick={() => run('title')} />
    <IconButton role="menuitem" disabled={!state.junction} icon={state.removesJunction ? 'junction-remove' : 'junction'} label={state.removesJunction ? '删除中转点' : '创建中转点'} onClick={() => run('junction')} />
  </ToolbarDropdown>;
}
