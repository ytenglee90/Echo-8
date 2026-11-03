import type { EventDeclaration, PatchOperation } from './state.ts';
import type { CanvasContextRequest } from './canvas.ts';
import type { MessageContract as CapabilityContract } from './messages.ts';

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
  /** Endpoint schema v3 adds groups; v2 added junctions. Omission retains a text-node endpoint. */
  kind?: 'junction' | 'group';
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

/** Optional connection-owned point targets for canvas input adapters (world coordinates). */
export interface ConnectionTargetAtRequest { point: { x: number; y: number }; excludeId: string; radius: number }
type ConnectionTargetAtContract = CapabilityContract<ConnectionTargetAtRequest, ConnectionEndpoint | undefined>;
/** Geometry-only target projection. Supplying node geometry permits synchronous frame previews. */
export interface ConnectionTargetsRequest { nodes?: ConnectionNodeGeometry[]; excludedIds?: string[]; membership?: import('./groups.ts').GroupDropTargetRequest }
export interface ConnectionTarget extends ConnectionNodeGeometry { kind: 'group' }
type ConnectionTargetsContract = CapabilityContract<ConnectionTargetsRequest | undefined, ConnectionTarget[]>;
type ConnectionDetachContract = CapabilityContract<{ ids: string[] }, import('./selection.ts').EntityDeletePlan>;

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

export type ConnectionJunctionPreview = { id: string; x: number; y: number } | { positions: Array<{ id: string; x: number; y: number }> } | { clear: true };

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
    (connection.from.kind === undefined && connection.from.side === 'title') ||
    (connection.to.kind === undefined && connection.to.side === 'title');
}

export interface ConnectionAppearanceSnapshot {
  /** Undefined keeps the original automatic color derived from the canvas background. */
  color?: string;
  revision: number;
}

/** Revision-checked endpoint replacement, v1; retains the connection identity and label. */
export interface ConnectionReconnectRequest { id: string; from: ConnectionEndpoint; to: ConnectionEndpoint; expectedRevision: number }

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
    'connection.reconnect': CommandContract<ConnectionReconnectRequest, { id?: string }>;
    'connection.moveJunctions': CommandContract<{ positions: ConnectionMoveJunctionRequest[] }, { moved: number }>;
    'connection.connectSelectedEndpoints': CommandContract<undefined, { id?: string }>;
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
    'connections.targetAt@1': ConnectionTargetAtContract;
    'connections.targets@1': ConnectionTargetsContract;
    'connections.detachPlan@1': ConnectionDetachContract;
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
  /** Inherited title-route styling for a junction with no title endpoint yet. */
  titleRoute?: boolean;
}

export interface ConnectionNodeGeometry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind?: ConnectionEndpoint['kind'];
  /** Presentation controls the projected anchor; legacy providers default to a card. */
  presentation?: 'card' | 'text-box';
}

/** Semantic drop target shared by node, group and junction gesture adapters. */
export function connectionTitlePortHit(node: ConnectionNodeGeometry, pointer: { x: number; y: number }): boolean {
  return !node.kind && node.presentation !== 'text-box' &&
    pointer.y >= node.y - 18 && pointer.y <= node.y + 42 &&
    Math.min(Math.abs(pointer.x - node.x), Math.abs(pointer.x - node.x - node.width)) <= 24;
}
export function connectionTargetSide(node: ConnectionNodeGeometry, pointer: { x: number; y: number }, titleRoute = false): ConnectionSide {
  return titleRoute || connectionTitlePortHit(node, pointer) ? 'title' : pointer.x < node.x + node.width / 2 ? 'left' : 'right';
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
  connection: Pick<ConnectionRecord, 'from' | 'to' | 'titleRoute'>,
  fromNode: ConnectionNodeGeometry,
  toNode: ConnectionNodeGeometry,
): { from: ConnectionEndpoint; to: ConnectionEndpoint } {
  const automatic = resolveConnectionEndpoints(fromNode, toNode);
  const title = isTitleConnection(connection);
  return {
    from: connection.from.kind ? { ...automatic.from, kind: connection.from.kind }
      : { ...automatic.from, side: title ? 'title' : automatic.from.side },
    to: connection.to.kind ? { ...automatic.to, kind: connection.to.kind }
      : { ...automatic.to, side: title ? 'title' : automatic.to.side },
  };
}

export function connectionEndpointPoint(
  endpoint: ConnectionEndpoint,
  node: ConnectionNodeGeometry,
  horizontalSide: ConnectionSide = 'left',
): { x: number; y: number; side: ConnectionSide } {
  if (endpoint.kind === 'junction') return { x: node.x, y: node.y, side: endpoint.side };
  if (endpoint.side === 'title') {
    return {
      x: node.x + (horizontalSide === 'right' ? node.width : 0),
      y: node.y + (node.presentation === 'text-box' ? node.height / 2 : CONNECTION_TITLE_ANCHOR_OFFSET_Y),
      side: horizontalSide === 'right' ? 'right' : 'left',
    };
  }
  return {
    x: node.x + (endpoint.side === 'right' ? node.width : 0),
    y: node.y + node.height / 2,
    side: endpoint.side,
  };
}

/** Only two actual card title bars share a side; boxes and non-title endpoints retain facing sides. */
export function connectionHorizontalSides(connection: Pick<ConnectionRecord, 'from' | 'to' | 'titleRoute'>, from: ConnectionNodeGeometry, to: ConnectionNodeGeometry) {
  const sides = resolveConnectionEndpoints(from, to);
  const endpoints = resolveConnectionRecordEndpoints(connection, from, to);
  if (!endpoints.from.kind && !endpoints.to.kind && endpoints.from.side === 'title' && endpoints.to.side === 'title' &&
    from.presentation !== 'text-box' && to.presentation !== 'text-box') sides.to.side = sides.from.side;
  return sides;
}
