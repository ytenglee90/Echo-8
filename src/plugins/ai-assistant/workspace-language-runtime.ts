import { isRecord, type PluginContext, type RegisteredShortcut } from '../../core/contracts.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { AnnotationRecord } from '../../protocols/annotations.ts';
import type { ClipboardSourceSnapshot } from '../../protocols/clipboard.ts';
import type { CameraState, CanvasViewportSize } from '../../protocols/canvas.ts';
import { canvasTitleAliases } from '../../services/canvas-titles.ts';
import { naturalNames } from '../../services/natural-canvas-rules.ts';
import type { TextFormattingSnapshot } from '../../protocols/formatting.ts';
import type { WorkspaceActionIndex, WorkspacePlanStep } from '../../protocols/workspace-actions.ts';
import type { CatalogIntent } from '../../services/workspace-catalog-intent.ts';
import { compileWorkspaceLanguage, workspaceNameKey, type WorkspaceLanguageStep } from '../../services/workspace-language.ts';
import { selectedWorkspaceName } from '../../services/workspace-selection-reference.ts';
import { isCapabilityUnavailable } from './runtime-errors.ts';

class MissingWorkspaceArgument extends Error {}
class UnavailableWorkspaceResource extends Error {}

function mentionedObjects<T extends { id: string; title: string }>(input: string, nodes: T[]): T[] {
  const text = workspaceNameKey(input);
  const quoted = [...text.matchAll(/「([^」]+)」|『([^』]+)』|“([^”]+)”|"([^"]+)"/gu)].map(match => ({
    start: match.index! + 1, end: match.index! + match[0].length - 1,
  }));
  const aliases = (title: string) => [...new Set([
    workspaceNameKey(title),
    workspaceNameKey(title).replace(/(\p{Script=Han})\s+(?=\d+$)/u, '$1'),
    workspaceNameKey(title).replace(/(\p{Script=Han})(\d+)$/u, '$1 $2'),
  ])];
  const matches = nodes.flatMap(node => aliases(node.title).flatMap(name => {
    if (name.length < 2 && !/[「『“"]/u.test(input)) return [];
    const start = text.indexOf(name);
    const end = start + name.length;
    return start < 0 || !name || quoted.some(quote => quote.start <= start && end <= quote.end &&
      (quote.start !== start || quote.end !== end)) ? [] : [{ node, start, end }];
  }));
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const found = new Map<string, T>();
  let previous: (typeof matches)[number] | undefined;
  for (const match of matches) {
    if (previous && match.start < previous.end && (match.start !== previous.start || match.end !== previous.end)) continue;
    found.set(match.node.id, match.node);
    previous = match;
  }
  return [...found.values()];
}

async function bindCatalogArguments(
  context: PluginContext, intent: CatalogIntent, sessionId: string, assistantId: string | undefined,
  selectedIds: string[] | undefined, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const { binding, steps, input } = intent;
  const step = steps[0]!;
  if (binding === 'assistant') {
    if (!assistantId) throw new MissingWorkspaceArgument('请从需要调整的助手窗口发送。');
    return { assistantId };
  }
  if (binding === 'session') return { sessionId };
  if (binding === 'selected-editor') {
    if (selectedIds?.length !== 1) throw new MissingWorkspaceArgument('请在发送时选中唯一要打开的节点。');
    const nodes = await context.capabilities.request<ContentSummary[]>('content.canvasSummariesById@1', { nodeIds: selectedIds }, signal);
    if (nodes.length !== 1) throw new MissingWorkspaceArgument('发送时选中的对象不是可编辑的文字节点。');
    return { target: { id: nodes[0]!.id } };
  }
  if (binding === 'provider') {
    if (!assistantId) throw new MissingWorkspaceArgument('请从需要切换模型的助手窗口发送。');
    const catalog = await context.capabilities.request<{ options: Array<{ id: string; label: string; model: string; configured: boolean }> }>('ai.provider.catalog@1', undefined, signal);
    const name = workspaceNameKey(intent.operand ?? '');
    const matches = catalog.options.filter(option => option.configured && [option.id, option.label, option.model].some(value => workspaceNameKey(value) === name));
    if (matches.length !== 1) throw new MissingWorkspaceArgument('请指定已配置的唯一模型名称；模型不存在或同名时不会自动选择。');
    return { assistantId, resourceId: matches[0]!.id };
  }
  if (binding === 'pane-ratios') {
    const panes = await context.queries.ask<string[]>('editor.openPanes');
    if (!intent.ratioWeights || panes.length !== intent.ratioWeights.length) {
      throw new UnavailableWorkspaceResource('请先打开与所给比例数量一致的编辑窗格。');
    }
    return { ratios: Object.fromEntries(panes.map((id, index) => [id, intent.ratioWeights![index]])) };
  }
  if (binding === 'import-text') {
    const [camera, viewport] = await Promise.all([
      context.capabilities.request<CameraState>('canvas.camera@1', undefined, signal),
      context.capabilities.request<CanvasViewportSize>('canvas.viewport@1', undefined, signal),
    ]);
    return { x: (viewport.width / 2 - camera.x) / camera.zoom, y: (viewport.height / 2 - camera.y) / camera.zoom };
  }
  if (binding === 'shortcut') {
    const shortcuts = await context.queries.ask<RegisteredShortcut[]>('system.shortcuts');
    const normalize = (value: string) => workspaceNameKey(value).replace(/选区|选中(?:的)?(?:对象|项)/gu, '选中');
    const operand = normalize(intent.operand ?? input);
    const matches = shortcuts.filter(shortcut => {
      const label = normalize(shortcut.label);
      const base = label.endsWith('选中') ? label.slice(0, -2) : label;
      return operand.includes(label) || ['操作', '快捷键', '按键'].some(suffix => operand.includes(base + suffix));
    });
    if (matches.length !== 1) throw new MissingWorkspaceArgument('请指定唯一的已有快捷键名称。');
    const chord = typeof step.arguments?.chord === 'string' ? step.arguments.chord.normalize('NFKC')
      .replace(/Control|Ctrl/giu, 'mod').replace(/加/gu, '+').replace(/\s+/gu, '').toLowerCase() : undefined;
    return { targetOwner: matches[0]!.owner, targetId: matches[0]!.id, ...(chord ? { chord } : {}) };
  }
  if (binding === 'template') {
    if (!assistantId) throw new MissingWorkspaceArgument('请从需要调整模板的助手窗口发送。');
    const catalog = await context.queries.ask<{ templates: Array<{ id: string; name: string }> }>('ai.promptTemplates');
    if (catalog.templates.length === 0) throw new UnavailableWorkspaceResource('本机尚未配置任何可选的提示模板，请先在模板中心添加。');
    const operand = workspaceNameKey(intent.operand ?? input);
    const matches = catalog.templates.filter(template => operand.includes(workspaceNameKey(template.name)));
    if (matches.length !== 1) throw new MissingWorkspaceArgument('请指定本机已有的唯一模板名称。');
    return { assistantId, resourceId: matches[0]!.id };
  }
  if (binding === 'checkpoint') {
    const points = await context.queries.ask<Array<{ id: string; label?: string }>>('system.recovery.list');
    const title = workspaceNameKey(input);
    const named = points.filter(point => point.label && title.includes(workspaceNameKey(point.label)));
    if (named.length !== 1) throw new MissingWorkspaceArgument('请给出要预览的恢复点名称。');
    return { id: named[0]!.id };
  }
  if (binding === 'clipboard-paste' && /^(?:内部)?剪贴板(?:里|中)(?:的)?(?:内容|节点|卡片?)$/u.test(intent.operand ?? '')) {
    const snapshot = await context.capabilities.request<ClipboardSourceSnapshot>('clipboard.sources@1', undefined, signal);
    if (snapshot.copiedAt === undefined || !snapshot.sourceIds.length) throw new UnavailableWorkspaceResource('内部剪贴板为空，请先复制内容。');
    return { copiedAt: snapshot.copiedAt, sourceIds: snapshot.sourceIds };
  }
  let group: GroupRecord | undefined;
  if (binding === 'group' || binding === 'group-member' || binding === 'group-members') {
    const groups = await context.capabilities.request<GroupRecord[]>('groups.list@1', undefined, signal);
    const matches = mentionedObjects(intent.groupOperand ?? intent.operand ?? input, groups);
    if (matches.length !== 1) throw new MissingWorkspaceArgument('请给出唯一的群组名称。');
    group = matches[0]!;
    if (binding === 'group') return { id: group.id };
    if (binding === 'group-members') return { nodeIds: [...group.memberIds] };
  }
  const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1', undefined, signal);
  const operand = intent.operand ?? (binding === 'paragraph-replacement' && typeof step.arguments?.text === 'string'
    ? input.replace(step.arguments.text, '') : input);
  if (binding === 'members' || binding === 'duplicate') {
    const references = naturalNames(operand);
    const members = references.map(name => {
      const key = workspaceNameKey(name);
      const aliases = nodes.filter(node => canvasTitleAliases(node.title).some(alias => workspaceNameKey(alias) === key));
      return aliases.length ? aliases : mentionedObjects(name, nodes);
    });
    if (members.length < (binding === 'duplicate' ? 1 : 2) || members.length > 80 || members.some(matches => matches.length !== 1) ||
      new Set(members.map(matches => matches[0]?.id)).size !== members.length) {
      throw new MissingWorkspaceArgument('请指定每一张卡片的唯一名称，或明确使用当前选区。');
    }
    if (binding === 'duplicate') return { sourceIds: members.map(matches => matches[0]!.id), expectedKind: 'text-node' };
    return { members: members.map(matches => ({ id: matches[0]!.id })) };
  }
  const mentions = mentionedObjects(group && !intent.groupOperand ? operand.replace(group.title, '') : operand, nodes);
  if (binding === 'two-nodes' || binding === 'node-ids') {
    const selected = new Map(nodes.map(node => [node.id, node]));
    const plural = /^(?:查看|对比|比较|对照)?(?:这|选中(?:的)?)(?:两|二|2)(?:个|张)(?:章节|节点|卡片?)/u.test(input);
    const targets = mentions.length ? mentions : plural
      ? (selectedIds ?? []).flatMap(id => selected.get(id) ?? []) : [];
    if (binding === 'node-ids' && targets.length >= 1 && targets.length <= 100) return { [intent.idArgument ?? 'nodeIds']: targets.map(node => node.id) };
    if (binding === 'two-nodes' && targets.length === 2) {
      const [left, right] = targets.map(node => ({ id: node.id }));
      return step.action === 'connection.path' ? { from: left, to: right } : { left, right };
    }
    throw new MissingWorkspaceArgument(binding === 'two-nodes' ? '请指定两个不同的卡片。' : '请指定要统计的卡片名称。');
  }
  if (mentions.length !== 1) throw new MissingWorkspaceArgument('请指定唯一的卡片名称。');
  const node = mentions[0]!;
  const target = { id: node.id };
  if (binding === 'clipboard-paste' || binding === 'selected-node' || binding === 'clipboard-selection' && step.action === 'clipboard.cut') {
    const raw = workspaceNameKey(operand);
    const literal = raw.replace(/^[「『“"]|[」』”"]$/gu, '');
    const unwrapped = selectedWorkspaceName(literal) ?? literal;
    const keys = [unwrapped, unwrapped.replace(/(?:的)?(?:卡片?|节点|文本框)$/u, '')];
    if (!canvasTitleAliases(node.title).some(alias => keys.includes(workspaceNameKey(alias)))) {
      throw new MissingWorkspaceArgument('请完整指定剪贴板操作的对象和范围。');
    }
  }
  if (binding === 'selected-node') {
    if (selectedIds?.length !== 1 || selectedIds[0] !== node.id) {
      throw new MissingWorkspaceArgument('发送时的选区与所指的唯一卡片不一致，请重新选中。');
    }
    return { entityId: node.id };
  }
  if (binding === 'clipboard-paste') {
    const snapshot = await context.capabilities.request<ClipboardSourceSnapshot>('clipboard.sources@1', undefined, signal);
    if (snapshot.copiedAt === undefined || snapshot.sourceIds.length !== 1 || snapshot.sourceIds[0] !== node.id) {
      throw new MissingWorkspaceArgument('内部剪贴板中没有所指的唯一卡片，请先复制该卡。');
    }
    return { copiedAt: snapshot.copiedAt, sourceIds: snapshot.sourceIds };
  }
  if (binding === 'group-member' && group) {
    if (step.action === 'group.remove' && !group.memberIds.includes(node.id)) {
      throw new MissingWorkspaceArgument('该卡片目前不在指定群组内。');
    }
    return { groupId: group.id, nodeIds: [node.id] };
  }
  if (binding === 'annotation') {
    const annotations = await context.capabilities.request<AnnotationRecord[]>('annotations.list@1', undefined, signal).catch(error => {
      if (isCapabilityUnavailable(error, 'annotations.list@1')) throw new MissingWorkspaceArgument('当前无法在本地读取卡片标注。');
      throw error;
    });
    const matches = annotations.filter(annotation => annotation.target.targetId === node.id);
    if (matches.length !== 1) throw new MissingWorkspaceArgument('该卡片没有唯一可确定的标注，请明确具体标注。');
    return { id: matches[0]!.id, expectedRevision: matches[0]!.revision };
  }
  if (binding === 'node') return { target };
  if (binding === 'clipboard-selection') {
    if (selectedIds?.length !== 1 || selectedIds[0] !== node.id) {
      throw new MissingWorkspaceArgument('请先只选中要复制的这张卡片。');
    }
    return { sourceIds: [node.id], expectedKind: 'text-node' };
  }
  if (binding === 'format' || binding === 'range-format' || binding === 'range-reveal') {
    const { start, end } = step.arguments ?? {};
    if (binding !== 'format' && (typeof end !== 'number' || end > node.length)) {
      throw new MissingWorkspaceArgument('指定的字符范围超出了这张卡片的正文。');
    }
    if (binding === 'range-reveal') return { target, revision: node.revision };
    const format = await context.capabilities.request<TextFormattingSnapshot>('content.formatting@2', {
      nodeId: node.id, start: start ?? 0, length: typeof start === 'number' && typeof end === 'number' ? end - start : 1,
    }, signal);
    if (format.contentRevision !== node.revision) throw new MissingWorkspaceArgument('正文已变化，请重新发送。');
    return { target, expectedRevision: format.revision,
      ...(binding === 'range-format' ? { expectedContentRevision: format.contentRevision } : {}) };
  }
  const size = 16_384;
  const range = await context.capabilities.request<{ text: string; revision: number }>(
    'content.read@1', { nodeId: node.id, start: 0, length: size }, signal,
  );
  if (range.revision !== node.revision) throw new MissingWorkspaceArgument('正文已变化，请重新发送。');
  const paragraph = /\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/u.exec(range.text);
  if (!paragraph || paragraph.index + paragraph[0].length >= size && node.length > size ||
    node.length > range.text.length && !/\r?\n[ \t]*\r?\n/u.test(range.text.slice(paragraph.index + paragraph[0].length))) {
    throw new MissingWorkspaceArgument('首段超出读取范围或为空，请明确要操作的文字范围。');
  }
  const start = paragraph.index;
  const length = paragraph[0].trimEnd().length;
  return binding === 'paragraph' || binding === 'paragraph-extract' ? { target, start, length, expectedRevision: node.revision }
    : { target, start, deleteCount: length, expectedRevision: node.revision };
}

export async function prepareCatalogIntent(
  context: PluginContext, intent: CatalogIntent, sessionId: string, assistantId: string | undefined,
  selectedIds: string[] | undefined, signal: AbortSignal,
): Promise<{ steps?: WorkspaceLanguageStep[]; clarify?: string }> {
  const index = await context.queries.ask<WorkspaceActionIndex>('workspace.actions@1').catch(error => {
    if (error instanceof Error && error.message === 'Query unavailable: workspace.actions@1') return undefined;
    throw error;
  });
  signal.throwIfAborted();
  const available = new Set(index?.actions.filter(action => action.status === 'available').map(action => action.id));
  if (intent.steps.some(step => !available.has(step.action)) || intent.binding === 'range-reveal' && !available.has('editor.activate')) {
    return { clarify: '本地工作区动作当前无法使用，请检查对应功能是否启用。' };
  }
  if (intent.parts) {
    const effects = new Map(index?.actions.map(action => [action.id, action.effect]));
    if (intent.steps.some(step => !['query', 'workspace'].includes(effects.get(step.action) ?? ''))) {
      return { clarify: '这份组合中的文档或文件步骤暂未接入自动执行。' };
    }
    const prepared = await Promise.all(intent.parts.map(part =>
      prepareCatalogIntent(context, part, sessionId, assistantId, selectedIds, signal)));
    const clarification = prepared.find(part => part.clarify)?.clarify;
    if (clarification) return { clarify: clarification };
    const steps: WorkspaceLanguageStep[] = [];
    for (const [partIndex, part] of prepared.entries()) {
      const names = new Map(part.steps?.map(step => [step.id, 'sequence-' + (partIndex + 1) + '-' + step.id]));
      const remap = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(remap);
        if (!isRecord(value)) return value;
        return Object.fromEntries(Object.entries(value).map(([key, field]) =>
          [key, (key === '$step' || key === 'from') && typeof field === 'string' && names.has(field) ? names.get(field) : remap(field)]));
      };
      for (const [stepIndex, step] of (part.steps ?? []).entries()) {
        const previous = steps.at(-1)?.id;
        steps.push({ ...step, id: names.get(step.id)!,
          arguments: remap(step.arguments) as Record<string, unknown> | undefined,
          dependsOn: [...(step.dependsOn ?? []).map(id => names.get(id) ?? id), ...(stepIndex === 0 && previous ? [previous] : [])],
          ...(step.when ? { when: { ...step.when, step: names.get(step.when.step) ?? step.when.step } } : {}),
        });
      }
    }
    return steps.length <= 24 ? { steps } : { clarify: '组合步骤超过 24 项，请分批发送。' };
  }
  if (intent.primitive && intent.steps.some(step => step.arguments?.target || step.arguments?.targets)) {
    const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1', undefined, signal);
    const steps = compileWorkspaceLanguage(intent.input, new Set(nodes.map(node => workspaceNameKey(node.title))));
    return steps ? { steps } : { clarify: '无法完整核对这一步的对象，请明确名称。' };
  }
  if (!intent.binding) return { steps: intent.steps };
  try {
    const args = await bindCatalogArguments(context, intent, sessionId, assistantId, selectedIds, signal);
    const steps = intent.steps.map((step, i) => i === 0 ? { ...step, arguments: { ...step.arguments, ...args } } : step);
    if (intent.binding === 'range-reveal') steps.unshift({ id: 'activate-for-range', action: 'editor.activate', arguments: { target: args.target } });
    return { steps };
  } catch (error) {
    if (error instanceof UnavailableWorkspaceResource) return { clarify: error.message };
    if (error instanceof MissingWorkspaceArgument) return { clarify: '还不能可靠核对这项操作的对象或范围。' + error.message };
    throw error;
  }
}

