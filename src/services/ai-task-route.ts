import type { CanvasControlPurpose } from '../protocols/canvas-control.ts';
import { extendedCanvasOperation, naturalColor, naturalTargetFilter, NATURAL_QUOTED_NAME, type ExtendedCanvasOperation } from './natural-canvas-rules.ts';

/** Deterministic, conservative hints. Ambiguous requests retain the full path. */
export function canvasControlPurpose(prompt: string): CanvasControlPurpose {
  if (canvasContentTarget(prompt)) return 'content';
  prompt = canvasCommandText(prompt);
  const fields = [
    /颜色|改色|配色|#[0-9a-f]{6}/iu.test(prompt) ? 'appearance' : '',
    /移动|坐标|位置|对齐|排(?:成|列)|[向往][上下左右]/u.test(prompt) ? 'move' : '',
    /分组|群组|连线|连接|连到|连起|连上|实线|虚线|线型|插入/u.test(prompt) ? 'structure' : '',
    /正文|续写|改写|设定|人物设计/u.test(prompt) ? 'content' : '',
    /新建|创建|生成/u.test(prompt) ? 'creation' : '',
  ].filter(Boolean);
  return fields.length === 1 ? fields[0] as CanvasControlPurpose : 'general';
}

/** Reference titles are data, never routing commands or creative-intent cues. */
export function canvasCommandText(prompt: string): string {
  return prompt.replace(/@\[[^\]\r\n]+\](?:\([^)\r\n]*\))?|@node:[a-z0-9:-]+/giu, ' ');
}

export function canvasRequestsAllNodes(prompt: string): boolean {
  const text = canvasCommandText(prompt).replace(new RegExp(NATURAL_QUOTED_NAME, 'gu'), ' ');
  return /(?:(?:所有|全部)(?:的)?(?:文字)?(?:节点|卡片|文本框)|(?:节点|卡片|文本框)(?:全部|所有)|全画布)/u.test(text);
}

export type NaturalCanvasOperation =
  | ExtendedCanvasOperation
  | { kind: 'batch'; names: string[]; steps: NaturalCanvasOperation[] }
  | { kind: 'content'; names: string[] }
  | { kind: 'narrow'; names: string[] }
  | { kind: 'relative-color'; names: string[]; direction: 'lighter' | 'darker' }
  | { kind: 'choose-color'; names: string[]; background?: boolean }
  | { kind: 'choose-theme'; names: string[] }
  | { kind: 'find' | 'ungroup'; names: string[]; byMembers?: boolean }
  | { kind: 'relations'; names: string[]; direction?: 'in' | 'out' }
  | { kind: 'presentation'; names: string[]; presentation: 'card' | 'text-box'; color?: string; members?: boolean }
  | { kind: 'connect'; names: string[]; line?: 'solid' | 'dashed'; eitherDirection?: boolean; continueFromPrevious?: boolean }
  | { kind: 'line'; names: string[]; line: 'solid' | 'dashed'; reference?: 'previous' | 'selection' }
  | { kind: 'color'; names: string[]; color: string; members?: boolean }
  | { kind: 'background'; names: string[]; color: string }
  | { kind: 'theme'; names: string[]; theme: 'light' | 'dark' }
  | { kind: 'group' | 'group-add' | 'group-remove' | 'group-rename'; names: string[]; title?: string }
  | { kind: 'replace' | 'append'; names: string[]; text: string; old?: string; occurrence?: number | 'all' }
  | { kind: 'filter'; names: string[]; empty: boolean; disconnected: boolean; target?: string }
  | { kind: 'search'; names: string[]; terms: string[]; ungrouped: boolean }
  | { kind: 'move' | 'arrange'; names: string[]; x?: number; y?: number; layout?: 'horizontal' | 'vertical' | 'grid' };

