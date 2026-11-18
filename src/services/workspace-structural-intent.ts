import { naturalColor, NATURAL_QUOTED_NAME } from './natural-canvas-rules.ts';
import { readWorkspaceSelectionReference, workspaceCount } from './workspace-selection-reference.ts';
import type { CatalogIntent } from './workspace-catalog-intent.ts';

type Intent = Omit<CatalogIntent, 'input'>;
const VALUE = '[-+]?[0-9]+(?:\\.[0-9]+)?';
const coordinates = new RegExp('^[(（]?\\s*(?:x\\s*[=:：]?\\s*)?(' + VALUE + ')\\s*[,，、]\\s*(?:y\\s*[=:：]?\\s*)?(' + VALUE + ')\\s*[)）]?$', 'iu');
const dimensions = new RegExp('^(?:(?:宽(?:度)?\\s*)(' + VALUE + ')\\s*(?:px|像素)?[，,、\\s]*高(?:度)?\\s*(' + VALUE +
  ')|(' + VALUE + ')\\s*(?:×|乘(?:以)?|[x*])\\s*(' + VALUE + '))(?:\\s*(?:px|像素))?$', 'iu');
const axisRanges = new RegExp('^x(?:在|从|为)?\\s*(' + VALUE + ')\\s*(?:到|至)\\s*(' + VALUE +
  ')\\s*(?:[,，、]|且|并且|和)\\s*y(?:在|从|为)?\\s*(' + VALUE + ')\\s*(?:到|至)\\s*(' + VALUE + ')$', 'iu');
const coordinateRanges = new RegExp('^(' + VALUE + ')\\s*(?:到|至)\\s*(' + VALUE +
  ')\\s*[,，、]\\s*(' + VALUE + ')\\s*(?:到|至)\\s*(' + VALUE + ')$', 'u');
const cornerAndSize = new RegExp('^(' + VALUE + ')\\s*[,，、]\\s*(' + VALUE + ')\\s*' +
  '(?:坐标)?\\s*[,，、]?\\s*宽(?:度)?\\s*(' + VALUE + ')\\s*(?:px|像素)?\\s*[,，、]?\\s*高(?:度)?\\s*(' + VALUE + ')(?:px|像素)?$', 'iu');

function one(action: string, args?: Record<string, unknown>, binding?: CatalogIntent['binding'], operand?: string): Intent {
  return { steps: [{ id: 'catalog-1', action, arguments: args }], binding, operand };
}

function geometryIntent(masked: string, input: string): Intent | undefined {
  const normalized = masked.normalize('NFKC').replace(/[。！!]+$/u, '');
  if (/框选|矩形.{0,8}选择/u.test(normalized) && !/删除|移走|移除|排除/u.test(normalized)) {
    const extent = /x\s*[^。？！!]{3,85}?y\s*[^。？！!]{3,85}?(?=范围|的(?:卡|对象)|框选|区域|$)/iu.exec(normalized)?.[0]?.trim();
    const ordered = /(?:画布)?坐标\s*(.+?)\s*(?:的)?区域$/u.exec(normalized);
    const ranges = (extent && axisRanges.exec(extent)) || (ordered && coordinateRanges.exec(ordered[1]!));
    if (ranges) {
      const [x, right, y, bottom] = ranges.slice(1).map(Number) as [number, number, number, number];
      if (right >= x && bottom >= y) return one('selection.box', { x, y, width: right - x, height: bottom - y });
    }
    const exact = /(?:左上角|起点)\s*(.+?)\s*(?:的)?矩形/u.exec(normalized);
    const shape = exact && cornerAndSize.exec(exact[1]!);
    if (shape) {
      const [x, y, width, height] = shape.slice(1).map(Number);
      return one('selection.box', { x, y, width, height });
    }
  }
  const source = input.trim().replace(/[。！!]+$/u, '');
  const move = /^(?:把|将)?\s*(.+?)\s*(?:(?:的)?位置(?:设为|设成|改成|改为)|(?:放|移|挪|移动)(?:到|至|在)(?:画布)?(?:坐标)?)\s*(.+?)(?:的?位置)?$/u.exec(source);
  const point = move && coordinates.exec(move[2]!.normalize('NFKC').trim());
  if (point && move) return one('node.move', { x: Number(point[1]), y: Number(point[2]) }, 'node', move[1]);
  const resize = /^(?:把|将)?\s*(.+?)(?:的)?(?:尺寸|大小)?(?:调(?:整)?到|设成|设为|改为|改成)\s*(.+)$/u.exec(source);
  const size = resize && dimensions.exec(resize[2]!.normalize('NFKC').trim());
  if (size && resize) return one('node.resize', { width: Number(size[1] ?? size[3]), height: Number(size[2] ?? size[4]) }, 'node', resize[1]);
  const presentation = /^(?:把|将|让)?\s*(.+?)(?:节点|卡片?)?\s*(?:不要卡片形态\s*[,，]\s*)?(?:改成|改用|换成|转换为|转换成|切换为)\s*(?:文字框|文本框)(?:形态|显示)?$/u.exec(source);
  if (presentation) return one('node.presentation', { presentation: 'text-box' }, 'node', presentation[1]);
  return undefined;
}

