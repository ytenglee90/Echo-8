export const NODE_PREVIEW_MIN_ZOOM = 0.5;

export type CanvasNodeDetail = 'title-only' | 'preview';

/**
 * View-only level of detail. This must never alter document data, selection,
 * hit testing, commands or history.
 */
export function canvasNodeDetail(zoom: number): CanvasNodeDetail {
  return zoom < NODE_PREVIEW_MIN_ZOOM ? 'title-only' : 'preview';
}
