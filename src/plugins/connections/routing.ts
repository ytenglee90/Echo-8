import { connectionEndpointPoint, connectionHorizontalSides, resolveConnectionRecordEndpoints, type ConnectionJunction, type ConnectionNodeGeometry, type ConnectionRecord } from '../../protocols/connections.ts';
import type { ConnectionRenderPoint } from './rendering.ts';

export interface ConnectionPoints { from: ConnectionRenderPoint; to: ConnectionRenderPoint }

/** One geometry projection for paint, hit testing, lasso and labels; no durable routing state. */
export function connectionGraphPoints(records: readonly ConnectionRecord[], nodes: ReadonlyMap<string, ConnectionNodeGeometry>, junctions: readonly ConnectionJunction[]): Map<string, ConnectionPoints> {
  const points = new Map<string, ConnectionPoints>();
  const vectors = new Map<string, { incoming: Array<{ x: number; y: number }>; outgoing: Array<{ x: number; y: number }> }>();
  for (const point of junctions) vectors.set(point.id, { incoming: [], outgoing: [] });
  for (const record of records) {
    const fromNode = nodes.get(record.from.nodeId), toNode = nodes.get(record.to.nodeId);
    if (!fromNode || !toNode) continue;
    const endpoints = resolveConnectionRecordEndpoints(record, fromNode, toNode);
    const sides = connectionHorizontalSides(record, fromNode, toNode);
    const from = connectionEndpointPoint(endpoints.from, fromNode, sides.from.side), to = connectionEndpointPoint(endpoints.to, toNode, sides.to.side);
    points.set(record.id, { from, to });
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length < 0.0001) continue;
    const vector = { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
    if (record.from.kind === 'junction') vectors.get(record.from.nodeId)?.outgoing.push(vector);
    if (record.to.kind === 'junction') vectors.get(record.to.nodeId)?.incoming.push(vector);
  }
  const tangents = new Map<string, { x: number; y: number }>();
  for (const point of junctions) {
    const adjacent = vectors.get(point.id)!;
    const preferred = point.branchSide === 'outgoing' ? adjacent.incoming : adjacent.outgoing;
    const candidates = preferred.length ? preferred : [...adjacent.incoming, ...adjacent.outgoing];
    const sum = candidates.reduce((total, vector) => ({ x: total.x + vector.x, y: total.y + vector.y }), { x: 0, y: 0 });
    const length = Math.hypot(sum.x, sum.y);
    tangents.set(point.id, length > 0.0001 ? { x: sum.x / length, y: sum.y / length } : candidates[0] ?? { x: 1, y: 0 });
  }
  for (const record of records) {
    const geometry = points.get(record.id);
    if (!geometry) continue;
    if (record.from.kind === 'junction') geometry.from = { ...geometry.from, tangent: tangents.get(record.from.nodeId) ?? { x: 1, y: 0 } };
    if (record.to.kind === 'junction') geometry.to = { ...geometry.to, tangent: tangents.get(record.to.nodeId) ?? { x: 1, y: 0 } };
  }
  return points;
}
