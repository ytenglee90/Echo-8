export const DEFAULT_EDITOR_DOCK_WIDTH = 750;
export const MIN_EDITOR_DOCK_WIDTH = 360;
export const MAX_EDITOR_DOCK_WIDTH = 1800;
export const MIN_EDITOR_PANE_WIDTH = 360;
export const EDITOR_PANE_DIVIDER_WIDTH = 6;
export const EDITOR_READ_WINDOW = 256 * 1024;

export function minimumEditorDockWidth(paneCount: number): number {
  const count = Math.max(1, Math.floor(paneCount));
  return count * MIN_EDITOR_PANE_WIDTH + (count - 1) * EDITOR_PANE_DIVIDER_WIDTH;
}