const paragraph = /首段|第一段|开头(?:那|一)?段/u;
const literalName = new RegExp('^(?:' + NATURAL_QUOTED_NAME + ')$', 'u');
function cleanTitle(raw: string, type: 'group' | 'node') {
  const title = raw.trim().replace(/^(?:名为|命名为|叫做?|名字叫)\s*/u, '');
  if (literalName.test(title)) return title.slice(1, -1);
  return title.replace(type === 'group' ? /(?:的)?(?:群组|分组|组)$/u : /(?:的)?(?:新卡|卡片|节点|卡)$/u, '').trim();
}

function withoutPreviewFrame(input: string) {
  return input.trim()
    .replace(/^(?:(?:暂不(?:建组|写入)|暂时不要执行|不要直接创建)[,，]\s*)?\s*(?:先)?(?:看看|查看|看|给我看|给我看看|展示|预览)\s*/u, '')
    .replace(/^(?:预览)\s*/u, '').replace(/[。！!]+$/u, '')
    .replace(/[,，]?\s*(?:先看预览|先预览|的预览|的方案|的效果)$/u, '').trim();
}

export function isWorkspacePreviewRequest(input: string): boolean {
  return /(?:^|[,，]\s*)(?:先(?:看|做|给我看)?预览|预览|暂不|暂时不要执行|不要直接|只准备)|(?:的预览|的稿件|的方案|分组方案|排列方案|布局方案)[。！!]?$/u.test(input);
}

