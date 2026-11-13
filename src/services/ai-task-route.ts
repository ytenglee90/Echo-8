import type { CanvasControlPurpose } from '../protocols/canvas-control.ts';

/** Deterministic, conservative hints. Ambiguous requests retain the full path. */
export function canvasControlPurpose(prompt: string): CanvasControlPurpose {
  prompt = canvasCommandText(prompt);
  const fields = [
    /颜色|改色|配色|#[0-9a-f]{6}/iu.test(prompt) ? 'appearance' : '',
    /移动|坐标|位置|向[上下左右]/u.test(prompt) ? 'move' : '',
    /分组|群组|连线|连接|实线|虚线/u.test(prompt) ? 'structure' : '',
    /正文|续写|改写|设定|人物设计/u.test(prompt) ? 'content' : '',
    /新建|创建|生成/u.test(prompt) ? 'creation' : '',
  ].filter(Boolean);
  return fields.length === 1 ? fields[0] as CanvasControlPurpose : 'general';
}

/** Reference titles are data, never routing commands or creative-intent cues. */
export function canvasCommandText(prompt: string): string {
  return prompt.replace(/@\[[^\]\r\n]+\](?:\([^\)\r\n]*\))?|@node:[a-z0-9:-]+/giu, ' ');
}
