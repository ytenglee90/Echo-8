import type { ConnectionCurveBend, ConnectionEndpoint, ConnectionRecord } from '../../protocols/connections.ts';
import { isConnectionCurveBend } from '../../protocols/connections.ts';

/** A bend belongs to this physical endpoint of this edge, never a replaced junction. */
export function curveBendAtEndpoints(records: readonly ConnectionRecord[], from: ConnectionEndpoint, to: ConnectionEndpoint): ConnectionCurveBend | undefined {
  const bend: ConnectionCurveBend = {};
  for (const end of ['from', 'to'] as const) {
    const endpoint = end === 'from' ? from : to;
    if (endpoint.kind !== 'junction') continue;
    for (const record of records) for (const old of ['from', 'to'] as const) {
      if (record[old].kind === 'junction' && record[old].nodeId === endpoint.nodeId && isConnectionCurveBend(record.curveBend) && record.curveBend[old]) bend[end] = record.curveBend[old];
    }
  }
  return Object.keys(bend).length ? bend : undefined;
}

export function retargetCurveBend<T extends ConnectionRecord>(record: T, sources: readonly ConnectionRecord[]): T {
  const next = { ...record }, bend = curveBendAtEndpoints(sources, record.from, record.to);
  if (bend) next.curveBend = bend; else delete next.curveBend;
  return next;
}
