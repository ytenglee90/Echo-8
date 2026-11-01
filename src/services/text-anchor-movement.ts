/**
 * Moves a character-owned anchor with a relocated half-open text range.
 * Anchors in (start, end] travel with the moved characters; surrounding
 * anchors shift only when the removed or inserted range crosses them.
 */
export function moveTextAnchor(
  offset: number,
  start: number,
  end: number,
  target: number,
): number {
  const length = end - start;
  if (target < start) {
    if (offset > start && offset <= end) return target + offset - start;
    if (offset > target && offset <= start) return offset + length;
    return offset;
  }
  const destination = target - length;
  if (offset > start && offset <= end) return destination + offset - start;
  if (offset > end && offset <= target) return offset - length;
  return offset;
}
