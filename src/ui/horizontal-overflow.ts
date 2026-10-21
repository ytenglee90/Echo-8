export interface HorizontalOverflowTarget {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}

export interface WheelDelta {
  deltaX: number;
  deltaY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * Converts a wheel gesture over a horizontally overflowing control strip into
 * a bounded horizontal scroll. Browser/page zoom gestures remain untouched.
 */
export function scrollHorizontalOverflow(
  target: HorizontalOverflowTarget,
  wheel: WheelDelta,
): boolean {
  if (wheel.ctrlKey || wheel.metaKey) return false;
  const maximum = Math.max(0, target.scrollWidth - target.clientWidth);
  if (maximum <= 1) return false;
  const delta = Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY)
    ? wheel.deltaX
    : wheel.deltaY;
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return false;
  const next = Math.min(maximum, Math.max(0, target.scrollLeft + delta));
  if (Math.abs(next - target.scrollLeft) < 0.01) return false;
  target.scrollLeft = next;
  return true;
}
