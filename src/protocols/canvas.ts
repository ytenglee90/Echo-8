import type { NodePosition } from './content.ts';
import type { SelectionMode } from './selection.ts';

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasViewportSize {
  width: number;
  height: number;
  /** Optional viewport origin, supplied by the mounted canvas view. */
  left?: number;
  top?: number;
}

export interface CanvasViewportCenter {
  x: number;
  y: number;
}

/** Public, read-only document appearance supplied by `canvas.appearance@1`. */
export interface CanvasAppearanceSnapshot {
  color: string;
  revision: number;
}

/** Ephemeral pointer location owned by the canvas input service. */
export type CanvasPointerSnapshot =
  | { point: { x: number; y: number } }
  | { clear: true };

/** Ephemeral entity hover used by overview renderers without inspecting another plugin's DOM. */
export interface CanvasEntityHoverPreview {
  id?: string;
  clear?: boolean;
}

export type CanvasToolMode = 'select' | 'hand';

export interface CanvasZoomRequest {
  zoom: number;
  commit?: boolean;
}

/** High-frequency wheel input forwarded by an overlay canvas layer. */
export interface CanvasWheelZoomRequest {
  clientX: number;
  clientY: number;
  deltaY: number;
}

export interface DragPreview {
  positions?: NodePosition[];
  /** Stable source positions shown while an Alt-drag is preparing a duplicate. */
  duplicateOrigins?: NodePosition[];
  clear?: boolean;
}

export interface CanvasSnapGuide {
  orientation: 'vertical' | 'horizontal';
  position: number;
  start: number;
  end: number;
  kind: 'edge' | 'center' | 'spacing';
}

export type CanvasSnapPreview = { guides: CanvasSnapGuide[] } | { clear: true };

export interface LassoPreview {
  x: number;
  y: number;
  width: number;
  height: number;
  mode: SelectionMode;
}

export type LassoSignal = LassoPreview | { clear: true };

export interface CanvasExternalLassoStartRequest {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  mode: SelectionMode;
}

export interface CanvasExternalLassoPointerRequest {
  pointerId: number;
  clientX: number;
  clientY: number;
  cancel?: boolean;
}

export interface FocusRequest {
  bounds: { x: number; y: number; width: number; height: number };
}
