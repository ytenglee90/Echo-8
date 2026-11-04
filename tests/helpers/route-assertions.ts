import assert from 'node:assert/strict';
import type { RoutePlan, RoutePoint, RouteSegment } from '../../src/plugins/connections/route-geometry.ts';
export function derivative(s: RouteSegment, t: number): RoutePoint {
  return { x: 3 * (1 - t) ** 2 * (s.controlFrom.x - s.from.x) + 6 * (1 - t) * t * (s.controlTo.x - s.controlFrom.x) + 3 * t ** 2 * (s.to.x - s.controlTo.x),
    y: 3 * (1 - t) ** 2 * (s.controlFrom.y - s.from.y) + 6 * (1 - t) * t * (s.controlTo.y - s.controlFrom.y) + 3 * t ** 2 * (s.to.y - s.controlTo.y) };
}
export function curvature(s: RouteSegment, t: number) {
  const d = derivative(s, t), x = 6 * ((1 - t) * (s.controlTo.x - 2 * s.controlFrom.x + s.from.x) + t * (s.to.x - 2 * s.controlTo.x + s.controlFrom.x)),
    y = 6 * ((1 - t) * (s.controlTo.y - 2 * s.controlFrom.y + s.from.y) + t * (s.to.y - 2 * s.controlTo.y + s.controlFrom.y));
  return (d.x * y - d.y * x) / Math.hypot(d.x, d.y) ** 3;
}
export function assertSmoothRoute(plan: RoutePlan) {
  if (Math.hypot(plan.to.x - plan.from.x, plan.to.y - plan.from.y) < 1e-6) return;
  for (const s of plan.segments) for (let sample = 0; sample <= 20; sample++) {
    const speed = Math.hypot(...Object.values(derivative(s, sample / 20)));
    assert.ok(Number.isFinite(speed) && speed > 1e-8, 'a planned route must not contain a stationary cusp');
  }
  for (let i = 1; i < plan.segments.length; i++) {
    const a = plan.segments[i - 1], b = plan.segments[i], u = derivative(a, 1), v = derivative(b, 0);
    assert.ok(Math.hypot(a.to.x - b.from.x, a.to.y - b.from.y) < 1e-8, 'spline spans must meet');
    assert.ok((u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)) > 1 - 1e-9, 'tangents must be continuous and point forwards');
    assert.ok(Math.abs(curvature(a, 1) - curvature(b, 0)) < 1e-6, 'geometric curvature must be continuous');
  }
  assert.ok(Math.abs(curvature(plan.segments[0], 0)) < 1e-7);
  assert.ok(Math.abs(curvature(plan.segments.at(-1)!, 1)) < 1e-7);
}

export function assertNoSelfIntersection(plan: RoutePlan) {
  const sample = (p: RouteSegment, t: number) => { const q = 1 - t; return { x: q ** 3 * p.from.x + 3 * q * q * t * p.controlFrom.x + 3 * q * t * t * p.controlTo.x + t ** 3 * p.to.x,
    y: q ** 3 * p.from.y + 3 * q * q * t * p.controlFrom.y + 3 * q * t * t * p.controlTo.y + t ** 3 * p.to.y }; };
  const points = [...plan.segments.flatMap(s => Array.from({ length: 16 }, (_, i) => sample(s, i / 16))), plan.to];
  const cross = (a: RoutePoint, b: RoutePoint, c: RoutePoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 1; i < points.length; i++) for (let k = i + 2; k < points.length; k++) {
    const crossed = cross(points[i - 1], points[i], points[k - 1]) * cross(points[i - 1], points[i], points[k]) < -1e-6 &&
      cross(points[k - 1], points[k], points[i - 1]) * cross(points[k - 1], points[k], points[i]) < -1e-6;
    assert.ok(!crossed, 'a detour must not cross its own approach or return');
  }
}
