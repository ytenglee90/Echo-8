import type { CanvasControlPurpose } from '../protocols/canvas-control.ts';

/** Deterministic, conservative hints. Ambiguous requests retain the full path. */
export function canvasControlPurpose(prompt: string): CanvasControlPurpose {
  prompt = canvasCommandText(prompt);
  const fields = [
    /颜色|改色|配色|#[0-9a-f]{6}/iu.test(prompt) ? 'appearance' : '',
    /移动|坐标|位置|向[上下左右]/u.test(prompt) ? 'move' : '',
    /分组|群组|连线|连接|连到|实线|虚线|线型|插入/u.test(prompt) ? 'structure' : '',
    /正文|续写|改写|设定|人物设计/u.test(prompt) ? 'content' : '',
    /新建|创建|生成/u.test(prompt) ? 'creation' : '',
  ].filter(Boolean);
  return fields.length === 1 ? fields[0] as CanvasControlPurpose : 'general';
}

/** Reference titles are data, never routing commands or creative-intent cues. */
export function canvasCommandText(prompt: string): string {
  return prompt.replace(/@\[[^\]\r\n]+\](?:\([^)\r\n]*\))?|@node:[a-z0-9:-]+/giu, ' ');
}

export type NaturalCanvasOperation =
  | { kind: 'find' | 'relations' | 'ungroup'; names: string[] }
  | { kind: 'presentation'; names: string[]; presentation: 'card' | 'text-box'; color?: string; members?: boolean }
  | { kind: 'connect'; names: string[]; line?: 'solid' | 'dashed'; chooseDirection?: boolean }
  | { kind: 'line'; names: string[]; line: 'solid' | 'dashed'; reference?: 'previous' | 'selection' }
  | { kind: 'color'; names: string[]; color: string; members?: boolean }
  | { kind: 'background'; names: string[]; color: string }
  | { kind: 'theme'; names: string[]; theme: 'light' | 'dark' }
  | { kind: 'group' | 'group-add' | 'group-remove' | 'group-rename'; names: string[]; title?: string }
  | { kind: 'replace' | 'append'; names: string[]; text: string; old?: string }
  | { kind: 'filter'; names: string[]; empty: boolean; disconnected: boolean }
  | { kind: 'search'; names: string[]; terms: string[]; ungrouped: boolean }
  | { kind: 'move' | 'arrange'; names: string[]; x?: number; y?: number; layout?: 'horizontal' | 'vertical' | 'grid' };

const colors: Record<string, string> = { 墨绿: '#235347', 浅蓝: '#add8e6', 深蓝: '#244b85', 暖灰: '#b8afa4', 黑: '#202124', 白: '#ffffff', 红: '#c43d49', 蓝: '#3568a8', 绿: '#387453', 灰: '#888888', 紫: '#7455a1', 黄色: '#e5b945' };
const readColor = (value: string) => /^#[a-f\d]{6}$/iu.test(value) ? value.toLowerCase() : colors[value] ?? colors[value.replace(/色$/u, '')];
const name = (value: string) => value.trim().replace(/^@\[([^\]]+)\](?:\([^)]+\))?$/u, '$1').replace(/^[「“"『]|[」”"』]$/gu, '').trim();
// Quoted titles and inline references are single operands, including any list separators.
const quotedName = String.raw`「[^」\r\n]+」|『[^』\r\n]+』|“[^”\r\n]+”|"[^"\r\n]+"|@\[[^\]\r\n]+\](?:\([^\)\r\n]*\))?`;
const listPart = new RegExp(`${quotedName}|[、，,和与]|[^「『“"@、，,和与]+|.`, 'gu');
function names(value: string): string[] {
  const parts = [''];
  for (const [part] of value.matchAll(listPart)) {
    if (/^[、，,和与]$/u.test(part)) parts.push('');
    else parts[parts.length - 1] += part;
  }
  return parts.map(name).filter(Boolean);
}
const connectionOperand = `(${quotedName}|[^「」『』“”"，,？?\r\n]+?)`;
const connectionStyle = String.raw`(?:[，,\s]*(?:用|使用)\s*(实线|虚线))?`;
const directedConnection = new RegExp(`^(?:把|将)?\\s*${connectionOperand}\\s*(?:连接到|连到|连向|连接至)\\s*${connectionOperand}${connectionStyle}$`, 'u');
const fromConnection = new RegExp(`^从\\s*${connectionOperand}\\s*拉(?:一)?条\\s*(实线|虚线|线)\\s*到\\s*${connectionOperand}$`, 'u');
const pointingConnection = new RegExp(`^让\\s*${connectionOperand}\\s*指向\\s*${connectionOperand}${connectionStyle}$`, 'u');
const lineStyle = (value: string) => value === '实线' ? 'solid' as const : 'dashed' as const;

