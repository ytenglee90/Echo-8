export function resizePaneWidths(
  widths: readonly number[],
  dividerIndex: number,
  delta: number,
  requestedMinimum: number,
): number[] {
  if (
    widths.length < 2 ||
    dividerIndex < 0 ||
    dividerIndex >= widths.length - 1 ||
    !Number.isFinite(delta)
  ) return [...widths];

  const normalized = widths.map((width) => Math.max(0, Number.isFinite(width) ? width : 0));
  const totalWidth = normalized.reduce((sum, width) => sum + width, 0);
  if (totalWidth <= 0) return [...normalized];
  const minimum = Math.max(0, Math.min(requestedMinimum, totalWidth / normalized.length));
  const next = [...normalized];

  if (delta < 0) {
    let remaining = Math.min(
      -delta,
      next.slice(0, dividerIndex + 1).reduce((sum, width) => sum + Math.max(0, width - minimum), 0),
    );
    const transferred = remaining;
    for (let index = dividerIndex; index >= 0 && remaining > 0; index -= 1) {
      const consumed = Math.min(remaining, Math.max(0, next[index] - minimum));
      next[index] -= consumed;
      remaining -= consumed;
    }
    next[dividerIndex + 1] += transferred - remaining;
  } else if (delta > 0) {
    let remaining = Math.min(
      delta,
      next.slice(dividerIndex + 1).reduce((sum, width) => sum + Math.max(0, width - minimum), 0),
    );
    const transferred = remaining;
    for (let index = dividerIndex + 1; index < next.length && remaining > 0; index += 1) {
      const consumed = Math.min(remaining, Math.max(0, next[index] - minimum));
      next[index] -= consumed;
      remaining -= consumed;
    }
    next[dividerIndex] += transferred - remaining;
  }

  return next;
}

export function resizePaneLayout(
  widths: readonly number[],
  dividerIndex: number,
  delta: number,
  requestedMinimum: number,
  dockWidth: number,
  maximumDockWidth: number,
): { widths: number[]; dockWidth: number } {
  const nextWidths = resizePaneWidths(widths, dividerIndex, delta, requestedMinimum);
  let nextDockWidth = dockWidth;

  if (delta < 0 && dividerIndex + 1 < widths.length) {
    const transferred = Math.max(0, (nextWidths[dividerIndex + 1] ?? 0) - (widths[dividerIndex + 1] ?? 0));
    const remaining = Math.max(0, -delta - transferred);
    const expansion = Math.min(
      remaining,
      Math.max(0, maximumDockWidth - dockWidth),
    );
    if (expansion > 0) {
      nextWidths[dividerIndex + 1] = (nextWidths[dividerIndex + 1] ?? 0) + expansion;
      nextDockWidth += expansion;
    }
  }

  return { widths: nextWidths, dockWidth: nextDockWidth };
}
