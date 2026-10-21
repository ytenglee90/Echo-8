import type { CameraState, LassoPreview } from '../../protocols/canvas.ts';
import {
  connectionEndpointPoint,
  resolveConnectionEndpoints,
  type ConnectionDraft,
  type ConnectionEndpoint,
} from '../../protocols/connections.ts';
import type { ContentSummary, NodePosition } from '../../protocols/content.ts';
import type { SelectionMode } from '../../protocols/selection.ts';
import { endEllipsis } from '../../ui/title-ellipsis.ts';

const CONNECTION_DRAG_THRESHOLD = 3;
const CONNECTION_TARGET_SLOP = 18;
const EDGE_PAN_ZONE_PX = 52;
const EDGE_PAN_MAX_PX = 18;

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2.4;

export function clampCanvasZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export interface SurfaceSize {
  width: number;
  height: number;
}

export interface NodeCharacterCount {
  revision: number;
  characters: number;
}

export interface LassoSession {
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  mode: SelectionMode;
  latestClientX: number;
  latestClientY: number;
  cameraOrigin: CameraState;
  cameraMoved: boolean;
}

export interface ResizePreview {
  id: string;
  width: number;
  height: number;
}

export interface ConnectionSession {
  from: ConnectionEndpoint;
  to?: ConnectionEndpoint;
  pointer: { x: number; y: number };
  pointerId: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

export function modifierMode(
  event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
): SelectionMode {
  if (event.altKey) return 'remove';
  if (event.metaKey || event.ctrlKey) return 'toggle';
  if (event.shiftKey) return 'add';
  return 'replace';
}

export function normalizeDroppedText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\0/g, '').slice(0, 20_000_000).trimEnd();
}

export function droppedTextTitle(value: string): string {
  const firstLine = value.split('\n').map((line) => line.trim()).find(Boolean);
  if (!firstLine) return '拖入文本';
  return endEllipsis(firstLine, 48);
}

