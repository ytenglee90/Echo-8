import { isRecord, type PluginContext } from '../../core/contracts.ts';
import type { CameraState, CanvasViewportSize } from '../../protocols/canvas.ts';
import type { SelectionCatalogContribution } from '../../protocols/selection.ts';
import type { KnownCommandType } from '../../protocols/commands.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import { isClipboardCopySelectionRequest, MAX_CLIPBOARD_SOURCE_IDS } from '../../protocols/clipboard.ts';
import type { AnnotationRecord } from '../../protocols/annotations.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { ConnectionGraphSnapshot } from '../../protocols/connections.ts';
import type { ContentStatistics } from '../../protocols/statistics.ts';
import type { CanvasControlPlan } from '../../protocols/canvas-control.ts';
import type { KnownCapabilityType, KnownQueryType } from '../../protocols/messages.ts';
import type { WorkspaceActionDescriptor, WorkspaceTarget } from '../../protocols/workspace-actions.ts';
import { parseCanvasControlPlan } from '../../services/canvas-control-validation.ts';
import { isResultReference } from './result-references.ts';
import { scheduleWorkspaceQuery } from './query-tasks.ts';
import { canvasTitleAliases } from '../../services/canvas-titles.ts';

type Args = Record<string, unknown>;
type Rule = { description: string; test: (value: unknown) => boolean; optional?: boolean; schema?: Record<string, unknown> };
type Rules = Record<string, Rule>;
type Effect = WorkspaceActionDescriptor['effect'];
type Resolve = (target: WorkspaceTarget) => Promise<ContentSummary>;
type Outcome = { status?: 'waiting'; result?: unknown; message?: string };

export interface LocalAction {
  descriptor: Omit<WorkspaceActionDescriptor, 'status'>;
  commands: KnownCommandType[];
  queries: KnownQueryType[];
  capabilities: KnownCapabilityType[];
  requiresCommandOwner?: boolean;
  validate(args: Args): boolean;
  preflight?(context: PluginContext, args: Args): Promise<boolean>;
  run(context: PluginContext, args: Args, resolve: Resolve): Promise<Outcome>;
}

export function actionSources(action: LocalAction): string[] {
  return [
    ...action.commands.map(key => 'command:' + key),
    ...action.queries.map(key => 'query:' + key),
    ...action.capabilities.map(key => 'capability:' + key),
  ];
}

const optional = (rule: Rule): Rule => ({ ...rule, optional: true });
const string = (max: number): Rule => ({
  description: '文字，最多 ' + max + ' 字符',
  schema: { type: 'string', minLength: 1, maxLength: max },
  test: value => typeof value === 'string' && value.length > 0 && value.length <= max,
});
const number = (min: number, max: number, integer = false): Rule => ({
  description: min + '–' + max + (integer ? ' 的整数' : ' 的数值'),
  schema: { type: integer ? 'integer' : 'number', minimum: min, maximum: max },
  test: value => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)),
});
const oneOf = (...options: string[]): Rule => ({
  description: options.join(' / '), schema: { type: 'string', enum: options },
  test: value => typeof value === 'string' && options.includes(value),
});
const boolean: Rule = { description: '布尔值', schema: { type: 'boolean' }, test: value => typeof value === 'boolean' };
const emptyOrText = (max: number): Rule => ({
  description: '最多 ' + max + ' 字符', schema: { type: 'string', maxLength: max },
  test: value => typeof value === 'string' && value.length <= max,
});
const ids: Rule = { description: '1–100 个对象 ID',
  schema: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } },
  test: value => Array.isArray(value) &&
  value.length > 0 && value.length <= 100 && value.every(id => string(200).test(id)) && new Set(value).size === value.length };
const clipboardSourceIds: Rule = { description: '发送时选中的唯一对象 ID',
  schema: { ...ids.schema, maxItems: MAX_CLIPBOARD_SOURCE_IDS },
  test: value => isClipboardCopySelectionRequest({ sourceIds: value }),
};
const point: Rule = { description: '坐标 {x, y}',
  schema: { type: 'object', required: ['x', 'y'], additionalProperties: false, properties: {
    x: number(-1e9, 1e9).schema, y: number(-1e9, 1e9).schema,
  } },
  test: value => isRecord(value) &&
  Object.keys(value).length === 2 && number(-1e9, 1e9).test(value.x) && number(-1e9, 1e9).test(value.y) };
