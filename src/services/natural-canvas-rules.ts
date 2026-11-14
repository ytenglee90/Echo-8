/** Literal operands stay intact even when titles contain action words or separators. */
export const NATURAL_QUOTED_NAME = String.raw`「[^」\r\n]+」|『[^』\r\n]+』|“[^”\r\n]+”|"[^"\r\n]+"|@\[[^\]\r\n]+\](?:\([^\)\r\n]*\))?`;

export function naturalName(value: string): string {
  return value.trim().replace(/^@\[([^\]]+)\](?:\([^)]+\))?$/u, '$1')
    .replace(/^[「“"『]|[」”"』]$/gu, '').trim();
}

export function naturalNames(value: string): string[] {
  const parts = [''];
  for (const [part] of value.matchAll(new RegExp(`${NATURAL_QUOTED_NAME}|[、，,和与]|[^「『“"@、，,和与]+|.`, 'gu'))) {
    if (/^[、，,和与]$/u.test(part)) parts.push('');
    else parts[parts.length - 1] += part;
  }
  return parts.map(naturalName).filter(Boolean);
}

export interface NaturalTargetFilter {
  group?: string;
  empty?: boolean;
  disconnected?: boolean;
  ungrouped?: boolean;
  presentation?: 'card' | 'text-box';
  titleContains?: string;
  exclude: string[];
}

/** Parse only conjunctions with deterministic meaning. Unknown conditions remain ordinary operands. */
export function naturalTargetFilter(value: string): NaturalTargetFilter | undefined {
  const original = value.trim();
  let text = original.replace(/^(?:当前)?(?:画布(?:上|中)?|全画布)(?:的)?(?=所有|全部|节点|卡片|文本框|空白|未|没|正文)/u, '')
    .replace(/^(节点|卡片|文本框)(?:全部|所有)$/u, '所有$1');
  if (text !== original && /^(?:节点|卡片|文本框)$/u.test(text)) text = '所有' + text;
  const excluded: string[] = [];
  const inside = /^(.*?(?:里|内|中))除了(.+?)(?:以外|之外)[，,]?\s*(.*)$/u.exec(text);
  if (inside) { excluded.push(...naturalNames(inside[2]!)); text = inside[1]! + inside[3]!; }
  const tail = /^(.*?)[，,]\s*(.+?)除外$/u.exec(text);
  if (tail) { excluded.push(...naturalNames(tail[2]!)); text = tail[1]!; }
  const match = /^(?:(.+?)(?:里|内|中)的?)?((?:(?:所有|全部|空白|正文为空|没(?:有)?连线|未连接|未分组|还没分组|且|并且|的|\s))*?)(节点|卡片|文本框)(?:[，,]?\s*(?:除了|排除)(.+?)(?:以外|之外|除外)?)?$/u.exec(text);
  const title = /^(?:(.+?)(?:里|内|中)的?)?标题(?:含有|包含|含)[「『“"](.+?)[」』”"]的?(节点|卡片|文本框)$/u.exec(text);
  if (title) return { group: title[1] && naturalName(title[1]), titleContains: title[2],
    presentation: title[3] === '卡片' ? 'card' : title[3] === '文本框' ? 'text-box' : undefined, exclude: excluded };
  if (!match || (!match[1] && !match[2].trim() && !match[4])) return undefined;
  return {
    group: match[1] && naturalName(match[1]), empty: /空白|正文为空/u.test(match[2]!),
    disconnected: /没(?:有)?连线|未连接/u.test(match[2]!), ungrouped: /未分组|还没分组/u.test(match[2]!),
    presentation: match[3] === '卡片' ? 'card' : match[3] === '文本框' ? 'text-box' : undefined,
    exclude: [...excluded, ...(match[4] ? naturalNames(match[4].replace(/(?:以外|之外|除外)$/u, '')) : [])],
  };
}

