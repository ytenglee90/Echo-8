import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextCatalogContribution, AIContextReadContribution, AIContextSearchContribution } from '../../protocols/ai.ts';
import type { CanvasControlAction, CanvasControlAdmission, CanvasControlPlan, CanvasControlState } from '../../protocols/canvas-control.ts';
import { isTitleConnection } from '../../protocols/connections.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { NaturalCanvasOperation } from '../../services/ai-task-route.ts';
import { readControlOwners } from './context.ts';

export interface NaturalControlState { ids: string[]; lineId?: string; groupId?: string; pendingLine?: string }
export interface NaturalControlResult {
  plan: CanvasControlPlan;
  targets?: string[];
  navigation?: CanvasControlState['navigation'];
  focus?: string[];
  next?: Partial<NaturalControlState>;
  choice?: { name: string; ids: string[] };
  chosen?: ReadonlyMap<string, string>;
  setting?: Extract<NaturalCanvasOperation, { kind: 'theme' }> | { kind: 'background'; color: string };
  pendingLine?: { id: string; line: 'solid' | 'dashed' };
}

const answer = (message: string): NaturalControlResult => ({ plan: { version: 1, actions: [], answer: message } });
const normalize = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase();
const pronoun = /^(?:这个|这一个|这条线|这些|它们|这批|刚才的|选中节点|选中的节点)$/u;

