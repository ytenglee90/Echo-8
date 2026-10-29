import type { EventDeclaration, PatchOperation } from './state.ts';
import type { CanvasSnapGuide } from './canvas.ts';
import type { CommandContract } from './commands.ts';
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
    'node.arrangeSelectedCycle': CommandContract<undefined, ArrangeCycleResult>;
  }
}
