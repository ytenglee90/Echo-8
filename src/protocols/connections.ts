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
  /** Direction preference in 15-degree steps; the route planner projects it into the smooth physical transition. */
  handleAngle?: number;
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
export interface ConnectionCurveBend { from?: number; to?: number }
export function isConnectionCurveBend(value: unknown): value is ConnectionCurveBend {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bend = value as Record<string, unknown>;
  return Object.keys(bend).every(key => (key === 'from' || key === 'to') && typeof bend[key] === 'number' &&
    Number.isInteger(bend[key]) && Number(bend[key]) >= -75 && Number(bend[key]) <= 75 && Number(bend[key]) % 15 === 0);
}
export interface ConnectionSetCurveBendRequest { id: string; end: 'from' | 'to'; angle: number; expectedRevision: number }
export type ConnectionCurveBendPreview = ConnectionSetCurveBendRequest | { clear: true };

export interface ConnectionTitleOrigin { side: 'left' | 'right'; sourceIsLeft: boolean; sourceCenterX?: number; targetCenterX?: number }
export function isConnectionTitleOrigin(value: unknown): value is ConnectionTitleOrigin {
  if (!value || typeof value !== 'object') return false;
  const origin = value as Record<string, unknown>;
  return (origin.side === 'left' || origin.side === 'right') && typeof origin.sourceIsLeft === 'boolean' &&
    ((origin.sourceCenterX === undefined && origin.targetCenterX === undefined) ||
      (typeof origin.sourceCenterX === 'number' && Number.isFinite(origin.sourceCenterX) && typeof origin.targetCenterX === 'number' && Number.isFinite(origin.targetCenterX)));
}

