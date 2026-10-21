import type { CameraState, CanvasViewportCenter } from './canvas.ts';

export interface WorldBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export function worldViewport(
  camera: CameraState,
  surface: ViewportSize,
  margin: number,
): WorldBounds {
  const left = (-camera.x - margin) / camera.zoom;
  const top = (-camera.y - margin) / camera.zoom;
  const right = (surface.width - camera.x + margin) / camera.zoom;
  const bottom = (surface.height - camera.y + margin) / camera.zoom;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function viewportCenterInWorld(
  camera: CameraState,
  surface: ViewportSize,
): CanvasViewportCenter {
  return {
    x: (surface.width / 2 - camera.x) / camera.zoom,
    y: (surface.height / 2 - camera.y) / camera.zoom,
  };
}

export function clientPointInWorld(
  camera: CameraState,
  surface: { left: number; top: number },
  client: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: (client.x - surface.left - camera.x) / camera.zoom,
    y: (client.y - surface.top - camera.y) / camera.zoom,
  };
}

export function boundsIntersect(left: WorldBounds, right: WorldBounds): boolean {
  return left.x <= right.x + right.width && left.x + left.width >= right.x &&
    left.y <= right.y + right.height && left.y + left.height >= right.y;
}
