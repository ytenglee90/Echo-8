import type { WorkspaceLanguageStep } from './workspace-language.ts';
import { canvasIntentText, canvasRequestDisposition } from './ai-task-route.ts';
import { readWorkspaceSelectionReference, selectedWorkspaceName, workspaceCount } from './workspace-selection-reference.ts';
import { workspaceStructuralIntent } from './workspace-structural-intent.ts';
import { workspaceDuplicateIntent } from './workspace-duplicate-intent.ts';
import { palettePresetIntent } from './palette-preset-intent.ts';

type Binding = 'node' | 'paragraph' | 'paragraph-replacement' | 'node-ids' | 'two-nodes' | 'duplicate' | 'format' |
  'range-format' | 'range-reveal' | 'session' | 'assistant' | 'checkpoint' | 'clipboard-selection' |
  'paragraph-extract' | 'group' | 'group-members' | 'group-member' | 'members' | 'annotation' | 'clipboard-paste' | 'shortcut' | 'template' | 'import-text' | 'pane-ratios' | 'selected-node';

export interface CatalogIntent {
  steps: WorkspaceLanguageStep[];
  binding?: Binding;
  operand?: string;
  groupOperand?: string;
  ratioWeights?: number[];
  idArgument?: 'ids' | 'nodeIds';
  parts?: CatalogIntent[];
  primitive?: true;
  input: string;
}

export function catalogUsesSelection(intent: CatalogIntent | undefined): boolean {
  return Boolean(intent && (['two-nodes', 'node-ids', 'clipboard-selection', 'selected-node'].includes(intent.binding ?? '') ||
    intent.steps.some(step => step.selection) || intent.parts?.some(catalogUsesSelection)));
}

// Vocabulary for subjects and operations. The same subject can be opened, closed, or inspected.
const subject = {
  minimap: /小地图|缩略地图|画布导航|导航小窗/u,
  find: /查找|搜索|搜寻|检索/u,
  palette: /配色|外观|全局颜色|颜色设置/u,
  shortcuts: /快捷键|快捷操作键|按键|键盘绑定|绑定了?哪个键/u,
  settings: /设置中心|(?:应用|工作区)(?:的)?设置|配置页/u,
  diagnostic: /诊断|故障信息/u,
  operations: /操作.{0,12}(?:记录|日志|回执)|(?:动作|执行)(?:回执|记录)|(?:操作|动作).{0,6}(?:完成或失败记录|执行记录)|上一步.{0,8}执行成功/u,
  file: /文件|本地|书[籍本]?|项目/u,
  recovery: /恢复点|快照|恢复(?:记录|版本)/u,
  library: /书库|书籍首页|书籍列表/u,
  assistant: /助手|AI\s*(?:对话|窗口)/iu,
  session: /对话|会话|聊天/u,
  correction: /校对|纠错|修正错别字/u,
  completion: /补全|自动补写词句/u,
  selection: /选中|选区|选着|这些卡|这[两三四五几\d]张卡/u,
  nodes: /卡片?|节点|文本框|画布对象/u,
  groups: /群组|分组|哪些组/u,
  annotations: /批注|标注|注释/u,
  format: /排版|字号|字体大小|行距|粗体|加粗|号字|正文.{0,10}格式/u,
  searchResult: /命中|匹配|查找结果|搜索结果/u,
};

const verb = {
  read: /^(?:查看|查询|检查|读取|读出|看(?:看|一下)|让我看看|给我(?:看看|看|一份)|一份|列出|列一下|告诉我|现在|当前|哪些|上一步)|是否|有没有|多少|几次|多大|有哪|开着吗|打开了吗|在哪里|里.{0,6}有什么|内容给我$/u,
  open: /打开|开启|显示|展开|进入|弹出|带我去|让我(?:选择|编辑)/u,
  close: /关闭|关掉|收起|隐藏|停(?:止|用)|不要再|不再显示/u,
  set: /设(?:置)?(?:为|成)|改(?:成|为|用)|换成|调(?:整)?到|绑定/u,
  export: /导出|另存|保存|给我一份/u,
  next: /下(?:一|个)(?:个|条|处)?/u,
  previous: /上(?:一|个)(?:个|条|处)?|前一处/u,
};

