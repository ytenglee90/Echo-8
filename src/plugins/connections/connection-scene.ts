import { connectionJunctionDragRequest, isTitleConnection, type ConnectionDraft, type ConnectionNodeGeometry, type ConnectionRecord } from '../../protocols/connections.ts';
import { connectionGraphPoints, type ConnectionPoints } from './routing.ts';
import { curveBendAtEndpoints } from './curve-bend.ts';

export interface ConnectionScene { points: Map<string, ConnectionPoints>; draft?: { record: ConnectionRecord; points: ConnectionPoints } }

/** One owner projection for new, free and reconnect previews. The input adapter still owns the gesture. */
export function planConnectionScene(records: readonly ConnectionRecord[], nodes: ReadonlyMap<string, ConnectionNodeGeometry>, draft: ConnectionDraft, baseline = connectionGraphPoints(records, nodes)): ConnectionScene {
  const original = () => ({ points: baseline });
  if (!draft.from || (!draft.to && !draft.pointer)) return original();
  const fromNode = nodes.get(draft.from.nodeId); if (!fromNode) return original();
  const to = draft.to ?? { nodeId: '__connection-pointer__', side: 'left' as const };
  const toNode = draft.to ? nodes.get(to.nodeId) : { id: to.nodeId, ...draft.pointer!, width: 0, height: 0, presentation: 'text-box' as const };
  if (!toNode) return original();
  const titleOrigin = draft.titleStartSide ? { side: draft.titleStartSide,
    sourceIsLeft: fromNode.x + fromNode.width / 2 <= toNode.x + toNode.width / 2,
    sourceCenterX: fromNode.x + fromNode.width / 2, targetCenterX: toNode.x + toNode.width / 2 } : draft.titleOrigin;
  const record: ConnectionRecord = { id: draft.reconnectId ?? '__connection-draft__', from: draft.from, to, titleRoute: draft.titleRoute,
    titleOrigin, labelWidth: 0, labelHeight: 0, revision: 0, createdAt: 0 };
  const previous = draft.reconnectId ? records.find(edge => edge.id === draft.reconnectId) : undefined;
  if (previous) record.curveBend = curveBendAtEndpoints([previous], record.from, record.to);
  const candidate = draft.reconnectId ? record : connectionJunctionDragRequest(record, fromNode, toNode, draft.pointer);
  const duplicate = !draft.reconnectId && records.find(edge => edge.from.nodeId === candidate.from.nodeId && edge.to.nodeId === candidate.to.nodeId &&
    edge.from.kind === candidate.from.kind && edge.to.kind === candidate.to.kind && isTitleConnection(edge) === isTitleConnection(candidate));
  if (duplicate) candidate.id = duplicate.id;
  const projection = draft.to ? nodes : new Map([[fromNode.id, fromNode], [to.nodeId, toNode]]);
  const points = draft.to ? connectionGraphPoints([...records.filter(edge => edge.id !== candidate.id), candidate], projection) : baseline;
  const preview = draft.to ? points.get(candidate.id) : connectionGraphPoints([candidate], projection).get(candidate.id);
  return preview ? { points, draft: { record: candidate, points: preview } } : { points };
}

/** Component-owned, bounded cache: free pointer movement never replans the unchanged document graph. */
export function createConnectionScenePlanner() {
  let previousRecords: readonly ConnectionRecord[] | undefined, previousNodes: ReadonlyMap<string, ConnectionNodeGeometry> | undefined;
  let baseline: Map<string, ConnectionPoints>, attachedKey: string | undefined, attached: ConnectionScene | undefined;
  return (records: readonly ConnectionRecord[], nodes: ReadonlyMap<string, ConnectionNodeGeometry>, draft: ConnectionDraft): ConnectionScene => {
    if (records !== previousRecords || nodes !== previousNodes) {
      previousRecords = records; previousNodes = nodes; baseline = connectionGraphPoints(records, nodes); attachedKey = undefined; attached = undefined;
    }
    const start = draft.from ? nodes.get(draft.from.nodeId) : undefined;
    const key = draft.to ? JSON.stringify([draft.from, draft.to, draft.titleRoute, draft.titleStartSide, draft.titleOrigin, draft.reconnectId,
      start?.kind === 'junction' && draft.pointer ? draft.pointer.x < start.x : undefined]) : undefined;
    if (key && key === attachedKey && attached) return attached;
    const scene = planConnectionScene(records, nodes, draft, baseline!);
    if (key) { attachedKey = key; attached = scene; }
    return scene;
  };
}
