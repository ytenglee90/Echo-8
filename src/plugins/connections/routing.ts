import { connectionEndpointPoint, connectionHorizontalSides, resolveConnectionRecordEndpoints, type ConnectionNodeGeometry, type ConnectionRecord } from '../../protocols/connections.ts';
import type { ConnectionRenderPoint } from './rendering.ts';

export interface ConnectionPoints { from: ConnectionRenderPoint; to: ConnectionRenderPoint }

/** Horizontal tangent points away from a source port and into a target port. */
export function junctionRenderPoint(point: ConnectionRenderPoint, role: 'source' | 'target'): ConnectionRenderPoint {
  return { ...point, tangent: { x: role === 'source' ? point.side === 'left' ? -1 : 1 : point.side === 'right' ? -1 : 1, y: 0 } };
}

/** One projection for paint, hit testing, lasso and labels. Junction ports face the other endpoint independently on every edge. */
export function connectionGraphPoints(records: readonly ConnectionRecord[], nodes: ReadonlyMap<string, ConnectionNodeGeometry>): Map<string, ConnectionPoints> {
  const points = new Map<string, ConnectionPoints>();
  for (const record of records) {
    const fromNode = nodes.get(record.from.nodeId), toNode = nodes.get(record.to.nodeId);
    if (!fromNode || !toNode) continue;
    const endpoints = resolveConnectionRecordEndpoints(record, fromNode, toNode);
    const sides = connectionHorizontalSides(record, fromNode, toNode);
    const from: ConnectionRenderPoint = connectionEndpointPoint(endpoints.from, fromNode, sides.from.side);
    const to: ConnectionRenderPoint = connectionEndpointPoint(endpoints.to, toNode, sides.to.side);
    if (record.from.kind === 'junction') from.tangent = junctionRenderPoint(from, 'source').tangent;
    if (record.to.kind === 'junction') to.tangent = junctionRenderPoint(to, 'target').tangent;
    points.set(record.id, { from, to });
  }
  return points;
}
