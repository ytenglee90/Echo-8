import type { ConnectionSide } from '../../protocols/connections.ts';
import { canvasDetailWorldScale } from '../../ui/canvas-screen-scale.ts';

export interface ConnectionRenderPoint {
  x: number;
  y: number;
  side?: ConnectionSide;
}

export type ConnectionRenderMode = 'interactive-svg' | 'batched-svg';

export const CONNECTION_BATCH_RENDER_THRESHOLD = 600;
export const CONNECTION_OVERVIEW_MAX_ZOOM = 0.5;
export const CONNECTION_ARROW_SCREEN_LENGTH = 14;
export const CONNECTION_ARROW_SCREEN_HALF_WIDTH = 7;
export const CONNECTION_LINE_SCREEN_WIDTH = 1.5;
export const CONNECTION_MIN_HANDLE_LENGTH = 160;

interface CubicCurveSegment {
  kind: 'cubic';
  from: ConnectionRenderPoint;
  controlFrom: ConnectionRenderPoint;
  controlTo: ConnectionRenderPoint;
  to: ConnectionRenderPoint;
}

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

export function connectionCurvePathWithArrow(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
  zoom = 1,
): string {
  const segments = connectionCurveSegments(from, to);
  const final = segments.at(-1);
  if (!final) return connectionCurvePath(from, to);
  const tangentX = final.to.x - final.controlTo.x;
  const tangentY = final.to.y - final.controlTo.y;
  const tangentLength = Math.hypot(tangentX, tangentY);
  if (tangentLength === 0) return connectionCurvePath(from, to);
  const unitX = tangentX / tangentLength;
  const unitY = tangentY / tangentLength;
  const detailWorldScale = canvasDetailWorldScale(zoom);
  const arrowLength = CONNECTION_ARROW_SCREEN_LENGTH * detailWorldScale;
  const arrowHalfWidth = CONNECTION_ARROW_SCREEN_HALF_WIDTH * detailWorldScale;
  const base = {
    x: final.to.x - unitX * arrowLength,
    y: final.to.y - unitY * arrowLength,
  };
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
    ? { ...segment, to: base }
    : segment);
  const shaft = [
    `M ${formatPoint(from)}`,
    ...shaftSegments.map((segment) =>
      `C ${formatPoint(segment.controlFrom)}, ${formatPoint(segment.controlTo)}, ${formatPoint(segment.to)}`),
    ...[...shaftSegments].reverse().map((segment) =>
      `C ${formatPoint(segment.controlTo)}, ${formatPoint(segment.controlFrom)}, ${formatPoint(segment.from)}`),
    'Z',
  ].join(' ');
  return `${shaft} M ${formatPoint(firstWing)} L ${formatPoint(final.to)} L ${formatPoint(secondWing)} Z`;
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

function connectionCurveSegments(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
): CubicCurveSegment[] {
  if (from.side === 'title' || to.side === 'title') {
    return titleConnectionCurveSegments(from, to);
  }
  const relativeDirection = to.x >= from.x ? 1 : -1;
  const fromDirection = from.side === 'right' ? 1 : from.side === 'left' ? -1 : relativeDirection;
  const toDirection = to.side === 'left' ? 1 : to.side === 'right' ? -1 : relativeDirection;
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

function titleConnectionCurveSegments(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
): CubicCurveSegment[] {
  const verticalSpan = Math.abs(to.y - from.y);
  const horizontalSpan = Math.abs(to.x - from.x);
  const outward = Math.min(320, Math.max(
    CONNECTION_MIN_HANDLE_LENGTH,
    96 + Math.sqrt(verticalSpan) * 4.2 + Math.min(48, horizontalSpan * 0.16),
  ));
  const controlX = Math.min(from.x, to.x) - outward;
  return [{
    kind: 'cubic',
    from,
    controlFrom: { x: controlX, y: from.y },
    controlTo: { x: controlX, y: to.y },
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
