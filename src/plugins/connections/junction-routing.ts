import type { RoutePoint } from './route-geometry.ts';

export interface JunctionNeighbour { point: RoutePoint; other: RoutePoint; angle: number; horizontalOnly?: boolean; manualSafe?: boolean }
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
  const base = Math.atan2(y, Math.max(.001, x)), preference = base + neighbours[0].angle * Math.PI / 180;
  // A line has two halves. Projection keeps manual preference in the physical forward cone.
  let slope = Math.sin(preference) / Math.max(.05, Math.abs(Math.cos(preference)));
  if (Math.cos(preference) < 0) slope = -slope;
  if (horizontal) slope = 0;
  else if (flat || (positiveY && negativeY)) slope = neighbours[0].angle % 180 === 0 || neighbours.some(neighbour => neighbour.manualSafe === false)
    ? 0 : Math.max(-1, Math.min(1, slope));
  else if (positiveY) slope = Math.max(0, slope);
  else if (negativeY) slope = Math.min(0, slope);
  slope = Math.max(-5, Math.min(5, slope));
  const length = Math.hypot(1, slope), axis = { x: 1 / length, y: slope / length };
  for (const { other } of neighbours) if (Math.abs(axis.y) > .000001) reach = Math.min(reach, Math.abs((other.y - centre.y) / axis.y) * .1);
  return { axis, lead: Math.max(0, reach) };
}
