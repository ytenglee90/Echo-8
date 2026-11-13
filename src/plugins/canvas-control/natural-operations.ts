import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextCatalogContribution, AIContextReadContribution, AIContextSearchContribution } from '../../protocols/ai.ts';
import type { CanvasControlAction, CanvasControlAdmission, CanvasControlPlan, CanvasControlState } from '../../protocols/canvas-control.ts';
import { isTitleConnection } from '../../protocols/connections.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { ContentReplaceRequest, SearchHit } from '../../protocols/search.ts';
import type { NaturalCanvasOperation } from '../../services/ai-task-route.ts';
import { naturalTargetFilter } from '../../services/natural-canvas-rules.ts';
import { readControlOwners } from './context.ts';
import { naturalColor, NATURAL_COLORS } from '../../services/natural-canvas-rules.ts';
import { resolveNaturalBatch } from './natural-batch.ts';

export interface NaturalControlState { ids: string[]; lineId?: string; groupId?: string; pendingLine?: string; draftTitles?: ReadonlyMap<string, string> }
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
  pendingColor?: { id: string; direction: 'lighter' | 'darker' };
  selectionMode?: 'replace' | 'add';
  replacement?: ContentReplaceRequest;
}

const answer = (message: string): NaturalControlResult => ({ plan: { version: 1, actions: [], answer: message } });
const normalize = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase();
const pronoun = /^(?:它|新节点|刚建的节点|这个|这一个|这两个|这几个|这条线|这些|它们|这批|刚才的|刚才那批|刚才筛出的(?:空白)?节点|选中节点|选中的节点|选中的|选区)$/u;

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
    const base = key.replace(/\s+\d+$/u, '');
    const qualifiedParts = base.split('|').map(part => part.trim()).filter(Boolean);
    for (const alias of new Set([key, base, ...(qualifiedParts.length > 1 ? qualifiedParts : [])])) {
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
  const filterTargets = async (value: string): Promise<string[] | NaturalControlResult> => {
    const filter = naturalTargetFilter(value);
    if (!filter) return [];
    const group = filter.group ? lookupGroup(filter.group) : undefined;
    if (filter.group && !group) return answer(`没有找到唯一群组「${filter.group}」，请补充群组名称。`);
    const excluded = new Set<string>();
    for (const name of filter.exclude) {
      const ids = await read(name);
      if (!Array.isArray(ids)) return ids;
      for (const id of ids) excluded.add(id);
    }
    const connected = new Set((owners.graph?.connections ?? []).flatMap(edge => [edge.from.nodeId, edge.to.nodeId]));
    const grouped = new Set(groups.flatMap(item => item.memberIds));
    let ids = (group?.memberIds ?? [...sources.keys()]).filter(id => {
      const source = sources.get(id);
      return source && source.automaticRetrieval !== false && !excluded.has(id) &&
        (!filter.empty || source.length === 0) && (!filter.disconnected || !connected.has(id)) &&
        (!filter.ungrouped || !grouped.has(id)) && (!filter.titleContains || normalize(source.title).includes(normalize(filter.titleContains)));
    });
    if (filter.presentation) {
      const nodes = await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: ids }, signal);
      ids = nodes.filter(node => (node.presentation ?? 'card') === filter.presentation).map(node => node.id);
    }
    return ids;
  };
  const read = async (name: string): Promise<string[] | NaturalControlResult> => {
    if (previous.draftTitles?.has(normalize(name))) return [previous.draftTitles.get(normalize(name))!];
    if (!pronoun.test(name) && naturalTargetFilter(name)) return filterTargets(name);
    if (/^(?:这一组|这组|刚才那组)$/u.test(name)) {
      const group = lookupGroup(name);
      return group && validMembers(group.memberIds) ? group.memberIds : answer('当前没有可沿用的群组。');
    }
    if (pronoun.test(name)) {
      const selected = await context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal);
      const useSelection = /选中|选区|^这两个$|^这几个$/u.test(name);
      const selectedIds = (useSelection ? selected.ids : previous.ids.length ? previous.ids : selected.ids);
      const drafts = new Set(previous.draftTitles?.values());
      const ids = [...new Set(selectedIds.flatMap(id => groups.find(group => group.id === id)?.memberIds ?? [id]))]
        .filter(id => drafts.has(id) || (sources.has(id) && (useSelection || sources.get(id)?.automaticRetrieval !== false)));
      if (name === '这两个' && ids.length !== 2) return answer('请选中两个节点，再继续连线。');
      return ids.length ? ids : answer('当前没有可沿用的节点。请说出节点名称或先选中节点。');
    }
    const explicit = request.sourceIds?.find(id => id === name || `@${id}` === name || normalize(title(id)) === normalize(name) ||
      (name.endsWith('…') && normalize(title(id)).startsWith(normalize(name.slice(0, -1)))));
    if (explicit) return [explicit];
    const ids = lookup(name);
    const resolved = chosen.get(name);
    if (resolved && ids.includes(resolved)) return [resolved];
    if (!ids.length) {
      const group = lookupGroup(name);
      if (group) return validMembers(group.memberIds) ? group.memberIds : answer('群组包含未授权自动检索的节点，请明确指定范围。');
      return answer(`本轮允许查找的画布范围内，没有找到名为「${name}」的节点。`);
    }
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
    const drafts = new Set(previous.draftTitles?.values());
    return { plan: { version: 2, actions }, targets: targets.filter(id => !drafts.has(id)), focus: targets.filter(id => sources.has(id)), next };
  };
  if (operation.kind === 'batch') return resolveNaturalBatch(operation.steps, previous, (step, state) =>
    resolveNaturalOperation(context, request, step, state, chosen, signal));
  if (operation.kind === 'narrow') {
    if (!previous.ids.length) return answer('当前没有可缩小的筛选结果。');
    const excluded = new Set<string>();
    for (const operand of operation.names) {
      const result = await read(operand);
      if (!Array.isArray(result)) return result;
      for (const id of result) excluded.add(id);
    }
    const ids = previous.ids.filter(id => sources.has(id) && !excluded.has(id));
    return { ...answer(`筛选结果剩余 ${ids.length} 个节点。`), next: { ids }, focus: ids.slice(0, 80),
      navigation: { heading: '调整后的筛选结果', items: ids.slice(0, 80).map(id => ({ id, label: title(id) })) } };
  }
  if (operation.kind === 'choose-color') {
    const choiceName = operation.background ? '\u0000background' : '\u0000color';
    const color = chosen.get(choiceName);
    if (color && naturalColor(color) && operation.background) return { ...answer('已准备背景预览。'), setting: { kind: 'background', color } };
    if (color && naturalColor(color)) return resolveNaturalOperation(context, request, { kind: 'color', names: operation.names, color }, previous, chosen, signal);
    const items = ['浅蓝', '深蓝', '墨绿', '暖灰', '红', '紫'].map(label => ({ id: NATURAL_COLORS[label]!, label }));
    return { ...answer('请选择一种颜色，选完会继续原操作。'), choice: { name: choiceName, ids: items.map(item => item.id) },
      navigation: { heading: operation.background ? '选择画布背景色' : '选择颜色', choice: true, items } };
  }
  if (operation.kind === 'choose-theme') {
    const choiceName = '\u0000theme';
    const theme = chosen.get(choiceName);
    if (theme === 'light' || theme === 'dark') return { ...answer('正在切换主题。'), setting: { kind: 'theme', names: [], theme } };
    const items = [{ id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }];
    return { ...answer('请选择一个主题。'), choice: { name: choiceName, ids: items.map(item => item.id) },
      navigation: { heading: '选择主题', choice: true, items } };
  }
  if (operation.kind === 'filter') {
    if (operation.target) {
      const ids = await filterTargets(operation.target);
      if (!Array.isArray(ids)) return ids;
      return { ...answer(`找到 ${ids.length} 个节点${ids.length > 80 ? '，已显示前 80 个，请缩小范围后修改' : ''}。`), next: { ids }, focus: ids.slice(0, 80),
        navigation: { heading: `筛选结果 · ${ids.length} 个节点`, items: ids.slice(0, 80).map(id => ({ id, label: title(id) })) } };
    }
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
  if (operation.kind === 'color' && !operation.members && operation.names.length === 1) {
    const group = lookupGroup(operation.names[0]);
    if (group) return makePlan([{ type: 'update-group', id: group.id, color: operation.color }], [group.id, ...group.memberIds], { groupId: group.id, ids: group.memberIds });
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
  if (operation.kind === 'select') return { ...answer(`已${operation.selectionMode === 'add' ? '追加选择' : '选中'} ${unique.length} 个节点。`), next: { ids: unique }, focus: unique, selectionMode: operation.selectionMode };
  if (operation.kind !== 'create' && operation.names.length && !unique.length) return answer('没有命中符合条件的节点。');
  if (operation.kind === 'rename') return makePlan(unique.map(id => ({ type: 'update-node', id, title: operation.title })), unique, { ids: unique });
  if (operation.kind === 'remove') return makePlan([{ type: 'delete', ids: unique }], unique, { ids: unique });
  if (operation.kind === 'create') {
    const anchor = unique.length === 1 ? (await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: unique }, signal))[0] : undefined;
    if (operation.names.length && !anchor) return answer('请指定唯一的参照节点。');
    const width = operation.presentation === 'text-box' ? 240 : 340;
    const height = 220;
    return makePlan([{ type: 'create-node', ref: 'natural-node', title: operation.title, presentation: operation.presentation, width, height,
      ...(anchor ? { x: operation.side === 'left' ? anchor.x - width - 60 : operation.side === 'right' ? anchor.x + anchor.width + 60 : anchor.x,
        y: operation.side === 'above' ? anchor.y - height - 60 : operation.side === 'below' ? anchor.y + anchor.height + 60 : anchor.y } : {}) }], unique);
  }
  if (operation.kind === 'connect-many') {
    if (unique.length !== operation.names.length) return answer('每个端点需要命中一个不同节点，请明确端点名称。');
    const actions: CanvasControlAction[] = [];
    for (let index = 1; index < unique.length; index += 1) {
      const from = unique[operation.topology === 'fan' ? 0 : index - 1]!;
      const to = unique[index]!;
      const directed = edges.filter(edge => edge.from.nodeId === from && edge.to.nodeId === to);
      if (directed.some(edge => isTitleConnection(edge) === (operation.line === 'dashed'))) continue;
      if (directed.length > 1) return answer('端点之间有多条连线，请先明确要修改的线。');
      if (directed[0]) actions.push({ type: 'update-connection', id: directed[0].id, line: operation.line });
      else actions.push({ type: 'create-connection', ref: `natural-line-${index}`, from, to, line: operation.line });
    }
    return makePlan(actions, [...unique, ...actions.flatMap(action => 'id' in action ? [action.id] : [])], { ids: unique });
  }
  if (operation.kind === 'line-update') {
    let candidates = unique.length === 2 ? edges.filter(edge => edge.from.nodeId === unique[0] && edge.to.nodeId === unique[1]) : [];
    if (!operation.names.length) {
      if (operation.reference === 'previous') candidates = edges.filter(edge => edge.id === previous.lineId);
      else {
        const selected = await context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal);
        candidates = edges.filter(edge => selected.ids.includes(edge.id));
      }
    }
    if (candidates.length !== 1) return answer('没有命中唯一连线，请选中一条连线或明确端点及方向。');
    const edge = candidates[0]!;
    if (operation.reverse && edges.some(other => other.id !== edge.id && other.from.nodeId === edge.to.nodeId && other.to.nodeId === edge.from.nodeId && isTitleConnection(other) === isTitleConnection(edge))) return answer('反向已有相同线型的连线，请先核对。');
    const action: CanvasControlAction = operation.remove ? { type: 'delete', ids: [edge.id] } : { type: 'update-connection', id: edge.id,
      ...(operation.reverse ? { from: edge.to.nodeId, to: edge.from.nodeId } : {}), ...(operation.label !== undefined ? { label: operation.label } : {}), ...(operation.color ? { color: operation.color } : {}) };
    return makePlan([action], [edge.id, edge.from.nodeId, edge.to.nodeId], { ids: [edge.from.nodeId, edge.to.nodeId], lineId: edge.id });
  }
  if (operation.kind === 'align') {
    if (unique.length > 80) return answer('对齐目标超过 80 个，请缩小范围。');
    const nodes = await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: unique }, signal);
    if (nodes.length < 2) return answer('对齐至少需要两个节点。');
    const left = Math.min(...nodes.map(node => node.x)), right = Math.max(...nodes.map(node => node.x + node.width));
    const top = Math.min(...nodes.map(node => node.y)), bottom = Math.max(...nodes.map(node => node.y + node.height));
    return makePlan(nodes.map(node => ({ type: 'update-node', id: node.id,
      ...(['left', 'right', 'horizontal-center'].includes(operation.alignment) ? { x: operation.alignment === 'left' ? left : operation.alignment === 'right' ? right - node.width : (left + right - node.width) / 2 } :
        { y: operation.alignment === 'top' ? top : operation.alignment === 'bottom' ? bottom - node.height : (top + bottom - node.height) / 2 }) })), unique, { ids: unique });
  }
  if (operation.kind === 'find') return { ...answer(unique.length === 1 ? `找到「${title(unique[0]!)}」，已在画布定位。` : `找到 ${unique.length} 个节点，已在画布定位。`), next: { ids: unique, groupId: lookupGroup(operation.names[0])?.id }, focus: unique };
  if (operation.kind === 'relations') {
    const id = unique[0]!;
    const other = unique[1];
    const related = edges.filter(edge => (operation.direction !== 'in' && edge.from.nodeId === id && (!other || edge.to.nodeId === other)) || (operation.direction !== 'out' && edge.to.nodeId === id && (!other || edge.from.nodeId === other)));
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
  if (operation.kind === 'relative-color') {
    if (unique.length > 80) return answer('目标超过 80 个，请缩小改色范围。');
    const nodes = await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: unique }, signal);
    if (nodes.length !== unique.length) return answer('目标尚未创建或已变化，请重新指定。');
    return makePlan(nodes.map(node => ({
      type: 'update-node', id: node.id, color: shadeColor(node.titleColor, operation.direction),
    })), unique, { ids: unique });
  }
  if (operation.kind === 'presentation') return makePlan(unique.map(id => ({ type: 'update-node', id, presentation: operation.presentation, color: operation.color })), unique, { ids: unique });
  if (operation.kind === 'append') return makePlan(unique.map(id => ({ type: 'update-node', id, append: operation.text })), unique, { ids: unique });
  if (operation.kind === 'replace') {
    if (operation.occurrence !== undefined) {
      if (!operation.old || operation.old === operation.text || !unique.length || unique.length > 80) return answer('请指定需要替换的原文、新值和不超过 80 个节点。');
      const hits: SearchHit[] = [];
      const old = operation.old;
      const limit = 500;
      let totalLength = 0;
      for (const id of unique) {
        const source = sources.get(id);
        if (!source) return answer('请先应用新节点，再查找正文。');
        totalLength += source.length;
        if (totalLength > 2 * 1024 * 1024) return answer('本批正文超过 2 MiB，请缩小替换范围。');
        let count = 0;
        let lastEnd = 0;
        for (let start = 0; start < source.length; start += 8_192) {
          const parts = await context.capabilities.requestAll<AIContextReadContribution>('context.read@1', { sourceId: id, start, length: 8_192 + old.length - 1 }, signal);
          const part = parts.find(item => item.handled);
          if (part?.source?.revision !== source.revision) return answer('查找期间正文已变化，请重试。');
          const body = part.text ?? '';
          for (let at = body.indexOf(old, Math.max(0, lastEnd - start)); at >= 0 && at < 8_192; at = body.indexOf(old, at + old.length)) {
            count += 1;
            lastEnd = start + at + old.length;
            if (operation.occurrence === 'all' || count === operation.occurrence) {
              hits.push({ nodeId: id, title: source.title, field: 'body', revision: source.revision, start: start + at, length: old.length, matchedText: old,
                preview: body.slice(Math.max(0, at - 24), at + old.length + 24) });
            }
            if (hits.length > limit) return answer('命中超过 500 处，请缩小替换范围。');
          }
            if (typeof operation.occurrence === 'number' && count >= operation.occurrence) break;
        }
      }
      if (!hits.length) return answer('没有找到指定的正文命中。');
      return { plan: { version: 2, actions: [] }, targets: [...new Set(hits.map(hit => hit.nodeId))], next: { ids: unique }, replacement: { hits, replacement: operation.text } };
    }
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

export function shadeColor(color: string, direction: 'lighter' | 'darker'): string {
  const limit = direction === 'lighter' ? 255 : 0;
  const channels = color.slice(1).match(/../gu) ?? [];
  return '#' + channels.map(channel => Math.round(Number.parseInt(channel, 16) * 0.8 + limit * 0.2).toString(16).padStart(2, '0')).join('');
}
