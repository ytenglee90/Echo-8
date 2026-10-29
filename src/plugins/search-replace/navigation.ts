import type { SearchHit, SearchNavigationSignal } from '../../protocols/search.ts';

export interface SearchNavigationTarget {
  hit: SearchHit;
  state: SearchNavigationSignal;
}

export function resolveSearchNavigation(
  allHits: readonly SearchHit[],
  selectedNodeIds: readonly string[] | undefined,
  current: SearchNavigationSignal | undefined,
  direction: -1 | 1,
): SearchNavigationTarget | undefined {
  const selected = selectedNodeIds?.length ? new Set(selectedNodeIds) : undefined;
  const hits = selected ? allHits.filter((hit) => selected.has(hit.nodeId)) : [...allHits];
  if (hits.length === 0) return undefined;
  const currentIndex = current?.total === hits.length &&
    current.scope === (selected ? 'selection' : 'canvas') &&
    current.scopeNodeCount === (selected?.size ?? 0) &&
    hits[current.index]?.nodeId === current.nodeId
    ? current.index
    : -1;
  const index = currentIndex < 0
    ? direction > 0 ? 0 : hits.length - 1
    : (currentIndex + direction + hits.length) % hits.length;
  return {
    hit: hits[index],
    state: {
      nodeId: hits[index].nodeId,
      index,
      total: hits.length,
      scope: selected ? 'selection' : 'canvas',
      scopeNodeCount: selected?.size ?? 0,
    },
  };
}
