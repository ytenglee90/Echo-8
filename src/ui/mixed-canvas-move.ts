import type { ViewClient } from '../core/contracts.ts';
import type { ConnectionGraphSnapshot } from '../protocols/connections.ts';
import type { NodePosition } from '../protocols/content.ts';
import type { EntityMovePosition } from '../protocols/selection.ts';

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
