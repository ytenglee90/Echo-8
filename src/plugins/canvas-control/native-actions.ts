import type { PluginContext, RegisteredAction } from '../../core/contracts.ts';
import { MAX_ANNOTATION_BODY_LENGTH, type AnnotationRecord, type AnnotationTarget } from '../../protocols/annotations.ts';
import type { AIContextCatalogContribution } from '../../protocols/ai.ts';
import type { AppearanceReadContribution } from '../../protocols/appearance.ts';
import { PALETTE_PRESET_LABELS } from '../../protocols/appearance.ts';
import type { CanvasControlNativeRequest } from '../../protocols/canvas-control.ts';
import { isTitleConnection, type ConnectionGraphSnapshot } from '../../protocols/connections.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { SelectionResolution, SelectionSnapshot } from '../../protocols/selection.ts';
import { canvasTitleAliases, normalizeCanvasTitle } from '../../services/canvas-titles.ts';
import type { NativeCanvasIntent } from '../../services/native-canvas-intent.ts';
import { readTaskMarkers } from './task-state.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { ContentSearchResultV2 } from '../../protocols/search.ts';

export interface NativeCanvasAction {
  label: string;
  ids: string[];
  review: boolean;
  pendingResult?(): boolean;
  apply(): Promise<string>;
}

const sameIds = (a: readonly string[], b: readonly string[]) => {
  const ids = new Set(b);
  return a.length === ids.size && a.every(id => ids.has(id));
};

