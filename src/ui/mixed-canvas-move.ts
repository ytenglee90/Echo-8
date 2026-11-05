import type { ViewClient } from '../core/contracts.ts';
import type { ConnectionGraphSnapshot } from '../protocols/connections.ts';
import type { NodePosition } from '../protocols/content.ts';
import type { EntityMovePosition } from '../protocols/selection.ts';
import type { SmartSnapRequest, SmartSnapResult } from '../protocols/layout.ts';

/** Explicit selection only: related routing points never join by graph adjacency. */
export function selectedJunctionOrigins(client: ViewClient, ids: ReadonlySet<string>): EntityMovePosition[] {
  try {
    return client.requestSync<ConnectionGraphSnapshot>('connections.graph@1').junctions.filter(point => ids.has(point.id))
      .map(point => ({ id: point.id, x: point.x, y: point.y, expectedRevision: point.revision }));
  } catch { return []; }
}
export function includesJunctionMoves(positions: NodePosition[]): boolean {
  return positions.some(position => 'expectedRevision' in position);
}
export function moveCanvasEntities(client: ViewClient, positions: NodePosition[]) {
  if (!includesJunctionMoves(positions)) return client.dispatch('node.moveMany', { positions });
  // Close this gesture before queued commits, so a following drag cannot overtake its end.
  return client.dispatch('interaction.end', { mode: 'dragging-node' }).then(() => client.dispatch('selection.moveEntities', { positions }));
}

/** Nodes and groups share the same governed snap preview and position adjustment. */
export function snapCanvasPositions(client: ViewClient, positions: NodePosition[], request: SmartSnapRequest): NodePosition[] {
  let snap: SmartSnapResult;
  try { snap = client.requestSync<SmartSnapResult>('layout.snap@1', request); }
  catch { client.emit('canvas.snap.preview', { clear: true }); return positions; }
  client.emit('canvas.snap.preview', snap.guides.length ? { guides: snap.guides } : { clear: true });
  if (snap.offsetX === 0 && snap.offsetY === 0) return positions;
  return positions.map(position => ({ ...position, x: position.x + snap.offsetX, y: position.y + snap.offsetY }));
}
