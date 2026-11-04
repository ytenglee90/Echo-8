import { connectionEndpointPoint, connectionHorizontalSides, isTitleConnection, isConnectionCurveBend, resolveConnectionRecordEndpoints, type ConnectionNodeGeometry, type ConnectionRecord } from '../../protocols/connections.ts';
import { connectionStrokeGeometry, type ConnectionRenderPoint } from './rendering.ts';
import { planSmoothRoute } from './route-geometry.ts';
import { planJunctionTransition, type JunctionNeighbour } from './junction-routing.ts';

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

/** Project all physical anchors, plan each junction once, then attach immutable route plans to its edges. */
export function connectionGraphPoints(records: readonly ConnectionRecord[], nodes: ReadonlyMap<string, ConnectionNodeGeometry>): Map<string, ConnectionPoints> {
  const points = new Map<string, ConnectionPoints>(), neighbours = new Map<string, JunctionNeighbour[]>();
  const include = (id: string, point: ConnectionRenderPoint, other: ConnectionRenderPoint, otherIsJunction: boolean) => {
    const horizontalOnly = !otherIsJunction && Math.abs(point.y - other.y) < 24 && (point.x - other.x) * (other.side === 'left' ? -1 : 1) <= 0;
    const manualSafe = otherIsJunction || (point.x - other.x) * (other.side === 'left' ? -1 : 1) > 0;
    const list = neighbours.get(id) ?? []; list.push({ point, other, angle: nodes.get(id)?.handleAngle ?? 0, horizontalOnly, manualSafe }); neighbours.set(id, list);
  };
  for (const record of records) {
    const fromNode = nodes.get(record.from.nodeId), toNode = nodes.get(record.to.nodeId);
    if (!fromNode || !toNode) continue;
    const endpoints = resolveConnectionRecordEndpoints(record, fromNode, toNode), sides = connectionHorizontalSides(record, fromNode, toNode);
    const from = connectionEndpointPoint(endpoints.from, fromNode, sides.from.side), to = connectionEndpointPoint(endpoints.to, toNode, sides.to.side);
    points.set(record.id, { from, to });
    if (record.from.kind === 'junction') include(record.from.nodeId, from, to, record.to.kind === 'junction');
    if (record.to.kind === 'junction') include(record.to.nodeId, to, from, record.from.kind === 'junction');
  }
  const transitions = new Map([...neighbours].map(([id, list]) => [id, planJunctionTransition(list)]));
  for (const record of records) {
    const pair = points.get(record.id); if (!pair || (record.from.kind !== 'junction' && record.to.kind !== 'junction')) continue;
    const span = Math.hypot(pair.to.x - pair.from.x, pair.to.y - pair.from.y);
    const bend = isConnectionCurveBend(record.curveBend) ? record.curveBend : undefined;
    const nodeLead = Math.min(32, Math.max(.5, Math.abs(pair.to.x - pair.from.x) * .2), Math.max(.5, span * .1));
    const end = (point: ConnectionRenderPoint, other: ConnectionRenderPoint, endpoint: ConnectionRecord['from'], source: boolean) => {
      const transition = endpoint.kind === 'junction' ? transitions.get(endpoint.nodeId) : undefined;
      const sign = source ? 1 : -1;
      if (transition) {
        const half = other.x < point.x ? -1 : 1;
        point.side = half < 0 ? 'left' : 'right';
        point.tangent = { x: transition.axis.x * half * sign, y: transition.axis.y * half * sign };
        return { ...point, direction: point.tangent, lead: transition.lead, bend: bend?.[source ? 'from' : 'to'] };
      }
      return { ...point, direction: { x: (point.side === 'left' ? -1 : 1) * sign, y: 0 }, lead: nodeLead };
    };
    const route = planSmoothRoute(end(pair.from, pair.to, record.from, true), end(pair.to, pair.from, record.to, false));
    pair.from = { ...pair.from, route }; pair.to = { ...pair.to, route };
  }
  return points;
}
