'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import type { ArrangeMode } from '../../protocols/layout.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { ToolbarDropdown } from '../../ui/ToolbarDropdown.tsx';

export function ArrangeGridActions({ client }: { client: ViewClient }) {
  const version = useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  const [ready, setReady] = useState(false);
  const [nextMode, setNextMode] = useState<ArrangeMode>('grid');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const cycle = () => void client.dispatch('node.arrangeSelectedCycle').then(result => {
    setNextMode(result.nextMode);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setNextMode('grid'), result.resetAfterMs);
  });
  useEffect(() => {
    let current = true;
    void client.request<SelectionSnapshot>('selection.read@1').then(selection => {
      if (current) setReady(selection.items.some(item => item.kind === 'text-node' || item.kind === 'unknown'));
    }, () => { if (current) setReady(false); });
    return () => { current = false; };
  }, [client, version]);
  return <ToolbarDropdown className="canvas-tool-actions" menuClassName="toolbar-icon-menu" label="自动排列选项" enabled={ready} width="max-content"
    trigger={<IconButton icon={nextMode === 'grid' ? 'grid' : nextMode === 'horizontal' ? 'grid-horizontal' : 'grid-vertical'} label="自动排列（宫格、横排、竖排轮转）" className="icon-button toolbar-tool-button" disabled={!ready} onClick={cycle} />}>
    <IconButton role="menuitem" icon="grid" label="宫格排列" onClick={() => void client.dispatch('node.arrangeSelectedGrid')} />
    <IconButton role="menuitem" icon="grid-horizontal" label="横排" onClick={() => void client.dispatch('node.arrangeSelectedGrid.horizontal')} />
    <IconButton role="menuitem" icon="grid-vertical" label="竖排" onClick={() => void client.dispatch('node.arrangeSelectedGrid.vertical')} />
  </ToolbarDropdown>;
}
