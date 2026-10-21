'use client';

import { useCallback, useEffect } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { ContentReferenceDropZone } from '../../protocols/content.ts';
import type { FloatingPanelRect } from '../../protocols/floating.ts';

export function useAIDropZone({
  client,
  owner,
  active,
}: {
  client: ViewClient;
  owner: string;
  active: boolean;
}) {
  const publish = useCallback((rect: FloatingPanelRect) => {
    client.emit('content.reference.drop-zone', { owner, active, rect } satisfies ContentReferenceDropZone);
  }, [active, client, owner]);

  useEffect(() => {
    if (!active) client.emit('content.reference.drop-zone', { owner, active: false } satisfies ContentReferenceDropZone);
    return () => {
      client.emit('content.reference.drop-zone', { owner, active: false } satisfies ContentReferenceDropZone);
    };
  }, [active, client, owner]);

  return publish;
}
