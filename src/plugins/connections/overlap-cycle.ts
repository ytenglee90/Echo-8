/** Click-only state. Stable IDs order coincident objects independently of paint order. */
export class OverlapCycle {
  private last?: { x: number; y: number; signature: string; id: string };
  next(ids: readonly string[], x: number, y: number, signature: string, first = ids[0]): string | undefined {
    if (!ids.length) return undefined;
    const last = this.last;
    if (!last || last.signature !== signature || Math.hypot(x - last.x, y - last.y) > 6) return first;
    return ids[(ids.indexOf(last.id) + 1) % ids.length];
  }
  commit(id: string, x: number, y: number, signature: string) { this.last = { id, x, y, signature }; }
  reset() { this.last = undefined; }
}
