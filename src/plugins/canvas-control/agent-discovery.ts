import { isRecord, type PluginContext } from '../../core/contracts.ts';
import type { AIContextCatalogContribution, AIContextReadContribution, AIContextSearchContribution } from '../../protocols/ai.ts';
import type { CanvasControlAdmission } from '../../protocols/canvas-control.ts';
import type { CanvasAgentNode, CanvasAgentQuery, CanvasAgentQueryResult, CanvasAgentReadResult } from '../../protocols/canvas-agent.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { SemanticRetrievalResult } from '../../protocols/retrieval.ts';
import { isTitleConnection } from '../../protocols/connections.ts';
import { canvasTitleAliases, normalizeCanvasTitle } from '../../services/canvas-titles.ts';
import { assertNotAborted } from '../../services/async-control.ts';
import { optionalControlOwner, readControlOwners, type ControlSnapshot } from './context.ts';
import type { NaturalControlState } from './natural-operations.ts';

export interface AgentDiscoverySession {
  sessionId: string;
  prompt: string;
  expiresAt: number;
  nodes: Map<string, CanvasAgentNode>;
  groupRevisions: Map<string, number>;
  connectionRevisions: Map<string, number>;
  bodyCharacters: number;
}

export function newAgentDiscovery(input: CanvasControlAdmission): AgentDiscoverySession {
  return { sessionId: input.sessionId, prompt: input.prompt, expiresAt: Date.now() + 10 * 60_000,
    nodes: new Map(), groupRevisions: new Map(), connectionRevisions: new Map(), bodyCharacters: 0 };
}

export function validateAgentQuery(query: unknown): asserts query is CanvasAgentQuery {
  if (!isRecord(query) || !['state', 'selection', 'recent', 'search', 'all', 'relations'].includes(String(query.mode)) ||
    Object.keys(query).some(key => !['mode', 'query', 'ids', 'cursor'].includes(key)) ||
    (query.query !== undefined && (typeof query.query !== 'string' || !query.query.trim() || query.query.length > 300)) ||
    (query.ids !== undefined && (!Array.isArray(query.ids) || query.ids.length > 12 || query.ids.some(id => typeof id !== 'string' || id.length > 200))) ||
    (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor) || Number(query.cursor) < 0 || Number(query.cursor) > 1_000_000))) {
    throw new Error('画布查询参数无效');
  }
}

function rememberNodes(session: AgentDiscoverySession, nodes: ContentSummary[]): CanvasAgentNode[] {
  if (new Set([...session.nodes.keys(), ...nodes.map(node => node.id)]).size > 80) throw new Error('本轮已查找超过 80 个对象，请缩小范围后重新操作');
  return nodes.map(node => {
    const value: CanvasAgentNode = { id: node.id, title: node.title.slice(0, 300), revision: node.revision,
      nodeRevision: node.nodeRevision ?? node.revision, length: node.length, x: node.x, y: node.y, width: node.width, height: node.height,
      color: node.titleColor, presentation: node.presentation ?? 'card' };
    const known = session.nodes.get(node.id);
    if (known && (known.revision !== value.revision || known.nodeRevision !== value.nodeRevision)) throw new Error('查找期间节点已变化，请重新发送这次操作');
    session.nodes.set(node.id, value);
    return value;
  });
}

/** Legacy directories are owner-validated discoveries too; grant only the supplied scope. */
export function grantAgentSnapshot(session: AgentDiscoverySession, snapshot: ControlSnapshot): void {
  rememberNodes(session, snapshot.nodes);
  for (const group of snapshot.groups) {
    if (session.groupRevisions.has(group.id) && session.groupRevisions.get(group.id) !== group.revision) throw new Error('已查询的群组已变化，请重新发送任务');
    session.groupRevisions.set(group.id, group.revision);
  }
  for (const edge of snapshot.graph.connections) {
    if (session.connectionRevisions.has(edge.id) && session.connectionRevisions.get(edge.id) !== edge.revision) throw new Error('已查询的连线已变化，请重新发送任务');
    session.connectionRevisions.set(edge.id, edge.revision);
  }
}