const name = (value: string) => value.trim().replace(/^@\[([^\]]+)\](?:\([^)]+\))?$/u, '$1').replace(/^[「“"『]|[」”"』]$/gu, '').trim();
// Quoted titles and inline references are single operands, including any list separators.
const quotedName = String.raw`「[^」\r\n]+」|『[^』\r\n]+』|“[^”\r\n]+”|"[^"\r\n]+"|@\[[^\]\r\n]+\](?:\([^\)\r\n]*\))?`;
const listPart = new RegExp(`${quotedName}|以及|[、，,和与跟]|(?:(?!以及)[^「『“"@、，,和与跟])+|.`, 'gu');
function names(value: string): string[] {
  const parts = [''];
  for (const [part] of value.matchAll(listPart)) {
    if (/^[、，,和与跟]$/u.test(part) || part === '以及') parts.push('');
    else parts[parts.length - 1] += part;
  }
  return parts.map(name).filter(Boolean);
}
function numberedOperands(value: string): string[] {
  const literal = name(value);
  if (literal !== value.trim()) return [literal];
  const match = /^(.+?\p{Script=Han})\s*(\d+(?:[\s、，,]+\d+)+)$/u.exec(literal);
  return match ? match[2]!.split(/[\s、，,]+/u).map(number => `${match[1]} ${number}`) : [literal];
}
function ungroupTarget(value: string): NaturalCanvasOperation {
  const targets = names(value);
  return { kind: 'ungroup', names: targets, ...(targets.length > 1 ? { byMembers: true } : {}) };
}
const connectionOperand = `(${quotedName}|[^「」『』“”"，,？?\r\n]+?)`;
const connectionStyle = String.raw`(?:(?:[，,\s]*(?:使用|用)\s*|[，,\s]+)(实线|虚线))?`;
const directedConnection = new RegExp(`^(?:把|将)?\\s*${connectionOperand}\\s*(?:连接到|连到|连向|连接至|接到)\\s*${connectionOperand}${connectionStyle}$`, 'u');
const drawLine = String.raw`(?:加|画|拉|接|连)(?:上)?(?:一)?条\s*(实线|虚线|连线|线)`;
const fromConnection = new RegExp(String.raw`^从\s*${connectionOperand}\s*${drawLine}\s*到\s*${connectionOperand}$`, 'u');
const betweenConnection = new RegExp(String.raw`^从\s*${connectionOperand}\s*到\s*${connectionOperand}\s*${drawLine}$`, 'u');
const pointingConnection = new RegExp(`^让\\s*${connectionOperand}\\s*指向\\s*${connectionOperand}${connectionStyle}$`, 'u');
const pairedConnection = new RegExp(String.raw`^(?:(?:用(?:一条)?|拉(?:一)?条)\s*(实线|虚线)\s*)?(?:把|将|给)?\s*(.+?)\s*(?:(?:使用|用)(?:一条)?\s*(实线|虚线)\s*)?(?:(?:之间\s*)?${drawLine}|连线|接线|连一下|连起来|连接起来|连上|接起来|连(?:接)?在一起|连接)${connectionStyle}$`, 'u');
const leadingConnection = new RegExp(String.raw`^(?:用\s*(实线|虚线)\s*)?(?:连接|连上|连一下|连线)\s*(.+?)${connectionStyle}$`, 'u');
const selectionConnection = new RegExp(String.raw`^(?:用\s*(实线|虚线)\s*)?(?:连线|接线|连一下)${connectionStyle}$`, 'u');
const selectedConnection = /^(?:这(?:两|2)个(?:节点|卡片)?|(?:两|2)(?:个节点|张卡片)|(?:当前)?选中(?:的)?(?:(?:两|2)(?:个|张))?(?:节点|卡片)?|选区|它们)$/u;
const lineStyle = (value: string) => value === '实线' ? 'solid' as const : 'dashed' as const;

