import type { CanvasRelativePlacement } from '../../protocols/canvas-agent.ts';
import type { ControlNodeAction } from '../../protocols/canvas-control.ts';
import type { ContentSummary } from '../../protocols/content.ts';

export type ControlRelativePlacement = Omit<CanvasRelativePlacement, 'nodeId'> & { movingIds: string[] };

export function planRelativePlacement(nodes: readonly ContentSummary[], placement: CanvasRelativePlacement): ControlNodeAction {
  const { nodeId, ...destination } = placement;
  return planRelativeTranslation(nodes, { ...destination, movingIds: [nodeId] })[0]!;
}

export function planRelativeTranslation(nodes: readonly ContentSummary[], placement: ControlRelativePlacement): ControlNodeAction[] {
  const ids = new Set(placement.movingIds);
  const moving = nodes.filter(node => ids.has(node.id));
  const anchor = nodes.find(node => node.id === placement.anchorId);
  if (!moving.length || moving.length !== ids.size || !anchor || ids.has(anchor.id)) throw new Error('相对摆放需要现有卡片和一个不同的参照对象');
  const left = Math.min(...moving.map(node => node.x));
  const top = Math.min(...moving.map(node => node.y));
  const width = Math.max(...moving.map(node => node.x + node.width)) - left;
  const height = Math.max(...moving.map(node => node.y + node.height)) - top;
  const { side, gap } = placement;
  const vertical = side === 'above' || side === 'below';
  const x = vertical ? anchor.x + (anchor.width - width) / 2
    : side === 'left' ? anchor.x - width - gap : anchor.x + anchor.width + gap;
  const y = vertical ? (side === 'above' ? anchor.y - height - gap : anchor.y + anchor.height + gap)
    : anchor.y + (anchor.height - height) / 2;
  return moving.map(node => ({ type: 'update-node', id: node.id, x: node.x + (x - left), y: node.y + (y - top) }));
}
