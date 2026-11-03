import type { EventDeclaration, PatchOperation } from './state.ts';
import type { CanvasContextRequest } from './canvas.ts';

export const MAX_CONNECTION_LABEL_LENGTH = 200;
export const DEFAULT_CONNECTION_LABEL_WIDTH = 180;
export const DEFAULT_CONNECTION_LABEL_HEIGHT = 48;
export const MIN_CONNECTION_LABEL_WIDTH = 80;
export const MAX_CONNECTION_LABEL_WIDTH = 640;
export const MIN_CONNECTION_LABEL_HEIGHT = 36;
export const MAX_CONNECTION_LABEL_HEIGHT = 320;

export type ConnectionSide = 'left' | 'right' | 'title';

export const CONNECTION_TITLE_ANCHOR_OFFSET_Y = 21;

export interface ConnectionEndpoint {
  nodeId: string;
  side: ConnectionSide;
  /** Endpoint schema v2. Omission retains the v1 text-node endpoint meaning. */
  kind?: 'junction';
}

export interface ConnectionJunction {
  id: string;
  /** World-space centre; this is a connection-owned vertex, never text content. */
  x: number;
  y: number;
  revision: number;
  /** Identifies the original labelled branches when only one branch survives. */
  branchSide?: 'incoming' | 'outgoing';
}

export interface ConnectionGraphSnapshot {
  version: 1;
  connections: ConnectionRecord[];
  junctions: ConnectionJunction[];
}

export interface ConnectionAddJunctionRequest {
  x: number;
  y: number;
  connections: Array<{ id: string; revision: number }>;
}

export interface ConnectionMoveJunctionRequest {
  id: string;
  x: number;
  y: number;
  expectedRevision: number;
}

export type ConnectionJunctionPreview = { id: string; x: number; y: number } | { clear: true };

export interface ConnectionRecord {
  id: string;
  from: ConnectionEndpoint;
  to: ConnectionEndpoint;
  label?: string;
  labelWidth: number;
  labelHeight: number;
  /** Optional object-level overrides; absence inherits the corresponding global appearance. */
  lineColor?: string;
  labelBackgroundColor?: string;
  labelTextColor?: string;
  /** Schema v2 routing segment; original branch records keep this absent. */
  junctionTrunk?: boolean;
  /** Keeps title-route styling on segments whose two ends are junctions. */
  titleRoute?: boolean;
  revision: number;
  createdAt: number;
}

export function isTitleConnection(connection: Pick<ConnectionRecord, 'from' | 'to' | 'titleRoute'>): boolean {
  return connection.titleRoute === true ||
    (connection.from.kind !== 'junction' && connection.from.side === 'title') ||
    (connection.to.kind !== 'junction' && connection.to.side === 'title');
}

export interface ConnectionAppearanceSnapshot {
  /** Undefined keeps the original automatic color derived from the canvas background. */
  color?: string;
  revision: number;
}

export interface ConnectionSetLabelRequest {
  id: string;
  label: string;
  expectedRevision: number;
}

export interface ConnectionResizeLabelRequest {
  id: string;
  width: number;
  height: number;
  expectedRevision: number;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'connection.addJunction': CommandContract<ConnectionAddJunctionRequest, { id: string }>;
    'connection.addJunctionFromContext': CommandContract<CanvasContextRequest, { id?: string }>;
    'connection.addJunctionAtPointer': CommandContract<undefined, { id?: string }>;
    'connection.moveJunction': CommandContract<ConnectionMoveJunctionRequest, { revision: number }>;
    'connection.nudgeJunction': CommandContract<{ id: string; dx: number; dy: number }, { revision: number }>;
    'connection.removeSelectedJunctions': CommandContract<undefined, { removed: number }>;
    'connection.create': CommandContract<{
      from: ConnectionEndpoint;
      to: ConnectionEndpoint;
    }, { id?: string }>;
    'connection.setLabel': CommandContract<ConnectionSetLabelRequest, { revision: number }>;
    'connection.resizeLabel': CommandContract<ConnectionResizeLabelRequest, {
      width: number;
      height: number;
      revision: number;
    }>;
    'connection.toggleSelected': CommandContract<undefined, { removed?: number; id?: string }>;
    'connection.toggleTitleSelected': CommandContract<undefined, {
      removed?: number;
      id?: string;
      converted?: boolean;
    }>;
  }
}

