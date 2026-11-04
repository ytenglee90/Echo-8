import { createId, isRecord, type PatchOperation } from '../../core/contracts.ts';
import type {
  ConnectionAddJunctionRequest,
  ConnectionEndpoint,
  ConnectionJunction,
  ConnectionMoveJunctionRequest,
  ConnectionNodeGeometry,
  ConnectionRecord,
} from '../../protocols/connections.ts';
import { isTitleConnection } from '../../protocols/connections.ts';

export const JUNCTION_NAMESPACE = 'connectionJunction';
const CONNECTION_NAMESPACE = 'connections';
const MAX_JUNCTION_BATCH = 10_000;
const MAX_RECONNECTED_EDGES = 20_000;

export function isJunction(value: unknown): value is ConnectionJunction {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Number.isInteger(value.revision) && Number(value.revision) > 0 &&
    (value.branchSide === undefined || value.branchSide === 'incoming' || value.branchSide === 'outgoing');
}

export function isAddJunctionRequest(value: unknown): value is ConnectionAddJunctionRequest {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Array.isArray(value.connections) && value.connections.length > 0 && value.connections.length <= MAX_JUNCTION_BATCH &&
    value.connections.every((item) => isRecord(item) && typeof item.id === 'string' &&
      Number.isInteger(item.revision) && Number(item.revision) > 0);
}

export function isMoveJunctionRequest(value: unknown): value is ConnectionMoveJunctionRequest {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Number.isInteger(value.expectedRevision) && Number(value.expectedRevision) > 0;
}

export function junctionGeometry(junction: ConnectionJunction): ConnectionNodeGeometry {
  return { id: junction.id, x: junction.x, y: junction.y, width: 0, height: 0 };
}

function sameEndpoint(left: ConnectionEndpoint, right: ConnectionEndpoint): boolean {
  return left.nodeId === right.nodeId && left.kind === right.kind;
}

/** Validate only edited components; legacy unrelated mixed graphs remain readable and removable. */
export function assertJunctionLineTypes(records: readonly ConnectionRecord[], touched?: ReadonlySet<string>): void {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    for (let current = id; parent.has(current) && parent.get(current) !== root;) {
      const next = parent.get(current)!; parent.set(current, root); current = next;
    }
    return root;
  };
  for (const edge of records) for (const endpoint of [edge.from, edge.to]) if (endpoint.kind === 'junction') parent.set(endpoint.nodeId, endpoint.nodeId);
  for (const edge of records) if (edge.from.kind === 'junction' && edge.to.kind === 'junction') parent.set(find(edge.to.nodeId), find(edge.from.nodeId));
  const roots = touched ? new Set([...touched].map(find)) : undefined;
  const types = new Map<string, boolean>();
  for (const edge of records) {
    const point = edge.from.kind === 'junction' ? edge.from : edge.to.kind === 'junction' ? edge.to : undefined;
    if (!point) continue;
    const root = find(point.nodeId);
    if (roots && !roots.has(root)) continue;
    const title = isTitleConnection(edge);
    if (types.has(root) && types.get(root) !== title) throw new Error('虚线与实线不能共用同一个中转点，请分别添加中转点');
    types.set(root, title);
  }
}

/** Check a proposed edge replacement without changing unrelated legacy components. */
export function assertJunctionChanges(before: readonly ConnectionRecord[], changed: readonly ConnectionRecord[]): void {
  const ids = new Set(changed.map(edge => edge.id));
  const touched = new Set<string>();
  for (const edge of [...before.filter(edge => ids.has(edge.id)), ...changed]) for (const endpoint of [edge.from, edge.to]) if (endpoint.kind === 'junction') touched.add(endpoint.nodeId);
  if (!touched.size) return;
  assertJunctionLineTypes([...before.filter(edge => !ids.has(edge.id)), ...changed], touched);
}

/** Keep each original identity/label on its branch and create exactly one common trunk. */
export function splitConnectionsAtJunction(
  records: ConnectionRecord[],
  point: { x: number; y: number },
): { junction: ConnectionJunction; connections: ConnectionRecord[] } {
  if (records.length === 0 || records.length > MAX_JUNCTION_BATCH) throw new Error('请先选中连接线');
  if (new Set(records.map(isTitleConnection)).size > 1) throw new Error('虚线与实线不能共用同一个中转点，请分别添加中转点');
  const commonTo = records.every((record) => sameEndpoint(record.to, records[0].to)) &&
    !(records.length === 1 && records[0].from.kind === 'junction' && records[0].to.kind !== 'junction');
  const commonFrom = records.every((record) => sameEndpoint(record.from, records[0].from));
  if (!commonTo && !commonFrom) throw new Error('只有输入到同一节点或从同一节点输出的连接线才能共用中转点');
  const junction: ConnectionJunction = {
    id: createId('junction'), x: point.x, y: point.y, revision: 1,
    branchSide: commonTo ? 'incoming' : 'outgoing',
  };
  const endpoint: ConnectionEndpoint = { nodeId: junction.id, kind: 'junction', side: commonTo ? 'left' : 'right' };
  const branches = records.map((record) => ({
    ...record,
    ...(isTitleConnection(record) ? { titleRoute: true } : {}),
    ...(commonTo ? { to: endpoint } : { from: endpoint }),
    revision: record.revision + 1,
  }));
  const first = records[0];
  const trunk: ConnectionRecord = {
    id: createId('connection'),
    from: commonTo ? { ...endpoint, side: 'right' } : first.from,
    to: commonTo ? first.to : { ...endpoint, side: 'left' },
    labelWidth: first.labelWidth,
    labelHeight: first.labelHeight,
    ...(first.lineColor ? { lineColor: first.lineColor } : {}),
    revision: 1,
    junctionTrunk: true,
    ...(records.some(isTitleConnection) ? { titleRoute: true } : {}),
    createdAt: Date.now(),
  };
  return { junction, connections: [...branches, trunk] };
}

