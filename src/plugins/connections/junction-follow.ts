import type { ConnectionJunction, ConnectionNodeGeometry, ConnectionRecord } from '../../protocols/connections.ts';

/** Each connected routing component follows the mean displacement of its unique real endpoints. */
export function junctionFollowPositions(records: readonly ConnectionRecord[], junctions: readonly ConnectionJunction[],
  before: ReadonlyMap<string, ConnectionNodeGeometry>, after: ReadonlyMap<string, ConnectionNodeGeometry>) {
  if (!junctions.length) return [];
  const neighbors = new Map(junctions.map(point => [point.id, new Set<string>()]));
  const terminals = new Map(junctions.map(point => [point.id, new Set<string>()]));
  for (const edge of records) {
    if (edge.from.kind === 'junction' && edge.to.kind === 'junction') {
      neighbors.get(edge.from.nodeId)?.add(edge.to.nodeId); neighbors.get(edge.to.nodeId)?.add(edge.from.nodeId);
    } else if (edge.from.kind === 'junction') terminals.get(edge.from.nodeId)?.add(edge.to.nodeId);
    else if (edge.to.kind === 'junction') terminals.get(edge.to.nodeId)?.add(edge.from.nodeId);
  }
  const seen = new Set<string>(), byId = new Map(junctions.map(point => [point.id, point]));
  const result: Array<{ id: string; x: number; y: number }> = [];
  for (const point of junctions) {
    if (seen.has(point.id)) continue;
    const component = [point.id], boundary = new Set<string>(); seen.add(point.id);
    for (let index = 0; index < component.length; index += 1) {
      for (const id of terminals.get(component[index]) ?? []) boundary.add(id);
      for (const id of neighbors.get(component[index]) ?? []) if (!seen.has(id) && byId.has(id)) { seen.add(id); component.push(id); }
    }
    let dx = 0, dy = 0, count = 0;
    for (const id of boundary) {
      const a = before.get(id), b = after.get(id); if (!a || !b) continue;
      dx += b.x + b.width / 2 - a.x - a.width / 2; dy += b.y + b.height / 2 - a.y - a.height / 2; count += 1;
    }
    if (!count || (dx === 0 && dy === 0)) continue;
    for (const id of component) { const origin = byId.get(id)!; result.push({ id, x: origin.x + dx / count, y: origin.y + dy / count }); }
  }
  return result;
}