type Facet = readonly [RegExp, string];
const reads: readonly Facet[] = [
  [/自动保存(?:的)?(?:实际|当前)?(?:间隔|周期|配置)|(?:多久|多长时间)自动保存/u, 'persistence.preferences'],
  [/持久化|(?:文件|本地|书籍|这本书).{0,12}(?:保存状态|保存情况|保存成功|保存现在)/u, 'persistence.read'],
  [/(?:缓存|本机).{0,16}(?:有哪些书|授权书籍|书籍.{0,4}列表)|书籍.{0,6}本地缓存/u, 'library.cachedProjects'],
  [/(?:云)?同步(?:和授权|状态)|缓存的授权和同步/u, 'cloud.state'],
  [/(?:书籍|文档|这本书).{0,8}(?:修订(?:号|版本)?|版本编号)/u, 'document.revision'],
  [/(?:存储|空间).{0,6}占用|(?:存|占用)了多少.{0,8}(?:空间|数据)/u, 'storage.read'],
  [/(?:运行|实时)状态|应用.{0,8}运行情况/u, 'workspace.state'],
  [/插件.{0,8}(?:状态|启停|启用)|模块.{0,6}(?:启用|启停)/u, 'plugins.read'],
  [/剪贴板|(?:刚|刚才)复制的对象/u, 'clipboard.read'],
  [/用量|调用了几次模型|token/iu, 'assistant.usage'],
  [/提示模板|写作模板|模板目录/u, 'assistant.templates'],
  [/历史记忆|聊天存档目录/u, 'assistant.memories'],
  [/(?:会话|对话).{0,8}(?:原话|原文|记录)|(?:聊天|会话)内容/u, 'assistant.transcript'],
  [/(?:激活|当前).{0,8}(?:ai\s*对话|会话)|开了哪些助手/iu, 'assistant.state'],
  [subject.shortcuts, 'shortcuts.read'],
  [subject.operations, 'diagnostics.operations'],
  [/诊断|记录错误/u, 'diagnostics.read'],
  [subject.minimap, 'minimap.read'],
  [subject.library, 'library.state'],
  [subject.recovery, 'recovery.list'],
  [subject.searchResult, 'search.read'],
  [subject.selection, 'selection.read'],
  [subject.annotations, 'annotation.list'],
  [subject.groups, 'group.list'],
  [subject.correction, 'correction.settings'],
  [/配色|外观|全局颜色|颜色设置|应用了哪些颜色/u, 'appearance.read'],
  [/可操作对象|(?:画布)?对象.{0,4}的?目录|画布对象的目录|卡片.{0,4}群组.{0,4}连线/u, 'entities.list'],
  [/(?:可见|显示)区域.{0,8}(?:多大|尺寸|宽高)|视口.{0,4}宽高/u, 'viewport.size'],
];

const panels: readonly Facet[] = [
  [/同步.{0,8}(?:账户|设置)|(?:账户|账号).{0,8}同步/u, 'registered:cloud-sync:cloud-sync.open-action'],
  [/画布控制|画布操作.{0,6}(?:预览|审查)面板/u, 'registered:canvas-control:canvas-control.open-action'],
  [/工作区动作|本地动作.{0,8}(?:计划|目录)|动作索引/u, 'registered:workspace-actions:workspace-actions.open'],
  [/(?:模型|AI).{0,10}(?:密钥|连接).{0,6}(?:配置|设置|页面|面板)|(?:模型连接|密钥)(?:配置|设置)(?:页|面板)/iu, 'registered:ai-assistant:ai.open-provider-settings-action'],
  [subject.minimap, 'minimap.open'],
  [subject.shortcuts, 'settings.keys.open'],
  [subject.operations, 'diagnostics.log'],
  [subject.diagnostic, 'diagnostics.open'],
  [/(?:书籍|文件).{0,6}(?:管理|恢复|保存).{0,6}(?:设置|页面|面板)|文件.{0,6}恢复/u, 'file.panel'],
  [subject.library, 'library.show'],
  [/(?:校对|纠错|补全).{0,10}规则/u, 'correction.rules'],
  [subject.palette, 'palette.open'],
  [subject.settings, 'settings.open'],
  [subject.find, 'search.open'],
];

