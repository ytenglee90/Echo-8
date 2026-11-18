import { naturalColor } from './natural-canvas-rules.ts';

export interface ConnectionColorIntent { kind: 'connection-color'; color: string; scope?: 'selection' | 'canvas' }

/** A complete color request; the subject is a connection, never a node title. */
export function connectionColorIntent(text: string): ConnectionColorIntent | undefined {
  const match = /^(?:把|将)?\s*((?:(?:当前)?选中(?:的)?|这(?:条|些|几条)|(?:整个|当前)?画布(?:上|中)?(?:的)?(?:所有|全部)?|(?:所有|全部)(?:的)?)?)\s*(?:连接线|连线)(?:的?(?:颜色|色))?\s*(?:改成|改为|换成|设为|设置为)\s*([^，。；！？?!\n]+)$/u.exec(text);
  const color = match && naturalColor(match[2]!);
  if (!match || !color) return undefined;
  const prefix = match[1]!;
  return { kind: 'connection-color', color, ...(prefix ? { scope: /选中|这/u.test(prefix) ? 'selection' as const : 'canvas' as const } : {}) };
}
