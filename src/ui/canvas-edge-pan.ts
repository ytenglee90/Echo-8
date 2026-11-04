/** Screen-space edge speed, shared by lasso and object drags. */
export function edgePanVelocity(position: number, size: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(size) || size <= 0) return 0;
  const zone = Math.min(52, size / 2);
  if (position < zone) return -18 * Math.min(1, (zone - Math.max(0, position)) / zone);
  if (position > size - zone) return 18 * Math.min(1, (Math.min(size, position) - size + zone) / zone);
  return 0;
}
