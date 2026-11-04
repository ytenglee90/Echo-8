import type { ConnectionSide } from '../../protocols/connections.ts';
import { orientedRoute, type RoutePlan, type RouteSegment } from './route-geometry.ts';
import { canvasDetailWorldScale } from '../../ui/canvas-screen-scale.ts';

export interface ConnectionRenderPoint {
  x: number;
  y: number;
  side?: ConnectionSide;
  /** Planned forward tangent at this endpoint, in world coordinates. */
  tangent?: { x: number; y: number };
  /** Rebuildable geometry shared by paint, hit testing, labels and bounds. Never persisted. */
  route?: RoutePlan;
}

export type ConnectionRenderMode = 'interactive-svg' | 'batched-svg';

export const CONNECTION_BATCH_RENDER_THRESHOLD = 600;
export const CONNECTION_OVERVIEW_MAX_ZOOM = 0.5;
export const CONNECTION_ARROW_SCREEN_LENGTH = 14;
export const CONNECTION_ARROW_SCREEN_HALF_WIDTH = 7;
export const CONNECTION_LINE_SCREEN_WIDTH = 1.5;
export const CONNECTION_HIGHLIGHT_SCREEN_WIDTH = 3;
export const CONNECTION_MIN_HANDLE_LENGTH = 160;
export const CONNECTION_LASSO_REGION_PADDING = 4;

const CONNECTION_LASSO_MAX_REGION_LENGTH = 12;
const CONNECTION_LASSO_MIN_REGIONS = 16;
const CONNECTION_LASSO_MAX_REGIONS = 256;

type CubicCurveSegment = RouteSegment;

export function connectionRenderMode(visibleConnections: number): ConnectionRenderMode {
  return visibleConnections > CONNECTION_BATCH_RENDER_THRESHOLD ? 'batched-svg' : 'interactive-svg';
}

export function connectionOverviewMode(zoom: number): boolean {
  return zoom < CONNECTION_OVERVIEW_MAX_ZOOM;
}

export function connectionVisibleForOverview(
  connection: { id: string; from: { nodeId: string }; to: { nodeId: string } },
  focusedNodeIds: ReadonlySet<string>,
  emphasizedConnectionIds: ReadonlySet<string>,
): boolean {
  return emphasizedConnectionIds.has(connection.id) ||
    focusedNodeIds.has(connection.from.nodeId) || focusedNodeIds.has(connection.to.nodeId);
}

export function orderConnectionsForPaint<T extends { connection: { id: string } }>(
  items: readonly T[],
  selectedIds: ReadonlySet<string>,
): T[] {
  const ordinary: T[] = [];
  const selected: T[] = [];
  for (const item of items) {
    (selectedIds.has(item.connection.id) ? selected : ordinary).push(item);
  }
  return [...ordinary, ...selected];
}

export function connectionCurvePath(from: ConnectionRenderPoint, to: ConnectionRenderPoint): string {
  const segments = connectionCurveSegments(from, to);
  return [
    `M ${formatPoint(from)}`,
    ...segments.map((segment) =>
      `C ${formatPoint(segment.controlFrom)}, ${formatPoint(segment.controlTo)}, ${formatPoint(segment.to)}`),
  ].join(' ');
}

