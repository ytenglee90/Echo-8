import type { CanvasControlPlan } from '../../protocols/canvas-control.ts';
import type { ControlSnapshot } from './context.ts';
import { isTitleConnection } from '../../protocols/connections.ts';

export function lineStyleFollowup(prompt: string): 'solid' | 'dashed' | undefined {
  const command = prompt.trim().replace(/^@画布操作\s*/u, '').replace(/[。！!]$/u, '').trim();
  const match = /^(?:(?:插入|引用)(?:是|应该)?(?:用|使用)|(?:把|将)?(?:刚才的|上一条|这条|刚才那条)(?:连线|线)?(?:改为|改成|设为|用))\s*(虚线|实线)$/u.exec(command);
  return match ? (match[1] === '虚线' ? 'dashed' : 'solid') : undefined;
}

export function localLinePlan(snapshot: ControlSnapshot, line: 'solid' | 'dashed'): CanvasControlPlan {
  const candidates = snapshot.graph.connections.filter(edge => snapshot.relatedLineIds?.has(edge.id));
  if (candidates.length !== 1) return { version: 1, actions: [], answer: '请选中要修改的那条连线，或说出它连接的两个节点。' };
  const edge = candidates[0]!;
  if (isTitleConnection(edge) === (line === 'dashed')) return { version: 1, actions: [], answer: `这条连线已经是${line === 'dashed' ? '虚线' : '实线'}。` };
  return { version: 1, actions: [{ type: 'update-connection', id: edge.id, line }] };
}

export function localOperation(prompt: string): { color: string } | { axis: 'x' | 'y'; delta: number } | { x: number; y: number } | undefined {
  const command = prompt.trim().replace(/^@画布操作\s*/u, '').replace(/[。！!]$/u, '').trim();
  const color = /^(?:把|将)?\s*选中(?:的)?(?:文字)?节点(?:的)?(?:颜色)?\s*(?:设为|设置为|改为|改成|改色为)\s*(#[a-f0-9]{6})$/iu.exec(command);
  if (color) return { color: color[1]!.toLowerCase() };
  const offset = /^(?:把|将)?\s*选中(?:的)?(?:文字)?节点\s*向([左右上下])移动\s*(\d+(?:\.\d+)?)\s*(?:像素|px)?$/u.exec(command);
  if (offset && Number(offset[2]) <= 1_000_000) return { axis: /[左右]/u.test(offset[1]!) ? 'x' : 'y', delta: Number(offset[2]) * (/[左上]/u.test(offset[1]!) ? -1 : 1) };
  const position = /^(?:把|将)?\s*选中(?:的)?(?:文字)?节点\s*移动到\s*x\s*[=:：]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*y\s*[=:：]\s*(-?\d+(?:\.\d+)?)$/iu.exec(command);
  if (position) return { x: Number(position[1]), y: Number(position[2]) };
  return undefined;
}
export function localPlan(snapshot: ControlSnapshot, operation: NonNullable<ReturnType<typeof localOperation>>): CanvasControlPlan | undefined {
  const nodes = snapshot.nodes.filter(node => snapshot.writable.has(node.id));
  if (!nodes.length || ('x' in operation && nodes.length !== 1)) return undefined;
  return { version: 1, actions: nodes.map(node => ({ type: 'update-node', id: node.id,
    ...('color' in operation ? { color: operation.color } : 'axis' in operation ? { [operation.axis]: node[operation.axis] + operation.delta } : operation),
  })) };
}
