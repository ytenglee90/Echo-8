export interface SpatialBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface IndexedItem<T> {
  item: T;
  bounds: SpatialBounds;
}

/** A rebuildable uniform-grid index for viewport queries and hit-test candidates. */
export class SpatialHashIndex<T> {
  private readonly cells = new Map<string, Set<string>>();
  private readonly items = new Map<string, IndexedItem<T>>();
  private readonly cellSize: number;

  constructor(cellSize = 640) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('Spatial index cell size must be positive');
    this.cellSize = cellSize;
  }

  rebuild(items: readonly T[], idOf: (item: T) => string, boundsOf: (item: T) => SpatialBounds): void {
    this.clear();
    for (const item of items) this.set(idOf(item), item, boundsOf(item));
  }

  set(id: string, item: T, bounds: SpatialBounds): void {
    this.delete(id);
    const normalized = normalizeBounds(bounds);
    this.items.set(id, { item, bounds: normalized });
    for (const key of cellKeys(normalized, this.cellSize)) {
      const members = this.cells.get(key) ?? new Set<string>();
      members.add(id);
      this.cells.set(key, members);
    }
  }

  delete(id: string): void {
    const existing = this.items.get(id);
    if (!existing) return;
    for (const key of cellKeys(existing.bounds, this.cellSize)) {
      const members = this.cells.get(key);
      members?.delete(id);
      if (members?.size === 0) this.cells.delete(key);
    }
    this.items.delete(id);
  }

  query(bounds: SpatialBounds): T[] {
    const normalized = normalizeBounds(bounds);
    const candidates = new Set<string>();
    for (const key of cellKeys(normalized, this.cellSize)) {
      for (const id of this.cells.get(key) ?? []) candidates.add(id);
    }
    const result: T[] = [];
    for (const id of candidates) {
      const entry = this.items.get(id);
      if (entry && intersects(normalized, entry.bounds)) result.push(entry.item);
    }
    return result;
  }

  get(id: string): T | undefined {
    return this.items.get(id)?.item;
  }

  clear(): void {
    this.cells.clear();
    this.items.clear();
  }
}

function cellKeys(bounds: SpatialBounds, cellSize: number): string[] {
  const left = Math.floor(bounds.x / cellSize);
  const right = Math.floor((bounds.x + Math.max(0, bounds.width)) / cellSize);
  const top = Math.floor(bounds.y / cellSize);
  const bottom = Math.floor((bounds.y + Math.max(0, bounds.height)) / cellSize);
  const keys: string[] = [];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) keys.push(`${x}:${y}`);
  }
  return keys;
}

function normalizeBounds(bounds: SpatialBounds): SpatialBounds {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    throw new Error('Spatial bounds must be finite');
  }
  return {
    x: bounds.width < 0 ? bounds.x + bounds.width : bounds.x,
    y: bounds.height < 0 ? bounds.y + bounds.height : bounds.y,
    width: Math.abs(bounds.width),
    height: Math.abs(bounds.height),
  };
}

function intersects(left: SpatialBounds, right: SpatialBounds): boolean {
  return left.x <= right.x + right.width && left.x + left.width >= right.x &&
    left.y <= right.y + right.height && left.y + left.height >= right.y;
}
