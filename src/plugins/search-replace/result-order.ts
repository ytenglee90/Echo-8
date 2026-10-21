import type { EditorContextSnapshot } from '../../protocols/editor.ts';
import type { SearchHit } from '../../protocols/search.ts';

export interface SearchNodeResult {
  nodeId: string;
  title: string;
  hits: SearchHit[];
}

export function groupHitsByNode(
  hits: SearchHit[],
  editorContext: EditorContextSnapshot,
): SearchNodeResult[] {
  const byNode = new Map<string, SearchNodeResult>();
  for (const hit of hits) {
    const existing = byNode.get(hit.nodeId);
    if (existing) {
      existing.hits.push(hit);
    } else {
      byNode.set(hit.nodeId, { nodeId: hit.nodeId, title: hit.title, hits: [hit] });
    }
  }
  const resultOrder = new Map([...byNode.keys()].map((id, index) => [id, index]));
  const openOrder = new Map(editorContext.openPanes.map((id, index) => [id, index]));
  return [...byNode.values()].sort((left, right) => {
    const leftPriority = left.nodeId === editorContext.activePane
      ? -1
      : openOrder.has(left.nodeId) ? openOrder.get(left.nodeId)! : Number.MAX_SAFE_INTEGER;
    const rightPriority = right.nodeId === editorContext.activePane
      ? -1
      : openOrder.has(right.nodeId) ? openOrder.get(right.nodeId)! : Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority || resultOrder.get(left.nodeId)! - resultOrder.get(right.nodeId)!;
  });
}