export const NATURAL_COLORS: Readonly<Record<string, string>> = {
  墨绿: '#235347', 浅蓝: '#add8e6', 深蓝: '#244b85', 暖灰: '#b8afa4', 黑: '#202124', 白: '#ffffff',
  红: '#c43d49', 蓝: '#3568a8', 绿: '#387453', 灰: '#888888', 紫: '#7455a1', 黄: '#e5b945',
  橙: '#d8803c', 粉: '#d78ca4', 浅绿: '#b4d6bd', 深绿: '#235347', 浅灰: '#d7d7d7', 深灰: '#555555',
};

export function naturalColor(value: string): string | undefined {
  const text = value.trim();
  return /^#[a-f\d]{6}$/iu.test(text) ? text.toLowerCase() : NATURAL_COLORS[text.replace(/色$/u, '')];
}

export type ExtendedCanvasOperation =
  | { kind: 'select'; names: string[]; selectionMode: 'replace' | 'add' }
  | { kind: 'rename'; names: string[]; title: string }
  | { kind: 'remove'; names: string[] }
  | { kind: 'line-update'; names: string[]; reverse?: boolean; label?: string; color?: string; remove?: boolean; reference?: 'previous' | 'selection' }
  | { kind: 'align'; names: string[]; alignment: 'left' | 'right' | 'top' | 'bottom' | 'horizontal-center' | 'vertical-center' }
  | { kind: 'create'; names: string[]; title: string; presentation: 'card' | 'text-box'; side?: 'left' | 'right' | 'above' | 'below'; template?: 'character' | 'blank-character' }
  | { kind: 'connect-many'; names: string[]; topology: 'fan' | 'chain'; line: 'solid' | 'dashed' };

