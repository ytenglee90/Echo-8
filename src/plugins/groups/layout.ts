import type { ContentSummary } from '../../protocols/content.ts';

export interface GroupLayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeGroupBounds(nodes: readonly ContentSummary[]): GroupLayoutBounds {
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return {
    x: left - 25,
    y: top - 25,
    width: right - left + 50,
    height: bottom - top + 50,
  };
}