function quoteOperand(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value)) return undefined;
  const pair = ['「」', '『』', '“”', '""'].find(([open, close]) => !value.includes(open!) && !value.includes(close!));
  return pair ? pair[0] + value + pair[1] : undefined;
}

/** Keep the canvas-control owner's review and retry flow for existing title edits. */
export function workspaceDocumentInstruction(steps: WorkspacePlanStep[] | undefined): string | undefined {
  if (steps?.length !== 1) return undefined;
  const { action, arguments: args } = steps[0]!;
  const title = quoteOperand(args?.title);
  if (!title) return undefined;
  if (action === 'node.create') return '新建一个叫' + title + '的节点';
  if (action !== 'node.rename' || !isRecord(args?.target)) return undefined;
  const target = quoteOperand(args.target.title);
  return target ? '把' + target + '改名为' + title : undefined;
}

export async function bindWorkspaceLanguage(
  context: PluginContext, steps: WorkspaceLanguageStep[], selectedIds: string[] | undefined, signal: AbortSignal,
): Promise<WorkspacePlanStep[]> {
  const groupTitle = (step: WorkspaceLanguageStep): string | undefined => {
    if (step.group) return step.group.title;
    const target = step.arguments?.target;
    if (step.action === 'viewport.set' && isRecord(target) && typeof target.title === 'string' && /组$/u.test(target.title)) return target.title;
    return undefined;
  };
  const mayUseGroup = steps.some(step => groupTitle(step) !== undefined);
  const [groups, nodes, emptySelection] = await Promise.all([
    mayUseGroup ?
    context.capabilities.request<GroupRecord[]>('groups.list@1', undefined, signal)
      .catch(error => { if (isCapabilityUnavailable(error, 'groups.list@1')) return []; throw error; }) : [],
    mayUseGroup ?
    context.capabilities.request<ContentSummary[]>('content.summaries@1', undefined, signal)
      .catch(error => { if (isCapabilityUnavailable(error, 'content.summaries@1')) return []; throw error; }) : [],
    selectedIds?.length && steps.some(step => step.selection?.emptyOnly) ?
      context.capabilities.request<ContentSummary[]>('content.canvasSummariesById@1', { nodeIds: selectedIds }, signal) : [],
  ]);
  return steps.map(({ group, selection, ...step }, index) => {
    if (index > 0) step.dependsOn = [steps[index - 1]!.id];
    if (selection) {
      if (!selectedIds?.length) throw new Error('发送时没有选中对象，请先选中要操作的对象。');
      if (selection.expectedCount !== undefined && selection.expectedCount !== selectedIds.length) {
        throw new Error('你指定了 ' + selection.expectedCount + ' 张卡片，发送时实际选中 ' + selectedIds.length + ' 个对象。');
      }
      if (selection.emptyOnly && (emptySelection.length !== selectedIds.length || emptySelection.some(node => node.length > 0))) {
        throw new Error('发送时选中的对象中包含非空白卡片。');
      }
      if (['clipboard.copy', 'clipboard.cut', 'clipboard.duplicate'].includes(step.action)) {
        step.arguments = { ...step.arguments, sourceIds: [...selectedIds], expectedKind: selection.expectedKind };
      } else if (step.action === 'group.createExplicit') {
        if (selectedIds.length < 2) throw new Error('分组至少需要两张卡片。');
        step.arguments = { ...step.arguments, members: selectedIds.map(id => ({ id })) };
      } else step.arguments = { ...step.arguments, [selection.argument ?? 'nodeIds']: [...selectedIds] };
    }
    const title = groupTitle({ ...step, group });
    if (!title) return step;
    const key = workspaceNameKey(title);
    const matchingGroups = groups.filter(item => workspaceNameKey(item.title) === key);
    const matchingNodes = group ? [] : nodes.filter(item => workspaceNameKey(item.title) === key);
    if (matchingGroups.length + matchingNodes.length > 1 && matchingGroups.length) {
      throw new Error('「' + title + '」对应多个对象，请明确群组或卡片名称。');
    }
    const match = matchingGroups[0];
    if (!match && group) throw new Error('没有找到群组「' + title + '」。');
    if (!match) return step;
    if (group) return { ...step, arguments: { id: match.id } };
    return { ...step, action: 'viewport.focusEntity', arguments: {
      entityId: match.id, ...(step.arguments?.zoom === undefined ? {} : { zoom: step.arguments.zoom }),
    } };
  });
}
