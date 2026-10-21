import type { CameraState } from '../protocols/canvas.ts';

const MIN_RENDER_ZOOM = 0.1;

/**
 * Keeps secondary canvas details legible without making them dominate the
 * overview. Below 100%, the screen size follows the square root of the camera
 * zoom (40% canvas zoom becomes about 63% detail size). At and above 100%, the
 * detail size stays capped at its normal CSS-pixel size.
 */
export function canvasDetailScreenScale(zoom: number): number {
  const safeZoom = normalizeCanvasZoom(zoom);
  return safeZoom < 1 ? Math.sqrt(safeZoom) : 1;
}

/** Converts the desired screen-detail scale into the world transform scale. */
export function canvasDetailWorldScale(zoom: number): number {
  const safeZoom = normalizeCanvasZoom(zoom);
  return canvasDetailScreenScale(safeZoom) / safeZoom;
}

/** Places a fixed-size overlay at the screen position of a world-space point. */
export function worldPointToCanvasScreen(
  camera: CameraState,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: camera.x + point.x * camera.zoom,
    y: camera.y + point.y * camera.zoom,
  };
}

function normalizeCanvasZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(MIN_RENDER_ZOOM, zoom) : 1;
}