export function connectionStrokeGeometry(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
  zoom = 1,
  arrow = true,
): { shaftPath: string; arrowPath: string } {
  const segments = connectionCurveSegments(from, to);
  const final = segments.at(-1);
  const full = { shaftPath: connectionCurvePath(from, to), arrowPath: '' };
  if (!final || !arrow) return full;
  if (from.route && from.route === to.route) return plannedStroke(segments, from, zoom);
  const length = approximateCubicLength(final);
  const detailWorldScale = canvasDetailWorldScale(zoom);
  const arrowLength = Math.min(CONNECTION_ARROW_SCREEN_LENGTH * detailWorldScale, length * .45);
  if (arrowLength < 0.001) return full;
  // Trim on the actual Bézier, preserving both control points and a single forward stroke.
  let previous = final.to, traversed = 0, trimT = 1;
  for (let step = 1; step <= 128; step += 1) {
    const t = 1 - step / 128;
    const current = pointOnCubicCurve(final, t);
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (traversed + distance >= arrowLength) {
      trimT = t + (1 - (arrowLength - traversed) / distance) / 128;
      break;
    }
    traversed += distance; previous = current;
  }
  const mix = (a: ConnectionRenderPoint, b: ConnectionRenderPoint) => ({ x: a.x + (b.x - a.x) * trimT, y: a.y + (b.y - a.y) * trimT });
  const a = mix(final.from, final.controlFrom), b = mix(final.controlFrom, final.controlTo), c = mix(final.controlTo, final.to);
  const d = mix(a, b), e = mix(b, c), curveBase = mix(d, e);
  // The terminal derivative, rather than the trimmed chord, owns the port direction.
  const tangentX = final.to.x - final.controlTo.x;
  const tangentY = final.to.y - final.controlTo.y;
  const tangentLength = Math.hypot(tangentX, tangentY);
  if (tangentLength === 0) return full;
  const unitX = tangentX / tangentLength;
  const unitY = tangentY / tangentLength;
  const base = { x: final.to.x - unitX * arrowLength, y: final.to.y - unitY * arrowLength };
  const terminalHandle = Math.max(0.001, Math.hypot(curveBase.x - d.x, curveBase.y - d.y));
  const controlFrom = a;
  const controlTo = { x: base.x - unitX * terminalHandle, y: base.y - unitY * terminalHandle };
  const arrowHalfWidth = Math.min(CONNECTION_ARROW_SCREEN_HALF_WIDTH * detailWorldScale, arrowLength / 2);
  const perpendicular = { x: -unitY, y: unitX };
  const firstWing = {
    x: base.x + perpendicular.x * arrowHalfWidth,
    y: base.y + perpendicular.y * arrowHalfWidth,
  };
  const secondWing = {
    x: base.x - perpendicular.x * arrowHalfWidth,
    y: base.y - perpendicular.y * arrowHalfWidth,
  };
  const shaftSegments = segments.map((segment, index) => index === segments.length - 1
    ? { ...segment, controlFrom, controlTo, to: base }
    : segment);
  const shaft = [
    `M ${formatPoint(from)}`,
    ...shaftSegments.map((segment) =>
      `C ${formatPoint(segment.controlFrom)}, ${formatPoint(segment.controlTo)}, ${formatPoint(segment.to)}`),
  ].join(' ');
  return { shaftPath: shaft, arrowPath: `M ${formatPoint(firstWing)} L ${formatPoint(final.to)} L ${formatPoint(secondWing)} Z` };
}

/** Planned routes end in a real straight port lead; trim it without modifying any spline control. */
function plannedStroke(segments: readonly CubicCurveSegment[], from: ConnectionRenderPoint, zoom: number) {
  const last = segments.at(-1)!, dx = last.to.x - last.from.x, dy = last.to.y - last.from.y, distance = Math.hypot(dx, dy);
  const length = Math.min(CONNECTION_ARROW_SCREEN_LENGTH * canvasDetailWorldScale(zoom), distance * .8);
  if (length < .001) return { shaftPath: connectionCurvePath(from, { ...last.to, route: from.route }), arrowPath: '' };
  const x = dx / distance, y = dy / distance, base = { x: last.to.x - x * length, y: last.to.y - y * length };
  const width = Math.min(CONNECTION_ARROW_SCREEN_HALF_WIDTH * canvasDetailWorldScale(zoom), length / 2);
  const trimmed = { ...last, to: base,
    controlFrom: { x: last.from.x + (base.x - last.from.x) / 3, y: last.from.y + (base.y - last.from.y) / 3 },
    controlTo: { x: last.from.x + 2 * (base.x - last.from.x) / 3, y: last.from.y + 2 * (base.y - last.from.y) / 3 } };
  const parts = [...segments.slice(0, -1), trimmed];
  return { shaftPath: [`M ${formatPoint(from)}`, ...parts.map(p => `C ${formatPoint(p.controlFrom)}, ${formatPoint(p.controlTo)}, ${formatPoint(p.to)}`)].join(' '),
    arrowPath: `M ${formatPoint({ x: base.x - y * width, y: base.y + x * width })} L ${formatPoint(last.to)} L ${formatPoint({ x: base.x + y * width, y: base.y - x * width })} Z` };
}

export function connectionCurveMidpoint(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
): ConnectionRenderPoint {
  const segments = connectionCurveSegments(from, to);
  const samples: Array<{
    segment: CubicCurveSegment;
    fromT: number;
    toT: number;
    length: number;
  }> = [];
  let totalLength = 0;
  for (const segment of segments) {
    let previous = segment.from;
    for (let step = 1; step <= 48; step += 1) {
      const toT = step / 48;
      const current = pointOnCubicCurve(segment, toT);
      const length = Math.hypot(current.x - previous.x, current.y - previous.y);
      samples.push({ segment, fromT: (step - 1) / 48, toT, length });
      totalLength += length;
      previous = current;
    }
  }
  const targetLength = totalLength / 2;
  let traversed = 0;
  for (const sample of samples) {
    if (traversed + sample.length >= targetLength) {
      const ratio = sample.length === 0 ? 0 : (targetLength - traversed) / sample.length;
      return pointOnCubicCurve(
        sample.segment,
        sample.fromT + (sample.toT - sample.fromT) * ratio,
      );
    }
    traversed += sample.length;
  }
  return to;
}

