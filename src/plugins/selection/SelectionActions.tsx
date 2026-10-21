'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { IconButton } from '../../ui/Icon.tsx';

export function SelectionActions({ client }: { client: ViewClient }) {
  const version = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion('selection'),
    () => 0,
  );
  const [selection, setSelection] = useState<SelectionSnapshot>({ ids: [], items: [] });

  useEffect(() => {
    let current = true;
    void client.request<SelectionSnapshot>('selection.read@1').then((next) => {
      if (current) setSelection(next);
    });
    return () => {
      current = false;
    };
  }, [client, version]);

  const hasSelection = selection.ids.length > 0;

  return (
    <div className="selection-actions" aria-label="选中项操作">
      <IconButton icon="focus" label="聚焦选中项" disabled={!hasSelection} onClick={() => void client.dispatch('canvas.focusSelection')} />
      <IconButton icon="trash" label="删除选中项" disabled={!hasSelection} onClick={() => void client.dispatch('selection.delete')} />
      <IconButton icon="close" label="取消选择" disabled={!hasSelection} onClick={() => void client.dispatch('selection.clear')} />
    </div>
  );
}
