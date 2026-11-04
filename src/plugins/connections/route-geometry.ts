/** Pure geometry for planned routes. No records, UI state or persistence belong here. */
export interface RoutePoint { x: number; y: number }
export interface RouteSegment {
  kind: 'cubic'; from: RoutePoint; controlFrom: RoutePoint; controlTo: RoutePoint; to: RoutePoint;
}
export interface RouteEnd extends RoutePoint { direction: RoutePoint; lead: number; bend?: number }
export interface RoutePlan { from: RoutePoint; to: RoutePoint; segments: readonly RouteSegment[]; key: string }
const shift = (p: RoutePoint, v: RoutePoint, length: number): RoutePoint => ({ x: p.x + v.x * length, y: p.y + v.y * length });
const mix = (a: RoutePoint, b: RoutePoint, t: number): RoutePoint => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const distance = (a: RoutePoint, b: RoutePoint) => Math.hypot(b.x - a.x, b.y - a.y);
function straight(from: RoutePoint, to: RoutePoint): RouteSegment {
  return { kind: 'cubic', from: { x: from.x, y: from.y }, controlFrom: mix(from, to, 1 / 3), controlTo: mix(from, to, 2 / 3), to: { x: to.x, y: to.y } };
}

/** Open cubic B-spline converted exactly to Bezier spans by knot insertion. Interior joins are C2. */
function spline(polygon: RoutePoint[]): RouteSegment[] {
  let points = polygon;
  const spans = points.length - 3;
  const interior = points.length === 6 ? [.14, .86] : Array.from({ length: spans - 1 }, (_, i) => (i + 1) / spans);
  let knots = [0, 0, 0, 0, ...interior, 1, 1, 1, 1];
  for (const u of interior) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const k = knots.findLastIndex(value => value <= u), multiplicity = knots.filter(value => value === u).length;
      const next: RoutePoint[] = [];
      for (let i = 0; i <= k - 3; i++) next[i] = points[i];
      for (let i = k - multiplicity; i < points.length; i++) next[i + 1] = points[i];
      for (let i = k - 2; i <= k - multiplicity; i++) next[i] = mix(points[i - 1], points[i], (u - knots[i]) / (knots[i + 3] - knots[i]));
      points = next; knots = [...knots.slice(0, k + 1), u, ...knots.slice(k + 1)];
    }
  }
  const result: RouteSegment[] = [];
  for (let i = 0; i + 3 < points.length; i += 3) result.push({ kind: 'cubic', from: points[i], controlFrom: points[i + 1], controlTo: points[i + 2], to: points[i + 3] });
  return result;
}

/** The first/last three controls are collinear: curvature reaches zero before a shared trunk or port. */
export function planSmoothRoute(from: RouteEnd, to: RouteEnd): RoutePlan {
  if (distance(from, to) < .000001) return finish(from, to, [straight(from, to)]);
  const start = shift(from, from.direction, from.lead), end = shift(to, to.direction, -to.lead);
  const dx = end.x - start.x, dy = end.y - start.y, span = distance(start, end);
  const handle = (v: RoutePoint) => {
    let length = Math.min(420, Math.max(8, span * .4));
    if (dx * v.x > .000001) length = Math.min(length, Math.abs(dx / v.x) * .5);
    if (dy * v.y > .000001) length = Math.min(length, Math.abs(dy / v.y) * .5);
    return length;
  };
  let h = handle(from.direction), k = handle(to.direction);
  const needsCorridor = Math.abs(dy) < 24 && (dx * from.direction.x <= 0 || dx * to.direction.x <= 0);
  const bias = (from.bend ?? 0) + (to.bend ?? 0);
  const clearance = Math.max(64, Math.min(320, (Math.abs(dx) + h + k) * .3)) * (1 + Math.sin(bias * Math.PI / 180) * .25);
  if (needsCorridor) {
    h = Math.max(h, 48); k = Math.max(k, 48);
    // Ordered lanes keep close, same-side ports from crossing their own approach rays.
    if (from.direction.x * to.direction.x < 0) {
      if (Math.abs(dy) < .000001 ? dx * from.direction.x < 0 : start.y > end.y) h = Math.max(h, k + clearance);
      else k = Math.max(k, h + clearance);
    }
  }
  if ((from.bend || to.bend) && dx * from.direction.x > 0 && dx * to.direction.x > 0) { h *= .75; k *= .75; }
  const exit = shift(start, from.direction, h), entry = shift(end, to.direction, -k);
  const corridorY = Math.min(start.y, end.y) - clearance;
  const endpointScale = needsCorridor ? .5 : .14;
  // Interior controls steer this edge without rotating either shared endpoint
  // tangent. Monotone x prevents a manual bend from creating a loop or cusp.
  const forward = Math.sign(dx), monotone = forward * from.direction.x > 0 && forward * to.direction.x > 0 && (entry.x - exit.x) * forward > .000001;
  const steering = (fraction: number, angle: number | undefined, sign: number) => {
    if (!angle || !monotone) return [];
    const point = mix(exit, entry, fraction), offset = Math.max(-span * .35, Math.min(span * .35, Math.tan(angle * Math.PI / 180) * Math.abs(entry.x - exit.x) * .5));
    return [{ x: point.x, y: point.y + offset * sign }];
  };
  const polygon = [start, shift(start, from.direction, h * endpointScale), exit,
    ...(needsCorridor ? [{ x: exit.x, y: corridorY }, { x: entry.x, y: corridorY }] : []),
    ...steering(1 / 3, from.bend, Math.sign(from.direction.x)), ...steering(2 / 3, to.bend, -Math.sign(to.direction.x)),
    entry, shift(end, to.direction, -k * endpointScale), end];
  return finish(from, to, [
    ...(from.lead > .000001 ? [straight(from, start)] : []), ...spline(polygon),
    ...(to.lead > .000001 ? [straight(end, to)] : []),
  ]);
}

function finish(from: RoutePoint, to: RoutePoint, segments: RouteSegment[]): RoutePlan {
  return { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, segments, key: segments.flatMap(segment => [segment.from, segment.controlFrom, segment.controlTo, segment.to])
    .map(p => `${p.x},${p.y}`).join(';') };
}

export function orientedRoute(plan: RoutePlan, from: RoutePoint): readonly RouteSegment[] {
  if (from.x === plan.from.x && from.y === plan.from.y) return plan.segments;
  return [...plan.segments].reverse().map(segment => ({ ...segment, from: segment.to, to: segment.from, controlFrom: segment.controlTo, controlTo: segment.controlFrom }));
}
