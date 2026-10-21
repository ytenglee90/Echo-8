'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { CanvasToolMode } from '../../protocols/canvas.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { useCommandTooltip } from '../../ui/runtime-hooks.ts';

export function CanvasToolActions({ client }: { client: ViewClient }) {
  const workspaceVersion = useSyncExternalStore(
    client.subscribeState,
    client.getWorkspaceVersion,
    () => 0,
  );
  useSyncExternalStore(
    client.subscribeKeyboard,
    client.getKeyboardVersion,
    () => 0,
  );
  const [tool, setTool] = useState<CanvasToolMode>('select');
  const temporaryHand = client.isShortcutPressed('canvas.pan-shortcut');
  const visibleTool: CanvasToolMode = temporaryHand ? 'hand' : tool;
  const selectLabel = useCommandTooltip(client, 'canvas.tool.select', '选择工具');
  const handLabel = useCommandTooltip(client, 'canvas.tool.hand', '手抓工具：拖动平移画布');

  useEffect(() => {
    let current = true;
    void client.request<CanvasToolMode>('canvas.tool@1').then((next) => {
      if (current) setTool(next);
    });
    return () => {
      current = false;
    };
  }, [client, workspaceVersion]);

  const activate = (next: CanvasToolMode) => {
    if (next === tool) return;
    setTool(next);
    void client.dispatch(next === 'hand' ? 'canvas.tool.hand' : 'canvas.tool.select');
  };

  return (
    <div className="canvas-tool-actions" aria-label="画布工具">
      <IconButton
        icon="pointer"
        label={selectLabel}
        className={`icon-button toolbar-tool-button ${visibleTool === 'select' ? 'active' : ''}`}
        aria-pressed={visibleTool === 'select'}
        onClick={() => activate('select')}
      />
      <IconButton
        icon="hand"
        label={handLabel}
        className={`icon-button toolbar-tool-button ${visibleTool === 'hand' ? 'active' : ''}`}
        aria-pressed={visibleTool === 'hand'}
        onClick={() => activate('hand')}
      />
    </div>
  );
}