const canvasPlan: Rule = { description: '已有画布计划 v1/v2', test: value => {
  if (!isRecord(value)) return false;
  try {
    const text = JSON.stringify(value);
    return text.length <= 256 * 1024 && parseCanvasControlPlan(text).actions.length > 0;
  } catch {
    return false;
  }
} };
const color: Rule = { description: 'RGB 颜色 #rrggbb', schema: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
  test: value => typeof value === 'string' && /^#[\da-f]{6}$/iu.test(value) };
const fields = (rules: Rules): Rule => ({
  description: '指定属性', schema: {
    type: 'object', additionalProperties: false, minProperties: 1,
    properties: Object.fromEntries(Object.entries(rules).map(([key, rule]) => [key, rule.schema ?? {}])),
  },
  test: value => isRecord(value) && Object.keys(value).length > 0 &&
    Object.entries(value).every(([key, field]) => rules[key]?.test(field) === true),
});
const ratios: Rule = { description: '窗格 ID 对应正比例',
  schema: { type: 'object', minProperties: 1, maxProperties: 3, additionalProperties: { type: 'number', exclusiveMinimum: 0 } },
  test: value => isRecord(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 3 &&
    Object.values(value).every(ratio => number(0.001, 1000).test(ratio)) };
const formatFields: Rules = {
  fontSize: number(8, 96), fontWeight: number(100, 900), lineHeight: number(0.8, 4),
  letterSpacing: number(-3, 20), firstLineIndent: number(0, 10), paragraphSpacing: number(0, 5), color,
};

export function isWorkspaceTarget(value: unknown): value is WorkspaceTarget {
  return isRecord(value) && Object.keys(value).length === 1 &&
    (string(200).test(value.id) || string(200).test(value.title) || string(80).test(value.from));
}
const target: Rule = { description: '对象 ID、名称或前置查找步骤',
  schema: { oneOf: ['id', 'title', 'from'].map(key => ({
    type: 'object', required: [key], additionalProperties: false, properties: { [key]: string(key === 'from' ? 80 : 200).schema },
  })) },
  test: isWorkspaceTarget };
const targets: Rule = { description: '1–80 个明确节点目标',
  schema: { type: 'array', minItems: 1, maxItems: 80, items: target.schema },
  test: value => Array.isArray(value) && value.length > 0 && value.length <= 80 && value.every(isWorkspaceTarget),
};
const asTarget = (value: unknown): WorkspaceTarget => {
  if (!isWorkspaceTarget(value)) throw new Error('操作对象参数无效');
  return value;
};

function action(
  id: string, owner: string, label: string, category: string, effect: Effect, rules: Rules,
  implementation: Pick<LocalAction, 'commands' | 'queries' | 'capabilities' | 'run'>,
): LocalAction {
  return {
    descriptor: { id, owner, label, category, effect, inputSchema: {
      type: 'object', additionalProperties: false,
      required: Object.entries(rules).filter(([, rule]) => !rule.optional).map(([key]) => key),
      properties: Object.fromEntries(Object.entries(rules).map(([key, rule]) =>
        [key, { description: rule.description, ...rule.schema }])),
    }, parameters: Object.fromEntries(
      Object.entries(rules).map(([key, rule]) => [key, rule.description + (rule.optional ? '（可选）' : '')]),
    ) },
    validate: args => Object.keys(args).every(key => Object.hasOwn(rules, key)) &&
      Object.entries(rules).every(([key, rule]) => args[key] === undefined ? rule.optional === true : isResultReference(args[key]) || rule.test(args[key])),
    ...implementation,
  };
}

function command(
  id: string, owner: string, label: string, category: string, effect: Effect, message: KnownCommandType,
  rules: Rules = {}, payload?: (args: Args, resolve: Resolve) => unknown,
  readback?: (context: PluginContext, result: unknown, args: Args) => Promise<Outcome>,
  reads: KnownCapabilityType[] = [],
): LocalAction {
  const definition = action(id, owner, label, category, effect, rules, {
    commands: [message], queries: [], capabilities: reads,
    run: async (context, args, resolve) => {
      const input = payload ? await payload(args, resolve) : Object.keys(rules).length ? args : undefined;
      const result: unknown = await context.commands.invoke(message, input);
      if (result === false) throw new Error('功能未完成该操作');
      const outcome = readback ? await readback(context, result, args) : { result };
      return isRecord(input) && typeof input.id === 'string' && isRecord(outcome.result)
        ? { ...outcome, result: { ...outcome.result, targetId: input.id } } : outcome;
    },
  });
  definition.descriptor.resultMode = readback ? 'readback' : 'returned';
  return definition;
}

function capability(id: string, owner: string, label: string, category: string, key: KnownCapabilityType, rules: Rules = {}): LocalAction {
  return action(id, owner, label, category, 'query', rules, {
    commands: [], queries: [], capabilities: [key],
    run: async (context, args) => ({ result: await context.capabilities.request(key, Object.keys(rules).length ? args : undefined) }),
  });
}

function query(id: string, owner: string, label: string, category: string, key: KnownQueryType, rules: Rules = {}): LocalAction {
  return action(id, owner, label, category, 'query', rules, {
    commands: [], queries: [key], capabilities: [],
    run: async (context, args) => ({ result: await context.queries.ask(key, Object.keys(rules).length ? args : undefined) }),
  });
}

const lookupNodeId = async (args: Args, resolve: Resolve) => ({ id: (await resolve(asTarget(args.target))).id });
const nameKey = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase();

export function matchingNodes(nodes: ContentSummary[], name: string): ContentSummary[] {
  const key = nameKey(name);
  const exact = nodes.filter(node => nameKey(node.title) === key);
  return exact.length ? exact : nodes.filter(node => canvasTitleAliases(node.title).some(alias => nameKey(alias) === key));
}

const cameraSet = command('viewport.set', 'canvas', '设置画布中心、缩放或平移', '视口', 'workspace', 'canvas.viewport.set@1',
  { target: optional(target), zoom: optional(number(0.4, 2.4)), center: optional(point), pan: optional(point) },
  async (args, resolve) => {
    if (args.target && args.center) throw new Error('视口只能指定一个中心');
    const { target: requested, ...rest } = args;
    return requested ? { ...rest, entityId: (await resolve(asTarget(requested))).id } : rest;
  },
  async (context, result) => {
    const actual = await context.capabilities.request<CameraState>('canvas.camera@1');
    if (!isRecord(result) || actual.x !== result.x || actual.y !== result.y || actual.zoom !== result.zoom) {
      throw new Error('实际视口与计划结果不一致');
    }
    return { result: actual };
  }, ['canvas.camera@1']);
const validateCameraFields = cameraSet.validate;
cameraSet.validate = args => Object.keys(args).length > 0 && !(args.target && args.center) && validateCameraFields(args);

const selectionSet = command('selection.set', 'selection', '设置选中对象', '选择', 'workspace', 'selection.set',
  { ids: optional(ids), targets: optional(targets), mode: optional(oneOf('replace', 'add', 'remove', 'toggle')) },
  async (args, resolve) => ({
    ids: args.targets === undefined ? args.ids
      : await Promise.all((args.targets as WorkspaceTarget[]).map(async item => (await resolve(item)).id)),
    mode: args.mode,
  }),
  async context => ({ result: await context.capabilities.request('selection.read@1') }), ['selection.read@1']);
const validateSelectionFields = selectionSet.validate;
selectionSet.validate = args => (args.ids === undefined) !== (args.targets === undefined) && validateSelectionFields(args);
selectionSet.descriptor.inputSchema = { ...selectionSet.descriptor.inputSchema, oneOf: [{ required: ['ids'] }, { required: ['targets'] }] };

function setOrToggle(
  id: string, owner: string, label: string, category: string, message: KnownCommandType, state: KnownCapabilityType, field: string,
): LocalAction {
  return action(id, owner, label, category, 'workspace', { enabled: optional(boolean) }, {
    commands: [message], queries: [], capabilities: [state],
    run: async (context, args) => {
      const before = await context.capabilities.request<Record<string, unknown>>(state);
      if (typeof before[field] !== 'boolean') throw new Error('未读到开关状态');
      const desired = args.enabled ?? !before[field];
      if (before[field] !== desired) await context.commands.invoke(message);
      const after = await context.capabilities.request<Record<string, unknown>>(state);
      if (after[field] !== desired) throw new Error('开关回读与所请求的状态不一致');
      return { result: after };
    },
  });
}

const duplicate = command('clipboard.duplicate', 'clipboard', '复制明确对象及内部关系到指定位置', '剪贴板', 'document', 'clipboard.duplicateCaptured@1', {
  sourceIds: clipboardSourceIds, expectedKind: optional(oneOf('text-node', 'group', 'connection')),
  includeInternalRelations: optional({ description: '必须保留内部关系', test: value => value === true, schema: { const: true } }),
  direction: optional(oneOf('right', 'left', 'down', 'up')), gap: optional(number(0, 10000)), offset: optional(point),
});
const validateDuplicateArguments = duplicate.validate;
duplicate.validate = args => validateDuplicateArguments(args) &&
  (args.offset === undefined ? args.direction !== undefined : args.direction === undefined && args.gap === undefined);
duplicate.descriptor.inputSchema = { ...duplicate.descriptor.inputSchema, oneOf: [
  { required: ['direction'], not: { required: ['offset'] } },
  { required: ['offset'], not: { anyOf: [{ required: ['direction'] }, { required: ['gap'] }] } },
] };

export const localActions: LocalAction[] = [
  cameraSet,
  capability('viewport.read', 'canvas', '读取实际视口', '视口', 'canvas.camera@1'),
  command('viewport.tool', 'canvas', '切换画布工具', '视口', 'workspace', 'canvas.tool.set', { tool: oneOf('select', 'hand') }),
  ...(['open', 'close'] as const).map(mode => command(
    'minimap.' + mode, 'minimap', mode === 'open' ? '打开小地图' : '关闭小地图', '面板', 'workspace', mode === 'open' ? 'minimap.open' : 'minimap.close',
    {}, undefined, async context => {
      const state = await context.capabilities.request<{ open: boolean }>('minimap.state@1');
      if (state.open !== (mode === 'open')) throw new Error('小地图状态与计划结果不一致');
      return { result: state };
    }, ['minimap.state@1'],
  )),
  capability('minimap.read', 'minimap', '读取小地图状态', '面板', 'minimap.state@1'),
  capability('selection.read', 'selection', '读取选区', '选择', 'selection.read@1'),
  selectionSet,
  command('selection.clear', 'selection', '清空选区', '选择', 'workspace', 'selection.clear', {}, undefined,
    async context => ({ result: await context.capabilities.request('selection.read@1') }), ['selection.read@1']),
  command('selection.box', 'selection', '框选区域', '选择', 'workspace', 'selection.box', {
    x: number(-1e9, 1e9), y: number(-1e9, 1e9), width: number(0, 1e9), height: number(0, 1e9),
    mode: optional(oneOf('replace', 'add', 'remove', 'toggle')),
  }, undefined, async context => ({ result: await context.capabilities.request('selection.read@1') }), ['selection.read@1']),
  action('content.find', 'text-node', '查找同名文字节点', '查询', 'query', { title: string(200) }, {
    commands: [], queries: [], capabilities: ['content.summaries@1'],
    run: async (context, { title }) => {
      const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
      const matches = matchingNodes(nodes, String(title));
      return { result: { count: matches.length, matches: matches.slice(0, 20)
        .map(({ id, title, revision }) => ({ id, title, revision })) } };
    },
  }),
  action('content.read', 'text-node', '读取正文范围', '正文', 'query',
    { target, start: number(0, 1e9, true), length: number(1, 32768, true), expectedRevision: optional(number(0, 1e9, true)) }, {
      commands: [], queries: [], capabilities: ['content.read@1'],
      run: async (context, args, resolve) => {
        const result = await context.capabilities.request<{ revision: number }>('content.read@1', {
          nodeId: (await resolve(asTarget(args.target))).id, start: args.start, length: args.length,
        });
        if (args.expectedRevision !== undefined && result.revision !== args.expectedRevision) throw new Error('原文范围已变化，请重新读取');
        return { result };
      },
    }),
  action('content.search', 'search-replace', '查找标题与正文', '查找替换', 'query',
    { query: string(240), matchCase: optional(boolean), wholeWord: optional(boolean), nodeIds: optional(ids) }, {
      commands: [], queries: [], capabilities: ['content.search@2'],
      run: async (context, args) => ({ result: await context.capabilities.request('content.search@2', {
        maxResults: 50, matchCase: false, wholeWord: false, ...args,
      }) }),
    }),
  command('editor.open', 'editor', '打开或并排显示文字节点', '编辑器', 'workspace', 'editor.open',
    { target, mode: optional(oneOf('replace', 'add')) },
    async (args, resolve) => ({ ...await lookupNodeId(args, resolve), mode: args.mode }),
    async (_context, result) => isRecord(result) && result.status === 'limit'
      ? { status: 'waiting', result, message: '等待选择要替换的编辑窗格' } : { result }),
  command('editor.close', 'editor', '关闭指定编辑窗格', '编辑器', 'workspace', 'editor.close', { target }, lookupNodeId,
    async context => ({ result: await context.capabilities.request('editor.context@1') }), ['editor.context@1']),
  command('editor.width', 'editor', '设置编辑区宽度', '编辑器', 'workspace', 'editor.setDockWidth', { width: number(100, 10000) }),
  capability('editor.read', 'editor', '读取已打开编辑窗格', '编辑器', 'editor.context@1'),
  command('editor.immersive.exit', 'editor', '退出沉浸编辑', '编辑器', 'workspace', 'editor.exitImmersive'),
  action('editor.immersive.enter', 'editor', '进入沉浸编辑', '编辑器', 'workspace', { target }, {
    commands: ['editor.open', 'editor.enterImmersive'], queries: ['editor.state'], capabilities: [],
    run: async (context, args, resolve) => {
      const node = await resolve(asTarget(args.target));
      const opened = await context.commands.invoke('editor.open', { id: node.id, mode: 'add' });
      if (opened.status === 'limit') return { status: 'waiting', message: '请先选择要替换的编辑窗格，再进入沉浸编辑。', result: opened };
      await context.commands.invoke('editor.enterImmersive', { id: node.id });
      const state = await context.queries.ask<{ immersivePane?: string }>('editor.state');
      if (state.immersivePane !== node.id) throw new Error('未能进入目标节点的沉浸编辑');
      return { result: { targetId: node.id, title: node.title, immersive: true } };
    },
  }),
  command('search.open', 'search-replace', '打开查找面板', '面板', 'workspace', 'search.open'),
  command('search.close', 'search-replace', '关闭查找面板', '面板', 'workspace', 'search.close'),
  command('palette.open', 'palette', '打开外观面板', '面板', 'workspace', 'palette.open'),
  command('palette.close', 'palette', '关闭外观面板', '面板', 'workspace', 'palette.close'),
  command('appearance.theme', 'palette', '切换浅色或深色主题', '外观', 'workspace', 'palette.setPreferences',
    { themeId: oneOf('light', 'dark') }),
  setOrToggle('layout.guides.toggle', 'smart-layout', '切换智能参考线', '布局', 'layout.toggleGuides@1', 'layout.settings@1', 'guides'),
  setOrToggle('layout.snap.toggle', 'smart-layout', '切换吸附', '布局', 'layout.toggleSnap@1', 'layout.settings@1', 'snap'),
  ...(['grid', 'horizontal', 'vertical'] as const).map(mode => {
    const legacy = ({
      grid: 'node.arrangeSelectedGrid',
      horizontal: 'node.arrangeSelectedGrid.horizontal',
      vertical: 'node.arrangeSelectedGrid.vertical',
    } as const)[mode];
    const id = mode === 'grid' ? 'layout.arrange' : 'layout.' + mode;
    const label = ({ grid: '网格排列', horizontal: '横排', vertical: '竖排' })[mode];
    return action(id, 'smart-layout', label + '选中对象', '布局', 'document', { nodeIds: optional(ids) }, {
      commands: [legacy, 'layout.arrangeNodes@1'], queries: [], capabilities: [],
      run: async (context, args) => ({ result: args.nodeIds === undefined ? await context.commands.invoke(legacy) :
        await context.commands.invoke('layout.arrangeNodes@1', { nodeIds: args.nodeIds as string[], mode }) }),
    });
  }),
  command('node.rename', 'text-node', '修改节点标题', '节点', 'document', 'node.rename',
    { target, title: string(200) }, async (args, resolve) => ({ ...await lookupNodeId(args, resolve), title: args.title })),
  command('node.create', 'text-node', '新建文字节点', '节点', 'document', 'node.create',
    { title: string(200), x: optional(number(-1e9, 1e9)), y: optional(number(-1e9, 1e9)), text: optional(emptyOrText(32768)) },
    args => ({ title: args.title, x: args.x, y: args.y, body: args.text })),
  command('node.move', 'text-node', '移动一个文字节点', '布局', 'document', 'node.moveMany',
    { target, x: number(-1e9, 1e9), y: number(-1e9, 1e9) },
    async (args, resolve) => ({ positions: [{ ...await lookupNodeId(args, resolve), x: args.x, y: args.y }] })),
  command('content.edit', 'text-node', '替换指定修订的正文范围', '正文', 'document', 'content.applyDelta',
    { target, start: number(0, 1e9, true), deleteCount: number(0, 1e9, true),
      insert: emptyOrText(32768), expectedRevision: number(0, 1e9, true) },
    async (args, resolve) => {
      const { target: requested, ...change } = args;
      return { nodeId: (await resolve(asTarget(requested))).id, ...change };
    }),
  command('canvas.batch.preview', 'canvas-control', '预览可一次撤销的画布修改', '文档方案', 'document',
    'canvasControl.workspacePreview@1', { plan: canvasPlan, expectedRevision: number(0, 1e9, true) }, undefined,
    async (_context, result) => ({ status: 'waiting', result, message: '请在画布控制中确认并应用文档预览' })),
  command('group.create', 'groups', '为选中节点创建群组', '群组', 'document', 'group.create',
    { title: optional(string(200)) }),
  command('group.ungroup', 'groups', '解组并保留成员', '群组', 'document', 'group.ungroup', { id: string(200) }),
  capability('group.list', 'groups', '读取群组与成员', '群组', 'groups.list@1'),
  capability('connection.graph', 'connections', '读取连线关系', '连线', 'connections.graph@1'),
  action('connection.create', 'canvas-control', '预览两个节点之间的关系线', '连线', 'document',
    { from: target, to: target, line: optional(oneOf('solid', 'dashed')), label: optional(emptyOrText(120)) }, {
      commands: ['canvasControl.workspacePreview@1'], queries: ['system.document.revision'], capabilities: ['connections.graph@1'],
      run: async (context, args, resolve) => documentPreview(context, { version: 1, actions: [{
        type: 'create-connection', ref: 'workspace-edge', from: (await resolve(asTarget(args.from))).id,
        to: (await resolve(asTarget(args.to))).id, line: (args.line ?? 'solid') as 'solid' | 'dashed',
        ...(args.label === undefined ? {} : { label: String(args.label) }),
      }] }),
    }),
  command('connection.label', 'connections', '设置连线标签', '连线', 'document', 'connection.setLabel',
    { id: string(200), label: emptyOrText(120), expectedRevision: number(0, 1e9, true) }),
  command('annotation.add', 'annotations', '给文字节点或正文位置添加标注', '标注', 'document', 'annotation.create',
    { target, body: string(2000), offset: optional(number(0, 1e9, true)) },
    async (args, resolve) => ({
      target: { kind: args.offset === undefined ? 'text-node' : 'text-range',
        targetId: (await resolve(asTarget(args.target))).id, ...(args.offset === undefined ? {} : { offset: args.offset }) },
      body: args.body,
    })),
  capability('annotation.list', 'annotations', '读取标注', '标注', 'annotations.list@1'),
  action('clipboard.copy', 'clipboard', '复制当前或明确绑定的选区', '剪贴板', 'workspace', {
    expectedIds: optional(ids), sourceIds: optional(clipboardSourceIds), expectedKind: optional(oneOf('text-node', 'group', 'connection')),
  }, {
    commands: ['clipboard.copy', 'clipboard.copySelection@1'], queries: [], capabilities: ['clipboard.state@1', 'selection.read@1'],
    run: async (context, args) => {
      if (args.sourceIds !== undefined && args.expectedIds !== undefined || args.expectedKind !== undefined && args.sourceIds === undefined) {
        throw new Error('请提供一组明确的复制对象。');
      }
      if (Array.isArray(args.expectedIds)) {
        const { ids } = await context.capabilities.request<{ ids: string[] }>('selection.read@1');
        const expected = new Set(args.expectedIds);
        if (ids.length !== expected.size || ids.some(id => !expected.has(id))) throw new Error('发送后选区已变化，请重新选中要复制的对象');
      }
      if (Array.isArray(args.sourceIds)) {
        await context.commands.invoke('clipboard.copySelection@1', { sourceIds: args.sourceIds,
          expectedKind: args.expectedKind as 'text-node' | 'group' | 'connection' | undefined });
      } else await context.commands.invoke('clipboard.copy');
      return { result: await context.capabilities.request('clipboard.state@1') };
    },
  }),
  action('clipboard.paste', 'clipboard', '粘贴画布选区', '剪贴板', 'document', {
    copiedAt: optional(number(1, Number.MAX_SAFE_INTEGER, true)), sourceIds: optional(clipboardSourceIds),
  }, {
    commands: ['clipboard.paste', 'clipboard.pasteCaptured@1'], queries: [], capabilities: [],
    run: async (context, args) => {
      if (args.copiedAt === undefined && args.sourceIds === undefined) {
        return { result: await context.commands.invoke('clipboard.paste') };
      }
      if (args.copiedAt === undefined || !Array.isArray(args.sourceIds)) throw new Error('请完整指定待粘贴的剪贴板快照。');
      return { result: await context.commands.invoke('clipboard.pasteCaptured@1', {
        copiedAt: Number(args.copiedAt), sourceIds: args.sourceIds as string[],
      }) };
    },
  }),
  duplicate,
  capability('statistics.read', 'statistics', '读取统计快照', '统计', 'statistics.current@1'),
  capability('statistics.selection', 'statistics', '读取选区统计', '统计', 'statistics.selected@1'),
  command('library.show', 'book-library', '打开书库', '书库', 'workspace', 'bookLibrary.show'),
  command('library.canvas', 'book-library', '返回当前画布', '书库', 'workspace', 'bookLibrary.enterCanvas'),
  query('library.state', 'book-library', '读取书库打开状态', '书库', 'bookLibrary.state@1'),
  query('library.cachedProjects', 'cloud-sync', '读取已有授权书籍缓存', '书库', 'cloudSync.projects'),
  command('file.panel', 'import-export', '打开文件与恢复面板', '文件', 'workspace', 'file.openPanel'),
  capability('file.state', 'import-export', '读取本地文件状态', '文件', 'file.state@1'),
  command('file.choose', 'import-export', '打开项目文件选择器', '文件', 'file', 'file.chooseOpenProject',
    {}, undefined, async (_context, result) => ({ status: 'waiting', result, message: '等待选择本地项目文件' })),
  query('recovery.list', 'import-export', '读取本地恢复点', '恢复', 'system.recovery.list'),
  command('recovery.create', 'import-export', '创建本地恢复点', '恢复', 'file', 'system.persistence.checkpoint',
    { label: optional(string(200)) }),
  query('history.read', 'history-controls', '读取撤销与重做状态', '历史', 'history.state'),
  command('history.undo', 'history-controls', '撤销文档改动', '历史', 'document', 'history.undo'),
  command('history.redo', 'history-controls', '重做文档改动', '历史', 'document', 'history.redo'),
  command('settings.open', 'shortcut-center', '打开工作区设置', '设置', 'workspace', 'system.ui.openSettings@1'),
  query('settings.shortcuts', 'shortcut-center', '查看快捷键', '设置', 'system.shortcuts'),
  command('settings.keys.open', 'shortcut-center', '打开快捷键面板', '设置', 'workspace', 'shortcuts.open'),
  query('plugins.read', 'plugin-center', '查询插件实际状态', '设置', 'system.plugins'),
  command('diagnostics.open', 'diagnostic-center', '打开诊断面板', '诊断', 'workspace', 'diagnostics.open'),
  command('diagnostics.log', 'diagnostic-center', '打开操作记录', '诊断', 'workspace', 'diagnostics.operationLog.open@1'),
  command('assistant.open', 'ai-assistant', '打开助手窗口', '助手', 'workspace', 'ai.open'),
  command('assistant.close', 'ai-assistant', '关闭助手窗口', '助手', 'workspace', 'ai.closeAll'),
  query('workspace.state', 'canvas', '读取当前工作区运行状态', '工作区', 'system.runtime'),
  action('node.inspect', 'text-node', '读取节点位置、尺寸和修订', '查询', 'query', { target }, {
    commands: [], queries: [], capabilities: [],
    run: async (_context, args, resolve) => {
      const { id, title, x, y, width, height, revision, nodeRevision, length } = await resolve(asTarget(args.target));
      return { result: { id, title, x, y, width, height, revision, nodeRevision, length } };
    },
  }),
  capability('viewport.size', 'canvas', '读取画布可视区域', '视口', 'canvas.viewport@1'),
  command('selection.all', 'selection', '全选当前画布范围', '选择', 'workspace', 'selection.all'),
  command('editor.activate', 'editor', '聚焦已有编辑窗格', '编辑器', 'workspace', 'editor.activate', { target }, lookupNodeId),
  command('editor.closeAll', 'editor', '关闭全部编辑窗格', '编辑器', 'workspace', 'editor.closeAll'),
  command('editor.next', 'editor', '切换到下一个编辑窗格', '编辑器', 'workspace', 'editor.activateNext'),
  command('editor.previous', 'editor', '切换到上一个编辑窗格', '编辑器', 'workspace', 'editor.activatePrevious'),
  command('editor.reveal', 'editor', '定位当前编辑窗格的文字范围', '编辑器', 'workspace', 'editor.revealRange',
    { target, start: number(0, 32e6, true), end: number(0, 32e6, true), revision: optional(number(0, 1e9, true)) },
    async (args, resolve) => {
      const { target: requested, ...range } = args;
      return { id: (await resolve(asTarget(requested))).id, ...range };
    }),
  command('editor.ratios', 'editor', '设置窗格宽度比例', '编辑器', 'workspace', 'editor.setPaneRatios', { ratios }),
  command('node.resize', 'text-node', '设置节点尺寸', '布局', 'document', 'node.resize',
    { target, width: number(80, 10000), height: number(40, 10000), expectedRevision: optional(number(0, 1e9, true)) },
    async (args, resolve) => {
      const { target: requested, ...size } = args;
      return { id: (await resolve(asTarget(requested))).id, ...size };
    }),
  command('node.resetSize', 'text-node', '恢复节点默认尺寸', '布局', 'document', 'node.resetSize', { target }, lookupNodeId),
  command('node.presentation', 'text-node', '设置卡片或文本框形态', '节点', 'document', 'node.presentation.set',
    { target, presentation: oneOf('card', 'text-box') },
    async (args, resolve) => ({ ...await lookupNodeId(args, resolve), presentation: args.presentation })),
  command('group.add', 'groups', '加入指定群组', '群组', 'document', 'group.membership.add', { groupId: string(200), nodeIds: ids }),
  command('group.remove', 'groups', '从指定群组移出', '群组', 'document', 'group.membership.remove', { groupId: string(200), nodeIds: ids }),
  command('selection.delete', 'selection', '删除选中对象及所属关系', '节点', 'document', 'selection.delete'),
  action('clipboard.cut', 'clipboard', '剪切当前或发送时选区', '剪贴板', 'document', {
    sourceIds: optional(clipboardSourceIds), expectedKind: optional(oneOf('text-node', 'group', 'connection')),
  }, {
    commands: ['clipboard.cut', 'clipboard.cutSelection@1'], queries: [], capabilities: [],
    run: async (context, args) => {
      if (args.expectedKind !== undefined && args.sourceIds === undefined) throw new Error('请指定发送时的剪切对象。');
      const result = Array.isArray(args.sourceIds)
        ? await context.commands.invoke('clipboard.cutSelection@1', { sourceIds: args.sourceIds as string[],
            expectedKind: args.expectedKind as 'text-node' | 'group' | 'connection' | undefined })
        : await context.commands.invoke('clipboard.cut');
      return { result };
    },
  }),
  capability('clipboard.read', 'clipboard', '读取内部剪贴板状态', '剪贴板', 'clipboard.state@1'),
  command('annotation.update', 'annotations', '修改标注正文', '标注', 'document', 'annotation.update',
    { id: string(200), body: emptyOrText(32768), expectedRevision: number(1, 1e9, true) }),
  action('annotation.delete', 'annotations', '删除指定标注', '标注', 'document',
    { id: string(200), expectedRevision: optional(number(1, 1e9, true)) }, {
      commands: ['annotation.delete'], queries: [], capabilities: ['annotations.list@1'],
      run: async (context, args) => {
        if (args.expectedRevision !== undefined) {
          const annotations = await context.capabilities.request<AnnotationRecord[]>('annotations.list@1');
          if (annotations.find(item => item.id === args.id)?.revision !== args.expectedRevision) throw new Error('标注已变化，请重新确认要删除的内容。');
        }
        return { result: await context.commands.invoke('annotation.delete', { id: args.id }) };
      },
    }),
  command('annotation.open', 'annotations', '打开指定标注', '标注', 'workspace', 'annotation.open', { id: string(200) }),
  command('annotation.focus', 'annotations', '聚焦标注所在位置', '标注', 'workspace', 'annotation.focus', { id: string(200) }),
  command('annotation.close', 'annotations', '关闭标注窗口', '标注', 'workspace', 'annotation.close'),
  command('appearance.preferences', 'palette', '设置工作区默认颜色', '外观', 'workspace', 'palette.setPreferences', {
    editorBackground: optional(color), editorChromeBackground: optional(color), toolbarBackground: optional(color),
    annotationColor: optional(color), groupBackground: optional(color),
  }),
  command('appearance.preset', 'palette', '应用内置配色', '外观', 'workspace', 'palette.applyPresetColors@1', { id: oneOf('bright', 'dark', 'eye-care') }),
  command('appearance.preset.apply', 'palette', '切换完整主题配色', '外观', 'document', 'palette.applyPreset@1', { id: oneOf('bright', 'dark', 'eye-care') }),
  capability('appearance.read', 'palette', '读取配色设置', '外观', 'palette.state@1'),
  command('format.document', 'text-node', '设置文档排版', '格式', 'document', 'content.setDocumentFormat',
    { target, expectedRevision: number(0, 1e9, true), patch: fields(formatFields) },
    async (args, resolve) => {
      const { target: requested, ...change } = args;
      return { nodeId: (await resolve(asTarget(requested))).id, ...change };
    }),
  command('format.range', 'text-node', '设置指定文字范围的排版', '格式', 'document', 'content.setRangeFormat',
    { target, expectedRevision: number(0, 1e9, true), expectedContentRevision: number(0, 1e9, true),
      start: number(0, 32e6, true), end: number(0, 32e6, true), scope: oneOf('selection', 'paragraph'), patch: fields(formatFields) },
    async (args, resolve) => {
      const { target: requested, ...change } = args;
      return { nodeId: (await resolve(asTarget(requested))).id, ...change };
    }),
  action('format.read', 'text-node', '读取指定范围的排版修订', '格式', 'query',
    { target, start: optional(number(0, 32e6, true)), length: optional(number(1, 32768, true)) }, {
      commands: [], queries: [], capabilities: ['content.formatting@2'],
      run: async (context, args, resolve) => ({ result: await context.capabilities.request('content.formatting@2', {
        nodeId: (await resolve(asTarget(args.target))).id, start: args.start, length: args.length,
      }) }),
    }),
  command('search.run', 'search-replace', '执行界面中的查找', '查找替换', 'workspace', 'search.run',
    { query: string(240), scope: oneOf('current', 'canvas'), matchCase: boolean, wholeWord: boolean },
    undefined, async (_context, result) => ({ status: 'waiting', result, message: '查找任务已开始，请核对搜索结果' })),
  command('search.next', 'search-replace', '定位下一个匹配', '查找替换', 'workspace', 'search.next'),
  command('search.previous', 'search-replace', '定位上一个匹配', '查找替换', 'workspace', 'search.previous'),
  capability('search.read', 'search-replace', '读取搜索结果状态', '查找替换', 'search.state@1'),
  capability('correction.settings', 'text-assist', '读取本地校对设置', '校对', 'text.assist.settings@1'),
  setOrToggle('correction.toggle', 'text-assist', '切换本地纠错', '校对', 'textAssist.toggleCorrection', 'text.assist.settings@1', 'correctionEnabled'),
  setOrToggle('completion.toggle', 'text-assist', '切换本地补全', '校对', 'textAssist.toggleCompletion', 'text.assist.settings@1', 'completionEnabled'),
  command('correction.rules', 'text-assist', '打开本地校对规则', '校对', 'workspace', 'textAssist.openRules'),
  query('storage.read', 'import-export', '读取本地存储使用量', '保存恢复', 'system.storage.usage'),
  query('persistence.read', 'import-export', '读取实际保存状态', '保存恢复', 'system.persistence'),
  query('persistence.preferences', 'import-export', '读取自动保存偏好', '保存恢复', 'system.persistence.preferences@1'),
  command('persistence.interval', 'import-export', '设置自动保存间隔', '保存恢复', 'workspace', 'system.persistence.setAutosaveInterval',
    { intervalMs: number(0, 86400000, true) }),
  query('recovery.preview', 'import-export', '预览恢复点差异', '恢复', 'system.recovery.preview', { id: string(200) }),
  query('cloud.state', 'cloud-sync', '读取已缓存的同步和授权状态', '书库', 'cloudSync.state'),
  query('shortcuts.read', 'shortcut-center', '读取快捷键设置', '设置', 'shortcuts.state'),
  command('shortcuts.set', 'shortcut-center', '修改已有快捷键', '设置', 'workspace', 'shortcuts.setOverride',
    { targetOwner: string(200), targetId: string(200), chord: string(100) }, undefined,
    async (context, _result, args) => {
      const state = await context.queries.ask<{ overrides: Array<{ targetOwner: string; targetId: string; chord?: string }> }>('shortcuts.state');
      const saved = state.overrides.find(entry => entry.targetOwner === args.targetOwner && entry.targetId === args.targetId);
      if (!saved?.chord) throw new Error('快捷键未能保存，请检查冲突');
      return { result: { chord: saved.chord, targetId: saved.targetId } };
    }),
  command('shortcuts.reset', 'shortcut-center', '恢复指定快捷键', '设置', 'workspace', 'shortcuts.resetOverride',
    { targetOwner: string(200), targetId: string(200) }),
  query('diagnostics.read', 'diagnostic-center', '读取本地诊断', '诊断', 'system.diagnostics'),
  query('diagnostics.operations', 'diagnostic-center', '读取操作回执记录', '诊断', 'system.operationLog@2'),
  query('assistant.state', 'ai-assistant', '读取助手和会话状态', '助手', 'ai.state'),
  query('assistant.templates', 'ai-assistant', '读取已配置模板', '助手', 'ai.promptTemplates'),
  query('assistant.transcript', 'ai-assistant', '读取本地会话原文尾部', '助手', 'ai.transcript', { sessionId: string(200) }),
  query('assistant.usage', 'ai-assistant', '读取会话用量记录', '助手', 'ai.task.usage@1', { sessionId: string(200), taskId: optional(string(200)) }),
  command('assistant.cancel', 'ai-assistant', '停止指定会话生成', '助手', 'workspace', 'ai.generation.cancel', { sessionId: string(200) }),
  command('assistant.context', 'ai-assistant', '设置本轮资料模式', '助手', 'workspace', 'ai.assistant.setContextMode',
    { assistantId: string(200), mode: oneOf('automatic', 'explicit-only') }),
];

export async function documentPreview(context: PluginContext, plan: CanvasControlPlan, sourceIds?: string[]): Promise<Outcome> {
  const { revision } = await context.queries.ask<{ revision: number }>('system.document.revision');
  const result = await context.commands.invoke('canvasControl.workspacePreview@1', { plan, expectedRevision: revision, sourceIds });
  return { status: 'waiting', result, message: '本地文档方案已准备，请核对并应用' };
}

localActions.push(
  query('document.revision', 'workspace-actions', '读取书籍修订', '查询', 'system.document.revision'),
  action('layout.plan', 'text-node', '准备精确分列与着色方案', '布局', 'query', {
    nodeIds: ids, columns: number(1, 20, true), gap: number(0, 1000),
    sort: optional(oneOf('input', 'title', 'position')), excludeIds: optional(ids), color: optional(color),
  }, {
    commands: [], queries: ['system.document.revision'], capabilities: ['content.canvasSummariesById@1'],
    run: async (context, args) => {
      const { revision: expectedRevision } = await context.queries.ask<{ revision: number }>('system.document.revision');
      const requested = args.nodeIds as string[]; const excluded = new Set(args.excludeIds as string[] | undefined);
      const all = await context.capabilities.request<ContentSummary[]>('content.canvasSummariesById@1', { nodeIds: requested });
      if (all.length !== requested.length) throw new Error('布局范围包含失效对象');
      const nodes = requested.filter(id => !excluded.has(id)).map(id => all.find(node => node.id === id)!);
      if (!nodes.length || nodes.length > 80) throw new Error('本次布局需包含 1–80 个节点');
      if (args.sort === 'title') nodes.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }));
      if (args.sort === 'position') nodes.sort((a, b) => a.y - b.y || a.x - b.x);
      const columns = Math.min(Number(args.columns), nodes.length); const gap = Number(args.gap);
      const origin = { x: Math.min(...nodes.map(node => node.x)), y: Math.min(...nodes.map(node => node.y)) };
      const widths = Array.from({ length: columns }, (_, column) => Math.max(...nodes.filter((_, i) => i % columns === column).map(node => node.width)));
      const heights = Array.from({ length: Math.ceil(nodes.length / columns) }, (_, row) => Math.max(...nodes.slice(row * columns, (row + 1) * columns).map(node => node.height)));
      const plan: CanvasControlPlan = { version: 1, actions: nodes.map((node, i) => ({
        type: 'update-node', id: node.id, x: origin.x + widths.slice(0, i % columns).reduce((sum, width) => sum + width + gap, 0),
        y: origin.y + heights.slice(0, Math.floor(i / columns)).reduce((sum, height) => sum + height + gap, 0),
        ...(args.color ? { color: String(args.color) } : {}),
      })) };
      return { result: { plan, expectedRevision, nodeIds: nodes.map(node => node.id), excludedIds: [...excluded],
        geometry: nodes.map(({ id, x, y, width, height, nodeRevision }) => ({ id, x, y, width, height, nodeRevision })) } };
    },
  }),
  action('entities.list', 'selection', '查询卡片、群组、连线和中转点', '查询', 'query', {
    kind: optional(string(100)), inViewport: optional(boolean), cursor: optional(number(0, 1e7, true)), limit: optional(number(1, 200, true)),
  }, {
    commands: [], queries: [], capabilities: ['selection.entities@1', 'canvas.camera@1', 'canvas.viewport@1'],
    run: async (context, args) => {
      const catalogs = await context.capabilities.requestAll<SelectionCatalogContribution>('selection.entities@1');
      let entities = catalogs.flatMap(catalog => catalog.entities.map(entity => ({ ...entity, owner: catalog.owner })));
      if (args.kind) entities = entities.filter(entity => entity.kind === args.kind);
      if (args.inViewport) {
        const [camera, viewport] = await Promise.all([
          context.capabilities.request<CameraState>('canvas.camera@1'), context.capabilities.request<CanvasViewportSize>('canvas.viewport@1'),
        ]);
        const box = { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: viewport.width / camera.zoom, height: viewport.height / camera.zoom };
        entities = entities.filter(entity => entity.bounds && entity.bounds.x < box.x + box.width && entity.bounds.x + entity.bounds.width > box.x &&
          entity.bounds.y < box.y + box.height && entity.bounds.y + entity.bounds.height > box.y);
      }
      const start = Number(args.cursor ?? 0); const limit = Number(args.limit ?? 100);
      return { result: { count: entities.length, entities: entities.slice(start, start + limit),
        ids: entities.map(entity => entity.id), next: start + limit < entities.length ? start + limit : null } };
    },
  }),
  action('viewport.restore', 'canvas', '返回保存的视口位置与倍率', '视口', 'workspace', {
    camera: { description: '先前 viewport.read 返回的视口', schema: { type: 'object', required: ['x', 'y', 'zoom'], additionalProperties: false,
      properties: { x: number(-1e9, 1e9).schema, y: number(-1e9, 1e9).schema, zoom: number(0.4, 2.4).schema } },
      test: value => isRecord(value) && Object.keys(value).length === 3 && point.test({ x: value.x, y: value.y }) && number(0.4, 2.4).test(value.zoom) },
  }, {
    commands: ['canvas.viewport.set@1'], queries: [], capabilities: ['canvas.viewport@1', 'canvas.camera@1'],
    run: async (context, args) => {
      const camera = args.camera as unknown as CameraState;
      const viewport = await context.capabilities.request<CanvasViewportSize>('canvas.viewport@1');
      await context.commands.invoke('canvas.viewport.set@1', { zoom: camera.zoom,
        center: { x: (viewport.width / 2 - camera.x) / camera.zoom, y: (viewport.height / 2 - camera.y) / camera.zoom } });
      const actual = await context.capabilities.request<CameraState>('canvas.camera@1');
      if (Math.abs(actual.x - camera.x) > 0.001 || Math.abs(actual.y - camera.y) > 0.001 || actual.zoom !== camera.zoom) throw new Error('返回视口的回读不匹配');
      return { result: actual };
    },
  }),
  action('viewport.scale', 'canvas', '按当前倍率进行相对缩放', '视口', 'workspace',
    { factor: number(0.01, 6), expectedZoom: optional(number(0.4, 2.4)) }, {
    commands: ['canvas.viewport.set@1'], queries: [], capabilities: ['canvas.camera@1'],
    run: async (context, args) => {
      const before = await context.capabilities.request<CameraState>('canvas.camera@1');
      if (args.expectedZoom !== undefined && before.zoom !== args.expectedZoom) throw new Error('当前画布倍率与指定的初始倍率不一致。');
      const zoom = Number((before.zoom * Number(args.factor)).toFixed(6));
      if (zoom < 0.4 || zoom > 2.4) throw new Error('相对缩放超出当前支持的 40%–240% 范围');
      await context.commands.invoke('canvas.viewport.set@1', { zoom });
      const actual = await context.capabilities.request<CameraState>('canvas.camera@1');
      if (actual.zoom !== zoom) throw new Error('相对缩放的回读不匹配');
      return { result: { ...actual, previousZoom: before.zoom, factor: args.factor } };
    },
  }),
  command('viewport.focusEntity', 'canvas', '聚焦任意公开画布对象', '视口', 'workspace', 'canvas.viewport.set@1',
    { entityId: string(200), zoom: optional(number(0.4, 2.4)) }, undefined,
    async (context, result) => {
      const actual = await context.capabilities.request<CameraState>('canvas.camera@1');
      if (!isRecord(result) || actual.x !== result.x || actual.y !== result.y || actual.zoom !== result.zoom) throw new Error('聚焦视口的回读不匹配');
      return { result: actual };
    }, ['canvas.camera@1']),
  action('content.diff', 'text-node', '比较两个原文范围', '正文', 'query', {
    left: target, right: target, start: optional(number(0, 32e6, true)), length: number(1, 32768, true),
  }, {
    commands: [], queries: [], capabilities: ['content.read@1'],
    run: async (context, args, resolve) => {
      const [left, right] = await Promise.all([resolve(asTarget(args.left)), resolve(asTarget(args.right))]);
      const read = (node: ContentSummary) => context.capabilities.request<{ text: string; revision: number }>('content.read@1', {
        nodeId: node.id, start: args.start ?? 0, length: args.length,
      });
      const [a, b] = await Promise.all([read(left), read(right)]);
      let prefix = 0; while (prefix < a.text.length && prefix < b.text.length && a.text[prefix] === b.text[prefix]) prefix += 1;
      let suffix = 0; while (suffix < a.text.length - prefix && suffix < b.text.length - prefix && a.text.at(-suffix - 1) === b.text.at(-suffix - 1)) suffix += 1;
      return { result: { equal: a.text === b.text, left: { id: left.id, revision: a.revision, start: Number(args.start ?? 0) + prefix,
        text: a.text.slice(prefix, a.text.length - suffix) }, right: { id: right.id, revision: b.revision, start: Number(args.start ?? 0) + prefix,
        text: b.text.slice(prefix, b.text.length - suffix) }, comparedLength: args.length, truncated: left.length > Number(args.start ?? 0) + Number(args.length) || right.length > Number(args.start ?? 0) + Number(args.length) } };
    },
  }),
  action('group.createExplicit', 'canvas-control', '用明确对象创建群组预览', '群组', 'document', {
    title: string(200), members: targets,
  }, {
    commands: ['canvasControl.workspacePreview@1'], queries: ['system.document.revision'], capabilities: [],
    run: async (context, args, resolve) => documentPreview(context, { version: 1, actions: [{
      type: 'create-group', ref: 'explicit-group', title: String(args.title),
      members: await Promise.all((args.members as WorkspaceTarget[]).map(async target => (await resolve(target)).id)),
    }] }),
  }),
  action('node.color', 'canvas-control', '预览节点标题颜色', '外观', 'document', { target, color }, {
    commands: ['canvasControl.workspacePreview@1'], queries: ['system.document.revision'], capabilities: [],
    run: async (context, args, resolve) => documentPreview(context, { version: 1, actions: [{
      type: 'update-node', id: (await resolve(asTarget(args.target))).id, color: String(args.color),
    }] }),
  }),
  action('content.draft.preview', 'canvas-control', '预览本地稿件替换正文', '写作', 'document', {
    target, start: number(0, 32e6, true), deleteCount: number(0, 32e6, true),
    expectedRevision: number(1, 1e9, true), text: emptyOrText(32768),
  }, {
    commands: ['canvasControl.workspacePreview@1'], queries: ['system.document.revision'], capabilities: ['content.read@1'],
    run: async (context, args, resolve) => {
      const node = await resolve(asTarget(args.target));
      return documentPreview(context, { version: 2, actions: [{
        type: 'update-node', id: node.id, edit: {
          start: Number(args.start), deleteCount: Number(args.deleteCount), expectedRevision: Number(args.expectedRevision), insert: String(args.text),
        },
      }] });
    },
  }),
  action('content.extract.preview', 'canvas-control', '将原文片段复制到新卡预览', '正文', 'document', {
    target, start: number(0, 32e6, true), length: number(1, 32768, true), expectedRevision: number(1, 1e9, true), title: string(200),
  }, {
    commands: ['canvasControl.workspacePreview@1'], queries: ['system.document.revision'], capabilities: ['content.read@1'],
    run: async (context, args, resolve) => {
      const node = await resolve(asTarget(args.target));
      const source = await context.capabilities.request<{ text: string; revision: number }>('content.read@1', {
        nodeId: node.id, start: args.start, length: args.length,
      });
      if (source.revision !== args.expectedRevision || source.text.length !== args.length) throw new Error('待复制的原文范围已变化');
      return documentPreview(context, { version: 1, actions: [
        { type: 'create-node', ref: 'excerpt', title: String(args.title), text: source.text },
      ] }, [node.id]);
    },
  }),
  action('content.statistics', 'text-node', '统计指定节点的正文', '统计', 'query', { nodeIds: ids }, {
    commands: [], queries: [], capabilities: ['content.statistics@2', 'content.canvasSummariesById@1'],
    run: async (context, args) => {
      const input = { nodeIds: args.nodeIds };
      const nodes = await context.capabilities.request<ContentSummary[]>('content.canvasSummariesById@1', input);
      if (nodes.length !== (args.nodeIds as string[]).length) throw new Error('统计范围包含失效节点');
      const compute = async (signal?: AbortSignal) => {
        const result = await context.capabilities.request<ContentStatistics>('content.statistics@2', input, signal);
        const current = await context.capabilities.request<ContentSummary[]>('content.canvasSummariesById@1', input, signal);
        if (current.length !== nodes.length || nodes.some(node => current.find(item => item.id === node.id)?.revision !== node.revision)) {
          throw new Error('统计期间原文已经变化，请重新统计');
        }
        return result;
      };
      if (nodes.reduce((sum, node) => sum + node.length, 0) > 256 * 1024) {
        return scheduleWorkspaceQuery(context, 'statistics:' + JSON.stringify(nodes.map(node => [node.id, node.revision])), '正在本地统计正文，可继续操作画布', compute);
      }
      return { result: await compute() };
    },
  }),
  action('content.filter', 'text-node', '按名称、群组和连线状态筛选', '查询', 'query', {
    titleIncludes: optional(string(200)), groupId: optional(string(200)), empty: optional(boolean),
    unconnected: optional(boolean), excludeIds: optional(ids), sort: optional(oneOf('title', 'position')), limit: optional(number(1, 100, true)),
    inViewport: optional(boolean),
  }, {
    commands: [], queries: [], capabilities: ['content.summaries@1', 'groups.list@1', 'connections.graph@1'],
    run: async (context, args) => {
      let nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
      if (args.groupId) {
        const group = (await context.capabilities.request<GroupRecord[]>('groups.list@1')).find(group => group.id === args.groupId);
        if (!group) throw new Error('限定的群组已失效');
        const members = new Set(group.memberIds);
        nodes = nodes.filter(node => members.has(node.id));
      }
      if (args.unconnected !== undefined) {
        const graph = await context.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
        const linked = new Set(graph.connections.flatMap(edge => [edge.from.nodeId, edge.to.nodeId]));
        nodes = nodes.filter(node => linked.has(node.id) !== args.unconnected);
      }
      const excluded = new Set(Array.isArray(args.excludeIds) ? args.excludeIds : []);
      const title = typeof args.titleIncludes === 'string' ? nameKey(args.titleIncludes) : '';
      nodes = nodes.filter(node => !excluded.has(node.id) && (!title || nameKey(node.title).includes(title)) &&
        (args.empty === undefined || (node.length === 0) === args.empty));
      if (args.inViewport) {
        const [camera, viewport] = await Promise.all([
          context.capabilities.request<CameraState>('canvas.camera@1'), context.capabilities.request<CanvasViewportSize>('canvas.viewport@1'),
        ]);
        const box = { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: viewport.width / camera.zoom, height: viewport.height / camera.zoom };
        nodes = nodes.filter(node => node.x < box.x + box.width && node.x + node.width > box.x && node.y < box.y + box.height && node.y + node.height > box.y);
      }
      nodes.sort(args.sort === 'position' ? (a, b) => a.y - b.y || a.x - b.x : (a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }));
      const total = nodes.length;
      if (args.limit) nodes = nodes.slice(0, Number(args.limit));
      return { result: { count: nodes.length, total, ids: nodes.map(node => node.id), matches: nodes.slice(0, 100)
        .map(({ id, title, revision }) => ({ id, title, revision })) } };
    },
  }),
  command('file.copy', 'import-export', '导出当前书的本地副本', '文件', 'file', 'file.saveLocalCopy@1', {}, undefined,
    async (_context, result) => ({ status: 'waiting', result, message: '本地副本正在生成，等待文件任务结果' })),
  command('file.exportText', 'import-export', '导出指定节点为文本', '文件', 'file', 'file.exportText', { target },
    async (args, resolve) => ({ scope: 'current', nodeId: (await resolve(asTarget(args.target))).id }),
    async (_context, result) => ({ status: 'waiting', result, message: '文本正在生成，等待文件任务结果' })),
  command('file.exportWord', 'import-export', '导出指定节点为 Word', '文件', 'file', 'file.exportWord', { target },
    async (args, resolve) => ({ scope: 'current', nodeId: (await resolve(asTarget(args.target))).id }),
    async (_context, result) => ({ status: 'waiting', result, message: 'Word 正在生成，等待文件任务结果' })),
  capability('file.result', 'import-export', '读取本地文件任务结果', '文件', 'file.operationResult@1', { taskId: string(200) }),
  command('file.importText', 'import-export', '导入已提供的本地文本', '文件', 'document', 'file.commitImportedDocuments',
    { title: string(200), text: emptyOrText(32768), x: number(-1e9, 1e9), y: number(-1e9, 1e9) },
    args => ({ documents: [{ title: args.title, body: args.text, x: args.x, y: args.y }] })),
  query('assistant.memories', 'ai-assistant', '读取本地记忆目录', '助手', 'ai.memoryCatalog'),
  command('assistant.openSession', 'ai-assistant', '继续已有会话', '助手', 'workspace', 'ai.assistant.openSession', { sessionId: string(200) }),
  command('assistant.template', 'ai-assistant', '选择已有模板', '助手', 'workspace', 'ai.assistant.setPromptTemplate',
    { assistantId: string(200), resourceId: emptyOrText(200) }),
  action('connection.path', 'connections', '查询两点之间最短连线路径', '连线', 'query', {
    from: target, to: target, directed: optional(boolean),
  }, {
    commands: [], queries: [], capabilities: ['connections.graph@1'],
    run: async (context, args, resolve) => {
      const start = (await resolve(asTarget(args.from))).id;
      const end = (await resolve(asTarget(args.to))).id;
      const graph = await context.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
      const adjacency = new Map<string, Array<{ to: string; edge: string }>>();
      const add = (from: string, to: string, edge: string) => {
        const list = adjacency.get(from) ?? [];
        list.push({ to, edge });
        adjacency.set(from, list);
      };
      for (const edge of graph.connections) {
        add(edge.from.nodeId, edge.to.nodeId, edge.id);
        if (!args.directed) add(edge.to.nodeId, edge.from.nodeId, edge.id);
      }
      const parent = new Map<string, { from: string; edge: string }>();
      const seen = new Set([start]);
      const queue = [start];
      for (let index = 0; index < queue.length && !seen.has(end); index += 1) {
        for (const next of adjacency.get(queue[index]!) ?? []) if (!seen.has(next.to)) {
          seen.add(next.to);
          parent.set(next.to, { from: queue[index]!, edge: next.edge });
          queue.push(next.to);
        }
      }
      if (!seen.has(end)) return { result: { found: false, nodeIds: [], edgeIds: [] } };
      const nodeIds = [end];
      const edgeIds: string[] = [];
      let current = end;
      while (current !== start) {
        const previous = parent.get(current)!;
        edgeIds.unshift(previous.edge);
        nodeIds.unshift(previous.from);
        current = previous.from;
      }
      return { result: { found: true, nodeIds, edgeIds } };
    },
  }),
  action('layout.inspect', 'text-node', '读取重叠与位置证据', '布局', 'query', { nodeIds: ids }, {
    commands: [], queries: [], capabilities: ['content.canvasSummariesById@1'],
    run: async (context, args) => {
      const nodes = await context.capabilities.request<ContentSummary[]>('content.canvasSummariesById@1', { nodeIds: args.nodeIds });
      const overlaps: Array<{ a: string; b: string }> = [];
      for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) {
          overlaps.push({ a: a.id, b: b.id });
        }
      }
      return { result: { nodes: nodes.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })), overlaps } };
    },
  }),
);
