import type { SelectableEntity } from '../../protocols/selection.ts';
import { SpatialHashIndex, type SpatialBounds } from '../../services/spatial-index.ts';

export interface SelectionCatalogUpdateStats {
  added: number;
  updated: number;
  removed: number;
  indexed: number;
}

/** Rebuildable selection metadata with an incrementally maintained geometry index. */
export class SelectionCatalogIndex {
  private readonly entities = new Map<string, SelectableEntity>();
  private readonly spatial = new SpatialHashIndex<string>();

  get size(): number {
    return this.entities.size;
  }

  get(id: string): SelectableEntity | undefined {
    return this.entities.get(id);
  }

  values(): SelectableEntity[] {
    return [...this.entities.values()];
  }

  clear(): void {
    this.entities.clear();
    this.spatial.clear();
  }

  replace(nextEntities: readonly SelectableEntity[]): SelectionCatalogUpdateStats {
    const next = new Map<string, SelectableEntity>();
    for (const entity of nextEntities) {
      if (!next.has(entity.id)) next.set(entity.id, entity);
    }

    const stats: SelectionCatalogUpdateStats = { added: 0, updated: 0, removed: 0, indexed: 0 };
    for (const id of this.entities.keys()) {
      if (next.has(id)) continue;
      this.entities.delete(id);
      this.spatial.delete(id);
      stats.removed += 1;
      stats.indexed += 1;
    }

    for (const [id, entity] of next) {
      const previous = this.entities.get(id);
      if (!previous) stats.added += 1;
      else if (!sameSelectableEntity(previous, entity)) stats.updated += 1;

      this.entities.set(id, entity);
      if (previous && sameIndexedGeometry(previous, entity)) continue;
      this.spatial.delete(id);
      const bounds = selectionIndexBounds(entity);
      if (bounds) this.spatial.set(id, id, bounds);
      stats.indexed += 1;
    }
    return stats;
  }

  query(bounds: SpatialBounds): SelectableEntity[] {
    return this.spatial.query(bounds).flatMap((id) => {
      const entity = this.entities.get(id);
      return entity ? [entity] : [];
    });
  }
}

export function selectionIndexBounds(entity: SelectableEntity): SpatialBounds | undefined {
  if (entity.bounds) return entity.bounds;
  const regions = entity.boxRegions;
  if (!regions?.length) return undefined;
  const left = Math.min(...regions.map((region) => Math.min(region.x, region.x + region.width)));
  const top = Math.min(...regions.map((region) => Math.min(region.y, region.y + region.height)));
  const right = Math.max(...regions.map((region) => Math.max(region.x, region.x + region.width)));
  const bottom = Math.max(...regions.map((region) => Math.max(region.y, region.y + region.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function sameIndexedGeometry(left: SelectableEntity, right: SelectableEntity): boolean {
  if (left.geometryRevision !== undefined || right.geometryRevision !== undefined) {
    return left.geometryRevision === right.geometryRevision &&
      sameBounds(selectionIndexBounds(left), selectionIndexBounds(right));
  }
  return sameBounds(selectionIndexBounds(left), selectionIndexBounds(right));
}

function sameSelectableEntity(left: SelectableEntity, right: SelectableEntity): boolean {
  return left.kind === right.kind && left.part === right.part &&
    left.geometryRevision === right.geometryRevision &&
    left.boxMatch === right.boxMatch && left.includeInSelectAll === right.includeInSelectAll &&
    sameBounds(left.bounds, right.bounds) &&
    sameStringArray(left.contains, right.contains) &&
    sameStringArray(left.parts, right.parts) &&
    sameBoundsArray(left.boxRegions, right.boxRegions);
}

function sameBounds(left?: SpatialBounds, right?: SpatialBounds): boolean {
  if (!left || !right) return left === right;
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function sameBoundsArray(left?: SpatialBounds[], right?: SpatialBounds[]): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((bounds, index) => sameBounds(bounds, right[index]));
}

function sameStringArray(left?: string[], right?: string[]): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
