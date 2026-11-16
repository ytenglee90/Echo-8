import { canvasIntentText } from './ai-task-route.ts';
import { naturalColor, naturalName, NATURAL_QUOTED_NAME } from './natural-canvas-rules.ts';

export type NativeCanvasIntent =
  | { kind: 'action'; label: string }
  | { kind: 'view'; action: 'zoom-in' | 'zoom-out' | 'reset-zoom' | 'focus' | 'select-all' | 'clear-selection' | 'minimap-open' | 'minimap-close' }
  | { kind: 'preset'; id: 'bright' | 'dark' | 'eye-care' }
  | { kind: 'copy' | 'cut'; expectedCount?: number; expectedKind?: 'text-node' | 'group' }
  | { kind: 'paste' | 'undo' | 'redo' }
  | { kind: 'junction'; scope?: 'canvas'; line?: 'solid' | 'dashed' }
  | { kind: 'preferences'; property: 'toolbarBackground' | 'annotationColor' | 'editorChromeBackground' | 'editorBackground' | 'groupBackground'; color: string; label: string }
  | { kind: 'annotation-create'; name?: string; body?: string }
  | { kind: 'annotation-update'; body: string }
  | { kind: 'annotation-delete' }
  | { kind: 'annotation-color'; color: string };

const annotation = '(?:标注|批注|注释)';
const selected = '(?:(?:当前)?选中(?:的)?|这(?:个|条|处|张|些|几张|几条)(?:选中(?:的)?)?)';
const literal = new RegExp(`^(${NATURAL_QUOTED_NAME})$`, 'u');

