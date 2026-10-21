export const GRID_NODE_WIDTH = 280;
export const GRID_NODE_HEIGHT = 158;
export const GRID_NODE_GAP_X = 40;
export const GRID_NODE_GAP_Y = 40;

export interface GridLayoutNode {
  id: string;
  x: number;
  y: number;
}

export interface GridLayoutPosition {
  id: string;
  x: number;
  y: number;
}

export interface GridLayoutResult {
  columns: number;
  positions: GridLayoutPosition[];
}

export function arrangeNodesInGrid(
  nodes: GridLayoutNode[],
  mode: 'grid' | 'horizontal' | 'vertical' = 'grid',
): GridLayoutResult {
  if (nodes.length === 0) return { columns: 0, positions: [] };
  const ordered = [...nodes].sort((left, right) =>
    left.y - right.y || left.x - right.x || left.id.localeCompare(right.id));
  const anchorX = Math.min(...ordered.map((node) => node.x));
  const anchorY = Math.min(...ordered.map((node) => node.y));
  const columns = mode === 'horizontal'
    ? ordered.length
    : mode === 'vertical'
      ? 1
      : Math.ceil(Math.sqrt(ordered.length));
  return {
    columns,
    positions: ordered.map((node, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      return {
        id: node.id,
        x: anchorX + column * (GRID_NODE_WIDTH + GRID_NODE_GAP_X),
        y: anchorY + row * (GRID_NODE_HEIGHT + GRID_NODE_GAP_Y),
      };
    }),
  };
}
