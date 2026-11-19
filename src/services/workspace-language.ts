import { workspaceSimpleControl } from './workspace-controls.ts';
import type { WorkspacePlanStep } from '../protocols/workspace-actions.ts';
import { readWorkspaceSelectionReference, type WorkspaceSelectionReference } from './workspace-selection-reference.ts';

export { workspaceSurfaceAction } from './workspace-controls.ts';

const QUOTE = /「([^」\r\n]+)」|『([^』\r\n]+)』|“([^”\r\n]+)”|"([^"\r\n]+)"/gu;
const DECIMAL = '[0-9０-９]+(?:[.．][0-9０-９]+)?';
const NUMBER = DECIMAL + '|[零〇一二两三四五六七八九十百点]+';
const NODE = /(?:空白|空|文字|文本)?(?:卡片?|节点|文本框)$/u;
const NODE_TYPE = /(?:卡片?|节点|文本框)$/u;
const VIEW = '(?:(?:当前|现在|现有|原来)(?:的)?)?(?:画布|视图|视口|画面)?(?:的)?';
const ZOOM = '(?:缩放(?:比例|倍率)?|倍率|比例)';
const PERCENT = '(?:百分之(' + NUMBER + ')|(' + NUMBER + ')\\s*[%％])';

export const workspaceNameKey = (name: string) => name.trim().normalize('NFKC').toLowerCase();