export async function prepareNativeCanvasAction(context: PluginContext, input: CanvasControlNativeRequest, intent: NativeCanvasIntent, defaultScope: 'selection' | 'canvas' = 'selection'): Promise<NativeCanvasAction> {
  const selection = async () => {
    const current = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
    if (!input.selectedIds || !sameIds(input.selectedIds, current.ids)) throw new Error('选区已变化，请重新选定目标后发送。');
    if (!current.ids.length) throw new Error('请先在画布上选中要操作的对象。');
    return current;
  };
  const action = (label: string, apply: () => Promise<string>, ids: string[] = [], review = false) => ({ label, ids, review, apply });
  if (intent.kind === 'action') {
    const find = async () => (await context.queries.ask<RegisteredAction[]>('system.actions')).filter(item =>
      item.label === intent.label && /^(?:canvas|selection|group|connection|annotation|palette|minimap|layout|editor|search|clipboard|history)\./u.test(item.command));
    const candidates = await find();
    if (candidates.length !== 1) throw new Error('没有找到唯一可用的本地画布命令，请在命令面板中选择。');
    const target = candidates[0]!;
    return action(intent.label, async () => {
      if (!(await find()).some(item => item.owner === target.owner && item.id === target.id)) throw new Error('本地命令已停用，请重新选择。');
      await context.commands.invoke('system.action.execute', { owner: target.owner, id: target.id });
      return `已提交本地命令「${intent.label}」。`;
    });
  }
  if (intent.kind === 'view') {
    const commands = { 'zoom-in': 'canvas.zoomIn', 'zoom-out': 'canvas.zoomOut', 'reset-zoom': 'canvas.resetZoom',
      focus: 'canvas.focusSelection', 'select-all': 'selection.all', 'clear-selection': 'selection.clear',
      'minimap-open': 'minimap.open', 'minimap-close': 'minimap.close' } as const;
    return action('调整画布视图或选区', async () => {
      await context.commands.invoke(commands[intent.action]);
      return '已更新画布视图或选区。';
    });
  }
  if (intent.kind === 'preset') return action('应用配色方案', async () => {
    await context.commands.invoke('palette.applyPreset@1', { id: intent.id });
    return `已切换为${PALETTE_PRESET_LABELS[intent.id]}主题，完整配色已应用。`;
  });
  if (intent.kind === 'connection-color') {
    const current = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
    const chosen = current.items.filter(item => item.kind === 'connection').map(item => item.id);
    const global = intent.scope === 'canvas' || !intent.scope && !chosen.length && defaultScope === 'canvas';
    if (!global && (!chosen.length || !input.selectedIds || !sameIds(input.selectedIds, current.ids))) {
      throw new Error('请先选中要改色的连接线，或说“全部连接线改为蓝色”。');
    }
    const read = async () => (await context.capabilities.requestAll<AppearanceReadContribution>('appearance.read@1', {
      mode: global ? 'global' : 'selection', selectedIds: global ? [] : chosen,
      ...(global ? {} : { selectedItems: current.items.filter(item => chosen.includes(item.id)) }),
    })).flatMap(part => part.targets).filter(target => target.kind === 'connection-line').flatMap(target => target.entities);
    const entities = await read();
    if (!entities.length) throw new Error('当前范围没有可改色的连接线。');
    if (entities.length > 10_000) throw new Error('本次连接线超过 10000 条，请缩小范围。');
    return action(`将 ${entities.length} 条连接线改为 ${intent.color}`, async () => {
      const live = await read();
      const byId = new Map(live.map(entity => [entity.id, entity]));
      if (live.length !== entities.length || entities.some(entity => {
        const next = byId.get(entity.id);
        return !next || next.revision !== entity.revision || next.expectedColor !== entity.expectedColor;
      })) throw new Error('连接线或其颜色已变化，请重新发送要求。');
      await context.commands.invoke('palette.applyAppearance', { kind: 'connection-line', color: intent.color, entities });
      return `已将 ${entities.length} 条连接线改为 ${intent.color}，可一次撤销。`;
    }, entities.map(entity => entity.id));
  }
  if (intent.kind === 'connection-inspect') {
    const current = await selection();
    const ids = current.items.filter(item => item.kind === 'connection').map(item => item.id);
    if (!ids.length) throw new Error('请先选中要查看的连接线。');
    const [graph, groups] = await Promise.all([
      context.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1'),
      context.capabilities.request<GroupRecord[]>('groups.list@1').catch(() => []),
    ]);
    const selectedEdges = graph.connections.filter(edge => ids.includes(edge.id));
    if (selectedEdges.length !== ids.length) throw new Error('选中的连接线已变化，请重新选择。');
    const endpointIds = [...new Set(selectedEdges.flatMap(edge => [edge.from.nodeId, edge.to.nodeId]))];
    const nodes = await context.capabilities.request<import('../../protocols/content.ts').ContentSummary[]>('content.summariesById@1', { nodeIds: endpointIds });
    const titles = new Map([...nodes.map(node => [node.id, node.title] as const), ...groups.map(group => [group.id, group.title] as const),
      ...graph.junctions.map((point, index) => [point.id, `中转点 ${index + 1}`] as const)]);
    const message = `选中的 ${selectedEdges.length} 条连接线：\n` + selectedEdges.map((edge, index) =>
      `${index + 1}. ${titles.get(edge.from.nodeId) ?? '已失效端点'} → ${titles.get(edge.to.nodeId) ?? '已失效端点'}（${isTitleConnection(edge) ? '虚线' : '实线'}）`).join('\n');
    return action('查看选中连线端点', async () => message);
  }
  if (intent.kind === 'undo' || intent.kind === 'redo') {
    const undo = intent.kind === 'undo';
    const label = undo ? '撤销' : '重做';
    return action(label, async () => {
      const state = await context.queries.ask<{ nextUndo?: string; nextRedo?: string }>('history.state');
      const next = undo ? state.nextUndo : state.nextRedo;
      if (next?.startsWith('记录 AI ')) return `下一项是「${next}」。如需处理这条对话记录，请使用历史控制。`;
      return await context.commands.invoke(undo ? 'history.undo' : 'history.redo')
        ? `已${label}上一项画布操作。` : `没有可${label}的画布操作。`;
    });
  }
  if (intent.kind === 'paste') {
    const clipboardState = () => context.capabilities.request<{ copiedAt?: number; count: number; hasContent: boolean }>('clipboard.state@1');
    const initial = await clipboardState();
    if (!initial.hasContent) throw new Error('内部剪贴板为空，请先复制或剪切。');
    return action('粘贴内部剪贴板', async () => {
      const live = await clipboardState();
      if (!live.hasContent || live.copiedAt !== initial.copiedAt || live.count !== initial.count) throw new Error('剪贴板已变化，请重新准备粘贴。');
      const result = await context.commands.invoke('clipboard.paste') as { created: number };
      return `已粘贴 ${result.created} 个选中项，可一次撤销。`;
    });
  }
  if (intent.kind === 'preferences') {
    const label = `${intent.label}颜色改为 ${intent.color}`;
    return action(label, async () => {
      await context.commands.invoke('palette.setPreferences', { [intent.property]: intent.color });
      return `已将${label}。`;
    });
  }
  if (intent.kind === 'copy' || intent.kind === 'cut') {
    const initial = await selection();
    if (intent.expectedCount && initial.ids.length !== intent.expectedCount) throw new Error(`本轮指定 ${intent.expectedCount} 个对象，当前选中 ${initial.ids.length} 个。`);
    if (intent.expectedKind && initial.items.some(item => item.kind !== intent.expectedKind)) {
      throw new Error(`选区包含其他类型的画布对象，请只选中要处理的${intent.expectedKind === 'group' ? '群组' : '节点'}。`);
    }
    const cut = intent.kind === 'cut';
    const resolve = (value: SelectionSnapshot) => context.capabilities.request<SelectionResolution>('selection.resolve@1', { items: value.items, mode: 'replace' });
    const expanded = cut ? (await resolve(initial)).expandedIds : initial.ids;
    const before = cut ? (await readTaskMarkers(context, expanded)).markers : undefined;
    return action(`${cut ? '剪切' : '复制'} ${initial.ids.length} 个选中项`, async () => {
      const current = await selection();
      if (before) {
        if (!sameIds(expanded, (await resolve(current)).expandedIds)) throw new Error('群组成员已变化，请重新准备剪切。');
        const verified = (await readTaskMarkers(context, expanded)).markers;
        if (expanded.some(id => verified[id] !== before[id])) throw new Error('选中内容已变化，请重新准备剪切。');
      }
      const result = await context.commands.invoke('clipboard.copy') as { count: number };
      if (cut) {
        const deleted = await context.commands.invoke('selection.delete') as { deleted: number };
        if (!deleted.deleted) throw new Error('已复制到剪贴板，原对象未删除。');
      }
      return `已${cut ? '剪切' : '复制'} ${result.count} 个选中项到内部剪贴板。`;
    }, expanded, cut);
  }
  if (intent.kind === 'junction') {
    if (intent.scope === 'canvas') {
      const readEdges = async () => {
        const [graph, catalogs, groups] = await Promise.all([
          context.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1'),
          context.capabilities.requestAll<AIContextCatalogContribution>('context.catalog@1'),
          context.capabilities.request<GroupRecord[]>('groups.list@1').catch(() => []),
        ]);
        const readable = new Set(catalogs.flatMap(catalog => catalog.sources)
          .filter(source => source.kind === 'text' && (source.automaticRetrieval !== false || input.sourceIds?.includes(source.sourceId)))
          .map(source => source.sourceId));
        for (const group of groups) if (group.memberIds.every(id => readable.has(id))) readable.add(group.id);
        return graph.connections.filter(edge => isTitleConnection(edge) === (intent.line === 'dashed') &&
          readable.has(edge.from.nodeId) && readable.has(edge.to.nodeId));
      };
      const edges = await readEdges();
      const label = intent.line === 'dashed' ? '虚线' : '实线';
      if (!edges.length) throw new Error(`没有找到可添加中转点的${label}。请选中需要处理的连线。`);
      if (edges.length > 10_000) throw new Error('一次最多处理 10000 条连接线，请分批选择。');
      const references = edges.map(edge => ({ id: edge.id, revision: edge.revision }));
      return action(`给 ${edges.length} 条${label}添加一个共用中转点`, async () => {
        const live = await readEdges();
        const revisions = new Map(live.map(edge => [edge.id, edge.revision]));
        if (live.length !== edges.length || edges.some(edge => revisions.get(edge.id) !== edge.revision)) {
          throw new Error('这批连接线或可操作范围已变化，请重新发送要求。');
        }
        const result = await context.commands.invoke('connection.addJunctionForEdges@1', { connections: references, shared: true });
        return `已为 ${edges.length} 条${label}添加 ${result.ids.length} 个共用中转点，可一次撤销。`;
      }, edges.map(edge => edge.id));
    }
    const current = await selection();
    const graph = await context.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
    const chosen = new Set(current.ids);
    const edges = graph.connections.filter(edge => chosen.has(edge.id));
    if (!edges.length || edges.length !== chosen.size) throw new Error('请只选中要添加中转点的连接线。');
    return action(`给 ${edges.length} 条连接线添加中转点`, async () => {
      await selection();
      const live = await context.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
      const revisions = new Map(live.connections.map(edge => [edge.id, edge.revision]));
      if (edges.some(edge => revisions.get(edge.id) !== edge.revision)) throw new Error('连接线已变化，请重新准备。');
      const result = await context.commands.invoke('connection.toolbarToggle@1', { kind: 'junction' });
      return `已添加 ${result.ids?.length ?? 0} 个中转点，可一次撤销。`;
    }, current.ids);
  }
  if (intent.kind === 'annotation-create') {
    assertBodyLength(intent.body);
    let quote = intent.quote;
    let target = intent.name ? await namedAnnotationTarget(context, intent.name, input.sourceIds) : undefined;
    if (!target && intent.quote) throw new Error(`没有找到唯一可读取的节点「${intent.name}」。`);
    const selectionBound = !target;
    if (!target) {
      target = annotationTarget(await selection());
      if (intent.name && !quote) quote = intent.name;
    }
    let textRevision: number | undefined;
    if (quote) {
      if (target.kind !== 'text-node') throw new Error('正文文字注释需要指定一个文字节点。');
      const result = await context.capabilities.request<ContentSearchResultV2>('content.search@2', {
        query: quote, nodeIds: [target.targetId], matchCase: true, wholeWord: false, maxResults: 3,
      });
      const hits = result.hits.filter(hit => hit.field === 'body');
      if (result.truncated || hits.length !== 1) throw new Error(hits.length
        ? `「${quote}」在该节点出现多次，请先在编辑器中选中具体位置再添加注释。`
        : `该节点正文中没有找到「${quote}」，请核对文字。`);
      textRevision = hits[0]!.revision;
      target = { kind: 'text-range', targetId: target.targetId, offset: hits[0]!.start };
    }
    return action(`为${intent.name ? `「${intent.name}」` : '选中对象'}添加标注`, async () => {
      if (selectionBound) await selection();
      const exists = target.kind === 'group'
        ? (await context.capabilities.request<GroupRecord[]>('groups.list@1')).some(group => group.id === target.targetId)
        : (await context.capabilities.request<Array<{ id: string }>>('content.summariesById@1', { nodeIds: [target.targetId] })).some(node => node.id === target.targetId);
      if (!exists) throw new Error('标注对象已不存在，请重新指定。');
      if (textRevision !== undefined) {
        const [live] = await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: [target.targetId] });
        if (live?.revision !== textRevision) throw new Error('节点正文已变化，请重新定位注释文字。');
      }
      await context.commands.invoke('annotation.create', { target, body: intent.body });
      return quote ? `已在「${quote}」处添加注释，可一次撤销。` : '已添加标注，可一次撤销。';
    }, [target.targetId]);
  }

  const current = await selection();
  if (current.items.length !== 1 || current.items[0]?.kind !== 'annotation') throw new Error('请只选中要修改的一个标注。');
  const id = current.items[0].id;
  const records = () => context.capabilities.request<AnnotationRecord[]>('annotations.list@1');
  const annotation = (await records()).find(record => record.id === id);
  if (!annotation) throw new Error('标注已不存在。');
  const ensureRevision = async () => {
    const live = (await records()).find(record => record.id === id);
    if (live?.revision !== annotation.revision) throw new Error('标注已变化，请重新准备。');
  };
  if (intent.kind === 'annotation-delete') return action('删除选中的标注', async () => {
    await ensureRevision();
    await context.commands.invoke('annotation.delete', { id });
    return '已删除标注，可一次撤销。';
  }, [id], true);
  if (intent.kind === 'annotation-update') {
    assertBodyLength(intent.body);
    return action('替换选中标注的内容', async () => {
      await context.commands.invoke('annotation.update', { id, body: intent.body, expectedRevision: annotation.revision });
      return '已更新标注内容，可一次撤销。';
    }, [id], Boolean(annotation.body));
  }
  if (intent.kind !== 'annotation-color') throw new Error('这项标注指令尚不可用。');
  const { color } = intent;
  const contributions = await context.capabilities.requestAll<AppearanceReadContribution>('appearance.read@1', {
    mode: 'selection', selectedIds: [id], selectedItems: current.items,
  });
  const target = contributions.flatMap(item => item.targets).find(item => item.kind === 'annotation-marker');
  const entity = target?.entities.find(item => item.id === id);
  if (!entity) throw new Error('没有找到选中标注的颜色。');
  return action(`选中标注改色为 ${color}`, async () => {
    await context.commands.invoke('palette.applyAppearance', { kind: 'annotation-marker', color, entities: [entity] });
    return `已将标注颜色设为 ${color}。`;
  }, [id]);
}