/** Whole-clause matches only. Values between quotes are kept as data. */
export function nativeCanvasIntent(prompt: string): NativeCanvasIntent | undefined {
  const text = canvasIntentText(prompt).replace(/[。！!]$/u, '').trim();
  const localAction = /^执行(?:本地)?命令[：:]\s*(.{1,120})$/u.exec(text);
  if (localAction) return { kind: 'action', label: naturalName(localAction[1]!) };
  if (/^(?:修改|调整|更改|改|打开)(?:全局)?(?:主题|背景(?:颜色|色)?|注释颜色|批注颜色|标注颜色|外观|颜色设置)$/u.test(text)) {
    return { kind: 'action', label: '打开全局颜色设置' };
  }
  if (/^切换小地图$/u.test(text)) return { kind: 'action', label: '打开或关闭小地图' };
  const preset = /^(?:应用|切换到|切换为|换成|主题改成|主题改为)(护眼|明亮|深色)(?:配色|颜色方案)$/u.exec(text);
  if (preset) return { kind: 'preset', id: preset[1] === '护眼' ? 'eye-care' : preset[1] === '深色' ? 'dark' : 'bright' };
  const views: Array<[RegExp, Extract<NativeCanvasIntent, { kind: 'view' }>['action']]> = [
    [/^(?:放大|放大画布|画布放大)(?:一点|一级)?$/u, 'zoom-in'],
    [/^(?:缩小|缩小画布|画布缩小)(?:一点|一级)?$/u, 'zoom-out'],
    [/^(?:重置缩放|恢复(?:原始|默认)缩放|(?:缩放|画布缩放)(?:恢复|改为|设为)100%)$/u, 'reset-zoom'],
    [/^(?:聚焦|定位)(?:当前)?选中(?:的)?(?:对象|节点|项)?$/u, 'focus'],
    [/^(?:全选|全选画布|选中全部(?:画布)?对象)$/u, 'select-all'],
    [/^(?:取消选择|清空选区|取消全选|取消选中)$/u, 'clear-selection'],
    [/^(?:打开|显示)(?:画布)?小地图$/u, 'minimap-open'],
    [/^(?:关闭|隐藏)(?:画布)?小地图$/u, 'minimap-close'],
  ];
  for (const [pattern, action] of views) if (pattern.test(text)) return { kind: 'view', action };
  if (/^(?:撤销(?:刚才(?:的)?(?:操作)?|上一步|上一项操作)?|回退一步)$/u.test(text)) return { kind: 'undo' };
  if (/^(?:重做(?:刚才(?:的)?(?:操作)?|上一步)?|恢复刚撤销的操作)$/u.test(text)) return { kind: 'redo' };
  const clipboard = /^(?:(复制|剪切)(?:一下)?(?:当前|选中项|选中(?:的)?(?:节点|卡片|卡|群组|对象)?|这(?:几个|两张|三张|些)(?:节点|卡片|卡)?)?|把(?:当前)?选中(?:的)?(?:节点|卡片|卡|群组|对象|项)(复制|剪切)(?:一下)?)$/u.exec(text);
  if (clipboard) return { kind: (clipboard[1] ?? clipboard[2]) === '复制' ? 'copy' : 'cut',
    ...(/这两张/u.test(text) ? { expectedCount: 2 } : /这三张/u.test(text) ? { expectedCount: 3 } : {}),
    ...(/节点|卡片|卡|两张|三张/u.test(text) ? { expectedKind: 'text-node' } : /群组/u.test(text) ? { expectedKind: 'group' } : {}) };
  if (/^(?:粘贴|黏贴|贴上)(?:一下|到(?:当前)?画布(?:上)?|(?:剪贴板(?:中|里)的)?(?:节点|卡片|内容))?$/u.test(text)) return { kind: 'paste' };
  const canvasJunction = /^(?:给|为|在)?\s*(?:所有|全部)(?:的)?\s*(虚线|实线)(?:连接线|连线)?(?:上)?\s*[，,：:]?\s*(?:添加|增加|加上?|插入)\s*(?:一|1)个\s*(?:共用|共享)?中转点$/u.exec(text);
  if (canvasJunction) return { kind: 'junction', scope: 'canvas', line: canvasJunction[1] === '虚线' ? 'dashed' : 'solid' };
  if (/^(?:在|给)?\s*(?:(?:当前)?选中(?:的)?(?:连接线|连线|线)|这(?:一|几)?条(?:连接线|连线|线))\s*(?:上)?\s*(?:添加|增加|加上?|插入)\s*(?:一?个)?\s*中转点$/u.test(text)) return { kind: 'junction' };
  const appearance = /^(?:把|将)?\s*(?:全局)?(导航栏|工具栏|顶部栏|编辑器背景|编辑器栏|全局标注|默认标注|全局批注|默认批注|全局注释|默认注释|群组默认底色|默认群组底色)(?:的?(?:背景)?(?:颜色|色))?\s*(?:设为|设置为|改成|改为|调成|换成)\s*([^，。；!?！？\n]+)$/u.exec(text);
  if (appearance) {
    const label = appearance[1]!;
    const color = naturalColor(appearance[2]!);
    const property = /标注|批注|注释/u.test(label) ? 'annotationColor' : /群组/u.test(label) ? 'groupBackground' : label === '编辑器背景' ? 'editorBackground'
      : label === '编辑器栏' ? 'editorChromeBackground' : 'toolbarBackground';
    if (color) return { kind: 'preferences', property, color, label };
  }
  const selectedAnnotation = `(?:${selected})?${annotation}`;
  if (new RegExp(`^(?:删除|移除)${selectedAnnotation}$`, 'u').test(text)) return { kind: 'annotation-delete' };
  const colorChange = new RegExp(`^(?:把|将)?\\s*${selectedAnnotation}(?:的)?(?:颜色|色)\\s*(?:改成|改为|设为|换成)\\s*([^，。；!?！？\\n]+)$`, 'u').exec(text);
  if (colorChange) {
    const color = naturalColor(colorChange[1]!);
    if (color) return { kind: 'annotation-color', color };
  }
  const bodyEdit = new RegExp(`^(?:把|将)?\\s*${selectedAnnotation}(?:的?(?:内容|正文))?\\s*(?:改成|改为|写成|填入|填上)\\s*[：:]?\\s*(${NATURAL_QUOTED_NAME})$`, 'u').exec(text);
  if (bodyEdit) return { kind: 'annotation-update', body: naturalName(bodyEdit[1]!) };
  const add = new RegExp(`^(?:(?:在|给|为)\\s*(${NATURAL_QUOTED_NAME}|${selected}(?:节点|卡片|卡|群组)?|[^，,：:。；;！？?!\\r\\n]{1,120}?)(?:上)?\\s*)?(?:添加|新建|加上?|写一个)\\s*(?:一[个条])?${annotation}(?:\\s*(?:[：:]|[，,]\\s*(?:内容(?:是|为)?|写上))\\s*([\\s\\S]+))?$`, 'u').exec(text);
  if (!add) return undefined;
  const target = add[1];
  const value = add[2];
  // Bare multiline content and compound clauses require an explicit quoted literal.
  if (value && !literal.test(value) && /[\r\n，,；;。！？!?]/u.test(value)) return undefined;
  return { kind: 'annotation-create', ...(target && !new RegExp(`^${selected}(?:节点|卡片|卡|群组)?$`, 'u').test(target) ? { name: naturalName(target) } : {}),
    ...(value ? { body: literal.test(value) && !value.startsWith('@[') ? value.slice(1, -1) : value } : {}) };
}

export function nativeCanvasUsesSelection(intent: NativeCanvasIntent): boolean {
  return !(['paste', 'undo', 'redo', 'preferences', 'action', 'view', 'preset'].includes(intent.kind) ||
    (intent.kind === 'junction' && intent.scope === 'canvas') || (intent.kind === 'annotation-create' && intent.name));
}
