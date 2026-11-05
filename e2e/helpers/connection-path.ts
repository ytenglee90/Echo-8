/** End anchors and terminal handles are invariant under subdivision into multiple cubic spans. */
export function connectionTerminals(path: string): number[] {
  const numbers = path.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  if (numbers.length < 8 || (numbers.length - 2) % 6 !== 0) throw new Error('Expected a cubic connection path');
  return [...numbers.slice(0, 4), ...numbers.slice(-4)];
}