function parseConnection(text: string): NaturalCanvasOperation | undefined {
  text = text.replace(/^在(?:当前)?画布上\s*/u, '').replace(/^先\s*(?=把|将|给|用|从|连|接)/u, '');
  if (/^(?:如何|怎么|怎样|能否|能不能|可不可以|可以|如果|先别|不要|别|新建|创建|新增|生成|总结|分析|解释|对比|比较|检查|查看|查询)/u.test(text)) return undefined;
  const continueFromPrevious = /^(?:连到|接到|连向|指向)/u.test(text);
  if (continueFromPrevious) text = '它' + text.replace(/^指向/u, '连向');
  let match = directedConnection.exec(text) ?? pointingConnection.exec(text) ?? betweenConnection.exec(text);
  if (match) {
    const destination = name(match[2]!);
    const heading = match[2]!.trim() === destination ? /^(.*?)(?:的)?标题(?:栏)?$/u.exec(destination) : null;
    const line = match[3] === '实线' || match[3] === '虚线' ? lineStyle(match[3]) : heading ? 'dashed' : undefined;
    return { kind: 'connect', names: [name(match[1]!), heading?.[1]?.trim() || destination], line,
      ...(continueFromPrevious ? { continueFromPrevious } : {}) };
  }
  match = fromConnection.exec(text);
  if (match) return { kind: 'connect', names: [name(match[1]!), name(match[3]!)], line: /实线|虚线/u.test(match[2]!) ? lineStyle(match[2]!) : undefined };
  const trailing = pairedConnection.exec(text);
  const leading = trailing ? null : leadingConnection.exec(text);
  const selected = selectionConnection.exec(text);
  if (selected && (!selected[1] || !selected[2] || selected[1] === selected[2])) {
    const style = selected[1] ?? selected[2];
    return { kind: 'connect', names: ['这两个'], line: style ? lineStyle(style) : undefined, eitherDirection: true };
  }
  const operands = trailing?.[4] && /之间\s*(?:加|画|拉|接|连)/u.test(text) ? trailing[2]!.replace(/^在\s*/u, '') : trailing?.[2] ?? leading?.[2];
  if (!operands) return undefined;
  const unquoted = operands.replace(new RegExp(NATURAL_QUOTED_NAME, 'gu'), '');
  if (/(?:并且?|然后)(?:新建|创建|分组|删除|改)|(?:分组|删除)并且?\s*$/u.test(unquoted)) return undefined;
  const pair = names(operands);
  const styles = (trailing ? [trailing[1], trailing[3], trailing[4], trailing[5]] : [leading?.[1], leading?.[3]]).filter(style => style === '实线' || style === '虚线');
  if (new Set(styles).size > 1) return undefined;
  const numbered = /^(.+?\p{Script=Han}\s*\d+(?:[\s、，,]+\d+)+)\s*(?:和|与|跟|以及)\s*(.+)$/u.exec(operands);
  if (numbered) return { kind: 'connect-many', names: [name(numbered[2]!), ...numberedOperands(numbered[1]!)], topology: 'fan', line: styles[0] ? lineStyle(styles[0]) : 'solid' };
  if (pair.length < 1 || pair.length > 2) return undefined;
  const selection = pair.length === 1 && selectedConnection.test(pair[0]!);
  if (pair.length === 1 && !selection && !/^(?:把|将|给|连接|连上|连线)/u.test(text)) return undefined;
  return { kind: 'connect', names: selection && pair[0] !== '它们' ? ['这两个'] : pair, line: styles[0] ? lineStyle(styles[0]) : undefined, eitherDirection: true };
}

function canvasIntentText(prompt: string): string {
  const request = prompt.trim().replace(/^@画布操作(?=\s|$)\s*/u, '');
  const politeQuestion = /^(?:能不能|可以)帮我/u.test(request);
  return (politeQuestion ? request.replace(/[？?]$/u, '') : request)
    .replace(/^(?:(?:请你|请|能不能帮我|可以帮我|麻烦你|麻烦|帮我|给我)\s*[，,]?\s*)+/u, '')
    .replace(/^(?:我想|我希望)\s*(?=把|将|建|创建|在画布|用(?:实线|虚线))/u, '');
}

