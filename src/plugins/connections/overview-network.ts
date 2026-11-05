import type { ConnectionRecord } from '../../protocols/connections.ts';

/** Follow physical junctions, stopping at every ordinary node/group endpoint. */
export function overviewNetwork(anchors: readonly string[], byNode: ReadonlyMap<string, ReadonlySet<string>>, byId: ReadonlyMap<string, ConnectionRecord>) {
  const nodes = new Set(anchors), points = new Set<string>(), edges = new Set<string>(), queue = [...nodes];
  for (let index = 0; index < queue.length; index++) for (const id of byNode.get(queue[index]) ?? []) {
    const edge = byId.get(id); if (!edge) continue;
    edges.add(id);
    for (const endpoint of [edge.from, edge.to]) if (endpoint.kind === 'junction') {
      points.add(endpoint.nodeId);
      if (!nodes.has(endpoint.nodeId)) { nodes.add(endpoint.nodeId); queue.push(endpoint.nodeId); }
    }
  }
  return { nodes, points, edges };
}
