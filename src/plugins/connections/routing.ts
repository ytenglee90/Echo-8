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

/** Rotate the shared flow axis; unconnected drafts fall back to the facing horizontal port. */
export function junctionRenderPoint(point: ConnectionRenderPoint, role: 'source' | 'target', other?: ConnectionRenderPoint, handleAngle = 0, flow?: { x: number; y: number }): ConnectionRenderPoint {
  const side = other ? other.x < point.x ? 'left' : 'right' : point.side;
  const sign = role === 'source' ? side === 'left' ? -1 : 1 : side === 'right' ? -1 : 1;
  const radians = handleAngle * Math.PI / 180;
  const clean = (value: number) => Math.abs(value) < 1e-10 ? 0 : value;
  const axis = flow ?? { x: sign, y: 0 };
  return { ...point, side, tangent: { x: clean(axis.x * Math.cos(radians) - axis.y * Math.sin(radians)), y: clean(axis.x * Math.sin(radians) + axis.y * Math.cos(radians)) } };
}

/** Prefer a shared forward axis; contradictory graph roles use facing halves of a common horizontal axis. */
export function connectionGraphPoints(records: readonly ConnectionRecord[], nodes: ReadonlyMap<string, ConnectionNodeGeometry>): Map<string, ConnectionPoints> {
  const points = new Map<string, ConnectionPoints>();
  const joints = new Map<string, { x: number; y: number; positiveX: boolean; negativeX: boolean; positiveY: boolean; negativeY: boolean;
    incoming: { x: number; y: number; count: number }; outgoing: { x: number; y: number; count: number } }>();
  const accumulate = (id: string, role: 'incoming' | 'outgoing', other: ConnectionRenderPoint) => {
    const node = nodes.get(id)!;
    let joint = joints.get(id);
    if (!joint) { joint = { x: node.x, y: node.y, positiveX: false, negativeX: false, positiveY: false, negativeY: false,
      incoming: { x: 0, y: 0, count: 0 }, outgoing: { x: 0, y: 0, count: 0 } }; joints.set(id, joint); }
    const sign = role === 'incoming' ? -1 : 1, dx = (other.x - node.x) * sign, dy = (other.y - node.y) * sign;
    joint.positiveX ||= dx > .001; joint.negativeX ||= dx < -.001;
    joint.positiveY ||= dy > .001; joint.negativeY ||= dy < -.001;
    const mean = joint[role]; mean.count += 1; mean.x += (other.x - mean.x) / mean.count; mean.y += (other.y - mean.y) / mean.count;
  };
  for (const record of records) {
    const fromNode = nodes.get(record.from.nodeId), toNode = nodes.get(record.to.nodeId);
    if (!fromNode || !toNode) continue;
    const endpoints = resolveConnectionRecordEndpoints(record, fromNode, toNode), sides = connectionHorizontalSides(record, fromNode, toNode);
    const from = connectionEndpointPoint(endpoints.from, fromNode, sides.from.side), to = connectionEndpointPoint(endpoints.to, toNode, sides.to.side);
    points.set(record.id, { from, to });
    if (record.from.kind === 'junction') accumulate(record.from.nodeId, 'outgoing', to);
    if (record.to.kind === 'junction') accumulate(record.to.nodeId, 'incoming', from);
  }
  const axes = new Map<string, { x: number; y: number }>();
  for (const [id, joint] of joints) {
    const a = joint.incoming, b = joint.outgoing;
    let x = (b.count ? b.x : joint.x) - (a.count ? a.x : joint.x), y = (b.count ? b.y : joint.y) - (a.count ? a.y : joint.y);
    if (a.count && b.count) {
      // An axis component that overshoots both adjoining chords creates an avoidable lobe.
      const horizontal = (joint.x - a.x) * (b.x - joint.x) < 0 ? 0 : x;
      const vertical = (joint.y - a.y) * (b.y - joint.y) < 0 ? 0 : y;
      if (Math.hypot(horizontal, vertical) > .001) { x = horizontal; y = vertical; }
    }
    if (Math.hypot(x, y) < .001) { x = b.count ? b.x - joint.x : joint.x - a.x; y = b.count ? b.y - joint.y : joint.y - a.y; }
    if (Math.hypot(x, y) < .001 && a.count) { x = joint.x - a.x; y = joint.y - a.y; }
    // A split/deleted/reconnected graph can retain opposite logical roles on the same physical side.
    // Means alone hide those conflicts. Never point an automatic handle backwards along any incident leg.
    if ((x > 0 && joint.negativeX) || (x < 0 && joint.positiveX)) x = 0;
    if ((y > 0 && joint.negativeY) || (y < 0 && joint.positiveY)) y = 0;
    const length = Math.hypot(x, y);
    // No directed axis can satisfy the whole graph: retain a common tangent line, facing each real endpoint.
    if (length > .001) axes.set(id, { x: x / length, y: y / length });
  }
  for (const record of records) {
    const pair = points.get(record.id); if (!pair) continue;
    const { from, to } = pair;
    if (record.from.kind === 'junction') pair.from = junctionRenderPoint(from, 'source', to, nodes.get(record.from.nodeId)?.handleAngle, axes.get(record.from.nodeId));
    if (record.to.kind === 'junction') pair.to = junctionRenderPoint(to, 'target', from, nodes.get(record.to.nodeId)?.handleAngle, axes.get(record.to.nodeId));
  }
  return points;
}