/** A named write destination is an action even when its body needs a model. */
export function canvasContentTarget(prompt: string): { names: string[] } | undefined {
  const text = canvasIntentText(prompt).trim().replace(/[。！!]$/u, '');
  if (/^(?:不要|先别|先不要|别|如果|如何|怎么)/u.test(text) || /[？?]$/u.test(text)) return undefined;
  let match = /^(?:在|往|向|给)\s*(.+?)(?:里|内|中|上)[，,\s]*(?:设计|创作|写|填|生成|补充|续写|完善)/u.exec(text);
  if (match) return /^(?:当前)?(?:画布|全画布)$/u.test(name(match[1]!)) ? undefined : { names: [name(match[1]!)] };
  match = /^(.+?(?:卡|卡片|节点|文本框))(?:里|内|中)[，,\s]*(?:设计|创作|写|填|生成|补充|续写|完善)/u.exec(text)
    ?? /^(?:设计|创作|写|生成|补充).+?[，,；;]\s*(?:再|然后)?(?:填入|写入|写进|放进)\s*(.+?(?:卡|卡片|节点|文本框))(?:里|内|中)?$/u.exec(text);
  if (match) return { names: [name(match[1]!)] };
  match = /^(?:填入|填充|补全|完善|填好)\s*(.{1,120}?)(?:[，,].*)?$/u.exec(text);
  if (match) return { names: [name(match[1]!)] };
  if (/^(?:填进去|写进去|填进刚才的卡|填入刚才的节点)$/u.test(text)) return { names: ['刚才创建的节点'] };
  match = /^(?:把|将)\s*(.+?)(?:的正文|的内容)?\s*(?:填成|填上|补全为|写成)[，,\s]*.+$/u.exec(text);
  if (match && /卡|节点|文本框|刚才|这个|它/u.test(match[1]!)) return { names: [name(match[1]!)] };
  match = /^(?:把|将)\s*.+?(?:填入|写入|写进)\s*(.+?(?:卡|节点|文本框))(?:里|内|中)?$/u.exec(text);
  if (match) return { names: [name(match[1]!)] };
  return undefined;
}

export function naturalCanvasOperation(prompt: string): NaturalCanvasOperation | undefined {
  const command = canvasIntentText(prompt);
  const literals = new RegExp(NATURAL_QUOTED_NAME, 'gu');
  const masked = command.replace(literals, match => '□'.repeat(match.length));
  const separators = [...masked.matchAll(/[，,；;。]\s*(?:再把|再将|然后把|然后将|再从|然后从|然后|再)|\s*(?:然后|接着|并且|并)\s*(?=把|将|从|改成|改为|换成|切成|向|往|连到)/gu)];
  if (separators.length && separators.length < 8) {
    const clauses: string[] = [];
    let start = 0;
    for (const separator of separators) {
      const end = separator.index!;
      clauses.push(command.slice(start, end).trim());
      const next = separator[0].match(/(?:把|将|从)$/u)?.[0].length ?? 0;
      start = end + separator[0].length - next;
    }
    clauses.push(command.slice(start).trim());
    const steps = clauses.map(parseCanvasOperation);
    if (steps.every(step => step !== undefined)) return { kind: 'batch', names: [], steps };
    return undefined;
  }
  return parseCanvasOperation(command.replace(/^(?:再|然后|接着)\s*(?=把|将|给|换|改|往|向|移|连|接到|指向|排|归到|切|转)/u, ''));
}

