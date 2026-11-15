import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextSource } from '../../protocols/ai.ts';
import type { CanvasControlAction } from '../../protocols/canvas-control.ts';
import type { ConnectionGraphSnapshot, ConnectionEndpoint } from '../../protocols/connections.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { ContentSearchResultV2 } from '../../protocols/search.ts';
import { assertNotAborted } from '../../services/async-control.ts';
import { canvasTitleAliases, normalizeCanvasTitle } from '../../services/canvas-titles.ts';
import type { NaturalControlResult } from './natural-operations.ts';

const answer = (message: string): NaturalControlResult => ({ plan: { version: 1, actions: [], answer: message } });

export async function findCanvasText(context: PluginContext, allowedIds: string[], before: string, after?: string, signal?: AbortSignal): Promise<NaturalControlResult> {
  if (!allowedIds.length) return answer('没有允许搜索的正文卡片。');
  if (before === after) return answer('新旧原文相同。');
  const result = await context.capabilities.request<ContentSearchResultV2>('content.search@2', {
    query: before, nodeIds: allowedIds, matchCase: true, wholeWord: false, maxResults: 501,
  }, signal);
  const hits = result.hits.filter(hit => hit.field === 'body');
  const ids = [...new Set(hits.map(hit => hit.nodeId))];
  if (!ids.length) return answer('没有找到匹配的正文。');
  if (result.truncated || ids.length > 80) return answer('命中范围较大，请提供更完整的原句或缩小范围。');
  if (after !== undefined) return { plan: { version: 2, actions: [] }, targets: ids, next: { ids },
    replacement: { hits, replacement: after } };
  return { ...answer(`找到 ${ids.length} 张含有「${before}」的卡片。`), next: { ids }, focus: ids,
    navigation: { heading: '跨卡片原文命中', items: hits.slice(0, 80).map(hit => ({ id: hit.nodeId, label: `${hit.title} · ${hit.preview}` }))
      .filter((item, index, items) => items.findIndex(previous => previous.id === item.id) === index) } };
}

export function auditCanvasNames(sources: AIContextSource[]): NaturalControlResult {
  const names = new Map<string, AIContextSource[]>();
  for (const source of sources) {
    const title = normalizeCanvasTitle(source.title);
    if (title) names.set(title, [...(names.get(title) ?? []), source]);
  }
  const duplicates = [...names.values()].filter(items => items.length > 1).flat();
  if (!duplicates.length) return answer('当前允许检查的卡片中没有重名标题。');
  return { ...answer(`发现 ${duplicates.length} 张卡片有重复标题。`),
    navigation: { heading: '重名检查', items: duplicates.slice(0, 80).map(source => ({ id: source.sourceId, label: source.title })) } };
}

const endpointKey = (endpoint: ConnectionEndpoint) => endpoint.kind === 'junction' ? `junction:${endpoint.nodeId}` : `object:${endpoint.nodeId}`;
export function shortestCanvasPath(
  graph: ConnectionGraphSnapshot | undefined, allowed: ReadonlySet<string>, from: string, to: string, directed: boolean, signal?: AbortSignal,
): { objects: string[]; edges: string[] } | undefined {
  if (!graph || from === to || !allowed.has(from) || !allowed.has(to)) return undefined;
  const adjacency = new Map<string, Array<{ node: string; edge: string }>>();
  const link = (key: string, node: string, edge: string) => {
    const neighbours = adjacency.get(key) ?? [];
    neighbours.push({ node, edge });
    adjacency.set(key, neighbours);
  };
  for (const edge of graph.connections) {
    assertNotAborted(signal);
    if ([edge.from, edge.to].some(endpoint => endpoint.kind !== 'junction' && !allowed.has(endpoint.nodeId))) continue;
    const head = endpointKey(edge.from), tail = endpointKey(edge.to);
    link(head, tail, edge.id);
    if (!directed) link(tail, head, edge.id);
  }
  const start = `object:${from}`, end = `object:${to}`;
  const previous = new Map<string, { node: string; edge: string } | undefined>([[start, undefined]]);
  const queue = [start];
  for (let index = 0; index < queue.length && !previous.has(end); index++) {
    assertNotAborted(signal);
    const current = queue[index]!;
    for (const next of adjacency.get(current) ?? []) {
      if (previous.has(next.node)) continue;
      previous.set(next.node, { node: current, edge: next.edge });
      queue.push(next.node);
    }
  }
  if (!previous.has(end)) return undefined;
  const objects: string[] = [], edges: string[] = [];
  for (let key = end, arc = previous.get(key); ; key = arc!.node, arc = previous.get(key)) {
    if (key.startsWith('object:')) objects.push(key.slice(7));
    if (!arc) break;
    edges.push(arc.edge);
  }
  return { objects: objects.reverse(), edges: edges.reverse() };
}

export async function planGroupColumns(
  context: PluginContext, groups: GroupRecord[], sources: AIContextSource[], lead: string | undefined, keep: string[], signal?: AbortSignal,
): Promise<NaturalControlResult> {
  const allowed = new Set(sources.map(source => source.sourceId));
  const names = new Map(sources.map(source => [source.sourceId, canvasTitleAliases(source.title)]));
  const protectedIds = new Set<string>();
  for (const name of keep) {
    const group = groups.filter(item => normalizeCanvasTitle(item.title) === normalizeCanvasTitle(name));
    const matches = sources.filter(source => names.get(source.sourceId)?.includes(normalizeCanvasTitle(name)));
    if (group.length + matches.length !== 1) return answer(`请明确要保持原位的卡片或群组「${name}」。`);
    (group[0]?.memberIds ?? matches.map(item => item.sourceId)).filter(id => allowed.has(id)).forEach(id => protectedIds.add(id));
  }
  const seen = new Set<string>();
  const columns = groups.map(group => group.memberIds.filter(id => {
    if (!allowed.has(id) || protectedIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  })).filter(ids => ids.length);
  if (!seen.size) return answer('没有可排版的已分组卡片。');
  if (seen.size + protectedIds.size > 80) return answer('排版涉及超过 80 张卡，请缩小范围。');
  const targets = [...seen, ...protectedIds];
  const byId = new Map((await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: targets }, signal)).map(node => [node.id, node]));
  if (byId.size !== targets.length) return answer('排版对象已经变化，请重试。');
  const nodes = [...byId.values()];
  const obstacles = [...protectedIds].map(id => byId.get(id)!);
  let x = Math.min(...nodes.map(node => node.x));
  const top = Math.min(...nodes.map(node => node.y));
  const actions: CanvasControlAction[] = [];
  for (const column of columns) {
    const leadIndex = lead ? column.findIndex(id => names.get(id)?.includes(normalizeCanvasTitle(lead))) : -1;
    if (leadIndex > 0) column.unshift(...column.splice(leadIndex, 1));
    let y = top;
    for (const id of column) {
      const node = byId.get(id)!;
      for (const obstacle of obstacles.filter(item => x < item.x + item.width + 40 && x + node.width + 40 > item.x).sort((a, b) => a.y - b.y)) {
        if (y < obstacle.y + obstacle.height + 40 && y + node.height + 40 > obstacle.y) y = obstacle.y + obstacle.height + 40;
      }
      if (node.x !== x || node.y !== y) actions.push({ type: 'update-node', id, x, y });
      y += node.height + 60;
    }
    x += Math.max(...column.map(id => byId.get(id)!.width)) + 80;
  }
  return actions.length ? { plan: { version: 1, actions }, targets, next: { ids: [...seen] } } : answer('当前卡片已符合分列布局。');
}