export function clampSize(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

export function isSupportedDocumentDrop(file: File): boolean {
  const name = file.name.toLocaleLowerCase();
  return name.endsWith('.txt') || name.endsWith('.docx') || name.endsWith('.doc') ||
    file.type.startsWith('text/plain') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

export function contrastTextColor(color: string): '#111111' | '#ffffff' {
  const match = /^#([0-9a-f]{6})$/iu.exec(color);
  if (!match) return '#ffffff';
  const numeric = Number.parseInt(match[1], 16);
  const channels = [numeric >> 16, (numeric >> 8) & 255, numeric & 255].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.42 ? '#111111' : '#ffffff';
}

export function selectionAfterPointer(current: string[], id: string, mode: SelectionMode): string[] {
  const next = new Set(current);
  if (mode === 'replace') return next.has(id) ? current : [id];
  if (mode === 'add') next.add(id);
  if (mode === 'remove') next.delete(id);
  if (mode === 'toggle') {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  return [...next];
}

export function updateConnectionSession(
  session: ConnectionSession,
  pointer: { x: number; y: number },
  clientX: number,
  clientY: number,
  nodes: ContentSummary[],
  previews: Record<string, NodePosition>,
  resizePreviews: Record<string, ResizePreview>,
  zoom: number,
): ConnectionSession {
  const sourceNode = nodes.find((node) => node.id === session.from.nodeId);
  const source = sourceNode ? nodeGeometry(sourceNode, previews, resizePreviews) : undefined;
  const target = findConnectionTarget(nodes, pointer, session.from.nodeId, previews, resizePreviews, zoom);
  const moved = session.moved || Math.hypot(
    clientX - session.startClientX,
    clientY - session.startClientY,
  ) >= CONNECTION_DRAG_THRESHOLD;
  if (source && target) {
    const endpoints = session.from.side === 'title'
      ? {
          from: { nodeId: source.id, side: 'title' as const },
          to: { nodeId: target.id, side: 'title' as const },
        }
      : resolveConnectionEndpoints(source, target);
    return { ...session, ...endpoints, pointer, moved };
  }
  if (!source) return { ...session, to: undefined, pointer, moved };
  if (session.from.side === 'title') {
    return {
      ...session,
      from: { nodeId: source.id, side: 'title' },
      to: undefined,
      pointer,
      moved,
    };
  }
  const sourceCenter = source.x + source.width / 2;
  return {
    ...session,
    from: { nodeId: source.id, side: pointer.x < sourceCenter ? 'left' : 'right' },
    to: undefined,
    pointer,
    moved,
  };
}

function findConnectionTarget(
  nodes: ContentSummary[],
  pointer: { x: number; y: number },
  sourceId: string,
  previews: Record<string, NodePosition>,
  resizePreviews: Record<string, ResizePreview>,
  zoom: number,
): ContentSummary | undefined {
  const slop = CONNECTION_TARGET_SLOP / Math.max(zoom, 0.28);
  let best: { node: ContentSummary; score: number } | undefined;
  for (const node of nodes) {
    if (node.id === sourceId) continue;
    const geometry = nodeGeometry(node, previews, resizePreviews);
    if (
      pointer.x < geometry.x - slop || pointer.x > geometry.x + geometry.width + slop ||
      pointer.y < geometry.y - slop || pointer.y > geometry.y + geometry.height + slop
    ) continue;
    const inside = pointer.x >= geometry.x && pointer.x <= geometry.x + geometry.width &&
      pointer.y >= geometry.y && pointer.y <= geometry.y + geometry.height;
    const dx = pointer.x - (geometry.x + geometry.width / 2);
    const dy = pointer.y - (geometry.y + geometry.height / 2);
    const score = Math.hypot(dx, dy) + (inside ? 0 : 1_000_000);
    if (!best || score < best.score) best = { node: geometry, score };
  }
  return best?.node;
}

export function nodeGeometry(
  node: ContentSummary,
  previews: Record<string, NodePosition>,
  resizePreviews: Record<string, ResizePreview>,
): ContentSummary {
  return { ...node, ...previews[node.id], ...resizePreviews[node.id] };
}

export function connectionDraftPayload(session: ConnectionSession): ConnectionDraft {
  return { from: session.from, to: session.to, pointer: session.pointer };
}

export function connectionPortPoint(
  node: ContentSummary,
  side: ConnectionEndpoint['side'],
  previews: Record<string, NodePosition>,
  resizePreviews: Record<string, ResizePreview>,
): { x: number; y: number } {
  const geometry = nodeGeometry(node, previews, resizePreviews);
  return connectionEndpointPoint({ nodeId: node.id, side }, geometry);
}

export function screenToWorld(
  clientX: number,
  clientY: number,
  camera: CameraState,
  surface: HTMLElement,
): { x: number; y: number } {
  const rect = surface.getBoundingClientRect();
  return {
    x: (clientX - rect.left - camera.x) / camera.zoom,
    y: (clientY - rect.top - camera.y) / camera.zoom,
  };
}

export function normalizeLasso(session: LassoSession): LassoPreview {
  return {
    x: Math.min(session.startX, session.latestX),
    y: Math.min(session.startY, session.latestY),
    width: Math.abs(session.latestX - session.startX),
    height: Math.abs(session.latestY - session.startY),
    mode: session.mode,
  };
}

export function edgePanVelocity(position: number, size: number): number {
  if (size <= 0) return 0;
  if (position < EDGE_PAN_ZONE_PX) {
    return -EDGE_PAN_MAX_PX * Math.min(
      1,
      (EDGE_PAN_ZONE_PX - Math.max(0, position)) / EDGE_PAN_ZONE_PX,
    );
  }
  if (position > size - EDGE_PAN_ZONE_PX) {
    return EDGE_PAN_MAX_PX * Math.min(
      1,
      (Math.min(size, position) - (size - EDGE_PAN_ZONE_PX)) / EDGE_PAN_ZONE_PX,
    );
  }
  return 0;
}

export function formatNodeCharacterCount(
  node: ContentSummary,
  counts: ReadonlyMap<string, NodeCharacterCount>,
): string {
  const count = counts.get(node.id);
  return count?.revision === node.revision ? count.characters.toLocaleString() : '…';
}

export function dragOriginFor(id: string, nodes: ContentSummary[]): NodePosition | undefined {
  const node = nodes.find((item) => item.id === id);
  return node ? { id, x: node.x, y: node.y } : undefined;
}

export function cameraForBounds(
  bounds: { x: number; y: number; width: number; height: number },
  surface: SurfaceSize,
): CameraState {
  const padding = 120;
  const zoom = Math.min(1.4, clampCanvasZoom(Math.min(
    (surface.width - padding) / Math.max(bounds.width, 1),
    (surface.height - padding) / Math.max(bounds.height, 1),
  )));
  return {
    zoom,
    x: surface.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: surface.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}