export async function queryAgentCanvas(
  context: PluginContext, input: CanvasControlAdmission & { query: CanvasAgentQuery },
  session: AgentDiscoverySession, previous: NaturalControlState, signal?: AbortSignal,
): Promise<CanvasAgentQueryResult> {
  validateAgentQuery(input.query);
  const [catalogs, owners, selection] = await Promise.all([
    context.capabilities.requestAll<AIContextCatalogContribution>('context.catalog@1', undefined, signal),
    readControlOwners(context, signal),
    context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal),
  ]);
  const selectedMembers = (owners.groups ?? []).filter(group => selection.ids.includes(group.id)).flatMap(group => group.memberIds);
  const selectedEndpoints = (owners.graph?.connections ?? []).filter(edge => selection.ids.includes(edge.id) && edge.from.kind !== 'junction' && edge.to.kind !== 'junction')
    .flatMap(edge => [edge.from.nodeId, edge.to.nodeId]);
  const endpointMembers = (owners.groups ?? []).filter(group => selectedEndpoints.includes(group.id)).flatMap(group => group.memberIds);
  const explicit = new Set([...(input.sourceIds ?? []), ...selection.ids, ...selectedMembers, ...selectedEndpoints, ...endpointMembers]);
  const catalog = catalogs.flatMap(part => part.sources).filter(source => source.kind === 'text' &&
    (source.automaticRetrieval !== false || explicit.has(source.sourceId)));
  const allowed = new Set(catalog.map(source => source.sourceId));
  const selectedIds = [...new Set([...selection.ids.filter(id => allowed.has(id)), ...selectedMembers, ...selectedEndpoints, ...endpointMembers])].filter(id => allowed.has(id));
  const recentIds = previous.ids.filter(id => allowed.has(id));
  const createdIds = (previous.createdIds ?? []).filter(id => allowed.has(id));
  const groups = (owners.groups ?? []).filter(group => group.memberIds.every(id => allowed.has(id)));
  const allowedEndpoints = new Set([...allowed, ...groups.map(group => group.id)]);
  let ids: string[] = [];
  let matchingGroups = groups.filter(group => group.id === previous.groupId || selectedIds.some(id => group.memberIds.includes(id)));
  let relationTotal: number | undefined;
  const { mode } = input.query;
  if (mode === 'state' || mode === 'selection') ids = [...new Set([...(input.sourceIds ?? []).filter(id => allowed.has(id)), ...selectedIds])].slice(0, 12);
  if (mode === 'state' || mode === 'recent') ids = [...new Set([...ids, ...recentIds, ...createdIds])].slice(0, 12);
  if (mode === 'all') {
    const cursor = input.query.cursor ?? 0;
    ids = catalog.slice(cursor, cursor + 20).map(source => source.sourceId);
    matchingGroups = groups.filter(group => group.memberIds.every(id => ids.includes(id)));
  }
  if (mode === 'search') {
    if (!input.query.query) throw new Error('查找节点需要提供关键词或对象描述');
    const query = normalizeCanvasTitle(input.query.query);
    matchingGroups = groups.filter(group => normalizeCanvasTitle(group.title).includes(query)).slice(0, 4);
    const exact = catalog.filter(source => canvasTitleAliases(source.title).includes(query)).map(source => source.sourceId);
    const partial = catalog.filter(source => canvasTitleAliases(source.title).some(alias => alias.includes(query) || query.includes(alias) && alias.length >= 2)).map(source => source.sourceId);
    const terms = [...new Set(query.split(/[，,、\s]+/u).filter(Boolean))].slice(0, 8).map(term => term.slice(0, 48));
    const search = { query: input.query.query, terms: terms.length ? terms : [query.slice(0, 48)], maxResults: 12, sourceIds: [...allowed].length <= 100 ? [...allowed] : undefined };
    const lexical = await context.capabilities.requestAll<AIContextSearchContribution>('context.search@3', search, signal)
      .catch(error => { if (signal?.aborted) throw error; return [] as AIContextSearchContribution[]; });
    const lexicalIds = lexical.flatMap(part => part.hits).filter(hit => allowed.has(hit.source.sourceId)).sort((a, b) => b.score - a.score).map(hit => hit.source.sourceId);
    let semanticIds: string[] = [];
    if (new Set([...exact, ...partial, ...lexicalIds]).size < 3) {
      const semantic = await context.capabilities.request<SemanticRetrievalResult>('context.semanticSearch@3', { ...search, lexicalHits: new Set(lexicalIds).size }, signal)
        .catch(optionalControlOwner);
      semanticIds = semantic?.contributions.flatMap(part => part.hits).filter(hit => allowed.has(hit.source.sourceId)).map(hit => hit.source.sourceId) ?? [];
    }
    ids = [...new Set([...exact, ...partial, ...matchingGroups.flatMap(group => group.memberIds), ...lexicalIds, ...semanticIds])].slice(0, 20);
  }
  const visibleIds = new Set([...ids, ...matchingGroups.filter(group => group.memberIds.every(id => ids.includes(id))).map(group => group.id)]);
  let connections = (owners.graph?.connections ?? []).filter(edge => edge.from.kind !== 'junction' && edge.to.kind !== 'junction' &&
    allowedEndpoints.has(edge.from.nodeId) && allowedEndpoints.has(edge.to.nodeId) && visibleIds.has(edge.from.nodeId) && visibleIds.has(edge.to.nodeId));
  if (mode === 'relations') {
    const anchors = input.query.ids ?? recentIds.slice(0, 2);
    if (!anchors.length || anchors.some(id => !session.nodes.has(id) && !session.groupRevisions.has(id))) throw new Error('请先查找或读取要查询关系的节点');
    const related = (owners.graph?.connections ?? []).filter(edge => edge.from.kind !== 'junction' && edge.to.kind !== 'junction' &&
      allowedEndpoints.has(edge.from.nodeId) && allowedEndpoints.has(edge.to.nodeId) && (anchors.includes(edge.from.nodeId) || anchors.includes(edge.to.nodeId)));
    const cursor = input.query.cursor ?? 0;
    relationTotal = related.length;
    connections = related.slice(cursor, cursor + 12);
    const endpoints = [...new Set([...anchors, ...connections.flatMap(edge => [edge.from.nodeId, edge.to.nodeId])])];
    matchingGroups = groups.filter(group => endpoints.includes(group.id));
    ids = [...new Set([...endpoints.filter(id => allowed.has(id)), ...matchingGroups.flatMap(group => group.memberIds)])];
  }
  const summaries = await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: ids }, signal);
  assertNotAborted(signal);
  const nodes = rememberNodes(session, summaries);
  const known = new Set(session.nodes.keys());
  const visibleGroups = matchingGroups.filter(group => group.memberIds.every(id => known.has(id))).slice(0, 8);
  for (const group of visibleGroups) {
    const revision = session.groupRevisions.get(group.id);
    if (revision !== undefined && revision !== group.revision) throw new Error('查询期间群组已变化，请重新发送操作');
    session.groupRevisions.set(group.id, group.revision);
  }
  for (const edge of connections.slice(0, 12)) {
    const revision = session.connectionRevisions.get(edge.id);
    if (revision !== undefined && revision !== edge.revision) throw new Error('查询期间连线已变化，请重新发送操作');
    session.connectionRevisions.set(edge.id, edge.revision);
  }
  const cursor = input.query.cursor ?? 0;
  return {
    nodes, total: mode === 'all' ? catalog.length : relationTotal ?? nodes.length,
    ...(mode === 'all' && cursor + 20 < catalog.length ? { nextCursor: cursor + 20 } : {}),
    ...(mode === 'relations' && cursor + 12 < (relationTotal ?? 0) ? { nextCursor: cursor + 12 } : {}),
    groups: visibleGroups.map(group => ({ id: group.id, title: group.title.slice(0, 300), members: group.memberIds, revision: group.revision })),
    connections: connections.slice(0, 12).map(edge => ({ id: edge.id, from: edge.from.nodeId, to: edge.to.nodeId,
      line: isTitleConnection(edge) ? 'dashed' : 'solid', label: (edge.label ?? '').slice(0, 200), revision: edge.revision })),
    ...(mode === 'state' ? { selectedIds, recentIds, createdIds, pendingTask: previous.pendingTask } : {}),
    available: { nodes: true, groups: Boolean(owners.groups), connections: Boolean(owners.graph) },
  };
}

