import { naturalCanvasOperation } from '../../services/ai-task-route.ts';
import { NATURAL_QUOTED_NAME, naturalColor, naturalNames } from '../../services/natural-canvas-rules.ts';
import type { LocalIntentKind } from '../../services/local-intent-semantics.ts';

const NUMBER = '[零一二两三四五六七八九十百\\d]+';
const QUANTITY = new RegExp(`(${NUMBER})\\s*(张|个|份|块)\\s*(.+)`, 'u');
const QUOTED = new RegExp(NATURAL_QUOTED_NAME, 'gu');
const strip = (text: string) => text.trim().replace(/^(?:(?:请你?|帮我|给我|麻烦你?|再|然后|接着)\s*)+/u, '').replace(/[。！!]+$/u, '').trim();
const quote = (text: string) => `「${text}」`;
const literal = (text: string) => text.trim().replace(/^[「『“"]|[」』”"]$/gu, '').trim();

function localNumber(text: string): number | undefined {
  if (/^\d+$/u.test(text)) return Number(text);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text in digits) return digits[text];
  if (/^[一二两三四五六七八九]?十[一二三四五六七八九]?$/u.test(text)) {
    const [tens, ones] = text.split('十');
    return (tens ? digits[tens]! : 1) * 10 + (ones ? digits[ones]! : 0);
  }
  return undefined;
}

/** Quoted titles are data; question/negation guards never inspect their contents. */
export function isLocalDiscussion(prompt: string): boolean {
  const text = strip(prompt.replace(QUOTED, '对象'));
  return /^(?:不要|别|先别|先不要|不用|暂不|如果|假如|假设|如何|怎么|怎样|为什么|是否|解释|聊聊|讨论|我(?:已经|刚才|现在)?有|我已经|现在有|目前有)/u.test(text) ||
    /(?:有什么区别|是什么意思|怎么(?:连|做|改|移)|如何|是否应该|会怎样|怎么样|只(?:是)?(?:问|讨论|聊)|先不执行|不要执行)/u.test(text) || /[？?]\s*$/u.test(text);
}

export function splitLocalInstruction(prompt: string): string[] {
  const literals: string[] = [];
  const masked = prompt.replace(QUOTED, text => `\u0000${literals.push(text) - 1}\u0000`);
  const separator = new RegExp(`[，,、；;。]\\s*|(?:然后|接着)\\s*|(?:和|以及|再来)\\s*(?=${NUMBER}\\s*[张个份块])`, 'u');
  return masked.split(separator).map(text =>
    text.replace(/\u0000(\d+)\u0000/gu, (_match, index: string) => literals[Number(index)] ?? '')).map(strip).filter(Boolean);
}

export interface LocalInstructionContext {
  aliases: Map<string, string[]>;
  used: Set<string>;
  created: string[];
  expectedSelectionCount?: number;
}
export function localInstructionContext(): LocalInstructionContext {
  return { aliases: new Map(), used: new Set(), created: [] };
}

function operands(raw: string, context: LocalInstructionContext): string[] | undefined {
  let text = raw.trim().replace(/^(?:把|将|给|让)\s*/u, '').replace(/(?:的)?(?:颜色|底色|标题栏)$/u, '').replace(/(?:都|全部|一起|之间)$/u, '').trim();
  const selected = new RegExp(`^(?:这|那)(${NUMBER})?(?:张|个|块)(?:卡片?|节点|文本框)?$`, 'u').exec(text);
  if (selected || /^(?:选中(?:的)?(?:两张|几个|节点|卡片)?|当前(?:选中(?:的)?)?(?:节点|卡片)?|它们|这些|这几个|这几张|这两张|这张卡?|它|这个)$/u.test(text)) {
    const count = selected?.[1] && localNumber(selected[1]);
    const requestedCount = count || (/^(?:这张卡?|它|这个)$/u.test(text) ? 1 : undefined);
    if (requestedCount && context.expectedSelectionCount && requestedCount !== context.expectedSelectionCount) return undefined;
    if (requestedCount) context.expectedSelectionCount = requestedCount;
    return ['选中的节点'];
  }
  if (!text) return undefined;
  text = text.replace(/^(?:所有|全部)(?:的)?/u, '');
  const count = QUANTITY.exec(text);
  if (count?.index === 0) text = count[3]!.trim();
  const requestedCount = count?.index === 0 ? localNumber(count[1]!) : undefined;
  const names = naturalNames(text).flatMap(name => context.aliases.get(literal(name)) ?? [literal(name)]);
  if (requestedCount !== undefined && requestedCount !== names.length) return undefined;
  if (!names.length || names.some(name => !name || name.length > 120 || /[\r\n]/u.test(name))) return undefined;
  return names;
}
const renderOperands = (names: string[]) => names.map(name => name === '选中的节点' ? name : quote(name)).join('和');

