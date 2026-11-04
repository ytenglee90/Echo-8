import { connectionEndpointPoint, connectionHorizontalSides, isTitleConnection, resolveConnectionRecordEndpoints, type ConnectionNodeGeometry, type ConnectionRecord } from '../../protocols/connections.ts';
import { connectionStrokeGeometry, type ConnectionRenderPoint } from './rendering.ts';

export interface ConnectionPoints { from: ConnectionRenderPoint; to: ConnectionRenderPoint }

/** Solid arrows belong to actual left/input ports, independently of stored graph direction. */
export function connectionStrokeForEndpoints(record: Pick<ConnectionRecord, 'from' | 'to' | 'titleRoute'>, points: ConnectionPoints, zoom = 1) {
  const arrowEnd = !record.to.nodeId ? 'to' : isTitleConnection(record)
    ? record.to.kind === 'junction' ? undefined : 'to'
    : record.from.kind !== 'junction' && points.from.side === 'left' ? 'from'
      : record.to.kind !== 'junction' && points.to.side === 'left' ? 'to' : undefined;
  const reverse = (point: ConnectionRenderPoint): ConnectionRenderPoint => ({ ...point,
    ...(point.tangent ? { tangent: { x: -point.tangent.x, y: -point.tangent.y } } : {}) });
  const geometry = arrowEnd === 'from'
    ? connectionStrokeGeometry(reverse(points.to), reverse(points.from), zoom)
    : connectionStrokeGeometry(points.from, points.to, zoom, arrowEnd === 'to');
  return { ...geometry, arrowEnd: geometry.arrowPath ? arrowEnd as 'from' | 'to' : undefined };
}

/** Horizontal tangent points away from a source port and into a target port. */
export function junctionRenderPoint(point: ConnectionRenderPoint, role: 'source' | 'target', other?: ConnectionRenderPoint, handleAngle = 0): ConnectionRenderPoint {
  const side = other ? other.x < point.x ? 'left' : 'right' : point.side;
  const sign = role === 'source' ? side === 'left' ? -1 : 1 : side === 'right' ? -1 : 1;
  const radians = handleAngle * Math.PI / 180;
  const clean = (value: number) => Math.abs(value) < 1e-10 ? 0 : value;
  return { ...point, side, tangent: { x: clean(sign * Math.cos(radians)), y: clean(sign * Math.sin(radians)) } };
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
    points.set(record.id, { from: record.from.kind === 'junction' ? junctionRenderPoint(from, 'source', to, fromNode.handleAngle) : from,
      to: record.to.kind === 'junction' ? junctionRenderPoint(to, 'target', from, toNode.handleAngle) : to });
  }
  return points;
}
