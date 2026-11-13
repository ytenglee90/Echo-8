import type { EventDeclaration, PatchOperation } from './state.ts';
import type { ContentSummary } from './content.ts';
import type { ConnectionNodeGeometry, ConnectionRecord } from './connections.ts';
import type { GroupRecord } from './groups.ts';

export interface ControlNodeFields {
  /** Plan v2 only; offsets are UTF-16 indices into the expected content revision. */
  edit?: { start: number; deleteCount: number; insert: string; expectedRevision: number };
  title?: string;
  text?: string;
  append?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  presentation?: 'card' | 'text-box';
}
export type ControlNodeAction =
  | (ControlNodeFields & { type: 'create-node'; ref: string; title: string })
  | (ControlNodeFields & { type: 'update-node'; id: string });
export type ControlGroupAction =
  | { type: 'create-group'; ref: string; title: string; members: string[]; color?: string }
  | { type: 'update-group'; id: string; title?: string; members?: string[]; color?: string };
export type ControlConnectionAction =
  | { type: 'create-connection'; ref: string; from: string; to: string; line: 'solid' | 'dashed'; label?: string; color?: string }
  | { type: 'update-connection'; id: string; from?: string; to?: string; line?: 'solid' | 'dashed'; label?: string; color?: string };
export type CanvasControlAction = ControlNodeAction | ControlGroupAction | ControlConnectionAction | { type: 'delete'; ids: string[] };
export interface CanvasControlPlan { version: 1 | 2; actions: CanvasControlAction[]; answer?: string }

/** Bounded metadata captured only for an explicitly requested canvas-control turn. */
export interface CanvasControlAdmission {
  preparationId: string;
  sessionId: string;
  prompt: string;
  sourceIds?: string[];
}
export interface CanvasControlOffer extends CanvasControlAdmission { text: string; complete: boolean }
export type CanvasControlPurpose = 'appearance' | 'move' | 'creation' | 'structure' | 'content' | 'general';
export interface CanvasControlContextV2 { instruction: string; objectDirectory: string; targetIds?: string[]; responseSchema?: Record<string, unknown> }
export interface CanvasControlTaskState {
  version: 1;
  plans: Array<{ id: string; goal: string; status: 'pending' | 'applied' | 'undone' | 'changed' | 'failed' | 'dismissed' | 'expired';
    actions: unknown[]; actionCount: number; omittedActions: number; targets: Array<{ id: string; title: string; revision: number }>; error?: string }>;
}
export interface CanvasControlPatchPlan {
  patches: PatchOperation[];
  events?: EventDeclaration[];
  created: Record<string, string>;
}
export interface CanvasControlNodeRequest {
  actions: ControlNodeAction[];
  expected: ContentSummary[];
}
export interface CanvasControlNodePlan extends CanvasControlPatchPlan { nodes: ContentSummary[] }
export interface CanvasControlGroupRequest {
  actions: ControlGroupAction[];
  expected: GroupRecord[];
  nodes: ConnectionNodeGeometry[];
}
export interface CanvasControlGroupPlan extends CanvasControlPatchPlan { targets: ConnectionNodeGeometry[] }
export interface CanvasControlConnectionRequest {
  actions: ControlConnectionAction[];
  expected: ConnectionRecord[];
  nodes: ConnectionNodeGeometry[];
}
export interface CanvasControlReview {
  planVersion?: 1 | 2;
  id: string;
  sessionId: string;
  createdAt: number;
  status: 'pending' | 'applied' | 'dismissed';
  actions: CanvasControlAction[];
  titles: Record<string, string>;
  error?: string;
}
export interface CanvasControlState {
  open: boolean;
  scope: 'selection' | 'canvas';
  execution: 'direct' | 'review';
  reviews: CanvasControlReview[];
}
declare module './commands.ts' {
  interface ApplicationCommandMap {
    'canvasControl.open@1': CommandContract;
    'canvasControl.close@1': CommandContract;
    'canvasControl.scope@1': CommandContract<{ scope: 'selection' | 'canvas' }>;
    'canvasControl.execution@1': CommandContract<{ execution: 'direct' | 'review' }>;
    'canvasControl.offer@1': CommandContract<CanvasControlOffer, { message: string; directPlanId?: string }>;
    'canvasControl.generate@1': CommandContract<{ id: string }, { message: string }>;
    'canvasControl.apply@1': CommandContract<{ id: string }, { createdIds: string[] }>;
    'canvasControl.commit@1': CommandContract<{ id: string; token: string }, { createdIds: string[] }>;
    'canvasControl.dismiss@1': CommandContract<{ id: string }>;
  }
}
declare module './messages.ts' {
  interface ApplicationCapabilityMap {
    'canvasControl.context@2': MessageContract<CanvasControlAdmission & { purpose?: CanvasControlPurpose }, CanvasControlContextV2>;
    'canvasControl.localPlan@1': MessageContract<CanvasControlAdmission, { handled: boolean; text?: string }>;
    'canvasControl.taskState@1': MessageContract<{ sessionId: string; targetIds?: string[] }, CanvasControlTaskState>;
    'canvasControl.context@1': MessageContract<CanvasControlAdmission, { instruction: string }>;
    'canvasControl.nodesPlan@1': MessageContract<CanvasControlNodeRequest, CanvasControlNodePlan>;
    'canvasControl.nodesPlan@2': MessageContract<CanvasControlNodeRequest, CanvasControlNodePlan>;
    'canvasControl.groupsPlan@1': MessageContract<CanvasControlGroupRequest, CanvasControlGroupPlan>;
    'canvasControl.connectionsPlan@1': MessageContract<CanvasControlConnectionRequest, CanvasControlPatchPlan>;
  }
  interface ApplicationQueryMap { 'canvasControl.state@1': MessageContract<undefined, CanvasControlState> }
}