function numericValue(text: string): number {
  text = text.normalize('NFKC');
  if (/^-?[0-9.]+$/u.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  const converted = text.replace(/两/gu, '二').replace(/〇/gu, '零');
  const [whole, decimal] = converted.split('点');
  if (!whole || decimal && /[十百]/u.test(decimal)) return NaN;
  let total = 0;
  let digit = 0;
  for (const char of whole) {
    if (char === '百' || char === '十') {
      total += (digit || 1) * (char === '百' ? 100 : 10);
      digit = 0;
    } else {
      digit = digit * 10 + digits.indexOf(char);
    }
  }
  return total + digit + (decimal ? Number('0.' + [...decimal].map(char => digits.indexOf(char)).join('')) : 0);
}

const percentValue = (match: RegExpExecArray, start = 1) => numericValue(match[start] ?? match[start + 1]!) / 100;
const exact = (pattern: string) => new RegExp('^' + pattern + '$', 'u');
const absoluteZoom = exact('(?:把|将)?' + VIEW + '\\s*(?:' + ZOOM +
  '(?:设(?:置|定)?(?:为|成|到)|调(?:整)?(?:到|成|为)|到|至|为|保持在?)?|(?:缩|放大|缩小)(?:到|至)|(?:设(?:为|成)|调(?:到|至))|保持在?)\\s*' + PERCENT);
const relativeZoom = exact('(?:把|将)?' + VIEW + '\\s*(?:' + ZOOM + ')?(?:乘以\\s*(' + DECIMAL + ')|(?:在' +
  VIEW + '(?:' + PERCENT + ')?的基础上)?(缩小|放大)\\s*' + PERCENT + ')');
const relativeTenths = exact('(?:把|将)?' + VIEW + '(缩小|放大)\\s*(' + NUMBER + ')成(?:[,，]\\s*(?:留下|保留)原来的(' + NUMBER + ')成)?');
const focusAtZoom = exact('在' + PERCENT + '(?:的)?缩放下(?:聚焦|定位)(?:到)?(?:整个)?(.+)');
const zoomQuestion = /^(?:(?:告诉我|查询|查看|查(?:看)?一下|读(?:出|取))\s*)?(?:现在|当前|目前)?\s*(?:画布|视口|视图|画面)(?:的|现在|当前|目前)?(?:缩放(?:比例|倍率)?|倍率|比例|放大了)(?:是(?:多少)?|多少|多大)?$/u;

export interface WorkspaceLanguageStep extends WorkspacePlanStep {
  selection?: WorkspaceSelectionReference;
  group?: { title: string };
}
type Action = Omit<WorkspaceLanguageStep, 'id' | 'dependsOn' | 'when'>;
type Title = (value: string) => string;

function objectAction(text: string, title: Title, literal: Title): Action | undefined {
  const target = (value: string) => ({ target: { title: title(value) } });
  const focus = /^(?:(?:聚焦|居中到|跳转|跳)(?:到|至|于)?\s*(.+)|(?:把|将)\s*(.+?)\s*(?:放到|置于)(?:视口|画面|视图)正中(?:间|心)?|(?:让)\s*(.+?)\s*显示在(?:画面|视口)中央)$/u.exec(text);
  if (focus && !/^(?:下一个|上一个|刚才|标注|批注|选区|选中|它$)/u.test(focus[1] ?? focus[2] ?? focus[3]!)) {
    return { action: 'viewport.set', arguments: target(focus[1] ?? focus[2] ?? focus[3]!) };
  }
  const lookup = /^(?:找到|查找|找一下|定位一下)\s*(.+)$/u.exec(text);
  if (lookup && (NODE_TYPE.test(lookup[1]!) || /^\uE000\d+\uE001$/u.test(lookup[1]!)) &&
    !/包含|正文|和|并|连线|群组|关键词|回忆/u.test(lookup[1]!)) {
    return { action: 'content.find', arguments: { title: title(lookup[1]!) } };
  }
  const select = /^(?:只)?(?:选中|选择)\s*(.+)|^(?:把|将)\s*(.+?)\s*(?:设为当前选区|选中)$/u.exec(text);
  const selectedName = select?.[1] ?? select?.[2];
  if (selectedName && (select?.[2] || /名叫|卡片?$|节点$|^\uE000/u.test(selectedName)) && !/所有|全部|这些|选中|或|以及|和|与/u.test(selectedName)) {
    return { action: 'selection.set', arguments: { targets: [{ title: title(selectedName) }] } };
  }
  const create = /^(?:新建|创建|添加|建)\s*(.+)$/u.exec(text);
  if (create && NODE.test(create[1]!) && /(?:叫做?|名为|命名为|标题为)|(?:这张|这个)(?:空白|空|文字|文本)?(?:卡片?|节点)$/u.test(create[1]!) &&
    !/并|然后|写入|填入|生成|群组|连线|书籍|文本框$/u.test(create[1]!)) {
    const operand = create[1]!.replace(/^(?:一[张个]|一份|这[张个])\s*/u, '')
      .replace(/^(?:叫做?|名为|命名为|标题为)\s*/u, '')
      .trim();
    const name = operand.replace(/(?:的|这张|这个)(?:空白|空|文字|文本)?(?:卡片?|节点|文本框)$/u, '');
    const stripped = name === operand ? name.replace(NODE_TYPE, '').trim() : name.trim();
    if (stripped && !/^(?:空白|空|文字|文本)$/u.test(stripped)) return { action: 'node.create', arguments: { title: literal(stripped) } };
  }
  const rename = /^(?:把|将|给)?\s*(.+?)\s*(?:(?:的)?(?:标题|名字|名称)\s*(?:设为|改成|改为|换成)|重命名(?:为|成)|改名(?:为|成|叫)|换(?:个|一个)(?:名称|名字|标题)\s*[：:])\s*(.+)$/u.exec(text)
    ?? /^重命名\s*(.+?)\s*(?:为|成|叫)\s*(.+)$/u.exec(text);
  if (rename && !/书籍|群组|连线|正文|里的/u.test(rename[1]!)) {
    return { action: 'node.rename', arguments: { ...target(rename[1]!), title: literal(rename[2]!) } };
  }
  const immersive = /^(?:全屏(?:阅读|编辑)\s*(.+)|(?:进入|切到|打开|切换到)\s*(.+?)\s*的(?:沉浸(?:式)?(?:编辑|写作)|(?:专注|全屏)写作)(?:模式)?|打开\s*(.+?)[，,]\s*(?:进入|切到)?\s*(?:沉浸(?:式)?(?:编辑|写作)|专注写作)(?:模式)?)$/u.exec(text);
  if (immersive) return { action: 'editor.immersive.enter', arguments: target(immersive[1] ?? immersive[2] ?? immersive[3]!) };
  const namedEditor = /^(?:打开|进入|编辑|阅读)\s*(.+?)(?:的)?(?:正文|编辑器|编辑窗格|编辑页)$/u.exec(text);
  if (namedEditor && /^(?:当前)?选中/u.test(namedEditor[1]!)) return undefined;
  if (namedEditor) return { action: 'editor.open', arguments: target(namedEditor[1]!) };
  const explicitNode = /^(打开|编辑|阅读|关闭|关掉)\s*(.+)$/u.exec(text);
  if (explicitNode && !/选中/u.test(explicitNode[2]!) &&
    (/^\uE000\d+\uE001$/u.test(explicitNode[2]!) || /^(?:空白\s*[0-9０-９]+|未命名(?:节点|卡片)|.+(?:节点|卡片))$/u.test(explicitNode[2]!))) {
    return { action: /关闭|关掉/u.test(explicitNode[1]!) ? 'editor.close' : 'editor.open', arguments: target(explicitNode[2]!) };
  }
  const close = /^(?:关闭\s*(.+?)(?:的)?(?:编辑窗格|编辑器|编辑页)|把(?:右侧)?\s*(.+?)(?:那个|的)?编辑器关掉|不再显示\s*(.+?)编辑页)$/u.exec(text);
  if (close) return { action: 'editor.close', arguments: target(close[1] ?? close[2] ?? close[3]!) };
  const open = /^(?:(?:在|用)(?:右侧|右边|编辑区|编辑器|编辑窗格)(?:中|里)?(?:打开|阅读|编辑)\s*(.+)|(?:把|将)\s*(.+?)\s*(?:显示|打开|放)在(?:右侧|右边|编辑区|编辑窗格)(?:中|里)?|(?:打开|编辑)\s*(.+?)\s*(?:到|至|在)(?:右侧|右边|编辑区|编辑窗格)(?:中|里)?)$/u.exec(text);
  if (open) return { action: 'editor.open', arguments: target(open[1] ?? open[2] ?? open[3]!) };
  const active = /^(?:把编辑焦点切到\s*(.+)|激活\s*(.+?)(?:对应的|的)?编辑窗格|继续在\s*(.+?)(?:的)?编辑器里输入|(?:切换到|切到|切回)\s*(.+?)(?:的)?(?:编辑器|编辑窗格|编辑页))$/u.exec(text);
  if (active) return { action: 'editor.activate', arguments: target(active[1] ?? active[2] ?? active[3] ?? active[4]!) };
  const annotation = /^(?:给|在)\s*(.+?)(?:上|旁边)?\s*(?:加(?:上|个|一条)?|添加(?:一条)?|记(?:个|一条)?)\s*(?:标注|注释|批注)\s*[：:]?\s*(.+)$/u.exec(text);
  if (annotation) return { action: 'annotation.add', arguments: { ...target(annotation[1]!), body: literal(annotation[2]!) } };
  const ungroup = /^(?:解(?:散|除)\s*(.+?)(?:但保留(?:成员|卡片))?|(?:把|将)\s*(.+?)\s*解组)$/u.exec(text);
  if (ungroup && /组$/u.test(ungroup[1] ?? ungroup[2]!)) {
    return { action: 'group.ungroup', group: { title: literal(ungroup[1] ?? ungroup[2]!) } };
  }
  const connection = /^(?:把|将)\s*(.+?)\s*用(虚线|实线)(?:连(?:接)?到|指向)\s*(.+)$/u.exec(text);
  if (connection) return { action: 'connection.create', arguments: {
    from: { title: title(connection[1]!) }, to: { title: title(connection[3]!) }, line: connection[2] === '虚线' ? 'dashed' : 'solid',
  } };
  return undefined;
}

const simpleActions: Array<readonly [RegExp, string]> = [
  [/^(?:全选(?:当前)?(?:画布上?的?)?(?:卡片|节点|画布对象|对象)?|(?:选中|选择)(?:所有|全部)(?:画布)?(?:卡片|节点|对象))$/u, 'selection.all'],
  [/^(?:清空|清除|取消|解除)(?:当前)?(?:选区|选择|选中|所有对象的选择|所有选中)$/u, 'selection.clear'],
  [/^(?:现在选中了哪些(?:卡|节点|对象)|(?:告诉我|列出|查看)?(?:当前|目前)?选区(?:都有谁|里有什么|有哪些对象)?)$/u, 'selection.read'],
  [/^(?:关闭(?:全部|所有)编辑(?:窗格|器|页)|清空编辑区的所有页面|把右侧打开的文档都关掉)$/u, 'editor.closeAll'],
  [/^(?:退出沉浸编辑|返回普通编辑界面|把全屏写作模式关掉)$/u, 'editor.immersive.exit'],
  [/^(?:切换到|跳到|回到|激活)(?:右侧|右边)?(?:下一个|下一张)(?:编辑窗格|编辑页|已经打开的文档)$/u, 'editor.next'],
  [/^(?:切换到|跳到|回到|激活)(?:右侧|右边)?(?:上一个|上一张|前一个)(?:编辑窗格|编辑页|打开的编辑页|正在阅读的文档)$/u, 'editor.previous'],
  [/^(?:现在打开了哪些编辑窗格|(?:告诉我)?编辑器里当前有哪些卡|(?:列一下|查看)正在编辑的文档)$/u, 'editor.read'],
  [/^(?:撤销(?:上一步|刚才[^，。]{0,60})?|取消最后一次文档修改|把上一步[^，。]{0,40}退回去)$/u, 'history.undo'],
  [/^(?:重做(?:上一步|刚才(?:撤销的[^，。]{1,60})?)?|恢复刚才(?:撤销|取消)的[^，。]{1,60}|把被撤销的(?:那|上)一步再做一次)$/u, 'history.redo'],
  [/^(?:查询当前撤销历史状态|现在能撤销和重做什么|(?:告诉我)?还有几步可以撤销或重做)$/u, 'history.read'],
  [/^(?:现在)?(?:画布|视口|视图)(?:的)?(?:可见区域|显示区域)(?:有多大|的(?:宽高|像素尺寸))$|^(?:查询|查看)(?:当前)?视口的宽高$/u, 'viewport.size'],
  [/^(?:列出|显示|查看)(?:当前|所有|已有的?|现有的?)?(?:群组|分组)(?:和成员|目录|列表)?$/u, 'group.list'],
  [/^(?:列出|显示|查看)(?:当前|所有)?(?:注释|标注|批注)(?:列表)?$/u, 'annotation.list'],
  [/^(?:查看|读取)(?:当前画布|画布当前|当前)?的?(?:连线关系|连接关系)$/u, 'connection.graph'],
  [/^(?:显示|查看|读取)(?:当前)?(?:画布|整张画布|所有卡片)(?:的)?(?:文字|字数|正文的?)统计(?:数据)?$|^整张画布的字数$/u, 'statistics.read'],
  [/^(?:统计|只数)(?:一下)?(?:当前|现在)?选中(?:的)?.{0,30}(?:多少字|字数)$|^选区正文有多少字$/u, 'statistics.selection'],
  [/^(?:我现在|当前)是在书库还是画布$|^(?:查询|查看)当前工作区入口状态$/u, 'library.state'],
  [/^(?:查看|读取|列出)(?:当前|本地)?(?:的)?恢复点(?:列表)?$/u, 'recovery.list'],
  [/^(?:创建|新建)(?:一个)?(?:本地)?恢复点$/u, 'recovery.create'],
  [/^(?:导出|保存|另存)(?:当前|这本|本)(?:书籍?|项目)(?:的|为|成)?(?:一份)?(?:本地)?副本$/u, 'file.copy'],
  [/^(?:粘贴)(?:刚才复制的)?(?:画布)?(?:卡片?|对象|内容|选区)?$/u, 'clipboard.paste'],
];

const noMovement = /^(?:卡片都?(?:别|不要)(?:挪|移动|改动)|(?:别|不要)(?:挪|移动|改动)(?:任何)?卡片)$/u;
const coordinate = '([-－]?' + DECIMAL + ')';
const pair = '\\s*[(（]?' + coordinate + '\\s*[,，、]\\s*' + coordinate + '[)）]?';
const width = exact('(?:把|将)?(?:右侧)?(?:文本)?(?:编辑区(?:域)?|编辑器|编辑面板)(?:的)?(?:宽度)?(?:设为|调(?:整)?到|改成|改为)\\s*(' + NUMBER + ')\\s*(?:像素|px|宽)?');
const nodeMove = exact('(?:把|将)\\s*(.+?)\\s*(?:移动|挪|移)(?:到|至)(?:画布)?(?:坐标)?' + pair);
const nodeSize = exact('(?:把|将)?\\s*(.+?)(?:的)?(?:尺寸|大小)?(?:缩放|调整|设|改)(?:为|成|到)\\s*' + coordinate + '\\s*[×xX*]\\s*' + coordinate + '(?:px|像素)?');
const layout = [
  { pattern: /(?:横向排好|横排|排成一行|从左到右排列|水平排列)$/u, action: 'layout.horizontal' },
  { pattern: /(?:纵向排好|竖排|排成一列|从上到下排列|垂直排列)$/u, action: 'layout.vertical' },
  { pattern: /(?:排成|整理成)(?:网格|宫格)(?:布局)?$/u, action: 'layout.arrange' },
];
function selectionLayout(clause: string): Action | undefined {
  const operation = layout.find(item => item.pattern.test(clause));
  const subject = operation && readWorkspaceSelectionReference(clause.replace(/^(?:把|将|让)\s*/u, '').replace(operation.pattern, '').trim());
  if (!subject || !operation) return undefined;
  return { action: operation.action, selection: subject };
}

function parseClause(clause: string, title: Title, literal: Title): Action | undefined {
  const zoom = absoluteZoom.exec(clause);
  if (zoom) return { action: 'viewport.set', arguments: { zoom: percentValue(zoom) } };
  const scale = relativeZoom.exec(clause);
  if (scale) return { action: 'viewport.scale', arguments: { factor: scale[1] ? numericValue(scale[1])
    : 1 + (scale[4] === '缩小' ? -1 : 1) * percentValue(scale, 5),
    ...(scale[2] || scale[3] ? { expectedZoom: percentValue(scale, 2) } : {}) } };
  const tenths = relativeTenths.exec(clause);
  if (tenths) {
    const retained = 10 + (tenths[1] === '缩小' ? -1 : 1) * numericValue(tenths[2]!);
    return tenths[3] !== undefined && numericValue(tenths[3]) !== retained ? undefined
      : { action: 'viewport.scale', arguments: { factor: retained / 10 } };
  }
  const focus = focusAtZoom.exec(clause);
  if (focus) return { action: 'viewport.set', arguments: { target: { title: title(focus[3]!) }, zoom: percentValue(focus) } };
  if (zoomQuestion.test(clause)) return { action: 'viewport.read' };
  const control = workspaceSimpleControl(clause);
  if (control) return control;
  const simple = simpleActions.find(([pattern]) => pattern.test(clause));
  if (simple) return { action: simple[1] };
  const arrangement = selectionLayout(clause);
  if (arrangement) return arrangement;
  if (/^(?:切换?到?|使用|用|(?:把)?当前工具换成)\s*(?:拖动画布的)?(?:手抓|手形|抓手)(?:工具|模式)?(?:平移画面)?$/u.test(clause)) {
    return { action: 'viewport.tool', arguments: { tool: 'hand' } };
  }
  const dock = width.exec(clause);
  if (dock) return { action: 'editor.width', arguments: { width: numericValue(dock[1]!) } };
  const move = nodeMove.exec(clause);
  if (move) return { action: 'node.move', arguments: { target: { title: title(move[1]!) }, x: numericValue(move[2]!), y: numericValue(move[3]!) } };
  const size = nodeSize.exec(clause);
  if (size) return { action: 'node.resize', arguments: { target: { title: title(size[1]!) }, width: numericValue(size[2]!), height: numericValue(size[3]!) } };
  return objectAction(clause, title, literal);
}

/** Compile complete, explicit instructions. Unknown clauses are left to the normal turn router. */
export function compileWorkspaceLanguage(prompt: string, knownTitles: ReadonlySet<string> = new Set()): WorkspaceLanguageStep[] | undefined {
  if (prompt.length > 600 || /[\uE000\uE001]/u.test(prompt)) return undefined;
  const quotes: string[] = [];
  const text = prompt.trim().replace(QUOTE, (_match, ...parts: unknown[]) => {
    quotes.push(String(parts.slice(0, 4).find(part => part !== undefined)));
    return '\uE000' + (quotes.length - 1) + '\uE001';
  }).replace(/^@画布操作\s+/u, '').replace(/[。！!?？]+$/u, '');
  if (!text || /[！!?？\n]/u.test(text) || /^(?:怎么|如何|怎样|如果|假如|举例|解释)/u.test(text)) return undefined;
  const literal = (value: string) => value.trim().replace(/\uE000(\d+)\uE001/gu, (_match, index: string) => quotes[Number(index)]!);
  const title = (value: string) => {
    const raw = literal(value);
    if (knownTitles.has(workspaceNameKey(raw))) return raw;
    const unwrapped = value.trim().replace(/^(?:那[张个]|这[张个]|一[张个])?\s*(?:叫做?|名为|名叫|标题为|名称为)?\s*/u, '');
    if (/^\uE000\d+\uE001/u.test(unwrapped)) return literal(unwrapped.replace(/\s*(?:的|这张|那张)?\s*(?:卡片?|节点|文本框)?$/u, ''));
    if (knownTitles.has(workspaceNameKey(unwrapped))) return unwrapped;
    const stripped = unwrapped.replace(NODE_TYPE, '').replace(/(?:的|这张|那张|那个)$/u, '').trim();
    return stripped || raw;
  };
  const parse = (value: string) => parseClause(value.trim()
    .replace(/^(?:(?:麻烦|请|帮我|给我|我要|我想要|先|再|让我|带我)\s*)+/u, '')
    .replace(/^(?:仍然用|继续用)(?=\s*(?:[0-9０-９]|百分之))/u, '保持')
    .replace(/(?:一下|吧)$/u, '').trim(), title, literal);
  const separator = /[,，;；、。]\s*|\s*(?:然后|接着|并且|同时|并|(?<!不)再)(?=\s*(?:打开|关闭|开启|展开|收起|关掉|聚焦|缩放|保持|把|将|显示|隐藏|删除|移除|修改|新建|创建))/u;
  // A location pair belongs to one action even when it contains a comma.
  const single = !separator.test(text) || nodeMove.test(text) || relativeTenths.test(text.replace(/^(?:把|将)/u, '')) ||
    /^打开.+[，,]\s*(?:进入|切到)?\s*(?:沉浸(?:式)?(?:编辑|写作)|专注写作)(?:模式)?$/u.test(text) ? parse(text) : undefined;
  if (single) return [{ id: single.action === 'viewport.set' ? 'viewport' : 'step-1', ...single }];
  const clauses = text.split(separator).map(clause => clause.trim()).filter(Boolean);
  if (clauses.length < 2 || clauses.length > 8) return undefined;
  const actions: Action[] = [];
  for (const clause of clauses) {
    if (noMovement.test(clause.trim())) continue;
    const action = parse(clause);
    if (!action) return undefined;
    const last = actions.at(-1);
    if (last?.action === 'viewport.set' && action.action === 'viewport.set' &&
      !Object.keys(action.arguments ?? {}).some(key => Object.hasOwn(last.arguments ?? {}, key))) {
      last.arguments = { ...last.arguments, ...action.arguments };
    } else actions.push(action);
  }
  if (clauses.some(clause => noMovement.test(clause.trim())) &&
    actions.some(action => !['viewport.set', 'viewport.read', 'minimap.open', 'minimap.close', 'minimap.read'].includes(action.action))) return undefined;
  return actions.length ? actions.map((action, index) => ({
    id: action.action === 'viewport.set' && index === 0 ? 'viewport' : action.action.startsWith('minimap.') &&
      actions.filter(item => item.action.startsWith('minimap.')).length === 1 ? 'minimap' : 'step-' + (index + 1), ...action,
  })) : undefined;
}