export interface ConnectionRecord {
  /** Data version 12: per-curve interior steering; junction tangents remain shared. */
  curveBend?: ConnectionCurveBend;
  /** Schema v5 / dataVersion 10: selected title departure side and its original relative ordering. */
  titleOrigin?: ConnectionTitleOrigin;
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

/** A flexible box/group adopts an existing junction's line type; ordinary card ports remain explicit. */
export function connectionJunctionRequest<T extends { from: ConnectionEndpoint; to: ConnectionEndpoint }>(
  request: T, from: ConnectionNodeGeometry, to: ConnectionNodeGeometry, records: readonly ConnectionRecord[],
): T & { titleRoute?: boolean } {
  const junction = request.from.kind === 'junction' ? request.from : request.to.kind === 'junction' ? request.to : undefined;
  const other = request.from.kind === 'junction' ? to : from;
  if (!junction || (other.kind !== 'group' && other.presentation !== 'text-box')) return request;
  const edge = records.find(edge => [edge.from, edge.to].some(end => end.kind === 'junction' && end.nodeId === junction.nodeId));
  if (!edge) return request;
  const title = isTitleConnection(edge), automatic = resolveConnectionEndpoints(from, to);
  return { ...request, titleRoute: title,
    from: { ...request.from, side: !request.from.kind && title ? 'title' : automatic.from.side },
    to: { ...request.to, side: !request.to.kind && title ? 'title' : automatic.to.side } };
}

export interface ConnectionAppearanceSnapshot {
  /** Undefined keeps the original automatic color derived from the canvas background. */
  color?: string;
  revision: number;
}

/** Revision-checked endpoint replacement, v1; retains the connection identity and label. */
export interface ConnectionReconnectRequest { id: string; from: ConnectionEndpoint; to: ConnectionEndpoint; expectedRevision: number; titleOrigin?: ConnectionTitleOrigin }

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
    'connection.rotateJunctionHandle': CommandContract<{ id: string }, { handleAngle: number; revision: number }>;
    'connection.setCurveBend@1': CommandContract<ConnectionSetCurveBendRequest, { angle: number; revision: number }>;
    'connection.moveJunctions': CommandContract<{ positions: ConnectionMoveJunctionRequest[] }, { moved: number }>;
    'connection.connectSelectedEndpoints': CommandContract<undefined, { id?: string }>;
    'connection.addJunction': CommandContract<ConnectionAddJunctionRequest, { id: string }>;
    'connection.addJunctionFromContext': CommandContract<CanvasContextRequest, { id?: string }>;
    'connection.addJunctionAtPointer': CommandContract<undefined, { id?: string }>;
    'connection.moveJunction': CommandContract<ConnectionMoveJunctionRequest, { revision: number }>;
    'connection.nudgeJunction': CommandContract<{ id: string; dx: number; dy: number }, { revision: number }>;
    'connection.removeSelectedJunctions': CommandContract<undefined, { removed: number }>;
    'connection.create': CommandContract<{
      titleOrigin?: ConnectionTitleOrigin;
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
  titleStartSide?: 'left' | 'right';
  titleOrigin?: ConnectionTitleOrigin;
  /** In-place preview of an existing edge; cleared only after its replacement revision is projected. */
  reconnectId?: string;
  reconnectRevision?: number;
  from?: ConnectionEndpoint;
  to?: ConnectionEndpoint;
  pointer?: { x: number; y: number };
  /** Inherited title-route styling for a junction with no title endpoint yet. */
  titleRoute?: boolean;
}

export interface ConnectionNodeGeometry {
  id: string;
  /** Routing-vertex-only handle rotation. */
  handleAngle?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  kind?: ConnectionEndpoint['kind'];
  /** Presentation controls the projected anchor; legacy providers default to a card. */
  presentation?: 'card' | 'text-box';
}

/** Compare the live pointer to the point centre; target anchors are only a fallback for non-pointer callers. */
export function connectionJunctionDragRequest<T extends { from: ConnectionEndpoint; to: ConnectionEndpoint }>(request: T, from: ConnectionNodeGeometry, to: ConnectionNodeGeometry, pointer?: { x: number; y: number }): T {
  if (request.from.kind !== 'junction') return request;
  const sides = resolveConnectionEndpoints(from, to);
  const target = connectionEndpointPoint(request.to, to, sides.to.side);
  return (pointer?.x ?? target.x) < from.x ? { ...request, from: request.to, to: request.from } : request;
}

export const CONNECTION_GROUP_PORT_SCREEN_WIDTH = 48;
export const CONNECTION_GROUP_PORT_SCREEN_HEIGHT = 64;
/** Shared source/target hit geometry; group anchors stay at side midpoints at every zoom. */
export function connectionGroupPortHit(node: ConnectionNodeGeometry, pointer: { x: number; y: number }, zoom: number) {
  const scale = Math.max(.01, zoom);
  let result: { side: 'left' | 'right'; distance: number } | undefined;
  for (const side of ['left', 'right'] as const) {
    const dx = pointer.x - node.x - (side === 'right' ? node.width : 0), dy = pointer.y - node.y - node.height / 2;
    const distance = Math.hypot(dx, dy);
    if (Math.abs(dx) <= CONNECTION_GROUP_PORT_SCREEN_WIDTH / 2 / scale && Math.abs(dy) <= CONNECTION_GROUP_PORT_SCREEN_HEIGHT / 2 / scale && (!result || distance < result.distance)) result = { side, distance };
  }
  return result;
}

/** Only two ordinary text boxes use split title/body edge regions. */
export function connectionTextBoxPair(from: ConnectionNodeGeometry | undefined, to: ConnectionNodeGeometry | undefined): boolean {
  return from?.presentation === 'text-box' && to?.presentation === 'text-box' && !from.kind && !to.kind;
}

/** Text boxes classify target height for box, group and junction sources. */
export function connectionUsesTextBoxRegions(from: ConnectionNodeGeometry | undefined, to: ConnectionNodeGeometry | undefined): boolean {
  return to?.presentation === 'text-box' && !to.kind && Boolean(from && (from.presentation === 'text-box' || from.kind === 'group' || from.kind === 'junction'));
}

/** Semantic drop target shared by node, group and junction gesture adapters. */
export function connectionTitlePortHit(node: ConnectionNodeGeometry, pointer: { x: number; y: number }): boolean {
  return !node.kind && node.presentation !== 'text-box' &&
    pointer.y >= node.y - 18 && pointer.y <= node.y + 42 &&
    Math.min(Math.abs(pointer.x - node.x), Math.abs(pointer.x - node.x - node.width)) <= 24;
}
export function connectionTargetSide(node: ConnectionNodeGeometry, pointer: { x: number; y: number }, titleRoute = false, source?: ConnectionNodeGeometry): ConnectionSide {
  if (connectionUsesTextBoxRegions(source, node)) return pointer.y < node.y + node.height / 2 ? 'title' : pointer.x < node.x + node.width / 2 ? 'left' : 'right';
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
  horizontalSide: ConnectionSide = endpoint.side === 'title' ? 'left' : endpoint.side,
): { x: number; y: number; side: ConnectionSide } {
  if (endpoint.kind === 'junction') return { x: node.x, y: node.y, side: horizontalSide };
  if (endpoint.side === 'title') {
    return {
      x: node.x + (horizontalSide === 'right' ? node.width : 0),
      y: node.y + (node.presentation === 'text-box' ? node.height / 2 : CONNECTION_TITLE_ANCHOR_OFFSET_Y),
      side: horizontalSide === 'right' ? 'right' : 'left',
    };
  }
  return {
    x: node.x + (horizontalSide === 'right' ? node.width : 0),
    y: node.y + node.height / 2,
    side: horizontalSide,
  };
}

/** Centre alignment is stable across zoom and tolerates small layout/snap differences. */
export function connectionTitleAlignmentTolerance(from: ConnectionNodeGeometry, to: ConnectionNodeGeometry): number {
  return Math.max(24, Math.min(80, Math.min(from.width, to.width) * .2));
}

/** Semantic title pairs share a side across card/box presentations; group and junction endpoints keep facing sides. */
export function connectionHorizontalSides(connection: Pick<ConnectionRecord, 'from' | 'to' | 'titleRoute' | 'titleOrigin'>, from: ConnectionNodeGeometry, to: ConnectionNodeGeometry) {
  const sides = resolveConnectionEndpoints(from, to);
  const endpoints = resolveConnectionRecordEndpoints(connection, from, to);
  const centreDelta = from.x + from.width / 2 - to.x - to.width / 2;
  const manualTitle = !endpoints.from.kind && !endpoints.to.kind && endpoints.from.side === 'title' && endpoints.to.side === 'title' && isConnectionTitleOrigin(connection.titleOrigin)
    && (Math.abs(centreDelta) <= connectionTitleAlignmentTolerance(from, to) ||
      (connection.titleOrigin.sourceCenterX !== undefined && connection.titleOrigin.targetCenterX !== undefined &&
        Math.abs(centreDelta - (connection.titleOrigin.sourceCenterX - connection.titleOrigin.targetCenterX)) <= .000001))
    ? connection.titleOrigin.side : undefined;
  if (manualTitle) sides.from.side = manualTitle;
  if (!endpoints.from.kind && !endpoints.to.kind && endpoints.from.side === 'title' && endpoints.to.side === 'title') {
    sides.from.side = manualTitle ?? (sides.from.side === 'right' ? 'left' : 'right');
    sides.to.side = sides.from.side;
  }
  return sides;
}
