import { isTitleConnection, type ConnectionGraphSnapshot, type ConnectionNodeGeometry } from '../../protocols/connections.ts';
import { logicalConnectionPaths } from './junctions.ts';

export function connectionToolbarSelection(ids: readonly string[], graph: ConnectionGraphSnapshot, endpoints: readonly ConnectionNodeGeometry[]) {
  const selected = new Set(ids);
  const edges = graph.connections.filter(edge => selected.has(edge.id));
  const points = graph.junctions.filter(point => selected.has(point.id));
  const nodes = endpoints.filter(node => selected.has(node.id));
  const hasEdges = edges.length > 0;
  const onlyPoints = points.length > 0 && points.length === selected.size;
  const onlyNodes = nodes.length > 0 && nodes.length === selected.size;
  const pair = onlyNodes && nodes.length === 2;
  const candidates = pair && !points.length ? logicalConnectionPaths(graph.connections).map(item => item.record) : graph.connections;
  const attached = candidates.filter(edge => nodes.length === 1
    ? selected.has(edge.from.nodeId) || selected.has(edge.to.nodeId)
    : selected.has(edge.from.nodeId) && selected.has(edge.to.nodeId));
  const bodyRemoves = (hasEdges ? edges : attached).some(edge => !isTitleConnection(edge));
  const titleRemoves = (hasEdges ? edges : attached).some(isTitleConnection);
  const pointIds = new Set(points.map(point => point.id));
  const inheritedTitle = graph.connections.some(edge => isTitleConnection(edge) && (pointIds.has(edge.from.nodeId) || pointIds.has(edge.to.nodeId)));
  const body = hasEdges ? bodyRemoves : onlyNodes && (pair && (!inheritedTitle || bodyRemoves) || nodes.length === 1 && bodyRemoves);
  const title = hasEdges ? titleRemoves : onlyNodes && (pair && nodes.every(node => node.kind !== 'group') && points.length < 2 || nodes.length === 1 && titleRemoves);
  const junction = onlyPoints || hasEdges && edges.length <= 10_000;
  const primary = onlyPoints ? 'junction' as const : hasEdges ? 'disconnect' as const : title && !body ? 'title' as const : 'body' as const;
  return { body, title, junction, bodyRemoves, titleRemoves, removesJunction: onlyPoints, primary, ready: primary === 'junction' ? junction : primary === 'disconnect' ? true : primary === 'title' ? title : body };
}