const closes: readonly Facet[] = [
  [subject.minimap, 'minimap.close'],
  [subject.annotations, 'annotation.close'],
  [subject.assistant, 'assistant.close'],
  [subject.palette, 'palette.close'],
  [subject.find, 'search.close'],
];

function bindingFor(action: string): Binding | undefined {
  if (action === 'assistant.usage' || action === 'assistant.transcript') return 'session';
  return undefined;
}

function findValue(input: string): string | undefined {
  const literal = /[「『“"]([^」』”"\n]{1,120})[」』”"]/u.exec(input);
  if (literal) return literal[1];
  const after = /(?:查找|搜索|搜(?:一下)?|包含|写了|窗口找)\s*([^，,。！？?\n]+?)\s*[。！？?]*$/u.exec(
    input.replace(/(?:查找|搜索)(?:替换)?(?:面板|窗口)(?=\s*(?:查找|搜索|找))/u, '窗口'),
  )?.[1];
  const before = /(?:画布|全书)\s*([^，,。！？?\s]{1,120}?)\s*(?:查找|搜索)$/u.exec(input)?.[1];
  const value = before ?? after?.replace(/^哪些地方写了/u, '')
    .replace(/的?(?:位置|地方|结果|命中|词语|词组)$/u, '')
    .replace(/这(?:两|几|\d+)个字$/u, '').trim();
  return value && !/^(?:结果|窗口|面板|一下|哪些|什么)/u.test(value) ? value : undefined;
}

function numericTime(text: string) {
  if (/半分钟/u.test(text)) return 30_000;
  const duration = /(?:^|[^\d])(\d{1,8})\s*(毫秒|秒|分钟|小时)(?!钟)/u.exec(text);
  if (!duration) return undefined;
  const unit = { 毫秒: 1, 秒: 1_000, 分钟: 60_000, 小时: 3_600_000 }[duration[2]!];
  return unit === undefined ? undefined : Number(duration[1]) * unit;
}