/** Extract slots after the local model (or an exact grammar) establishes intent. */
export function compileLocalClause(raw: string, kind: LocalIntentKind, context: LocalInstructionContext): string[] | undefined {
  const text = strip(raw);
  if (isLocalDiscussion(text)) return undefined;
  if (kind === 'create') {
    const match = QUANTITY.exec(text);
    if (!match) return undefined;
    const count = localNumber(match[1]!);
    if (!count || count > 80) return undefined;
    let title = match[3]!.trim().replace(/^(?:(?:名为|叫|叫做)\s*)/u, '').replace(/(?:放)?(?:在这儿|在这里|放这里|就好|就行|吧)$/u, '').trim();
    const presentation = /文本框/u.test(title) ? '文本框' : '节点';
    if (/[「『“"]/u.test(title)) {
      const quoted = new RegExp(`^(${NATURAL_QUOTED_NAME})(?:的)?(?:卡片?|节点|文本框)?$`, 'u').exec(title);
      if (!quoted) return undefined;
      title = literal(quoted[1]!);
    } else title = title.replace(/的(?:卡片?|节点|文本框)$/u, '');
    if (!title || title.length > 100 || /[\r\n]|(?:并|再)(?:写|填|设计|补)|正文|内容|写上|填上|带上/u.test(title) ||
      !/[「『“"]/u.test(match[3]!) && /连接|连到|指向|打组|分组|改成|改为|用虚线/u.test(title)) return undefined;
    if (/^(?:空白(?:的)?|空白(?:卡片?|节点)|卡片?|节点)$/u.test(title)) title = /空白/u.test(title) ? '空白' : '新节点';
    const titles: string[] = [];
    for (let index = 0; index < count; index++) {
      let candidate = count === 1 ? title : `${title} ${index + 1}`;
      let suffix = 2;
      while (context.used.has(candidate)) candidate = `${title} ${suffix++}`;
      context.used.add(candidate);
      titles.push(candidate);
      context.created.push(candidate);
    }
    context.aliases.set(title, [...(context.aliases.get(title) ?? []), ...titles]);
    return titles.map(name => /^(?:角色卡|人物卡)$/u.test(name) ? `新建一张${name}` : `新建一个叫${quote(name)}的${presentation}`);
  }
  // Existing exact grammars retain their own semantics and target boundaries.
  const exact = naturalCanvasOperation(text);
  const hasPluralAlias = [...context.aliases].some(([name, titles]) => titles.length > 1 && text.includes(name));
  if (exact && exact.kind !== 'batch' && exact.kind !== 'content' && !hasPluralAlias) return [text];
  if (kind === 'color') {
    const match = /^(.*?)(#[a-f\d]{6}|墨绿|浅蓝|深蓝|暖灰|浅绿|深绿|浅灰|深灰|[黑白红蓝绿灰紫黄橙粉]色)(?:色)?(?:吧|一点)?$/iu.exec(text);
    const color = match && naturalColor(match[2]!);
    const target = match?.[1]?.replace(/(?:都|全部)?(?:的颜色|的底色|颜色|底色)?(?:改成|换成|设为|设置成|涂成|弄成|变成|染成|涂上|调成|调为|换个|变|换|改)\s*$/u, '');
    const names = target ? operands(target, context) : undefined;
    if (color && names?.length) return names.map(name => `把${renderOperands([name])}改成${color}`);
  }
  if (kind === 'move') {
    const relative = /^(?:把|将|让)?(.+?)(?:坐到|放到|挪到|摆到|移到|移动到)(.+?)(上方|下方|上面|下面|左边|右边|左侧|右侧)(?:[，,]?间距(\d+))?$/u.exec(text);
    if (relative) {
      const target = operands(relative[1]!, context), anchor = operands(relative[2]!, context);
      if (target?.length === 1 && anchor?.length === 1) return [`${renderOperands(target)}移动到${renderOperands(anchor)}${relative[3]}，间距${relative[4] ?? 60}`];
    }
    const offset = /^(.*?)(?:向|往)([左右上下])(?:边)?(?:挪|移|移动|挪动|挪一挪)\s*(\d+(?:\.\d+)?)\s*(?:px|像素)?$/iu.exec(text);
    const names = offset && operands(offset[1]!, context);
    if (offset && names?.length && Number(offset[3]) <= 1000000) return [`${renderOperands(names)}向${offset[2]}移动${offset[3]}像素`];
    const layout = /^(.*?)(?:横着|横向|水平|竖着|纵向|垂直)(?:摆开|摆放|排列|排开|排好|铺开)$/u.exec(text);
    const layoutNames = layout && operands(layout[1]!, context);
    if (layout && layoutNames?.length) return [`${renderOperands(layoutNames)}排成${/横|水平/u.test(layout[0]) ? '横排' : '竖排'}`];
  }
  if (kind === 'connect') {
    const directed = /^(?:把|将|让)?(.+?)(?:连接到|连到|接到|连接|连向|指向)(.+?)(?:用|使用)?(虚线|实线|断线)?$/u.exec(text);
    if (directed) {
      const from = operands(directed[1]!, context), to = operands(directed[2]!, context);
      if (from?.length && to?.length === 1) return from.map(name => `${renderOperands([name])}连到${renderOperands(to)}用${directed[3] === '虚线' || directed[3] === '断线' ? '虚线' : '实线'}`);
    }
    const pair = /^(?:给|把|将)?(.+?)(?:之间)?(?:接一下线|接个线|拉条线|拉一条线|连一下|接一下|串起来)$/u.exec(text);
    const names = pair && operands(pair[1]!, context);
    if (names?.length === 2) return [`把${renderOperands(names)}连起来`];
  }
  if (kind === 'group') {
    const match = /^(.+?)(?:一起)?(?:分组|打组|打个组|归到一块儿?|归到一起|归成一组|放到一组|放在同一组|合在一组|合成一组|编成一组|归在一组|分在一堆|收进一组)$/u.exec(text);
    const names = match && operands(match[1]!, context);
    if (names?.length) return [`${renderOperands(names)}分组`];
  }
  if (kind === 'ungroup') {
    const match = /^(?:把|将)?(.+?)(?:散开|拆开|拆散|解开)(?:保留卡片)?$/u.exec(text);
    if (match) return [`解组${literal(match[1]!)}`];
  }
  if (kind === 'line') {
    const match = /^(.+?)(?:变成|换成|改成|切到)(虚线|实线|断线|断续的|一段段的)$/u.exec(text);
    if (match) return [`${match[1]}改成${match[2] === '实线' ? '实线' : '虚线'}`];
  }
  if (kind === 'rename') {
    const match = /^(?:把|将|给|让)?(.+?)(?:改名(?:为|成|叫)|重命名(?:为|成)|取名(?:为|叫)|的?标题(?:换成|变成|改成|改为))(.+)$/u.exec(text);
    const names = match && operands(match[1]!, context);
    if (names?.length === 1 && match?.[2]?.trim()) return [`${renderOperands(names)}改名为${quote(literal(match[2]))}`];
  }
  if (kind === 'remove') {
    const match = /^(?:把|将)?(.+?)(?:删掉|删除|移除)$/u.exec(text) ?? /^(?:删除|删掉|移除|清掉)(.+)$/u.exec(text);
    const names = match && operands(match[1]!, context);
    if (names?.length) return [`删除${renderOperands(names)}`];
  }
  if (kind === 'presentation') {
    const match = /^(?:把|将)?(.+?)(?:切换(?:成|为)?|转换(?:成|为)|改成|换成)(文本框|卡片)(?:显示|样式|形态)?$/u.exec(text);
    const names = match && operands(match[1]!, context);
    if (names?.length) return [`把${renderOperands(names)}改成${match![2]}`];
  }
  return undefined;
}
