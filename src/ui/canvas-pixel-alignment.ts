export interface CanvasRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasRenderCamera {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Aligns the rendered edges of a world-space rectangle to physical pixels.
 * The returned rectangle is presentation-only; callers must keep durable
 * geometry, hit-testing and history in the original world coordinates.
 */
export function alignCanvasRectToDevicePixels(
  rect: CanvasRenderRect,
  camera: CanvasRenderCamera,
  pixelRatio = globalThis.devicePixelRatio || 1,
): CanvasRenderRect {
  if (!Number.isFinite(camera.zoom) || camera.zoom <= 0) return rect;
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const snap = (value: number) => Math.round(value * ratio) / ratio;
  const left = snap(camera.x + rect.x * camera.zoom);
  const top = snap(camera.y + rect.y * camera.zoom);
  const right = snap(camera.x + (rect.x + rect.width) * camera.zoom);
  const bottom = snap(camera.y + (rect.y + rect.height) * camera.zoom);
  return {
    x: (left - camera.x) / camera.zoom,
    y: (top - camera.y) / camera.zoom,
    width: Math.max(0, (right - left) / camera.zoom),
    height: Math.max(0, (bottom - top) / camera.zoom),
  };
}