export async function resolveNaturalOperation(
  context: PluginContext, request: CanvasControlAdmission, operation: NaturalCanvasOperation,
  previous: NaturalControlState, chosen: ReadonlyMap<string, string>, signal?: AbortSignal,
): Promise<NaturalControlResult> {
  const [catalogs, owners] = await Promise.all([
    context.capabilities.requestAll<AIContextCatalogContribution>('context.catalog@1', undefined, signal),
    readControlOwners(context, signal),
  ]);
  const sources = new Map(catalogs.flatMap(catalog => catalog.sources).filter(source => source.kind === 'text').map(source => [source.sourceId, source]));
  const groups = owners.groups ?? [];
  const canReadEndpoint = (id: string) => sources.get(id)?.automaticRetrieval !== false || request.sourceIds?.includes(id);
  const edges = (owners.graph?.connections ?? []).filter(edge => edge.from.kind !== 'junction' && edge.to.kind !== 'junction' && canReadEndpoint(edge.from.nodeId) && canReadEndpoint(edge.to.nodeId));
  const title = (id: string) => sources.get(id)?.title ?? groups.find(group => group.id === id)?.title ?? id;
  const nodeTitles = new Map<string, string[]>();
  for (const source of sources.values()) {
    if (source.automaticRetrieval === false) continue;
    const key = normalize(source.title);
    // The canvas owner numbers duplicate titles. Include that family when the
    // user says the base name, and keep the full title independently searchable.
    for (const alias of new Set([key, key.replace(/\s+\d+$/u, '')])) {
      const list = nodeTitles.get(alias) ?? [];
      list.push(source.sourceId);
      nodeTitles.set(alias, list);
    }
  }
  const lookup = (name: string) => {
    const match = /^(.*?)组?(?:里|内|中)的(.+)$/u.exec(name);
    const ids = nodeTitles.get(normalize(match?.[2] ?? name)) ?? [];
    if (!match) return ids;
    const allowed = new Set(groups.filter(group => normalize(group.title).replace(/组$/u, '') === normalize(match[1]!).replace(/组$/u, '')).flatMap(group => group.memberIds));
    return ids.filter(id => allowed.has(id));
  };
  const lookupGroup = (name: string | undefined) => {
    if (!name || /^(?:这一组|这组|刚才那组)$/u.test(name)) return groups.find(group => group.id === previous.groupId);
    const matches = groups.filter(group => normalize(group.title) === normalize(name));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const validMembers = (ids: string[]) => ids.every(id => sources.has(id) && sources.get(id)?.automaticRetrieval !== false);
  const read = async (name: string): Promise<string[] | NaturalControlResult> => {
    if (pronoun.test(name)) {
      const selected = await context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal);
      const ids = (/选中/u.test(name) ? selected.ids : previous.ids.length ? previous.ids : selected.ids).filter(id => sources.has(id));
      return ids.length ? ids : answer('当前没有可沿用的节点。请说出节点名称或先选中节点。');
    }
    const explicit = request.sourceIds?.find(id => id === name || `@${id}` === name || normalize(title(id)) === normalize(name) ||
      (name.endsWith('…') && normalize(title(id)).startsWith(normalize(name.slice(0, -1)))));
    if (explicit) return [explicit];
    const ids = lookup(name);
    const resolved = chosen.get(name);
    if (resolved && ids.includes(resolved)) return [resolved];
    if (!ids.length) return answer(`当前画布没有找到名为「${name}」的节点。`);
    if (ids.length === 1) return ids;
    const items = ids.slice(0, 80).map(id => {
      const neighbors = [...new Set(edges.flatMap(edge => edge.from.nodeId === id ? [edge.to.nodeId] : edge.to.nodeId === id ? [edge.from.nodeId] : []))].slice(0, 3).map(title);
      return { id, label: [groups.find(group => group.memberIds.includes(id))?.title ?? '未分组', title(id), ...(neighbors.length ? [`相连 ${neighbors.join('、')}`] : [])].join(' · ') };
    });
    return { ...answer(`找到了 ${ids.length} 个「${name}」。请在画布控制里点选目标，继续原操作。`),
      choice: { name, ids: items.map(item => item.id) }, navigation: { heading: `选择「${name}」`, choice: true, items } };
  };
  const makePlan = (actions: CanvasControlAction[], targets: string[], next?: NaturalControlResult['next']): NaturalControlResult => {
    if (actions.length > 80 || new Set(targets).size > 80) return answer('目标超过 80 项，请按群组或范围分批操作。');
    return { plan: { version: 2, actions }, targets, focus: targets.filter(id => sources.has(id)), next };
  };
  if (operation.kind === 'filter') {
    const scope = operation.names[0];
    const group = scope ? lookupGroup(scope) : undefined;
    if (scope && !group) return answer(`请确认要筛选的群组「${scope}」。`);
    const connected = new Set((owners.graph?.connections ?? []).flatMap(edge => [edge.from.nodeId, edge.to.nodeId]));
    const ids = (group?.memberIds ?? [...sources.keys()]).filter(id => sources.get(id)?.automaticRetrieval !== false &&
      (!operation.empty || sources.get(id)?.length === 0) && (!operation.disconnected || !connected.has(id)));
    return { ...answer(`找到 ${ids.length} 个节点${ids.length > 80 ? '，已显示前 80 个，请按范围分批修改' : ''}。`), next: { ids }, focus: ids.slice(0, 80),
      navigation: { heading: `筛选结果 · ${ids.length} 个节点`, items: ids.slice(0, 80).map(id => ({ id, label: title(id) })) } };
  }
  if (operation.kind === 'search') {
    const query = { terms: operation.terms, maxResults: 50 };
    const indexed = await context.capabilities.requestAll<AIContextSearchContribution>('context.search@3', query, signal);
    const contributions = indexed.length ? indexed : await context.capabilities.requestAll<AIContextSearchContribution>('context.search@1', query, signal);
    const grouped = new Set(groups.flatMap(group => group.memberIds));
    const ids = [...new Set(contributions.flatMap(result => result.hits.map(hit => hit.source.sourceId)))].filter(id => sources.get(id)?.automaticRetrieval !== false && sources.has(id) && (!operation.ungrouped || !grouped.has(id)));
    return { ...answer(`本地检索找到 ${ids.length} 个候选节点。`), next: { ids }, focus: ids,
      navigation: { heading: `线索候选 · ${ids.length} 个节点`, items: ids.map(id => ({ id, label: title(id) })) } };
  }
  if ((operation.kind === 'color' || operation.kind === 'presentation') && operation.members) {
    const group = lookupGroup(operation.names[0]);
    if (!group) return answer(`请确认群组「${operation.names[0]}」。`);
    if (!validMembers(group.memberIds)) return answer('这个群组含有不参与自动查找的节点，请明确 @ 引用要修改的对象。');
    const presentation = operation.kind === 'presentation' ? operation.presentation : undefined;
    return makePlan(group.memberIds.map(id => ({ type: 'update-node', id, color: operation.color, presentation })), group.memberIds, { ids: group.memberIds, groupId: group.id });
  }
  if (operation.kind === 'ungroup' || operation.kind === 'group-rename') {
    const group = lookupGroup(operation.names[0]);
    if (!group) return answer('请说出要处理的唯一群组名称。');
    const action: CanvasControlAction = operation.kind === 'group-rename' ? { type: 'update-group', id: group.id, title: operation.title } : { type: 'delete', ids: [group.id] };
    return makePlan([action], [group.id, ...group.memberIds], { groupId: group.id });
  }
  if (operation.kind === 'line' && !operation.names.length) {
    const usePrevious = operation.reference === 'previous' || (operation.reference !== 'selection' && previous.lineId !== undefined);
    let edge = edges.find(item => item.id === previous.lineId);
    if (usePrevious && !edge) return answer(previous.lineId ? '上一条连线已撤销或删除。请先重做或重新连接。' : '本次对话还没有处理过连线，请说出两个端点。');
    if (!usePrevious) {
      const selected = await context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal);
      const selectedLines = edges.filter(item => selected.ids.includes(item.id));
      if (selectedLines.length > 1) return answer('选中了多条连线，请只选一条或说出两个端点。');
      edge = selectedLines[0];
    }
    if (!edge) return answer('请先选中一条连线，或说出它的两个端点。');
    if (isTitleConnection(edge) === (operation.line === 'dashed')) return answer(`「${title(edge.from.nodeId)} → ${title(edge.to.nodeId)}」已经是${operation.line === 'dashed' ? '虚线' : '实线'}。`);
    return makePlan([{ type: 'update-connection', id: edge.id, line: operation.line }], [edge.id, edge.from.nodeId, edge.to.nodeId]);
  }
  const ids: string[] = [];
  for (const name of operation.names) {
    const result = await read(name);
    if (!Array.isArray(result)) return result;
    ids.push(...result);
  }
  const unique = [...new Set(ids)];
  if (operation.kind === 'find') return { ...answer(`找到「${title(unique[0]!)}」，已在画布定位。`), next: { ids: unique }, focus: unique };
  if (operation.kind === 'relations') {
    const id = unique[0]!;
    const other = unique[1];
    const related = edges.filter(edge => (edge.from.nodeId === id && (!other || edge.to.nodeId === other)) || (edge.to.nodeId === id && (!other || edge.from.nodeId === other)));
    const subject = other ? `「${title(id)}」和「${title(other)}」之间` : `「${title(id)}」`;
    return { ...answer(`${subject}有 ${related.length} 条直接连线。`), next: { ids: unique, lineId: related.length === 1 ? related[0]!.id : undefined },
      navigation: { heading: `${subject}的连线`, items: related.slice(0, 80).map(edge => ({ id: edge.id, label: `${title(edge.from.nodeId)} → ${title(edge.to.nodeId)} · ${isTitleConnection(edge) ? '虚线' : '实线'}` })) } };
  }
  if (operation.kind === 'connect' || operation.kind === 'line') {
    if (unique.length !== 2) return answer('请指定两个不同的端点。');
    const start = operation.kind === 'connect' && operation.chooseDirection ? chosen.get('') : unique[0];
    if (!start || !unique.includes(start)) return {
      ...answer('请在画布控制里选择箭头方向，继续原操作。'), choice: { name: '', ids: unique },
      navigation: { heading: '选择箭头方向', choice: true, items: unique.map(id => ({ id, label: `${title(id)} → ${title(unique.find(other => other !== id)!)}` })) },
    };
    const from = start;
    const to = unique.find(id => id !== from)!;
    const directed = edges.filter(edge => edge.from.nodeId === from && edge.to.nodeId === to);
    const line = operation.line ?? 'solid';
    const desired = directed.find(edge => isTitleConnection(edge) === (line === 'dashed')) ?? (operation.line === undefined && directed.length === 1 ? directed[0] : undefined);
    if (desired) return { ...answer(`「${title(from)} → ${title(to)}」已有${isTitleConnection(desired) ? '虚线' : '实线'}。`), next: { ids: unique, lineId: desired.id, pendingLine: undefined } };
    if (directed.length === 1) return makePlan([{ type: 'update-connection', id: directed[0]!.id, line }], [...unique, directed[0]!.id], { ids: unique });
    if (operation.kind === 'line') {
      const reverse = edges.filter(edge => edge.from.nodeId === to && edge.to.nodeId === from);
      if (reverse.length === 1 && isTitleConnection(reverse[0]!) !== (operation.line === 'dashed')) return makePlan([{ type: 'update-connection', id: reverse[0]!.id, line: operation.line }], [...unique, reverse[0]!.id], { ids: unique });
      return answer('没有找到可改为该线型的唯一连线。');
    }
    return makePlan([{ type: 'create-connection', ref: 'natural-line', from, to, line }], unique, { ids: unique });
  }
  if (operation.kind === 'group') {
    if (unique.length < 2) return answer('建组至少需要两个不同节点。');
    if (groups.some(group => group.memberIds.some(id => unique.includes(id)))) return answer('有节点已属于其他群组。请先移出这些节点，再创建新组。');
    return makePlan([{ type: 'create-group', ref: 'natural-group', title: operation.title!, members: unique }], unique, { ids: unique });
  }
  if (operation.kind === 'group-add' || operation.kind === 'group-remove') {
    const group = lookupGroup(operation.title);
    if (!group) return answer('请说出群组名称，或先创建要沿用的群组。');
    if (operation.kind === 'group-add' && groups.some(other => other.id !== group.id && other.memberIds.some(id => unique.includes(id)))) return answer('要加入的节点已属于其他群组。请先将它移出原组。');
    const members = operation.kind === 'group-add' ? [...new Set([...group.memberIds, ...unique])] : group.memberIds.filter(id => !unique.includes(id));
    if (members.length < 2) return answer('移出后群组不足两个成员。如要保留节点并取消群组，请使用解组。');
    return makePlan([{ type: 'update-group', id: group.id, members }], [group.id, ...group.memberIds, ...unique], { ids: members, groupId: group.id });
  }
  if (operation.kind === 'color') return makePlan(unique.map(id => ({ type: 'update-node', id, color: operation.color })), unique, { ids: unique });
  if (operation.kind === 'presentation') return makePlan(unique.map(id => ({ type: 'update-node', id, presentation: operation.presentation, color: operation.color })), unique, { ids: unique });
  if (operation.kind === 'append') return makePlan(unique.map(id => ({ type: 'update-node', id, append: operation.text })), unique, { ids: unique });
  if (operation.kind === 'replace') {
    const source = unique.length === 1 ? sources.get(unique[0]!) : undefined;
    if (!source || !operation.old || operation.old === operation.text) return answer('请明确一个正文目标和不同的旧值、新值。');
    if (source.length > 512 * 1024) return answer('正文过长，请先选中要修改的段落或使用更具体的引用。');
    const hits: number[] = [];
    const field = /^(?:把|将).+?的(.{1,12}?)从/u.exec(request.prompt)?.[1];
    const fieldPattern = field ? new RegExp(String.raw`${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*[：:=]?\s*$`, 'u') : undefined;
    const fieldHits: number[] = [];
    const chunkSize = 8_192;
    for (let start = 0; start < source.length && (fieldPattern ? fieldHits.length < 2 : hits.length < 2); start += chunkSize) {
      const readStart = Math.max(0, start - 32);
      const offset = start - readStart;
      const chunks = await context.capabilities.requestAll<AIContextReadContribution>('context.read@1', { sourceId: source.sourceId, start: readStart, length: offset + chunkSize + operation.old.length - 1 }, signal);
      const read = chunks.find(chunk => chunk.handled);
      if (read?.source?.revision !== source.revision) return answer('查找期间正文已变化，请重新发送要求。');
      const text = read.text ?? '';
      for (let index = text.indexOf(operation.old, offset); index >= 0 && index < offset + chunkSize; index = text.indexOf(operation.old, index + 1)) {
        if (hits.length < 2) hits.push(readStart + index);
        if (fieldPattern?.test(text.slice(Math.max(0, index - 32), index))) fieldHits.push(readStart + index);
        if (fieldHits.length > 1) break;
        if (!fieldPattern && hits.length > 1) break;
      }
    }
    const matches = fieldHits.length ? fieldHits : hits;
    if (matches.length !== 1) return answer(matches.length ? '旧值出现多次，请引用更完整的原句。' : '没有找到要替换的旧值。');
    return makePlan([{ type: 'update-node', id: source.sourceId, edit: { start: matches[0]!, deleteCount: operation.old.length, insert: operation.text, expectedRevision: source.revision } }], unique, { ids: unique });
  }
  if (operation.kind === 'move' || operation.kind === 'arrange') {
    if (unique.length > 80) return answer('目标超过 80 项，请分批移动或排列。');
    const nodes = await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: unique }, signal);
    const x = Math.min(...nodes.map(node => node.x)), y = Math.min(...nodes.map(node => node.y));
    const width = Math.max(...nodes.map(node => node.width)) + 60, height = Math.max(...nodes.map(node => node.height)) + 60;
    const columns = operation.layout === 'horizontal' ? nodes.length : operation.layout === 'vertical' ? 1 : Math.ceil(Math.sqrt(nodes.length));
    return makePlan(nodes.map((node, index) => ({ type: 'update-node', id: node.id, x: operation.kind === 'move' ? node.x + (operation.x ?? 0) : x + index % columns * width,
      y: operation.kind === 'move' ? node.y + (operation.y ?? 0) : y + Math.floor(index / columns) * height })), unique, { ids: unique });
  }
  return answer('请明确要处理的画布对象。');
}
