export interface FloatingPanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeFloatingRect(
  value: unknown,
  fallback: FloatingPanelRect,
): FloatingPanelRect {
  if (!value || typeof value !== 'object') return { ...fallback };
  const candidate = value as Partial<FloatingPanelRect>;
  if (![candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite)) return { ...fallback };
  return {
    x: clamp(candidate.x!, 8, 10_000),
    y: clamp(candidate.y!, 56, 10_000),
    width: clamp(candidate.width!, 320, 1_200),
    height: clamp(candidate.height!, 320, 1_200),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
