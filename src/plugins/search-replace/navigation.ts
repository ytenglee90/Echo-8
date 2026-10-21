import type { SearchHit, SearchNavigationSignal } from '../../protocols/search.ts';

export interface SearchNavigationTarget {
  hit: SearchHit;
  state: SearchNavigationSignal;
}

export function resolveSearchNavigation(
  allHits: readonly SearchHit[],
  activeNodeId: string,
  current: SearchNavigationSignal | undefined,
  direction: -1 | 1,
): SearchNavigationTarget | undefined {
  const hits = allHits
    .filter((hit) => hit.nodeId === activeNodeId)
    .sort((left, right) => left.start - right.start || left.length - right.length);
  if (hits.length === 0) return undefined;
  const currentIndex = current?.nodeId === activeNodeId && current.total === hits.length
    ? current.index
    : -1;
  const index = currentIndex < 0
    ? direction > 0 ? 0 : hits.length - 1
    : (currentIndex + direction + hits.length) % hits.length;
  return {
    hit: hits[index],
    state: { nodeId: activeNodeId, index, total: hits.length },
  };
}