function previewIntent(masked: string, input: string): Intent | undefined {
  if (!isWorkspacePreviewRequest(masked)) return undefined;
  const scoped = withoutPreviewFrame(input);
  if (paragraph.test(masked) && /新卡|卡片?|节点/u.test(masked)) {
    const extract = /^(?:把|将)?\s*(.+?)\s*(?:复制|提取|摘录|摘|提)(?:到|成|为)\s*(.+)$/u.exec(scoped)
      ?? /^(.+?(?:首段|第一段|开头一段))\s*(?:做成|转成)\s*(.+)$/u.exec(scoped);
    const title = extract && cleanTitle(extract[2]!, 'node');
    if (extract && title && !/^(?:新|一张|一个)$/u.test(title)) return one('content.extract.preview', { title }, 'paragraph-extract', extract[1]);
  }
  const match = /^(?:把|将)?\s*(.+?)\s*(?:的)?标题(?:栏)?(?:颜色|色)?\s*(?:改成|改为|设为|换成|使用)\s*(.+)$/u.exec(scoped);
  const color = match && naturalColor(match[2]!);
  if (color && match && (/标题(?:栏)?(?:颜色|色)/u.test(masked) || /^#[\da-f]{6}$/iu.test(match[2]!))) {
    return one('node.color', { color }, 'node', match[1]);
  }
  const placement = /(?:按|做|排成|准备一个)\s*([一二两三四五六七八九十\d]+)\s*列(?:且)?[,，、\s]*(?:卡间距|间隔|间距)\s*(\d+(?:\.\d+)?)/u.exec(masked);
  const columns = placement?.[1] && workspaceCount(placement[1]);
  if (placement && columns && columns <= 20 && /布局|排列|摆放|分列|列.{0,15}卡间距/u.test(masked) && !/之外|以外|排除|除了/u.test(masked)) {
    const candidate = /(?:按|把|将|给)?\s*(当前选区|选中(?:的)?(?:[一二两三四五六七八九十\d]+张)?(?:卡片?|节点)|这[一二两三四五六七八九十\d]+张卡片?)/u.exec(masked);
    const selection = readWorkspaceSelectionReference(candidate?.[1] ?? '当前选区');
    return { steps: [
      { id: 'layout-source', action: 'layout.plan', arguments: { columns, gap: Number(placement[2]) }, selection },
      { id: 'layout-preview', action: 'canvas.batch.preview', arguments: {
        plan: { $step: 'layout-source', path: ['plan'] }, expectedRevision: { $step: 'layout-source', path: ['expectedRevision'] },
      } },
    ] };
  }
  return undefined;
}

function groupIntent(masked: string, input: string): Intent | undefined {
  if (/(?:不(?:要|许|用)|别|暂不)\s*(?:再|直接)?(?:解组|解散|取消分组|移出|退出|归入|纳入|并入|新增|添加|增加)/u.test(masked)) return undefined;
  if (/解组|取消.{0,80}(?:分组)|解散/u.test(masked) && /保留(?:卡片|成员)|成员不要删|(?:卡|成员).{0,8}留/u.test(masked)) {
    return one('group.ungroup', undefined, 'group');
  }
  if (/移出|退出|成员.{0,4}(?:去掉|移除)/u.test(masked) && /组/u.test(masked) && !/删除(?:卡|节点)/u.test(masked)) {
    return one('group.remove', undefined, 'group-member');
  }
  if (/布局冲突|重叠|互相遮挡/u.test(masked) && /查看|检查|看看/u.test(masked) && /(?:群组|组)(?:里|内)/u.test(masked)) {
    return one('layout.inspect', undefined, 'group-members');
  }
  const statement = input.trim().replace(/[。！!]+$/u, '');
  const entry = /^(?:把|将)\s*(.+?)\s*(?:归入|纳入|并入)\s*(?:现有|已有)(?:的)?\s*(.+?)(?:里|内|中)?$/u.exec(statement);
  const addition = /^(.+?(?:群组|分组|组))\s*(?:新增|添加|增加)\s*(.+?)\s*(?:这个|作为)?成员$/u.exec(statement);
  if (entry || addition) {
    return { ...one('group.add', undefined, 'group-member', entry?.[1] ?? addition?.[2]), groupOperand: entry?.[2] ?? addition?.[1] };
  }
  const scoped = withoutPreviewFrame(input).replace(/^(?:先)?把/u, '');
  if (/^(?:先)?(?:别|不要|不用|无需|不必|禁止|暂不)/u.test(scoped)) return undefined;
  const grouping = /^(?:将)?\s*(.+?)\s*(?:组成|建成|分成|分为|归入|归为)\s*(.+)$/u.exec(scoped)
    ?? /^(?:先)?给\s*(.+?)\s*(?:做|准备)\s*(.+?)\s*分组方案$/u.exec(scoped);
  if (!grouping || !/组/u.test(masked) || /删除|移动|连线|并且|处理/u.test(masked)) return undefined;
  if (/^(?:现有|已有)/u.test(grouping[2]!)) return undefined;
  const named = /(?:名为|名字叫|叫做?|命名为)\s*(.+?)(?:的群组|的分组)?$/u.exec(grouping[2]!);
  if (!named && /^(?:一个)?(?:新|群组|组|一组)/u.test(grouping[2]!)) return undefined;
  const title = cleanTitle(named?.[1] ?? grouping[2]!, 'group');
  if (!title) return undefined;
  const selection = readWorkspaceSelectionReference(grouping[1]!);
  if (selection) return { steps: [{ id: 'catalog-1', action: 'group.createExplicit', arguments: { title }, selection }] };
  return one('group.createExplicit', { title }, 'members', grouping[1]);
}

function noteIntent(masked: string, input: string): Intent | undefined {
  const added = /^(?:给|为)\s*(.+?)\s*(?:添加|增加|附上)(?:说明|批注|标注|注释)[,，：:]\s*(.+)$/u.exec(input);
  if (added) return one('annotation.add', { body: added[2] }, 'node', added[1]);
  if (!/批注|标注|注释/u.test(masked) || /全部|所有|正文也|范围|第.+段/u.test(masked)) return undefined;
  if (/^(?:删除|去掉|移除|删掉)|^(?:把|将).+(?:批注|标注|注释)(?:删除|去掉|移除|删掉)[。！!]?$/u.test(masked)) return one('annotation.delete', undefined, 'annotation');
  if (!/^(?:把|将|修改|更新|改)/u.test(masked)) return undefined;
  const replacement = /(?:改成|改为|换成|更新为)\s*(.+?)\s*[。！!]?$/u.exec(input)?.[1];
  if (replacement && /批注|标注|注释/u.test(masked)) return one('annotation.update', { body: replacement.replace(/^[「『“"]|[」』”"]$/gu, '') }, 'annotation', input.slice(0, -replacement.length));
  return undefined;
}

export function workspaceStructuralIntent(masked: string, input: string): Intent | undefined {
  return previewIntent(masked, input) ?? groupIntent(masked, input) ?? geometryIntent(masked, input) ?? noteIntent(masked, input);
}