export async function readAgentCanvas(
  context: PluginContext, input: CanvasControlAdmission & { id: string; start?: number; length?: number },
  session: AgentDiscoverySession, signal?: AbortSignal,
): Promise<CanvasAgentReadResult> {
  const known = session.nodes.get(input.id);
  if (!known) throw new Error('请先通过画布查询定位这个节点，禁止猜测 ID');
  const current = (await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: [input.id] }, signal))[0];
  if (!current || (current.nodeRevision ?? current.revision) !== known.nodeRevision || current.revision !== known.revision) throw new Error('已定位的节点已变化，请重新发送操作');
  const start = input.start ?? 0;
  const length = input.length ?? 4000;
  if (!Number.isSafeInteger(start) || start < 0 || start > known.length || !Number.isSafeInteger(length) || length < 1 || length > 8192) throw new Error('正文范围无效，每次最多读取 8192 字符');
  if (session.bodyCharacters + Math.min(length, known.length - start) > 16_000) throw new Error('本轮已读取 16000 字符，请缩小正文范围');
  const parts = await context.capabilities.requestAll<AIContextReadContribution>('context.read@1', { sourceId: input.id, start, length }, signal);
  const read = parts.find(part => part.handled);
  if (!read?.source || read.source.revision !== known.revision) throw new Error('正文已变化，请重新发送操作');
  const text = read.text ?? '';
  session.bodyCharacters += text.length;
  return { id: input.id, revision: known.revision, start, text, totalLength: known.length,
    ...(start + text.length < known.length ? { nextStart: start + text.length } : {}) };
}
