import { connectionEndpointPoint, connectionHorizontalSides, resolveConnectionRecordEndpoints, type ConnectionNodeGeometry, type ConnectionRecord } from '../../protocols/connections.ts';
import type { ConnectionRenderPoint } from './rendering.ts';

export interface ConnectionPoints { from: ConnectionRenderPoint; to: ConnectionRenderPoint }

/** One projection for paint, hit testing, lasso and labels. Junctions always receive on the left and output on the right. */
export function connectionGraphPoints(records: readonly ConnectionRecord[], nodes: ReadonlyMap<string, ConnectionNodeGeometry>): Map<string, ConnectionPoints> {
  const points = new Map<string, ConnectionPoints>();
  for (const record of records) {
    const fromNode = nodes.get(record.from.nodeId), toNode = nodes.get(record.to.nodeId);
    if (!fromNode || !toNode) continue;
    const endpoints = resolveConnectionRecordEndpoints(record, fromNode, toNode);
    const sides = connectionHorizontalSides(record, fromNode, toNode);
    const from: ConnectionRenderPoint = connectionEndpointPoint(endpoints.from, fromNode, sides.from.side);
    const to: ConnectionRenderPoint = connectionEndpointPoint(endpoints.to, toNode, sides.to.side);
    if (record.from.kind === 'junction') from.tangent = { x: 1, y: 0 };
    if (record.to.kind === 'junction') to.tangent = { x: 1, y: 0 };
    points.set(record.id, { from, to });
  }
  return points;
}
