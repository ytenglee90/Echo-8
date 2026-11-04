import type { RoutePoint } from './route-geometry.ts';

export interface JunctionNeighbour { point: RoutePoint; other: RoutePoint; horizontalOnly?: boolean }
export interface JunctionTransition { axis: RoutePoint; lead: number }

/** Physical neighbourhoods, not historical from/to roles, own the shared transition. */
export function planJunctionTransition(neighbours: readonly JunctionNeighbour[]): JunctionTransition {
  const centre = neighbours[0].point;
  let x = 0, y = 0, positiveY = false, negativeY = false, flat = false, horizontal = false, reach = 8;
  for (const { other, horizontalOnly } of neighbours) {
    const dx = other.x - centre.x, half = dx < 0 ? -1 : 1, dy = (other.y - centre.y) * half;
    x += Math.abs(dx); y += dy;
    positiveY ||= dy > .001; negativeY ||= dy < -.001;
    flat ||= Math.abs(dy) <= .001 || Math.hypot(dx, dy) < 48 || Boolean(horizontalOnly);
    horizontal ||= Boolean(horizontalOnly);
    reach = Math.min(reach, Math.abs(dx) * .04, Math.hypot(dx, dy) * .06);
  }
  let slope = y / Math.max(.001, x);
  if (horizontal || flat || (positiveY && negativeY)) slope = 0;
  else if (positiveY) slope = Math.max(0, slope);
  else if (negativeY) slope = Math.min(0, slope);
  slope = Math.max(-5, Math.min(5, slope));
  const length = Math.hypot(1, slope), axis = { x: 1 / length, y: slope / length };
  for (const { other } of neighbours) if (Math.abs(axis.y) > .000001) reach = Math.min(reach, Math.abs((other.y - centre.y) / axis.y) * .1);
  return { axis, lead: Math.max(0, reach) };
}