/** Approximate hit testing lets the batched path remain one DOM element. */
export function distanceToConnectionCurve(
  point: ConnectionRenderPoint,
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const segment of connectionCurveSegments(from, to)) {
    let previous = segment.from;
    for (let step = 1; step <= 16; step += 1) {
      const current = pointOnCubicCurve(segment, step / 16);
      nearest = Math.min(nearest, distanceToSegment(point, previous, current));
      previous = current;
    }
  }
  return nearest;
}

export function connectionCurveBounds(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
  padding = 8,
): { x: number; y: number; width: number; height: number } {
  const points = connectionCurveSegments(from, to).flatMap((segment) =>
    [segment.from, segment.controlFrom, segment.controlTo, segment.to]);
  const left = Math.min(...points.map((point) => point.x)) - padding;
  const top = Math.min(...points.map((point) => point.y)) - padding;
  const right = Math.max(...points.map((point) => point.x)) + padding;
  const bottom = Math.max(...points.map((point) => point.y)) + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Narrow lasso regions following the rendered curve. The broad curve bounds
 * remain useful for the spatial index, but using that whole rectangle as the
 * final hit target selects visually blank space around bent connections.
 */
export function connectionCurveLassoRegions(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
  padding = CONNECTION_LASSO_REGION_PADDING,
): Array<{ x: number; y: number; width: number; height: number }> {
  return connectionCurveSegments(from, to).flatMap((segment) => {
    const length = approximateCubicLength(segment);
    const regionCount = Math.max(
      CONNECTION_LASSO_MIN_REGIONS,
      Math.min(CONNECTION_LASSO_MAX_REGIONS, Math.ceil(length / CONNECTION_LASSO_MAX_REGION_LENGTH)),
    );
    const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
    let previous = segment.from;
    for (let step = 1; step <= regionCount; step += 1) {
      const current = pointOnCubicCurve(segment, step / regionCount);
      const left = Math.min(previous.x, current.x) - padding;
      const top = Math.min(previous.y, current.y) - padding;
      const right = Math.max(previous.x, current.x) + padding;
      const bottom = Math.max(previous.y, current.y) + padding;
      regions.push({ x: left, y: top, width: right - left, height: bottom - top });
      previous = current;
    }
    return regions;
  });
}

function connectionCurveSegments(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
): CubicCurveSegment[] {
  if (Math.hypot(to.x - from.x, to.y - from.y) < .000001) return [{ kind: 'cubic', from, controlFrom: from, controlTo: to, to }];
  if (from.route && from.route === to.route) return [...orientedRoute(from.route, from)];
  if (from.side === to.side && (from.side === 'left' || from.side === 'right')) {
    const direction = from.side === 'right' ? 1 : -1;
    const outward = Math.min(320, Math.max(CONNECTION_MIN_HANDLE_LENGTH, 96 + Math.sqrt(Math.abs(to.y - from.y)) * 4.2));
    const controlX = (direction > 0 ? Math.max(from.x, to.x) : Math.min(from.x, to.x)) + direction * outward;
    return [{ kind: 'cubic', from, to, controlFrom: { x: controlX, y: from.y }, controlTo: { x: controlX, y: to.y } }];
  }
  const relativeDirection = to.x >= from.x ? 1 : -1;
  const fromDirection = from.side === 'right' ? 1 : from.side === 'left' || from.side === 'title' ? -1 : relativeDirection;
  const toDirection = to.side === 'left' || to.side === 'title' ? 1 : to.side === 'right' ? -1 : relativeDirection;
  const bend = Math.min(420, Math.max(
    CONNECTION_MIN_HANDLE_LENGTH,
    Math.abs(to.x - from.x) * 0.62,
    Math.abs(to.y - from.y) * 0.34,
  ));
  return [{
    kind: 'cubic',
    from,
    controlFrom: { x: from.x + bend * fromDirection, y: from.y },
    controlTo: { x: to.x - bend * toDirection, y: to.y },
    to,
  }];
}


function pointOnCubicCurve(segment: CubicCurveSegment, t: number): ConnectionRenderPoint {
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * segment.from.x + 3 * inverse ** 2 * t * segment.controlFrom.x +
      3 * inverse * t ** 2 * segment.controlTo.x + t ** 3 * segment.to.x,
    y: inverse ** 3 * segment.from.y + 3 * inverse ** 2 * t * segment.controlFrom.y +
      3 * inverse * t ** 2 * segment.controlTo.y + t ** 3 * segment.to.y,
  };
}

function approximateCubicLength(segment: CubicCurveSegment): number {
  let length = 0;
  let previous = segment.from;
  for (let step = 1; step <= 24; step += 1) {
    const current = pointOnCubicCurve(segment, step / 24);
    length += Math.hypot(current.x - previous.x, current.y - previous.y);
    previous = current;
  }
  return length;
}

function formatPoint(point: ConnectionRenderPoint): string {
  return `${formatCoordinate(point.x)} ${formatCoordinate(point.y)}`;
}

function formatCoordinate(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function distanceToSegment(
  point: ConnectionRenderPoint,
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}
