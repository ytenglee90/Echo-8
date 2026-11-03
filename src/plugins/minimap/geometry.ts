import type { WorldBounds } from '../../protocols/viewport.ts';

export const MAP_WIDTH = 240;
export const MAP_HEIGHT = 160;
export interface MapProjection { x: number; y: number; scale: number }

/** Content-only bounds keep navigation stable while the camera moves. No text is inspected. */
export function mapProjection(rectangles: readonly WorldBounds[]): MapProjection {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const rect of rectangles) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
    left = Math.min(left, rect.x); top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height);
  }
  const cx = Number.isFinite(left) ? left / 2 + right / 2 : 0;
  const cy = Number.isFinite(top) ? top / 2 + bottom / 2 : 0;
  const width = Math.max(1200, right - left || 0), height = Math.max(800, bottom - top || 0);
  const scale = Math.min((MAP_WIDTH - 32) / width, (MAP_HEIGHT - 32) / height);
  return { x: MAP_WIDTH / 2 - cx * scale, y: MAP_HEIGHT / 2 - cy * scale, scale };
}

export function mapPoint(projection: MapProjection, point: { x: number; y: number }) {
  return { x: (point.x - projection.x) / projection.scale, y: (point.y - projection.y) / projection.scale };
}
