'use client';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../core/contracts.ts';
import type { ConnectionNodeGeometry, ConnectionTarget, ConnectionTargetsRequest } from '../protocols/connections.ts';

/** Providers own bounds; consumers supply only current geometry, never inspect foreign records. */
export function useConnectionTargets(client: ViewClient, nodes: ReadonlyMap<string, ConnectionNodeGeometry>, membership?: ConnectionTargetsRequest['membership']): ConnectionTarget[] {
  const capabilities = useSyncExternalStore(client.subscribeCapabilities, client.getCapabilityVersion, () => 0);
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribeSignal('connection.targets.invalidated', () => setVersion(value => value + 1)), [client]);
  return useMemo(() => {
    try { return client.requestSync<ConnectionTarget[]>('connections.targets@1', { nodes: [...nodes.values()], membership }); }
    catch { return []; }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Provider lifecycle and invalidation revisions explicitly expire the read cache.
  }, [capabilities, client, nodes, version, membership]);
}