function assertBodyLength(body: string | undefined): void {
  if (body && body.length > MAX_ANNOTATION_BODY_LENGTH) throw new Error('标注正文超过可写入长度，请缩短后重试。');
}

function annotationTarget(selection: SelectionSnapshot): AnnotationTarget {
  const item = selection.items[0];
  if (selection.items.length !== 1 || (item?.kind !== 'text-node' && item?.kind !== 'group')) throw new Error('请只选中一个需要添加标注的节点或群组。');
  return { kind: item.kind, targetId: item.id };
}

async function namedAnnotationTarget(context: PluginContext, name: string, sourceIds?: string[]): Promise<AnnotationTarget | undefined> {
  const key = normalizeCanvasTitle(name);
  const [catalogs, groups] = await Promise.all([
    context.capabilities.requestAll<AIContextCatalogContribution>('context.catalog@1'),
    context.capabilities.request<GroupRecord[]>('groups.list@1').catch(() => []),
  ]);
  const nodes = catalogs.flatMap(catalog => catalog.sources).filter(source => source.kind === 'text' && canvasTitleAliases(source.title).includes(key));
  const explicit = nodes.filter(node => sourceIds?.includes(node.sourceId));
  const targets: AnnotationTarget[] = (explicit.length ? explicit : nodes.filter(node => node.automaticRetrieval !== false))
    .map(node => ({ kind: 'text-node', targetId: node.sourceId }));
  if (!explicit.length) targets.push(...groups.filter(group => normalizeCanvasTitle(group.title) === key)
    .map(group => ({ kind: 'group' as const, targetId: group.id })));
  if (targets.length > 1) throw new Error(`请选中要添加标注的唯一对象「${name}」。`);
  return targets[0]!;
}