export function naturalCanvasOperation(prompt: string): NaturalCanvasOperation | undefined {
  const command = prompt.trim().replace(/^@画布操作\s*/u, '').replace(/^请\s*/u, '');
  const text = command.replace(/[。！？!?]$/u, '').trim();
  let match: RegExpExecArray | null;
  if (/^(?:如果|假如|假设|要是|先别|不要|别|不用|暂不)/u.test(text)) return undefined;
  if ((match = /^(?:找到|定位|查找|查一下)\s*(.+?)(?:节点)?(?:[，,]\s*(?:带我过去|定位过去|跳过去))?$/u.exec(text))) return { kind: 'find', names: [name(match[1]!)] };
  if ((match = /^(?:查(?:看|一下)?\s*)?(.+?)(?:(?:跟|和|与)谁有(?:连线|连接)|的(?:连线|连接关系)|(?:连接|连着)了哪些(?:节点|对象))$/u.exec(text))) return { kind: 'relations', names: [name(match[1]!)] };
  if ((match = /^(.+?)(?:连着吗|有连线吗|之间有几条(?:连)?线)$/u.exec(text))) {
    const pair = names(match[1]!);
    if (pair.length === 2) return { kind: 'relations', names: pair };
  }
  if (/[？?]$/u.test(command) || /(?:吗|么|会怎样|怎么样)$/u.test(text)) return undefined;
  if ((match = directedConnection.exec(text) ?? pointingConnection.exec(text))) return { kind: 'connect', names: [name(match[1]!), name(match[2]!)], line: match[3] ? lineStyle(match[3]) : undefined };
  if ((match = fromConnection.exec(text))) return { kind: 'connect', names: [name(match[1]!), name(match[3]!)], line: match[2] === '线' ? undefined : lineStyle(match[2]!) };
  if ((match = /^(?:把|将)\s*(.+?)\s*连起来(?:[，,\s]*(?:用|使用)\s*(实线|虚线))?$/u.exec(text))) {
    const pair = names(match[1]!);
    if (pair.length === 2) return { kind: 'connect', names: pair, line: match[2] ? lineStyle(match[2]) : undefined, chooseDirection: true };
  }
  if ((match = /^(?:(?:把|将)?\s*(刚才的|刚才那条|上一条|这条)(?:连线|线)?)?\s*(?:改为|改成|改回|设为|用|使用)\s*(实线|虚线)$/u.exec(text))) return { kind: 'line', names: [], line: lineStyle(match[2]!), reference: match[1] === '这条' ? 'selection' : match[1] ? 'previous' : undefined };
  if ((match = /^(?:把|将)?(.+?)的连线\s*(?:改为|改成|改回|设为)\s*(实线|虚线)$/u.exec(text))) return { kind: 'line', names: names(match[1]!), line: lineStyle(match[2]!) };
  if ((match = /^(?:把|将)?\s*(.+?)(?:的标题栏|的颜色)?\s*(?:统一)?(?:改成|改为|设为|换成|改色为)\s*(#[\da-f]{6}|[\p{Script=Han}]{1,5})$/iu.exec(text))) {
    const color = readColor(match[2]!);
    if (color) {
      const target = name(match[1]!);
      if (target === '画布背景') return { kind: 'background', names: [], color };
      const group = /^(.*?)组?(?:里|内|中)的(?:文字)?节点$/u.exec(target);
      return { kind: 'color', names: [group ? target.replace(/(?:里|内|中)的(?:文字)?节点$/u, '') : target], color, members: Boolean(group) };
    }
  }
  if ((match = /^(?:切到|切换到|换成|启用)\s*(深色|浅色|亮色|暗色)(?:应用)?主题$/u.exec(text))) return { kind: 'theme', names: [], theme: /深|暗/u.test(match[1]!) ? 'dark' : 'light' };
  if ((match = /^(?:把|将)?(.+?)(?:切成|切换为|切换成|转为|转换成|改成)\s*(文本框|卡片|文字节点)[，,]\s*(?:标题栏?|颜色)(?:统一)?改(?:成|为)?\s*(.+)$/u.exec(text))) {
    const color = readColor(match[3]!);
    const group = /^(.*?)(?:里|内|中)的(?:文字)?节点$/u.exec(match[1]!);
    if (color) return { kind: 'presentation', names: [name(group?.[1] ?? match[1]!)], presentation: match[2] === '文本框' ? 'text-box' : 'card', color, members: Boolean(group) };
  }
  if ((match = /^(?:把|将)?\s*(.+?)\s*(?:切成|切换为|切换成|转为|转换成|改成)\s*(文本框|卡片|文字节点)$/u.exec(text))) {
    const group = /^(.*?)(?:里|内|中)的(?:文字)?节点$/u.exec(match[1]!);
    return { kind: 'presentation', names: [name(group?.[1] ?? match[1]!)], presentation: match[2] === '文本框' ? 'text-box' : 'card', members: Boolean(group) };
  }
  if ((match = /^(?:把|将)?(.+?)(?:编成|分成|建成|组成)(?:一|一个)?组[，,\s]*(?:叫|命名为|名称为)\s*(.+)$/u.exec(text))) return { kind: 'group', names: names(match[1]!), title: name(match[2]!) };
  if ((match = /^(?:把|将)?(.+?)(?:也)?(?:加入|加进)(?:去)?\s*(.*)$/u.exec(text))) return { kind: 'group-add', names: [name(match[1]!)], title: name(match[2]!) || undefined };
  if ((match = /^(?:把|将)?(.+?)(?:移出|移除出)\s*(.*)$/u.exec(text))) return { kind: 'group-remove', names: [name(match[1]!)], title: name(match[2]!) || undefined };
  if ((match = /^(?:把|将)?(.+?)(?:改组名为|重命名为)\s*(.+)$/u.exec(text))) return { kind: 'group-rename', names: [name(match[1]!)], title: name(match[2]!) };
  if ((match = /^(?:解组|取消群组)\s*(.+)$/u.exec(text))) return { kind: 'ungroup', names: [name(match[1]!)] };
  if ((match = /^(?:把|将)(.+?)的(.{0,12}?)从\s*[「“"]?([^「」“”"，,]+?)[」”"]?\s*改(?:成|为)\s*[「“"]?([^「」“”"]+?)[」”"]?$/u.exec(text))) return { kind: 'replace', names: [name(match[1]!)], old: match[3]!.trim(), text: match[4]!.trim() };
  if ((match = /^(?:在|给)(.+?)(?:的?正文)?(?:末尾|结尾)\s*(?:追加|加上|补上)[：:\s]*[「“"]?([\s\S]+?)[」”"]?$/u.exec(text))) return { kind: 'append', names: [name(match[1]!)], text: match[2]! };
  if ((match = /^找出\s*(?:(.+?)(?:里|内|中)(?:的)?)?\s*((?:没(?:有)?连线的?)?(?:空白)?(?:没(?:有)?连线的?)?)节点$/u.exec(text)) && match[2]) return { kind: 'filter', names: match[1] ? [name(match[1])] : [], empty: match[2].includes('空白'), disconnected: match[2].includes('连线') };
  if ((match = /^(?:把|将)?(.+?)(?:向|往|移到|移向)(?:右(?:边|侧)?|左(?:边|侧)?|上(?:面|方)?|下(?:面|方)?)(?:移动)?\s*(\d+)?\s*(?:像素|px)?$/u.exec(text))) {
    const direction = /(?:向|往|移到|移向)([右左上下])/u.exec(text)?.[1];
    const distance = Number(match[2] ?? 300);
    return { kind: 'move', names: [name(match[1]!)], x: direction === '右' ? distance : direction === '左' ? -distance : 0, y: direction === '下' ? distance : direction === '上' ? -distance : 0 };
  }
  if ((match = /^(?:把|将)?(.+?)(?:按|排成|排列成)(横排|纵排|竖排|宫格)(?:排列)?$/u.exec(text))) return { kind: 'arrange', names: [name(match[1]!)], layout: match[2] === '宫格' ? 'grid' : match[2] === '横排' ? 'horizontal' : 'vertical' };
  return undefined;
}

/** Open-ended searches are interpreted by a model, then resolved against the local index. */
export function needsCanvasSearchInterpretation(prompt: string): boolean {
  return /^(?:请\s*)?(?:把|将|找出|筛选|查找).*(?:有关|相关).*(?:整理出来|找出来|筛出来|列出来)[。！]?$/u.test(prompt.trim());
}
