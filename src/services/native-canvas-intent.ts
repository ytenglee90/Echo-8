import { canvasIntentText } from './ai-task-route.ts';
import { naturalColor, naturalName, NATURAL_QUOTED_NAME } from './natural-canvas-rules.ts';

export type NativeCanvasIntent =
  | { kind: 'copy' | 'cut'; expectedCount?: number; expectedKind?: 'text-node' | 'group' }
  | { kind: 'paste' | 'undo' | 'redo' | 'junction' }
  | { kind: 'preferences'; property: 'toolbarBackground' | 'annotationColor' | 'editorChromeBackground' | 'editorBackground'; color: string; label: string }
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
  if (/^(?:撤销(?:刚才(?:的)?(?:操作)?|上一步|上一项操作)?|回退一步)$/u.test(text)) return { kind: 'undo' };
  if (/^(?:重做(?:刚才(?:的)?(?:操作)?|上一步)?|恢复刚撤销的操作)$/u.test(text)) return { kind: 'redo' };
  const clipboard = /^(?:(复制|剪切)(?:一下)?(?:当前|选中项|选中(?:的)?(?:节点|卡片|卡|群组|对象)?|这(?:几个|两张|三张|些)(?:节点|卡片|卡)?)?|把(?:当前)?选中(?:的)?(?:节点|卡片|卡|群组|对象|项)(复制|剪切)(?:一下)?)$/u.exec(text);
  if (clipboard) return { kind: (clipboard[1] ?? clipboard[2]) === '复制' ? 'copy' : 'cut',
    ...(/这两张/u.test(text) ? { expectedCount: 2 } : /这三张/u.test(text) ? { expectedCount: 3 } : {}),
    ...(/节点|卡片|卡|两张|三张/u.test(text) ? { expectedKind: 'text-node' } : /群组/u.test(text) ? { expectedKind: 'group' } : {}) };
  if (/^(?:粘贴|黏贴|贴上)(?:一下|到(?:当前)?画布(?:上)?|(?:剪贴板(?:中|里)的)?(?:节点|卡片|内容))?$/u.test(text)) return { kind: 'paste' };
  if (/^(?:在|给)?\s*(?:(?:当前)?选中(?:的)?(?:连接线|连线|线)|这(?:一|几)?条(?:连接线|连线|线))\s*(?:上)?\s*(?:添加|增加|加上?|插入)\s*(?:一?个)?\s*中转点$/u.test(text)) return { kind: 'junction' };
  const appearance = /^(?:把|将)?\s*(?:全局)?(导航栏|工具栏|顶部栏|编辑器背景|编辑器栏|全局标注|默认标注|全局批注|默认批注)(?:的?(?:背景)?(?:颜色|色))?\s*(?:设为|改成|改为|调成|换成)\s*([^，。；!?！？\n]+)$/u.exec(text);
  if (appearance) {
    const label = appearance[1]!;
    const color = naturalColor(appearance[2]!);
    const property = /标注|批注/u.test(label) ? 'annotationColor' : label === '编辑器背景' ? 'editorBackground'
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
  const add = new RegExp(`^(?:(?:在|给|为)\\s*(${NATURAL_QUOTED_NAME}|${selected}(?:节点|卡片|卡|群组)?)(?:上)?\\s*)?(?:添加|新建|加上?|写一个)\\s*(?:一[个条])?${annotation}(?:\\s*(?:[：:]|[，,]\\s*(?:内容(?:是|为)?|写上))\\s*([\\s\\S]+))?$`, 'u').exec(text);
  if (!add) return undefined;
  const target = add[1];
  const value = add[2];
  // Bare multiline content and compound clauses require an explicit quoted literal.
  if (value && !literal.test(value) && /[\r\n，,；;。！？!?]/u.test(value)) return undefined;
  return { kind: 'annotation-create', ...(target && literal.test(target) ? { name: naturalName(target) } : {}),
    ...(value ? { body: literal.test(value) && !value.startsWith('@[') ? value.slice(1, -1) : value } : {}) };
}

export function nativeCanvasUsesSelection(intent: NativeCanvasIntent): boolean {
  return !(['paste', 'undo', 'redo', 'preferences'].includes(intent.kind) || (intent.kind === 'annotation-create' && intent.name));
}
