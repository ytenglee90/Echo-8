import type { EventDeclaration, PatchOperation } from './state.ts';
import type { CanvasSnapGuide } from './canvas.ts';
import type { WorldBounds } from './viewport.ts';

export interface SmartSnapRequest {
  dragged: WorldBounds;
  movingIds: string[];
  mode: 'nodes' | 'group';
  threshold: number;
}

export interface SmartSnapResult {
  offsetX: number;
  offsetY: number;
  guides: CanvasSnapGuide[];
}

export interface SmartLayoutSettings { guides: boolean; snap: boolean }

export interface SmartResizeSnapRequest {
  resized: WorldBounds;
  resizingId: string;
  threshold: number;
}

export interface SmartResizeSnapResult {
  width: number;
  height: number;
  guides: CanvasSnapGuide[];
}

export interface GridArrangePlanRequest {
  nodeIds: string[];
  mode?: ArrangeMode;
  /** Legacy request field retained for older command payloads. */
  direction?: 'horizontal' | 'vertical';
}

export type ArrangeMode = 'grid' | 'horizontal' | 'vertical';

export interface GridArrangePlan {
  selected: number;
  changed: number;
  columns: number;
  patches: PatchOperation[];
  events?: EventDeclaration[];
}

export interface ArrangeCycleResult {
  mode: ArrangeMode;
  nextMode: ArrangeMode;
  resetAfterMs: number;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'layout.toggleGuides@1': CommandContract<undefined, SmartLayoutSettings>;
    'layout.toggleSnap@1': CommandContract<undefined, SmartLayoutSettings>;
    'node.arrangeSelectedCycle': CommandContract<undefined, ArrangeCycleResult>;
    'node.arrangeSelectedGrid': CommandContract<undefined, { selected: number; changed: number; columns: number }>;
    'node.arrangeSelectedGrid.horizontal': CommandContract<undefined, { selected: number; changed: number; columns: number }>;
    'node.arrangeSelectedGrid.vertical': CommandContract<undefined, { selected: number; changed: number; columns: number }>;
  }
}