declare module './messages.ts' {
  interface ApplicationCapabilityMap {
    'connections.graph@1': MessageContract<undefined, ConnectionGraphSnapshot>;
  }
}

export function normalizeConnectionLabelSize(width: unknown, height: unknown): {
  width: number;
  height: number;
} {
  return {
    width: clampLabelDimension(
      width,
      DEFAULT_CONNECTION_LABEL_WIDTH,
      MIN_CONNECTION_LABEL_WIDTH,
      MAX_CONNECTION_LABEL_WIDTH,
    ),
    height: clampLabelDimension(
      height,
      DEFAULT_CONNECTION_LABEL_HEIGHT,
      MIN_CONNECTION_LABEL_HEIGHT,
      MAX_CONNECTION_LABEL_HEIGHT,
    ),
  };
}

function clampLabelDimension(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

export interface ConnectionDraft {
  from?: ConnectionEndpoint;
  to?: ConnectionEndpoint;
  pointer?: { x: number; y: number };
}

export interface ConnectionNodeGeometry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Produces owner-labelled patches for a connection whose endpoint nodes may be
 * created in the same outer transaction. The caller must commit the returned
 * plan together with the content-owner plans for any not-yet-existing nodes.
 */
export interface ConnectionCreatePlanRequest {
  fromNodeId: string;
  toNodeId: string;
}

export interface ConnectionMutationPlan {
  id: string;
  patches: PatchOperation[];
  events?: EventDeclaration[];
}

/**
 * Ordinary left/right connection sides are derived from the nodes' current
 * horizontal centres. The explicit title endpoint is handled separately and
 * remains stable when nodes move or change size.
 */
export function resolveConnectionEndpoints(
  fromNode: ConnectionNodeGeometry,
  toNode: ConnectionNodeGeometry,
): { from: ConnectionEndpoint; to: ConnectionEndpoint } {
  const fromCenter = fromNode.x + fromNode.width / 2;
  const toCenter = toNode.x + toNode.width / 2;
  const fromIsLeft = fromCenter <= toCenter;
  return {
    from: { nodeId: fromNode.id, side: fromIsLeft ? 'right' : 'left' },
    to: { nodeId: toNode.id, side: fromIsLeft ? 'left' : 'right' },
  };
}

export function resolveConnectionRecordEndpoints(
  connection: Pick<ConnectionRecord, 'from' | 'to'>,
  fromNode: ConnectionNodeGeometry,
  toNode: ConnectionNodeGeometry,
): { from: ConnectionEndpoint; to: ConnectionEndpoint } {
  if (connection.from.kind === 'junction' || connection.to.kind === 'junction') {
    const automatic = resolveConnectionEndpoints(fromNode, toNode);
    return {
      from: connection.from.kind === 'junction'
        ? { ...automatic.from, kind: 'junction' }
        : connection.from.side === 'title' ? { ...connection.from } : automatic.from,
      to: connection.to.kind === 'junction'
        ? { ...automatic.to, kind: 'junction' }
        : connection.to.side === 'title' ? { ...connection.to } : automatic.to,
    };
  }
  if (connection.from.side === 'title' || connection.to.side === 'title') {
    return {
      from: { nodeId: fromNode.id, side: 'title' },
      to: { nodeId: toNode.id, side: 'title' },
    };
  }
  return resolveConnectionEndpoints(fromNode, toNode);
}

export function connectionEndpointPoint(
  endpoint: ConnectionEndpoint,
  node: ConnectionNodeGeometry,
): { x: number; y: number; side: ConnectionSide } {
  if (endpoint.kind === 'junction') return { x: node.x, y: node.y, side: endpoint.side };
  if (endpoint.side === 'title') {
    return {
      x: node.x,
      y: node.y + CONNECTION_TITLE_ANCHOR_OFFSET_Y,
      side: endpoint.side,
    };
  }
  return {
    x: node.x + (endpoint.side === 'right' ? node.width : 0),
    y: node.y + node.height / 2,
    side: endpoint.side,
  };
}
