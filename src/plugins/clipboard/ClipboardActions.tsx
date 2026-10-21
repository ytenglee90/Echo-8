'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { useCommandTooltip } from '../../ui/runtime-hooks.ts';

interface ClipboardState {
  hasContent: boolean;
  count: number;
}

export function ClipboardActions({ client }: { client: ViewClient }) {
  const workspaceVersion = useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [selection, setSelection] = useState<SelectionSnapshot>({ ids: [], items: [] });
  const [clipboard, setClipboard] = useState<ClipboardState>({ hasContent: false, count: 0 });

  useEffect(() => {
    let current = true;
    void Promise.all([
      client.request<SelectionSnapshot>('selection.read@1'),
      client.request<ClipboardState>('clipboard.state@1'),
    ]).then(([nextSelection, nextClipboard]) => {
      if (!current) return;
      setSelection(nextSelection);
      setClipboard(nextClipboard);
    });
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, workspaceVersion]);

  const hasSelection = selection.ids.length > 0;
  const copyLabel = useCommandTooltip(client, 'clipboard.copy', '复制');
  const cutLabel = useCommandTooltip(client, 'clipboard.cut', '剪切');
  const pasteLabel = useCommandTooltip(
    client,
    'clipboard.paste',
    clipboard.hasContent ? `粘贴（剪贴板中有 ${clipboard.count} 项）` : '粘贴',
  );

  return (
    <div className="clipboard-actions" aria-label="剪贴板操作">
      <IconButton icon="copy" label={copyLabel} disabled={!hasSelection} onClick={() => void client.dispatch('clipboard.copy')} />
      <IconButton icon="cut" label={cutLabel} disabled={!hasSelection} onClick={() => void client.dispatch('clipboard.cut')} />
      <IconButton
        icon="paste"
        label={pasteLabel}
        disabled={!clipboard.hasContent}
        onClick={() => void client.dispatch('clipboard.paste')}
      />
    </div>
  );
}