export function extendedCanvasOperation(text: string): ExtendedCanvasOperation | undefined {
  const operand = `(${NATURAL_QUOTED_NAME}|.+?)`;
  let match: RegExpExecArray | null;
  if ((match = /^(?:在(?:当前)?画布上\s*)?(?:(?:新建|创建|新增|建|做|添加|加|来)\s*(?:(?:一|1)\s*(?:张|个|份))?|(?:一|1)\s*(?:张|个|份))\s*(空白(?:的)?)?\s*(角色卡片?|人物卡片?|角色档案|人物档案)(?:[，,：:\s]*(?:叫|名为|取名(?:为)?|标题(?:是|为))\s*([「『“"][^」』”"\r\n]+[」』”"]|(?:(?!(?:并|再|然后)(?:写|填|加|补|设|连))[^「『“"』」” ，,。；;！？?!\r\n]){1,80}))?$/u.exec(text))) {
    return { kind: 'create', names: [], title: match[3] ? naturalName(match[3]) : match[2]!.replace(/卡片$/u, '卡'), presentation: 'card', template: match[1] ? 'blank-character' : 'character' };
  }
  if ((match = /^(?:选中|选择|框选)\s*(.+)$/u.exec(text))) return { kind: 'select', names: naturalTargetFilter(match[1]!) ? [match[1]!] : naturalNames(match[1]!), selectionMode: 'replace' };
  if ((match = /^(?:把|将)?\s*(.+?)(?:也选上|加入选择|加入选区)$/u.exec(text))) return { kind: 'select', names: naturalNames(match[1]!), selectionMode: 'add' };
  if ((match = new RegExp(`^(?:把|将)?\\s*${operand}\\s*(?:改名为|改名成|标题改成|标题改为)\\s*(.+)$`, 'u').exec(text))) {
    return { kind: 'rename', names: [naturalName(match[1]!)], title: naturalName(match[2]!) };
  }
  if ((match = /^(?:删除|删掉|移除节点)\s*(.+)$/u.exec(text))) return { kind: 'remove', names: naturalTargetFilter(match[1]!) ? [match[1]!] : naturalNames(match[1]!) };
  if ((match = /^(?:把|将)?\s*(刚才那条|上一条|这条)(?:连线|线)?(?:的)?(?:箭头|方向)?(?:反过来|反向|反转)$/u.exec(text))) {
    return { kind: 'line-update', names: [], reverse: true, reference: match[1] === '这条' ? 'selection' : 'previous' };
  }
  if ((match = /^(?:把|将)?\s*(刚才那条|上一条|这条)(?:连线|线)?(?:的)?标签(?:改成|改为|设为)\s*(.*)$/u.exec(text))) {
    return { kind: 'line-update', names: [], label: naturalName(match[2]!), reference: match[1] === '这条' ? 'selection' : 'previous' };
  }
  if ((match = /^(?:把|将)?\s*(刚才那条|上一条|这条)(?:连线|线)?(?:的)?(?:颜色)?(?:改成|改为|换成)\s*(.+)$/u.exec(text))) {
    const color = naturalColor(match[2]!);
    if (color) return { kind: 'line-update', names: [], color, reference: match[1] === '这条' ? 'selection' : 'previous' };
  }
  if ((match = new RegExp(`^断开\\s*${operand}\\s*(?:指向|到)\\s*${operand}的?(?:连线|线)$`, 'u').exec(text))) {
    return { kind: 'line-update', names: [naturalName(match[1]!), naturalName(match[2]!)], remove: true };
  }
  if ((match = /^(?:把|将)?(.+?)(?:[，,]\s*|\s*)(左对齐|右对齐|顶(?:部)?对齐|底(?:部)?对齐|水平居中|垂直居中)$/u.exec(text))) {
    const alignment = { 左对齐: 'left', 右对齐: 'right', 顶对齐: 'top', 顶部对齐: 'top', 底对齐: 'bottom', 底部对齐: 'bottom', 水平居中: 'horizontal-center', 垂直居中: 'vertical-center' } as const;
    return { kind: 'align', names: naturalNames(match[1]!), alignment: alignment[match[2] as keyof typeof alignment] };
  }
  if ((match = new RegExp(`^在\\s*${operand}\\s*(左边|左侧|右边|右侧|上方|下方)(?:新建|创建|建)(?:一张|一个)?(?:叫|名为)?\\s*${operand}\\s*(?:的)?(卡片|文本框|节点)$`, 'u').exec(text))) {
    return { kind: 'create', names: [naturalName(match[1]!)], side: /左/u.test(match[2]!) ? 'left' : /右/u.test(match[2]!) ? 'right' : match[2] === '上方' ? 'above' : 'below', title: naturalName(match[3]!), presentation: match[4] === '文本框' ? 'text-box' : 'card' };
  }
  if ((match = /^(?:新建|创建)(?:一张|一个)?(?:叫|名为)\s*(.+?)(?:的)?(卡片|文本框|节点)$/u.exec(text))) {
    return { kind: 'create', names: [], title: naturalName(match[1]!), presentation: match[2] === '文本框' ? 'text-box' : 'card' };
  }
  if ((match = new RegExp(String.raw`^(?:新建|创建|建|加|添加|来|放)(?:(?:一|1)?[个张])?(空白(?:的)?)?(节点|卡片|文本框)(?:[，,：:\s]*(?:就叫|叫|名为|命名为)\s*(${NATURAL_QUOTED_NAME}|[^\s，,。；;！？?!]{1,80}))?$`, 'u').exec(text))) {
    return { kind: 'create', names: [], title: match[3] ? naturalName(match[3]) : match[2] === '节点' ? '新节点' : match[2]!,
      presentation: match[2] === '文本框' ? 'text-box' : 'card' };
  }
  if ((match = /^(.+?)分别(?:连到|指向)(.+?)(?:[，,]\s*(?:用|使用)(实线|虚线))?$/u.exec(text))) {
    const targets = naturalNames(match[2]!);
    if (targets.length >= 2) return { kind: 'connect-many', names: [naturalName(match[1]!), ...targets], topology: 'fan', line: match[3] === '虚线' ? 'dashed' : 'solid' };
  }
  if ((match = /^按(.+?)(?:的顺序)?依次连起来(?:[，,]\s*(?:用|使用)(实线|虚线))?$/u.exec(text))) {
    const targets = naturalNames(match[1]!);
    if (targets.length >= 2) return { kind: 'connect-many', names: targets, topology: 'chain', line: match[2] === '虚线' ? 'dashed' : 'solid' };
  }
  return undefined;
}