/** Slot-bearing operations still need explicit values and actual object IDs from the workspace. */
function withArguments(text: string, input: string): Omit<CatalogIntent, 'input'> | undefined {
  const one = (action: string, args?: Record<string, unknown>, binding?: Binding) =>
    ({ steps: [{ id: 'catalog-1', action, arguments: args }], binding });
  const preset = palettePresetIntent(canvasIntentText(input));
  if (preset) return one('appearance.preset.apply', { id: preset });
  if (/规则/u.test(text) && /纠错|校对/u.test(text) && /txt|文本格式/iu.test(text) &&
    /导入|更新|选择/u.test(text)) return one('registered:text-assist:text-assist.load-rules-file-action');
  if (/颜色|调色/u.test(text) && /修改|调整|更改|打开|显示/u.test(text) &&
    !/全局|工具栏|界面|编辑器|改成|设为/u.test(text)) {
    const operand = /^(?:打开|显示|修改|调整|更改)\s*(.+?)(?:的)?(?:局部)?(?:颜色(?:选择器|面板)?|调色(?:面板|盘)?)[。！!]?$/u.exec(text)?.[1];
    const selection = operand && readWorkspaceSelectionReference(operand);
    const action = 'registered:palette:palette.selection-color-action';
    return selection ? { steps: [{ id: 'catalog-1', action, selection: { ...selection, argument: 'ids' } }] }
      : { ...one(action, undefined, 'node-ids'), idArgument: 'ids' };
  }
  const saveVerb = '(?:保存|存下|存好|存盘)';
  const fileSubject = '(?:(?:当前|现在|这|此)(?:本|个|的)?\\s*)?(?:书籍?|项目|文档)';
  const saveObject = '(?:(?:当前|现在|这次|本次|这本)(?:的)?\\s*)?(?:书籍?|项目|文档|修改|改动|内容)';
  if (new RegExp('^(?:(?:立即|马上|现在)\\s*)?' + saveVerb + '\\s*' + saveObject + '[。！!]?$', 'u').test(text) ||
    new RegExp('^(?:把|将)?\\s*' + fileSubject + '\\s*' + saveVerb + '(?:下来|一下|好)?[。！!]?$', 'u').test(text)) {
    return one('registered:import-export:file.save-action');
  }
  if (/另存|保存为|创建/u.test(text) && /云端|云书籍/u.test(text) && /另存|新|副本/u.test(text) &&
    !/^(?:先)?(?:不要|别|不用|暂不|不想|无需|禁止)|同步|上传|更新|覆盖/u.test(text)) {
    return one('registered:cloud-sync:cloud-sync.save-as-action');
  }
  if (/编辑器|编辑窗格|编辑页/u.test(text) && /比例|宽度|分配|分之/u.test(text) &&
    /设|分配|占|按/u.test(text) && !verb.read.test(text)) {
    const numeral = '[一二两三四五六七八九十百零〇0-9]{1,5}';
    const ratio = new RegExp(numeral + '(?:\\s*(?:比|[:：])\\s*' + numeral + ')+', 'u').exec(text)?.[0];
    const allocations = [...text.matchAll(new RegExp('(左|中|右)(?:边|侧|间)?(?:的)?(?:编辑器|编辑窗格|窗格|编辑页)?\\s*(?:占|为|设为|宽度为)\\s*(' + numeral + ')分之(' + numeral + ')', 'gu'))];
    const fractions = new Map(allocations.map(match => [match[1], Number(workspaceCount(match[3]!)) / Number(workspaceCount(match[2]!))]));
    const positions = allocations.length === 3 ? ['左', '中', '右'] : ['左', '右'];
    const ratioWeights = ratio ? ratio.split(/\s*(?:比|[:：])\s*/u).map(workspaceCount) :
      allocations.length === positions.length && fractions.size === positions.length ? positions.map(position => fractions.get(position)) : undefined;
    if (ratioWeights && ratioWeights.length <= 3 &&
      ratioWeights.every((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      return { ...one('editor.ratios', undefined, 'pane-ratios'), ratioWeights };
    }
  }
  const selectedFocus = /^(?:把|将)?\s*(.+?)\s*(?:放在|放到|置于)(?:画面|视口|视图)(?:的)?(?:中央|正中间?|中心)[。！!]?$/u.exec(input);
  if (selectedFocus && selectedWorkspaceName(selectedFocus[1]!)) {
    return { ...one('viewport.focusEntity', undefined, 'selected-node'), operand: selectedFocus[1] };
  }
  if (subject.shortcuts.test(text) && /恢复|还原|重置/u.test(text) && /默认|原样|原来/u.test(text)) {
    return { ...one('shortcuts.reset', undefined, 'shortcut'), operand: input };
  }
  if ((subject.shortcuts.test(text) || /绑定/u.test(text)) && verb.set.test(text)) {
    const chord = /(?:改为|改成|设置成|设为|绑定(?:为|到)?)\s*([a-z0-9+加 -]+)[。！!]?$/iu.exec(input)?.[1];
    if (chord) return { ...one('shortcuts.set', { chord }, 'shortcut'), operand: input.slice(0, input.lastIndexOf(chord)) };
  }
  if (/模板/u.test(text) && /选择|使用|切到|切换|设为|改为/u.test(text) && /助手|会话|本轮|已有/u.test(text)) {
    return { ...one('assistant.template', undefined, 'template'), operand: input };
  }
  if (/自动取材/u.test(text) && /关闭|停止/u.test(text) && /指定|明确/u.test(text)) {
    return one('assistant.context', { mode: 'explicit-only' }, 'assistant');
  }
  const imported = /^导入(?:纯)?文本\s*(.+?)[,，]\s*(?:正文|内容)(?:是|为)[：:]?\s*(.+)$/u.exec(input);
  const literalImport = /^(?:把|将)\s*(.+?)\s*作为\s*(.+?)这张(?:文本卡|卡片|节点)\s*导入[。！!]?$/u.exec(input);
  if (imported || literalImport) return one('file.importText', {
    title: (imported?.[1] ?? literalImport![2]!).trim().replace(/^[「『“"]|[」』”"]$/gu, ''),
    text: (imported?.[2] ?? literalImport![1]!).trim().replace(/^[「『“"]|[」』”"]$/gu, ''),
  }, 'import-text');
  if (/^自动排列\s*/u.test(text)) {
    const selection = readWorkspaceSelectionReference(text.replace(/^自动排列\s*/u, ''));
    if (selection) return { steps: [{ id: 'catalog-1', action: 'layout.arrange', selection }] };
  }
  if (/自动保存|自动存(?:盘|档)/u.test(text) && (verb.set.test(text) || /^(?:每隔|每\d)/u.test(text))) {
    const intervalMs = numericTime(text);
    if (intervalMs !== undefined) return one('persistence.interval', { intervalMs });
  }
  const toggles: readonly Facet[] = [
    [/智能参考线|对齐辅助线|拖动.{0,12}参考线/u, 'layout.guides.toggle'],
    [/吸附|自动吸到/u, 'layout.snap.toggle'],
    [subject.correction, 'correction.toggle'],
    [subject.completion, 'completion.toggle'],
  ];
  const switchTo = /关闭|关掉|停用|停止|不要(?:再|让|显示)/u.test(text) ? false
    : /开启|启用|打开/u.test(text) ? true : undefined;
  if (switchTo !== undefined && !/规则|面板|窗口|设置页|是否|吗|配置/u.test(text)) {
    const options = toggles.filter(([noun]) => noun.test(text));
    if (options.length === 1) return one(options[0]![1], { enabled: switchTo });
  }
  if ((/(?:导出|另存|保存).{0,12}(?:txt|纯文本|文本文件|docx|word)/iu.test(text) ||
    /^(?:给我一份|生成).{1,80}的(?:txt|纯文本|文本文件|docx|word)(?:文档|文件)?(?:给我)?[。！!]?$/iu.test(text)) &&
    !/样例|模板|编造|新写/u.test(text)) {
    return one(/docx|word/iu.test(text) ? 'file.exportWord' : 'file.exportText', undefined, 'node');
  }
  if (verb.export.test(text) && /副本|另存|(?:另外|另行|单独)保存|保存一份|不(?:要)?覆盖/u.test(text) && subject.file.test(text) &&
    !/云端|联网|上传/u.test(text)) return one('file.copy');
  if ((subject.recovery.test(text) || /(?:与|和)(?:当前|现在)(?:的)?(?:书籍|文档).{0,8}差异/u.test(text)) &&
    /(?:差异|对比|预览|看看.{0,80}内容)/u.test(text) && !/(?:创建|新建|建立|制作|做个)/u.test(text)) {
    return one('recovery.preview', undefined, 'checkpoint');
  }
  if (subject.recovery.test(text) && /创建|新建|建立|保存一份|做个|做一个/u.test(text) && !/覆盖|删除|预览|恢复到|云端/u.test(text)) {
    const label = /(?:名为|叫做?|命名为)\s*([^，,。！？]{1,80}?)(?:的(?:本地)?(?:恢复点|快照)|[。！!]?$)/u.exec(input)?.[1]
      ?? /保存一份\s*([^，,。！？]{1,80}?)\s*(?:恢复点|恢复记录|快照)[。！!]?$/u.exec(input)?.[1];
    return one('recovery.create', label ? { label: label.replace(/^[「『“"]|[」』”"]$/gu, '') } : undefined);
  }
  if (verb.read.test(text) && subject.format.test(text) && /正文|章节|文字|排版|字号|行距/u.test(text)) {
    return one('format.read', undefined, 'node');
  }
  if (/正文字号|字号|字体大小|号字/u.test(text) && verb.set.test(text) && !/选中|开头|第.{0,8}(?:段|个字)|部分/u.test(text)) {
    const size = /(?:字号|字体大小).{0,8}?(\d{1,2})(?!\d)|(?:改用)\s*(\d{1,2})(?:号字|px)/u.exec(text);
    if (size) return one('format.document', { patch: { fontSize: Number(size[1] ?? size[2]) } }, 'format');
  }
  const range = /(?:开头|最前面(?:的)?|前)\s*([一二两三四五六七八九十\d]{1,3})\s*(?:个)?(?:字|字符)|第\s*(\d{1,4})\s*(?:到|至)\s*(\d{1,4})\s*个字符/u.exec(text);
  if (range && !verb.read.test(text) && !/不要.{0,15}(?:加粗|选中|高亮)|别.{0,15}(?:加粗|选中|高亮)/u.test(text)) {
    const chinese = '零一二三四五六七八九十'.indexOf(range[1] === '两' ? '二' : range[1] ?? '');
    const end = range[1] ? chinese > 0 ? chinese : Number(range[1]) : Number(range[3]);
    const start = Number(range[2] ?? '0');
    if (Number.isSafeInteger(end) && end > start && end <= 4096) {
      if (/加粗|粗体/u.test(text)) return one('format.range', { start, end, scope: 'selection', patch: { fontWeight: 700 } }, 'range-format');
      if (/选中|高亮|定位/u.test(text)) return one('editor.reveal', { start, end }, 'range-reveal');
    }
  }
  if (verb.read.test(text) && /坐标|尺寸|宽度和高度|位置.{0,4}大小/u.test(text) && subject.nodes.test(text)) {
    return one('node.inspect', undefined, 'node');
  }
  const paragraph = /首段|第一段|开头(?:那|一)?段|开头(?=替换)/u.test(text);
  if (paragraph && /替换|换为|换成|改成|改为/u.test(text)) {
    const replacement = /(?:改成|改为|换成|换为|替换为)\s*(.+)$/u.exec(input)?.[1]
      ?? /^(?:请|帮我)?用\s*(.+?)\s*替换/u.exec(input)?.[1];
    const value = replacement?.replace(/(?:的)?(?:预览|稿件)(?:[，,]\s*原文保留)?[。！!]?$/u, '').trim();
    if (value) return one('content.draft.preview', { text: value.replace(/^[「『“"]|[」』”"]$/gu, '') }, 'paragraph-replacement');
  }
  if (paragraph && /读出|看看|摘出|读一下|查看|给我看/u.test(text) && !/复制到|新卡|另存|写入/u.test(text)) {
    return one('content.read', undefined, 'paragraph');
  }
  if (/原文|文字|正文|章节/u.test(text) && /差异|不一样|不同|逐字对照/u.test(text) && verb.read.test(text)) {
    return one('content.diff', { length: 8_192 }, 'two-nodes');
  }
  if (/字数|多少字|文字统计|正文.{0,4}统计|计数口径/u.test(text) && /告诉我|查看|统计|数一下|数一数|只数|计算/u.test(text)) {
    if (subject.selection.test(text)) return one('statistics.selection');
    if (/整张画布|所有(?:节点|卡片)|全(?:部|画布)/u.test(text)) return one('statistics.read');
    return one('content.statistics', undefined, 'node-ids');
  }
  if (/最短/u.test(text) && /路径|路线/u.test(text) && /连线|沿出线|到|至/u.test(text)) {
    return one('connection.path', { directed: /沿|方向|出线/u.test(text) }, 'two-nodes');
  }
  if (/(?:正文为空|空白(?:卡片?|节点)|空卡)/u.test(text) && /没(?:有)?连线|没有关系线|无连线|未连接/u.test(text) &&
    /筛选|找出|交集/u.test(text)) return one('content.filter', { empty: true, unconnected: true, limit: 100 });
  if (subject.find.test(text) || /包含.+字.{0,4}位置|哪些地方写了/u.test(text)) {
    if (verb.next.test(text) && subject.searchResult.test(text)) return one('search.next');
    if (verb.previous.test(text) && subject.searchResult.test(text)) return one('search.previous');
    if (!subject.searchResult.test(text) && !/查找面板$|搜索窗口$/u.test(text)) {
      const query = findValue(input);
      if (query && subject.find.test(text) && /面板|窗口|全画布/u.test(text)) {
        const run: WorkspaceLanguageStep = { id: 'catalog-2', action: 'search.run', arguments: { query, scope: 'canvas', matchCase: false, wholeWord: false } };
        return { steps: [{ id: 'catalog-1', action: 'search.open' }, run] };
      }
      if (query && /正文|包含|哪些地方写了/u.test(text)) return one('content.search', { query });
    }
  }
  if (/仅|明确/u.test(text) && /资料|来源|引用/u.test(text) && /本轮|这次|当前助手/u.test(text) &&
    /只|切换|切为|设置/u.test(text) && !/摘要|总结|润色|创作/u.test(text)) return one('assistant.context', { mode: 'explicit-only' }, 'assistant');
  if (/自动排列|整理成(?:规则|网格|宫格)布局/u.test(text) && subject.selection.test(text) &&
    !/间距|[一二两三四五六七八九十\d]+\s*列|移动.*以外|除外/u.test(text)) {
    const selection = readWorkspaceSelectionReference(text.replace(/^(?:把|将|给)?\s*(?:自动排列)?/u, '')
      .replace(/(?:整理成(?:规则|网格|宫格)布局|(?:执行)?自动排列)[。！!]?$/u, '').trim());
    if (selection) return { steps: [{ id: 'catalog-1', action: 'layout.arrange', selection }] };
  }
  if (/选(?:中|择|起来)|全选/u.test(text) && /(?:全部|所有)(?:可选)?(?:画布对象|对象|卡片|节点)/u.test(text) &&
    !/除外|除了|并|删除|改|复制/u.test(text)) return one('selection.all');
  const copy = /^(?:(?:只)?(?:复制|拷贝|拷一下)(?:一下)?\s*(.*?)(?:到(?:内部)?剪贴板)?|(?:把|将)\s*(.+?)\s*(?:复制|拷贝)(?:到(?:内部)?剪贴板)?)[。！!]?$/u.exec(text);
  if (copy && !/接着|然后|并|删除|剪切|导出|新卡|右侧|到画布|并保留/u.test(text)) {
    const operand = (copy[1] ?? copy[2] ?? '').trim();
    const selection = readWorkspaceSelectionReference(operand === '当前' || !operand ? '当前选区' : operand);
    if (selection) return { steps: [{ id: 'catalog-1', action: 'clipboard.copy', selection }] };
    if (/卡片?$|节点$|选中(?:的)?|^□$/u.test(operand)) return one('clipboard.copy', undefined, 'clipboard-selection');
  }
  const cut = /^(?:(?:剪切|剪下)\s*(.+?)(?:[,，]\s*留待粘贴)?|(?:把|将)\s*(.+?)\s*移到(?:内部)?剪贴板)[。！!]?$/u.exec(input);
  if (cut && !/然后|并|新卡|删除|除外/u.test(text)) {
    const operand = (cut[1] ?? cut[2]!).trim();
    const selection = readWorkspaceSelectionReference(operand === '当前节点' ? '当前选中的节点' : operand);
    if (selection) return { steps: [{ id: 'catalog-1', action: 'clipboard.cut', selection }] };
    return { ...one('clipboard.cut', undefined, 'clipboard-selection'), operand };
  }
  const paste = /^(?:(?:粘贴|黏贴)\s*(?:刚才)?(?:复制(?:的|好(?:的)?))?\s*(.+?)|(?:把|将)\s*(?:复制好(?:的)?)?\s*(.+?)\s*再贴一份)[。！!]?$/u.exec(input);
  if (paste && !/然后|并|右边|右侧|删除|选中/u.test(text)) {
    return { ...one('clipboard.paste', undefined, 'clipboard-paste'), operand: (paste[1] ?? paste[2]!).trim() };
  }
  const pasteBuffer = /^(?:把|将)?\s*((?:内部)?剪贴板(?:里|中)(?:的)?(?:内容|节点|卡片?))\s*(?:粘贴|贴)(?:到|上)(?:当前)?画布[。！!]?$/u.exec(input);
  if (pasteBuffer) return { ...one('clipboard.paste', undefined, 'clipboard-paste'), operand: pasteBuffer[1] };
  return undefined;
}

/** One explicit request. Sequences must be understood in full by the existing plan compiler. */
export function workspaceCatalogIntent(prompt: string): CatalogIntent | undefined {
  const input = canvasIntentText(prompt).trim();
  if (!input || input.length > 420 || /\n|@\[|@node:/u.test(input)) return undefined;
  const text = input.replace(/[「『“"][^」』”"\r\n]*[」』”"]/gu, ' □ ')
    .replace(/^(?:不用|无需|不要)联网\s*[,，]\s*/u, '').trim();
  if (/^保留原(?:书籍?|项目|文件)\s*(?:[,，]\s*)?(?:并)?(?:导出|另存|保存)(?:一份|新的?|一个)?(?:的)?(?:本地|本机)(?:书籍|文件|副本|项目)[。！!]?$/u.test(text)) {
    return { input, steps: [{ id: 'catalog-1', action: 'file.copy' }] };
  }
  if (/^(?:怎么|怎样|如何|为什么|如果|假如|请解释|给个建议)|(?:怎么|如何)(?:做|操作|使用|打开)/u.test(text) ||
    /^(?:我)?(?:先)?(?:别|不要|不用|暂不|不想|无需|禁止)\s*(?:再|去|给我)?\s*(?:保存|导入|更新|选择|修改|另存|加载|弹出)/u.test(text) ||
    /(?:先)?(?:别|不要|不用|禁止|暂不)\s*(?:打开|开启|启用|清空)|^(?:先)?(?:别|不要|不用|禁止|暂不)\s*覆盖/u.test(text) ||
    /(?:然后|接着|随后|最后|否则|失败就|[；;]|(?:并且?|同时|再)\s*(?:打开|关闭|删除|写入|修改|上传|导出|保存)|[，,]\s*(?:(?:并|再|还要|把|将|给)(?!.*预览)|(?:统计|标黄|排列|删除|上传|另存)))/u.test(text)) return undefined;
  const disposition = canvasRequestDisposition(prompt);
  const known = workspaceDuplicateIntent(input) ?? workspaceStructuralIntent(text, input) ?? withArguments(text, input);
  if (known && (disposition === 'normal' || known.steps.every(step =>
    /^(?:content\.(?:read|diff|filter|search|draft\.preview|extract\.preview)|assistant\.context|recovery\.preview|format\.read|node\.(?:inspect|color)|group\.createExplicit|layout\.(?:inspect|plan)|canvas\.batch\.preview)$/u.test(step.action)))) {
    return { ...known, input };
  }
  const one = (action: string): CatalogIntent => ({ input, steps: [{ id: 'catalog-1', action }], binding: bindingFor(action) });
  const explicitOpen = verb.open.test(text) && !verb.read.test(text) ||
    /^(?:让我|给我)看看/u.test(text) && /日志|执行记录/u.test(text);
  const explicitClose = verb.close.test(text) && !verb.read.test(text) &&
    !/(?:关闭|收起|隐藏)的.+(?:打开|显示|展开)[。！!]?$/u.test(text);
  // Close requests address a UI surface only. Do not interpret removal of notes, files or sessions.
  if (disposition === 'normal' && explicitClose && !/删除|去掉|清除|同时|全部资料/u.test(text)) {
    const candidates = closes.filter(([noun]) => noun.test(text));
    const panel = candidates.length === 1 ? candidates[0] : undefined;
    if (panel && (panel[1] !== 'assistant.close' || /所有|全部|都/u.test(text)) &&
      (panel[1] !== 'annotation.close' || /窗口|面板|编辑区/u.test(text))) return one(panel[1]);
  }
  if (disposition === 'normal' && explicitOpen && !/删除|覆盖|恢复(?:快照|版本)|写入|查找.{0,100}(?:替换|改成|换成)/u.test(text)) {
    if (/(?:文件|书籍).{0,6}(?:选择器|选文件|文件窗口)|选择一本本地.{0,10}文件/u.test(text)) return one('file.choose');
    const matches = panels.filter(([noun]) => noun.test(text));
    const candidates = matches.length > 1 ? matches.filter(([, action]) => action !== 'settings.open') : matches;
    const panel = candidates.length === 1 ? candidates[0] : undefined;
    if (panel?.[1] === 'settings.open' && /密钥|模型连接|提供商|AI模型/iu.test(text)) return undefined;
    if (panel && (panel[1] !== 'search.open' || /面板|窗口/u.test(text))) return one(panel[1]);
  }
  if (verb.read.test(text) && !/生成|创作|改写|润色|分析|总结|比较|(?:打开|关闭|删除|写入|应用)\s*(?:这|该|所有|全部)|(?:改成|设为|绑定到)/u.test(text)) {
    if (subject.searchResult.test(text) || subject.find.test(text) && /多少处.{0,4}(?:结果|命中|匹配)/u.test(text)) return one('search.read');
    const match = reads.find(([noun]) => noun.test(text));
    if (match) return one(match[1]);
  }
  return undefined;
}