/** Compatibility view: original node-to-node relationships, with their branch IDs. */
export function logicalConnectionPaths(records: ConnectionRecord[]): Array<{ record: ConnectionRecord; path: ConnectionRecord[] }> {
  const outgoing = new Map<string, ConnectionRecord[]>();
  for (const edge of records) {
    const list = outgoing.get(edge.from.nodeId) ?? [];
    list.push(edge);
    outgoing.set(edge.from.nodeId, list);
  }
  const result: Array<{ record: ConnectionRecord; path: ConnectionRecord[] }> = [];
  for (const first of records) {
    if (first.from.kind === 'junction') continue;
    interface Visit { edge: ConnectionRecord; parent?: Visit }
    const queue: Visit[] = [{ edge: first }];
    const seen = new Set<string>();
    for (let index = 0; index < queue.length; index += 1) {
      if (queue.length > MAX_RECONNECTED_EDGES || result.length > MAX_RECONNECTED_EDGES) throw new Error('连接图过于复杂，无法生成旧版连接视图');
      const visit = queue[index];
      const edge = visit.edge;
      if (edge.to.kind !== 'junction') {
        const path: ConnectionRecord[] = [];
        for (let cursor: Visit | undefined = visit; cursor; cursor = cursor.parent) path.push(cursor.edge);
        path.reverse();
        const branch = path.find((item) => !item.junctionTrunk) ?? first;
        result.push({ record: { ...branch, from: first.from, to: edge.to }, path });
      } else if (!seen.has(edge.to.nodeId)) {
        seen.add(edge.to.nodeId);
        for (const next of outgoing.get(edge.to.nodeId) ?? []) queue.push({ edge: next, parent: visit });
      }
    }
  }
  return result;
}

/** Deleting an edge removes only that edge; deleting a vertex bypasses its incident edges. */
export function planConnectionGraphDeletion(
  records: ConnectionRecord[],
  junctions: ConnectionJunction[],
  ids: ReadonlySet<string>,
): { patches: PatchOperation[]; removedIds: string[]; changedIds: string[] } {
  const pointIds = new Set(junctions.map((point) => point.id));
  const selectedPoints = junctions.filter((point) => ids.has(point.id));
  const deletedNodes = new Set([...ids].filter((id) => !pointIds.has(id)));
  let next = records.filter((record) => !ids.has(record.id) &&
    !deletedNodes.has(record.from.nodeId) && !deletedNodes.has(record.to.nodeId));
  for (const point of selectedPoints) {
    const incoming = next.filter((record) => record.to.kind === 'junction' && record.to.nodeId === point.id);
    const outgoing = next.filter((record) => record.from.kind === 'junction' && record.from.nodeId === point.id);
    next = next.filter((record) => record.from.nodeId !== point.id && record.to.nodeId !== point.id);
    if (incoming.length * outgoing.length + next.length > records.length + MAX_RECONNECTED_EDGES) {
      throw new Error('删除中转点将产生过多连接，请分批删除');
    }
    // With a shared output, original labels belong to outgoing branches. With
    // a shared input they belong to incoming branches. Preserve those IDs too.
    const useOutgoing = incoming.length === 1 && (point.branchSide === 'outgoing' || outgoing.length > 1);
    const primary = useOutgoing ? outgoing : incoming;
    const secondary = useOutgoing ? incoming : outgoing;
    for (const branch of primary) {
      for (const [index, trunk] of secondary.entries()) {
        const from = useOutgoing ? trunk.from : branch.from;
        const to = useOutgoing ? branch.to : trunk.to;
        if (sameEndpoint(from, to) || next.some((record) => isTitleConnection(record) === isTitleConnection(branch) && sameEndpoint(record.from, from) && sameEndpoint(record.to, to))) continue;
        const labelSource = branch.label || !trunk.label ? branch : trunk;
        next.push({
          ...labelSource,
          id: index === 0 ? branch.id : createId('connection'),
          from: { ...from },
          to: { ...to },
          revision: branch.revision + 1,
        });
      }
    }
  }
  const before = new Map(records.map((record) => [record.id, record]));
  const after = new Map(next.map((record) => [record.id, record]));
  const removedIds = records.filter((record) => !after.has(record.id)).map((record) => record.id);
  const changed = next.filter((record) => before.get(record.id) !== record);
  const patches: PatchOperation[] = [
    ...removedIds.map((id): PatchOperation => ({ op: 'delete', domain: 'document', namespace: CONNECTION_NAMESPACE, key: id, schemaOwner: 'connections' })),
    ...changed.map((record): PatchOperation => ({ op: 'set', domain: 'document', namespace: CONNECTION_NAMESPACE, key: record.id, value: record, schemaOwner: 'connections' })),
    ...selectedPoints.map((point): PatchOperation => ({ op: 'delete', domain: 'document', namespace: JUNCTION_NAMESPACE, key: point.id, schemaOwner: 'connections' })),
  ];
  return { patches, removedIds: [...removedIds, ...selectedPoints.map((point) => point.id)], changedIds: changed.map((record) => record.id) };
}

/** Copy only explicitly selected vertices; content selection never expands into a routed network. */
export function serializeConnectionGraph(
  records: ConnectionRecord[], junctions: ConnectionJunction[], selected: ReadonlySet<string>,
): { connections: ConnectionRecord[]; junctions: ConnectionJunction[] } {
  return { connections: records.filter(edge => selected.has(edge.from.nodeId) && selected.has(edge.to.nodeId)),
    junctions: junctions.filter(point => selected.has(point.id)) };
}
