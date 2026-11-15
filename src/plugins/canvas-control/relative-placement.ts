import type { CanvasRelativePlacement } from '../../protocols/canvas-agent.ts';
import type { ControlNodeAction } from '../../protocols/canvas-control.ts';
import type { ContentSummary } from '../../protocols/content.ts';

export function planRelativePlacement(nodes: readonly ContentSummary[], placement: CanvasRelativePlacement): ControlNodeAction {
  const moving = nodes.find(node => node.id === placement.nodeId);
  const anchor = nodes.find(node => node.id === placement.anchorId);
  if (!moving || !anchor || moving.id === anchor.id) throw new Error('相对摆放需要两张不同的现有卡片');
  const { side, gap } = placement;
  const vertical = side === 'above' || side === 'below';
  const x = vertical ? anchor.x + (anchor.width - moving.width) / 2
    : side === 'left' ? anchor.x - moving.width - gap : anchor.x + anchor.width + gap;
  const y = vertical ? (side === 'above' ? anchor.y - moving.height - gap : anchor.y + anchor.height + gap)
    : anchor.y + (anchor.height - moving.height) / 2;
  return { type: 'update-node', id: moving.id, x, y };
}