function parseCanvasOperation(command: string): NaturalCanvasOperation | undefined {
  const text = command.replace(/[。！？!?]$/u, '').trim();
  let match: RegExpExecArray | null;
  if (/^(?:如果|假如|假设|要是|先别|先不要|不要|别|不用|暂不|如何|怎么|怎样|解释|分析|总结|对比|比较)/u.test(text)) return undefined;
  if ((match = /^谁指向\s*(.+)$/u.exec(text))) return { kind: 'relations', names: [name(match[1]!)], direction: 'in' };
  if ((match = /^(.+?)\s*指向谁$/u.exec(text))) return { kind: 'relations', names: [name(match[1]!)], direction: 'out' };
  if ((match = /^(?:找到|定位|查找|查一下)\s*(.+?)(?:节点)?(?:[，,]\s*(?:带我过去|定位过去|跳过去))?$/u.exec(text))) return { kind: 'find', names: [name(match[1]!)] };
  if ((match = /^(?:查(?:看|一下)?\s*)?(.+?)(?:(?:跟|和|与)谁有(?:连线|连接)|的(?:连线|连接关系)|(?:连接|连着)了哪些(?:节点|对象))$/u.exec(text))) return { kind: 'relations', names: [name(match[1]!)] };
  if ((match = /^(.+?)(?:连着吗|有连线吗|之间有几条(?:连)?线)$/u.exec(text))) {
    const pair = names(match[1]!);
    if (pair.length === 2) return { kind: 'relations', names: pair };
  }
  if (/[？?]$/u.test(command) || /(?:吗|么|会怎样|怎么样)$/u.test(text)) return undefined;
  const content = canvasContentTarget(command);
  if (content) return { kind: 'content', ...content };
  if ((match = /^(水平|横向|横排|垂直|竖直|纵向|纵排|竖排|宫格|网格)(?:排列|排布|布局|整理)\s*(.*)$/u.exec(text))) {
    const target = match[2]!.trim();
    return { kind: 'arrange', names: !target || /^(?:节点|卡片|文本框)$/u.test(target) ? ['它们'] : [target],
      layout: /宫|网/u.test(match[1]!) ? 'grid' : /水平|横/u.test(match[1]!) ? 'horizontal' : 'vertical' };
  }
  if ((match = /^(?:把|将)?\s*(.+?)(?:水平|横向|横排|垂直|竖直|纵向|纵排|竖排|宫格|网格)(?:排列|排布|布局|整理)$/u.exec(text))) {
    const layout = /(?:宫格|网格)(?:排列|排布|布局|整理)$/u.test(text) ? 'grid' : /(?:水平|横向|横排)(?:排列|排布|布局|整理)$/u.test(text) ? 'horizontal' : 'vertical';
    return { kind: 'arrange', names: [match[1]!.trim()], layout };
  }
  if (/^(?:排列|整理|排布)(?:一下)?(?:节点|选中节点)$/u.test(text)) return { kind: 'arrange', names: ['它们'], layout: 'grid' };
  if ((match = /^([^，,；;。]+?)(?:除外|排除在外)$/u.exec(text)) && !/^(?:找出|筛选|高亮)/u.test(text)) return { kind: 'narrow', names: names(match[1]!) };
  if ((match = /^(?:(?:把|将)?(.+?)(?:的(?:颜色|标题栏))?)?(?:颜色)?再(浅|深)(?:一)?点$/u.exec(text))) {
    return { kind: 'relative-color', names: [match[1] ? name(match[1]) : '它们'], direction: match[2] === '浅' ? 'lighter' : 'darker' };
  }
  if (/^(?:切换|换|更换)(?:一)?(?:个|种)?(?:应用)?主题$/u.test(text)) return { kind: 'choose-theme', names: [] };
  if (/^(?:换个颜色|改个颜色|给它换个色)$/u.test(text)) return { kind: 'choose-color', names: ['它们'] };
  if (/^(?:把|将)?(?:画布背景|背景色)(?:调整|调|改)得?(?:更|稍微)?(?:护眼|舒服|柔和)(?:一点)?$/u.test(text)) {
    return { kind: 'choose-color', names: [], background: true };
  }
  if ((match = /^(?:(?:把|将|给)\s*)?(.+?)(?:的标题栏)?(?:换|改)(?:一)?(?:个|种)?颜色$/u.exec(text))) {
    const target = name(match[1]!);
    return { kind: 'choose-color', names: target === '画布背景' ? [] : names(match[1]!), background: target === '画布背景' };
  }
  if ((match = /^(?:把|将)(.+?)(?:正文|里|内|中)(?:的)?[「『“"](.+?)[」』”"](?:换成|替换成|替换为|改成)[「『“"](.*?)[」』”"](?:[，,]\s*(?:(?:只)?(?:改|替换)?第\s*(\d+)\s*处|(全部|所有|每一处)(?:都改)?))?$/u.exec(text))) {
    const target = name(match[1]!);
    return { kind: 'replace', names: naturalTargetFilter(target) ? [target] : names(match[1]!), old: match[2], text: match[3]!, occurrence: match[4] ? Number(match[4]) : match[5] ? 'all' : undefined };
  }
  const extended = extendedCanvasOperation(text);
  if (extended) return extended;
  const connection = parseConnection(text);
  if (connection) return connection;
  if ((match = /^(?:改成|改为|换成|设成)\s*(.+)$/u.exec(text))) {
    const color = naturalColor(match[1]!);
    if (color) return { kind: 'color', names: ['它们'], color };
  }
  if ((match = /^(?:切换到|切到|换成|开启|打开|用)?\s*(夜间|日间|白天|暗黑)(?:模式|主题)$/u.exec(text))) {
    return { kind: 'theme', names: [], theme: /夜间|暗黑/u.test(match[1]!) ? 'dark' : 'light' };
  }
  if ((match = /^(?:改成|换成|切成|转成|改为|转为)\s*(文本框|文字框|卡片)$/u.exec(text))) {
    return { kind: 'presentation', names: ['它们'], presentation: match[1] === '卡片' ? 'card' : 'text-box' };
  }
  if ((match = /^(?:把|将)?(.+?)(?:切成|切换为|切换成|转为|转换成|改成)\s*(文本框|卡片|文字节点)[，,]\s*(?:标题栏?|颜色)(?:统一)?改(?:成|为)?\s*(.+)$/u.exec(text))) {
    const color = naturalColor(match[3]!);
    const group = /^(.*?)(?:里|内|中)的(?:文字)?节点$/u.exec(match[1]!);
    if (color) return { kind: 'presentation', names: [naturalTargetFilter(match[1]!) ? match[1]!.trim() : name(group?.[1] ?? match[1]!)], presentation: match[2] === '文本框' ? 'text-box' : 'card', color, members: Boolean(group) && !naturalTargetFilter(match[1]!) };
  }
  if ((match = /^(?:找出|筛选|高亮)\s*(.+)$/u.exec(text)) && naturalTargetFilter(match[1]!)) return { kind: 'filter', names: [], empty: false, disconnected: false, target: match[1] };
  if ((match = /^(?:带我去|聚焦)\s*(.+)$/u.exec(text))) return { kind: 'find', names: names(match[1]!) };
  if ((match = /^(?:(?:把|将)?\s*(刚才的|刚才那条|上一条|这条)(?:连线|线)?)?\s*(?:改为|改成|改回|设为|用|使用)\s*(实线|虚线)$/u.exec(text))) return { kind: 'line', names: [], line: lineStyle(match[2]!), reference: match[1] === '这条' ? 'selection' : match[1] ? 'previous' : undefined };
  if ((match = /^(?:把|将)?(.+?)(?:之间)?的连线\s*(?:改为|改成|改回|设为)\s*(实线|虚线)$/u.exec(text))) return { kind: 'line', names: names(match[1]!), line: lineStyle(match[2]!) };
  if ((match = /^(?:把|将|给)?\s*(.+?)(?:的?标题栏|的?颜色)?\s*(?:统一)?(?:改成|改为|设为|设置为|换成|刷成|涂成|改色为|改)\s*(#[\da-f]{6}|[\p{Script=Han}]{1,5})$/iu.exec(text))) {
    const color = naturalColor(match[2]!);
    if (color) {
      const target = name(match[1]!);
      if (/^(?:画布背景|背景色|背景)$/u.test(target)) return { kind: 'background', names: [], color };
      const group = /^(.*?)组?(?:里|内|中)的(?:文字)?节点$/u.exec(target);
      if (naturalTargetFilter(target)) return { kind: 'color', names: [target], color };
      return { kind: 'color', names: group ? [target.replace(/(?:里|内|中)的(?:文字)?节点$/u, '')] : names(match[1]!), color, members: Boolean(group) };
    }
  }
  if ((match = /^(?:把|将)?(?:应用)?主题\s*(?:切到|切换到|改成|改为|换成)\s*(深色|浅色|亮色|暗色)(?:模式|主题)?$/u.exec(text) ??
    /^(?:切到|切换到|换成|启用|打开)\s*(深色|浅色|亮色|暗色)(?:应用)?(?:主题|模式)$/u.exec(text))) return { kind: 'theme', names: [], theme: /深|暗/u.test(match[1]!) ? 'dark' : 'light' };
  if ((match = /^(?:把|将)?\s*(.+?)\s*(?:切成|切换为|切换成|转成|转为|转换成|换成|改成)\s*(文本框|文字框|卡片|文字节点)$/u.exec(text))) {
    const group = /^(.*?)(?:里|内|中)的(?:文字)?节点$/u.exec(match[1]!);
    const filter = naturalTargetFilter(match[1]!);
    return { kind: 'presentation', names: filter ? [match[1]!.trim()] : group ? [name(group[1]!)] : names(match[1]!), presentation: /文本框|文字框/u.test(match[2]!) ? 'text-box' : 'card', members: Boolean(group) && !filter };
  }
  if ((match = /^(?:解组|取消(?:分组|群组))\s*(.*)$/u.exec(text))) return ungroupTarget(match[1]!);
  if ((match = /^取消\s*(.+?)\s*(?:的)?(?:分组|群组)$/u.exec(text))) return ungroupTarget(match[1]!);
  if ((match = /^(?:把|将)?\s*(.+?)\s*(?:解组|取消群组|取消分组)$/u.exec(text))) return ungroupTarget(match[1]!);
  if ((match = /^(?:(?:把|将)?(.+?))?(?:编成|分成|建成|组成|归成|放进|编|分|组)(?:一|一个)?(?:群)?组[，,\s]*(?:叫|名为|命名为|名称为)\s*(.+)$/u.exec(text))) return { kind: 'group', names: match[1] ? names(match[1]) : ['它们'], title: name(match[2]!) };
  if ((match = /^(?:把|将)?\s*(.+?)\s*(?:编为一组|归成一组|组成一组|放在同一组|分组|编组|群组)$/u.exec(text))) {
    const targets = naturalTargetFilter(match[1]!) ? [match[1]!] : names(match[1]!);
    if (targets.length > 1 || naturalTargetFilter(match[1]!) || /^(?:选中(?:的)?(?:节点|卡片)?|选区|它们|这几个|这两个)$/u.test(targets[0] ?? '')) return { kind: 'group', names: targets };
  }
  if ((match = /^(?:把|将)?(.+?)(?:也)?(?:加入|加进)(?:去)?\s*(.*)$/u.exec(text))) return { kind: 'group-add', names: names(match[1]!), title: name(match[2]!) || undefined };
  if ((match = /^(?:(?:把|将)?(.+?))?(?:归到|放到|移入|收进|放进)\s*(.+?组)(?:里|内|中)?$/u.exec(text))) return { kind: 'group-add', names: match[1] ? names(match[1]) : ['它们'], title: name(match[2]!) };
  if ((match = /^(?:把|将)?(.+?)(?:移出|移除出)\s*(.*)$/u.exec(text))) return { kind: 'group-remove', names: [name(match[1]!)], title: name(match[2]!) || undefined };
  if ((match = /^(?:把|将)?(.+?)(?:改组名为|重命名为)\s*(.+)$/u.exec(text))) return { kind: 'group-rename', names: [name(match[1]!)], title: name(match[2]!) };
  if ((match = /^(?:把|将)(.+?)的(.{0,12}?)从\s*[「“"]?([^「」“”"，,]+?)[」”"]?\s*改(?:成|为)\s*[「“"]?([^「」“”"]+?)[」”"]?$/u.exec(text))) return { kind: 'replace', names: [name(match[1]!)], old: match[3]!.trim(), text: match[4]!.trim() };
  if ((match = /^(?:在|给)(.+?)(?:的?正文)?(?:末尾|结尾|最后)\s*(?:追加|加上|补上|加一句|补一句)[：:\s]*([\s\S]+)$/u.exec(command))) return { kind: 'append', names: [name(match[1]!)], text: name(match[2]!.replace(/([」”"])[。！!]$/u, '$1')) };
  if ((match = /^找出\s*(?:(.+?)(?:里|内|中)(?:的)?)?\s*((?:没(?:有)?连线的?)?(?:空白)?(?:没(?:有)?连线的?)?)节点$/u.exec(text)) && match[2]) return { kind: 'filter', names: match[1] ? [name(match[1])] : [], empty: match[2].includes('空白'), disconnected: match[2].includes('连线') };
  if ((match = /^(?:(?:把|将)?(.+?))?(?:向|往|移到|移向)([右左上下])(?:边|侧|面|方)?(?:挪|移动|移)?\s*(一点|点|\d+(?:\.\d+)?)?\s*(?:像素|px)?$/u.exec(text))) {
    const direction = match[2];
    const distance = match[3] && /点/u.test(match[3]) ? 40 : Number(match[3] ?? 300);
    if (distance <= 1_000_000) return { kind: 'move', names: match[1] ? names(match[1]) : ['它们'], x: direction === '右' ? distance : direction === '左' ? -distance : 0, y: direction === '下' ? distance : direction === '上' ? -distance : 0 };
  }
  if ((match = /^(?:(?:把|将)?(.+?))?(?:(?:按|排成|排列成|排为)(横排|纵排|竖排|一排|一行|一列|宫格|网格)(?:排列)?|([横竖])着排)$/u.exec(text))) {
    const layout = match[2] ?? match[3]!;
    return { kind: 'arrange', names: match[1] ? names(match[1]) : ['它们'], layout: /格/u.test(layout) ? 'grid' : /横|一排|一行/u.test(layout) ? 'horizontal' : 'vertical' };
  }
  return undefined;
}

/** Open-ended searches are interpreted by a model, then resolved against the local index. */
export function needsCanvasSearchInterpretation(prompt: string): boolean {
  return /^(?:请\s*)?(?:把|将|找出|筛选|查找).*(?:有关|相关).*(?:整理出来|找出来|筛出来|列出来)[。！]?$/u.test(prompt.trim());
}

/** Creation without a literal title may require generated content, so it uses the plan path. */
export function needsCanvasCreationPlanning(prompt: string): boolean {
  const text = canvasIntentText(canvasCommandText(prompt)).replace(/^在(?:当前)?画布上\s*/u, '');
  if (/[？?]\s*$/u.test(text) || /(?:吗|么|怎么做|如何做)[。！!]?$/u.test(text)) return false;
  if (/^(?:(?:新建|创建|新增|生成|做|添加|建|来)\s*|(?:一|1)\s*(?:张|个|份))\s*[^，。；!?！？\r\n]{0,35}?(?:角色卡片?|人物卡片?|角色档案|人物档案)(?=$|[\s，。；,;！!：:]|(?:叫|名为|并|然后|再|用于|用来|写上|填上|带上))/u.test(text)) return true;
  return /^(?:新建|创建|新增|生成|做|添加|建)\s*[^，。；!?！？\r\n]{0,60}?(?:节点|卡片|文本框)(?=$|[\s，。；,;！!：:]|(?:叫|名为|并|然后|再|用于|用来|写上|填上|带上))/u.test(text);
}

/** Identify requests to act on the canvas even when a local rule needs more detail. */
export function needsCanvasActionPlanning(prompt: string): boolean {
  const text = canvasIntentText(canvasCommandText(prompt).replace(new RegExp(NATURAL_QUOTED_NAME, 'gu'), ' □ '));
  if (/[？?]\s*$/u.test(text) || /^(?:如何|怎么|怎样|能否|能不能|可以|如果|先别|不要|别)/u.test(text) ||
    /(?:怎么做|如何做|的方法|的步骤|有哪些方式)/u.test(text)) return false;
  const imperative = /^(?:在(?:当前)?画布上|(?:再|接着|然后)?(?:把|将|给|让|新建|创建|添加|移动|调整|连接|整理|排列))/u.test(text);
  if (imperative && /节点|卡片|文本框|画布|标题栏|群组|拉线|连线|连接到|连接起来|连起来|对齐|分组|归组|留白|横着排|竖着排/u.test(text)) return true;
  return /^(?:选中的?(?:文字)?节点|画布(?:背景)?|(?:应用)?主题).{0,120}?(?:移动|对齐|排列|改色|改成|改为|换成|调整|切换|分组|连线|连接|文本框|删除)/u.test(text);
}
