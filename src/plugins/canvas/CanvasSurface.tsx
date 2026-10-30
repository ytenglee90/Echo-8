'use client';

import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { UISlot, ViewClient } from '../../core/contracts.ts';
import { appearancePreviewTarget, type AppearancePreview } from '../../protocols/appearance.ts';
import type {
  CameraState,
  CanvasAppearanceSnapshot,
  CanvasExternalLassoPointerRequest,
  CanvasExternalLassoStartRequest,
  CanvasSnapGuide,
  CanvasSnapPreview,
  CanvasPointerSnapshot,
  CanvasToolMode,
  CanvasViewportSize,
  CanvasWheelZoomRequest,
  CanvasZoomRequest,
  DragPreview,
  FocusRequest,
  LassoPreview,
  LassoSignal,
} from '../../protocols/canvas.ts';
import {
  type ConnectionSide,
} from '../../protocols/connections.ts';
import type {
  ContentMetricsSnapshotV2,
  ContentReferenceDragPreview,
  ContentReferenceDrop,
  ContentReferenceDropZone,
  ContentSummary,
  NodePosition,
} from '../../protocols/content.ts';
import type {
  GroupDropTarget,
  GroupDropTargetRequest,
  GroupMembershipDropRequest,
  GroupMembershipPreview,
} from '../../protocols/groups.ts';
import type { SelectionMode, SelectionResolution, SelectionSnapshot } from '../../protocols/selection.ts';
import type {
  SmartResizeSnapRequest,
  SmartResizeSnapResult,
  SmartSnapRequest,
  SmartSnapResult,
} from '../../protocols/layout.ts';
import { isEcho8ProjectFile } from '../../protocols/files.ts';
import { boundsIntersect, clientPointInWorld, worldViewport } from '../../protocols/viewport.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { canvasContrastVariables } from '../../ui/canvas-contrast.ts';
import { SpatialHashIndex } from '../../services/spatial-index.ts';
import { useCommandAvailability, useContentCatalog } from '../../ui/runtime-hooks.ts';
import { CanvasEntityLayerProvider } from '../../ui/canvas-entity-layer-runtime.tsx';
import { canvasNodeDetail } from './lod.ts';
import {
  clampCanvasZoom,
  cameraForBounds,
  clampSize,
  connectionPortPoint,
  connectionDraftPayload,
  dragOriginFor,
  droppedTextTitle,
  edgePanVelocity,
  isSupportedDocumentDrop,
  modifierMode,
  normalizeDroppedText,
  normalizeLasso,
  screenToWorld,
  selectionAfterPointer,
  updateConnectionSession,
  type ConnectionSession,
  type LassoSession,
  type NodeCharacterCount,
  type ResizePreview,
  type SurfaceSize,
} from './surface-geometry.ts';

const CULL_MARGIN = 360;
const MIN_NODE_WIDTH = 220;
const MAX_NODE_WIDTH = 1600;
const MIN_NODE_HEIGHT = 120;
const MAX_NODE_HEIGHT = 1200;
const SNAP_THRESHOLD_PX = 18;

interface DragSession {
  primaryId: string;
  selectionMode: SelectionMode;
  pointerX: number;
  pointerY: number;
  latestClientX: number;
  latestClientY: number;
  origins: NodePosition[];
  latest: NodePosition[];
  moved: boolean;
  duplicateOnCommit?: boolean;
}

interface PendingNodeDrag {
  primaryId: string;
  selectionMode: SelectionMode;
  pointerId: number;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  released: boolean;
  cancelled: boolean;
  membershipActiveOnRelease?: boolean;
  duplicateOnCommit?: boolean;
}

interface PanSession {
  pointerX: number;
  pointerY: number;
  origin: CameraState;
  latest: CameraState;
}

interface PendingLassoGesture {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startWorldX: number;
  startWorldY: number;
  mode: SelectionMode;
  cameraOrigin: CameraState;
  released: boolean;
}

interface SuspendedDragPan {
  pointerX: number;
  pointerY: number;
  origin: CameraState;
  latest: CameraState;
}

interface ResizeSession extends ResizePreview {
  x: number;
  y: number;
  pointerId: number;
  pointerX: number;
  pointerY: number;
  originWidth: number;
  originHeight: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  expectedRevision?: number;
}

const ECHO8_CONTENT_DRAG_TYPE = 'application/x-echo8-content';

function referenceSourceIds(primaryId: string, positions: readonly NodePosition[]): string[] {
  return [...new Set([primaryId, ...positions.map((position) => position.id)])];
}

export function CanvasSurface({
  client,
  renderSlot,
}: {
  client: ViewClient;
  renderSlot?: (slot: UISlot) => ReactNode;
}) {
  const workspaceVersion = useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  useSyncExternalStore(client.subscribeKeyboard, client.getKeyboardVersion, () => 0);
  const spacePanActive = client.isShortcutPressed('canvas.pan-shortcut');
  const surfaceRef = useRef<HTMLDivElement>(null);
  const {
    summaries: nodes,
    byId: nodeById,
    geometryById,
    unavailable,
  } = useContentCatalog(client);
  const importAvailable = useCommandAvailability(client, 'file.importDocuments');
  const projectOpenAvailable = useCommandAvailability(client, 'file.openProject');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: 1 });
  const [tool, setTool] = useState<CanvasToolMode>('select');
  const [previews, setPreviews] = useState<Record<string, NodePosition>>({});
  const [snapGuides, setSnapGuides] = useState<CanvasSnapGuide[]>([]);
  const [resizePreviews, setResizePreviews] = useState<Record<string, ResizePreview>>({});
  const [lassoPreview, setLassoPreview] = useState<LassoPreview>();
  const [surfaceSize, setSurfaceSize] = useState<SurfaceSize>({ width: 1200, height: 800 });
  const [canvasColor, setCanvasColor] = useState('#efefec');
  const [appearancePreview, setAppearancePreview] = useState<AppearancePreview>();
  const [canvasDropHint, setCanvasDropHint] = useState<'documents' | 'text'>();
  const [connectionTargetId, setConnectionTargetId] = useState<string>();
  const [nodeDragActive, setNodeDragActive] = useState(false);
  const [dragOriginPreview, setDragOriginPreview] = useState<NodePosition[]>([]);
  const [nodeCharacterCounts, setNodeCharacterCounts] = useState<ReadonlyMap<string, NodeCharacterCount>>(
    () => new Map(),
  );
  const drag = useRef<DragSession | undefined>(undefined);
  const pendingDrag = useRef<PendingNodeDrag | undefined>(undefined);
  const pan = useRef<PanSession | undefined>(undefined);
  const pendingLasso = useRef<PendingLassoGesture | undefined>(undefined);
  const lasso = useRef<LassoSession | undefined>(undefined);
  const externalLassoPointerId = useRef<number | undefined>(undefined);
  const suspendedDragPan = useRef<SuspendedDragPan | undefined>(undefined);
  const lassoPanFrame = useRef<number | undefined>(undefined);
  const resize = useRef<ResizeSession | undefined>(undefined);
  const connectionDraft = useRef<ConnectionSession | undefined>(undefined);
  const zoomCommitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusFrame = useRef<number | undefined>(undefined);
  const membershipPreviewVisible = useRef(false);
  const referenceDropZone = useRef<ContentReferenceDropZone | undefined>(undefined);
  const cameraRef = useRef<CameraState>(camera);
  const surfaceSizeRef = useRef<SurfaceSize>(surfaceSize);
  const groupMembershipModifierActive = client.isShortcutPressed('canvas.group-membership-modifier');
  const duplicateModifierActive = client.isShortcutPressed('canvas.duplicate-modifier');

  const syncGroupMembershipPreview = useCallback((
    nodeId: string,
    clientX: number,
    clientY: number,
    active: boolean,
  ) => {
    const surface = surfaceRef.current;
    if (!active || !surface) {
      if (!membershipPreviewVisible.current) return;
      membershipPreviewVisible.current = false;
      client.emit('group.membership.preview', { clear: true } satisfies GroupMembershipPreview);
      return;
    }
    membershipPreviewVisible.current = true;
    client.emit('group.membership.preview', {
      nodeId,
      pointer: screenToWorld(clientX, clientY, cameraRef.current, surface),
      active: true,
    } satisfies GroupMembershipPreview);
  }, [client]);

  const referenceTargetAt = useCallback((clientX: number, clientY: number) => {
    const zone = referenceDropZone.current;
    const rect = zone?.rect;
    if (!zone?.active || !rect) return undefined;
    return clientX >= rect.x && clientX <= rect.x + rect.width &&
      clientY >= rect.y && clientY <= rect.y + rect.height
      ? zone
      : undefined;
  }, []);

  const syncReferenceDragPreview = useCallback((sourceIds: string[], clientX: number, clientY: number) => {
    const sourceId = sourceIds[0];
    if (!sourceId) return;
    const target = referenceTargetAt(clientX, clientY);
    client.emit('content.reference.drag.preview', target
      ? {
          sourceId,
          sourceIds,
          targetOwner: target.owner,
          overTarget: true,
        } satisfies ContentReferenceDragPreview
      : { sourceId, sourceIds, overTarget: false } satisfies ContentReferenceDragPreview);
  }, [client, referenceTargetAt]);

  const clearReferenceDragPreview = useCallback(() => {
    client.emit('content.reference.drag.preview', { clear: true } satisfies ContentReferenceDragPreview);
  }, [client]);

  const commitReferenceDrop = useCallback((sourceIds: string[], clientX: number, clientY: number) => {
    const sourceId = sourceIds[0];
    if (!sourceId) return false;
    const target = referenceTargetAt(clientX, clientY);
    if (!target) return false;
    client.emit('content.reference.drop', {
      sourceId,
      sourceIds,
      targetOwner: target.owner,
    } satisfies ContentReferenceDrop);
    clearReferenceDragPreview();
    return true;
  }, [clearReferenceDragPreview, client, referenceTargetAt]);

  useEffect(() => {
    let current = true;
    void client.request<CameraState>('canvas.camera@1').then((saved) => {
      if (!current) return;
      cameraRef.current = saved;
      setCamera(saved);
      client.emit('canvas.camera.preview', saved);
    });
    return () => {
      current = false;
    };
  }, [client]);

  useEffect(() => {
    let current = true;
    void client.request<CanvasToolMode>('canvas.tool@1')
      .then((next) => current && setTool(next))
      .catch(() => current && setTool('select'));
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, workspaceVersion]);

  useEffect(() => {
    let current = true;
    void client.request<CanvasAppearanceSnapshot>('canvas.appearance@1')
      .then((appearance) => current && setCanvasColor(appearance.color));
    return () => {
      current = false;
    };
  }, [capabilityVersion, client]);

  useEffect(() => {
    let current = true;
    void client
      .request<SelectionSnapshot>('selection.read@1')
      .then((selection) => current && setSelectedIds(selection.ids))
      .catch(() => current && setSelectedIds([]));
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, workspaceVersion]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = surface.getBoundingClientRect();
      const next: CanvasViewportSize = {
        width: surface.clientWidth,
        height: surface.clientHeight,
        left: rect.left,
        top: rect.top,
      };
      surfaceSizeRef.current = next;
      setSurfaceSize(next);
      if (next.width > 0 && next.height > 0) client.emit('canvas.viewport.preview', next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [client]);

  useEffect(
    () =>
      client.subscribeSignal<DragPreview>('canvas.drag.preview', (message) => {
        if (message.payload.clear) {
          setPreviews({});
          setDragOriginPreview([]);
          return;
        }
        setPreviews(
          Object.fromEntries((message.payload.positions ?? []).map((position) => [position.id, position])),
        );
        if (message.payload.duplicateOrigins) {
          setDragOriginPreview(message.payload.duplicateOrigins);
        }
      }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<CanvasSnapPreview>('canvas.snap.preview', (message) => {
      setSnapGuides('clear' in message.payload ? [] : message.payload.guides);
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<ContentReferenceDropZone>('content.reference.drop-zone', (message) => {
      const zone = message.payload;
      if (!zone.active || !zone.rect) {
        if (referenceDropZone.current?.owner === zone.owner) referenceDropZone.current = undefined;
        return;
      }
      referenceDropZone.current = zone;
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<ResizePreview & { clear?: boolean }>('canvas.node.resize.preview', (message) => {
      if (message.payload.clear) {
        setResizePreviews({});
        return;
      }
      setResizePreviews({ [message.payload.id]: message.payload });
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<AppearancePreview>('appearance.color.preview', (message) => {
      setAppearancePreview(message.payload.clear ? undefined : message.payload);
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal('canvas.appearance.invalidated', () => {
      void client.request<CanvasAppearanceSnapshot>('canvas.appearance@1')
        .then((appearance) => setCanvasColor(appearance.color))
        .catch(() => undefined);
    }),
    [client],
  );

  useEffect(
    () =>
      client.subscribeSignal<CameraState>('canvas.camera.preview', (message) => {
        cameraRef.current = message.payload;
        setCamera(message.payload);
      }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<CanvasZoomRequest>('canvas.zoom.requested', (message) => {
      const current = cameraRef.current;
      const size = surfaceSizeRef.current;
      const nextZoom = clampCanvasZoom(message.payload.zoom);
      const centerX = size.width / 2;
      const centerY = size.height / 2;
      const worldX = (centerX - current.x) / current.zoom;
      const worldY = (centerY - current.y) / current.zoom;
      const next = {
        zoom: nextZoom,
        x: centerX - worldX * nextZoom,
        y: centerY - worldY * nextZoom,
      };
      client.emit('canvas.camera.preview', next);
      if (message.payload.commit) void client.dispatch('canvas.camera.commit', next);
    }),
    [client],
  );

  const applyWheelZoom = useCallback((clientX: number, clientY: number, deltaY: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const current = cameraRef.current;
    const rect = surface.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const worldX = (localX - current.x) / current.zoom;
    const worldY = (localY - current.y) / current.zoom;
    const nextZoom = clampCanvasZoom(current.zoom * Math.exp(-deltaY * 0.001));
    const next = {
      zoom: nextZoom,
      x: localX - worldX * nextZoom,
      y: localY - worldY * nextZoom,
    };
    client.emit('canvas.camera.preview', next);
    if (zoomCommitTimer.current) clearTimeout(zoomCommitTimer.current);
    zoomCommitTimer.current = setTimeout(() => void client.dispatch('canvas.camera.commit', next), 140);
  }, [client]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      applyWheelZoom(event.clientX, event.clientY, event.deltaY);
    };
    // React delegates wheel events through a passive root listener in some
    // browser builds. Canvas zoom must suppress native page scrolling, so the
    // owning element installs one explicit non-passive listener and cleans it
    // up with the component lifecycle.
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, [applyWheelZoom]);

  useEffect(
    () => client.subscribeSignal<CanvasWheelZoomRequest>('canvas.wheel.requested', (message) => {
      applyWheelZoom(message.payload.clientX, message.payload.clientY, message.payload.deltaY);
    }),
    [applyWheelZoom, client],
  );

  useEffect(
    () =>
      client.subscribeSignal<LassoSignal>('canvas.lasso.preview', (message) => {
        if ('clear' in message.payload) setLassoPreview(undefined);
        else setLassoPreview(message.payload);
      }),
    [client],
  );

  useEffect(() => {
    const unsubscribe = client.subscribeSignal<FocusRequest>('canvas.focus.requested', (message) => {
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
      // A dock reveal and its focus request can land in the same command turn.
      // Wait through layout before measuring so all engines focus against the
      // newly narrowed canvas instead of occasionally using its previous size.
      focusFrame.current = requestAnimationFrame(() => {
        focusFrame.current = requestAnimationFrame(() => {
          focusFrame.current = undefined;
          const surface = surfaceRef.current;
          const rect = surface?.getBoundingClientRect();
          const viewport = surface && rect
            ? { width: surface.clientWidth, height: surface.clientHeight, left: rect.left, top: rect.top }
            : surfaceSizeRef.current;
          surfaceSizeRef.current = viewport;
          const next = cameraForBounds(message.payload.bounds, viewport);
          client.emit('canvas.camera.preview', next);
          void client.dispatch('canvas.camera.commit', next);
        });
      });
    });
    return () => {
      unsubscribe();
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
      focusFrame.current = undefined;
    };
  }, [client]);

  useEffect(
    () => () => {
      if (zoomCommitTimer.current) clearTimeout(zoomCommitTimer.current);
      if (membershipPreviewVisible.current) {
        membershipPreviewVisible.current = false;
        client.emit('group.membership.preview', { clear: true } satisfies GroupMembershipPreview);
      }
      if (lassoPanFrame.current !== undefined) cancelAnimationFrame(lassoPanFrame.current);
    },
    [client],
  );

  useEffect(() => {
    const activeDrag = drag.current;
    if (spacePanActive && activeDrag && !suspendedDragPan.current) {
      suspendedDragPan.current = {
        pointerX: activeDrag.latestClientX,
        pointerY: activeDrag.latestClientY,
        origin: cameraRef.current,
        latest: cameraRef.current,
      };
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      syncGroupMembershipPreview('', 0, 0, false);
      return;
    }
    if (!spacePanActive && suspendedDragPan.current) {
      const suspended = suspendedDragPan.current;
      suspendedDragPan.current = undefined;
      const currentDrag = drag.current;
      if (currentDrag) {
        currentDrag.origins = currentDrag.latest.map((position) => ({ ...position }));
        currentDrag.pointerX = currentDrag.latestClientX;
        currentDrag.pointerY = currentDrag.latestClientY;
      }
      void client.dispatch('canvas.camera.commit', suspended.latest).catch(() => undefined);
    }
  }, [client, spacePanActive, syncGroupMembershipPreview]);

  useEffect(() => {
    const current = drag.current;
    if (current?.moved) {
      syncGroupMembershipPreview(
        current.primaryId,
        current.latestClientX,
        current.latestClientY,
        groupMembershipModifierActive,
      );
      return;
    }
    const pending = pendingDrag.current;
    if (pending && Math.hypot(pending.latestX - pending.startX, pending.latestY - pending.startY) > 2) {
      syncGroupMembershipPreview(
        pending.primaryId,
        pending.latestX,
        pending.latestY,
        groupMembershipModifierActive,
      );
      return;
    }
    syncGroupMembershipPreview('', 0, 0, false);
  }, [groupMembershipModifierActive, syncGroupMembershipPreview]);

  useEffect(() => {
    if (pendingDrag.current) pendingDrag.current.duplicateOnCommit = duplicateModifierActive;
    if (!drag.current) return;
    drag.current.duplicateOnCommit = duplicateModifierActive;
    if (drag.current.moved) {
      client.emit('canvas.drag.preview', {
        positions: drag.current.latest,
        duplicateOrigins: duplicateModifierActive ? drag.current.origins : [],
      } satisfies DragPreview);
    }
  }, [client, duplicateModifierActive]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const panToolActive = tool === 'hand';
  const panReady = spacePanActive || panToolActive;
  const nodeDragPanActive = spacePanActive && nodeDragActive;
  const duplicateOrigins = useMemo(
    () => duplicateModifierActive ? dragOriginPreview : [],
    [dragOriginPreview, duplicateModifierActive],
  );
  const nodeTitlePreview = appearancePreviewTarget(appearancePreview, 'node-title');
  const previewEntities = useMemo(
    () => new Set(nodeTitlePreview?.entityIds ?? []),
    [nodeTitlePreview?.entityIds],
  );
  const canvasPreview = appearancePreviewTarget(appearancePreview, 'canvas-background');
  const renderedCanvasColor = canvasPreview?.color ?? canvasColor;
  const canvasContrastStyle = useMemo(
    () => canvasContrastVariables(renderedCanvasColor),
    [renderedCanvasColor],
  );
  const nodeIndex = useMemo(() => {
    const index = new SpatialHashIndex<ContentSummary>();
    index.rebuild(
      [...geometryById.values()],
      (node) => node.id,
      (node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }),
    );
    return index;
  }, [geometryById]);
  const visibleNodes = useMemo(() => {
    const viewport = worldViewport(camera, surfaceSize, CULL_MARGIN);
    const candidates = new Map(nodeIndex.query(viewport).flatMap((indexed) => {
      const node = nodeById.get(indexed.id);
      return node ? [[node.id, node] as const] : [];
    }));
    for (const id of [...Object.keys(previews), ...Object.keys(resizePreviews)]) {
      const node = nodeById.get(id);
      if (node) candidates.set(id, node);
    }
    return [...candidates.values()].filter((node) => {
      const position = previews[node.id] ?? node;
      const size = resizePreviews[node.id] ?? node;
      return (
        boundsIntersect(viewport, { x: position.x, y: position.y, width: size.width, height: size.height })
      );
    });
  }, [camera, nodeById, nodeIndex, previews, resizePreviews, surfaceSize]);
  const nodeMetricTargets = useMemo(() => {
    if (canvasNodeDetail(camera.zoom) !== 'preview') return [];
    const viewport = worldViewport(camera, surfaceSize, CULL_MARGIN);
    const targets = new Map(visibleNodes.flatMap((node) => {
      const position = previews[node.id] ?? node;
      const size = resizePreviews[node.id] ?? node;
      return boundsIntersect(viewport, {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      }) ? [[node.id, node] as const] : [];
    }));
    for (const origin of duplicateOrigins) {
      const node = nodeById.get(origin.id);
      if (node && boundsIntersect(viewport, {
        x: origin.x,
        y: origin.y,
        width: node.width,
        height: node.height,
      })) targets.set(node.id, node);
    }
    return [...targets.values()];
  }, [camera, duplicateOrigins, nodeById, previews, resizePreviews, surfaceSize, visibleNodes]);
  const nodeMetricKey = nodeMetricTargets
    .map((node) => `${node.id}:${node.revision}`)
    .sort()
    .join('\u0000');

  useEffect(() => {
    if (nodeMetricTargets.length === 0) return;
    const controller = new AbortController();
    const expectedRevisions = new Map(nodeMetricTargets.map((node) => [node.id, node.revision]));
    const frame = globalThis.requestAnimationFrame?.(() => {
      void client.request<ContentMetricsSnapshotV2>('content.metrics@2', {
        nodeIds: [...expectedRevisions.keys()],
      }, controller.signal).then((snapshot) => {
        if (controller.signal.aborted) return;
        setNodeCharacterCounts((current) => {
          const next = new Map(current);
          let changed = false;
          for (const metric of Object.values(snapshot.byNode)) {
            if (expectedRevisions.get(metric.nodeId) !== metric.revision) continue;
            const previous = next.get(metric.nodeId);
            if (previous?.revision === metric.revision &&
              previous.characters === metric.nonWhitespaceGraphemes) continue;
            next.set(metric.nodeId, {
              revision: metric.revision,
              characters: metric.nonWhitespaceGraphemes,
            });
            changed = true;
          }
          return changed ? next : current;
        });
      }).catch(() => undefined);
    }) ?? 0;
    return () => {
      if (frame) globalThis.cancelAnimationFrame?.(frame);
      controller.abort();
    };
    // nodeMetricKey captures the visible node IDs and content revisions without
    // restarting a potentially long scan for camera-only object identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilityVersion, client, nodeMetricKey]);

  const snapPositions = (positions: NodePosition[]): NodePosition[] => {
    const movingIds = new Set(positions.map((position) => position.id));
    const movingGeometry = positions.flatMap((position) => {
      const node = nodeById.get(position.id);
      return node ? [{ ...position, width: node.width, height: node.height }] : [];
    });
    if (movingGeometry.length === 0) {
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      return positions;
    }
    const left = Math.min(...movingGeometry.map((node) => node.x));
    const top = Math.min(...movingGeometry.map((node) => node.y));
    const right = Math.max(...movingGeometry.map((node) => node.x + node.width));
    const bottom = Math.max(...movingGeometry.map((node) => node.y + node.height));
    let snap: SmartSnapResult;
    try {
      snap = client.requestSync<SmartSnapResult>('layout.snap@1', {
        dragged: { x: left, y: top, width: right - left, height: bottom - top },
        movingIds: [...movingIds],
        mode: 'nodes',
        threshold: SNAP_THRESHOLD_PX / Math.max(camera.zoom, 0.28),
      } satisfies SmartSnapRequest);
    } catch {
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      return positions;
    }
    client.emit('canvas.snap.preview', snap.guides.length > 0
      ? { guides: snap.guides } satisfies CanvasSnapPreview
      : { clear: true } satisfies CanvasSnapPreview);
    if (snap.offsetX === 0 && snap.offsetY === 0) return positions;
    return positions.map((position) => ({
      ...position,
      x: position.x + snap.offsetX,
      y: position.y + snap.offsetY,
    }));
  };

  const commitNodeDrag = (
    primaryId: string,
    positions: NodePosition[],
    membershipActive: boolean,
    clientX: number,
    clientY: number,
    duplicateOnCommit = false,
  ) => {
    const moveNormally = () => client.dispatch('node.moveMany', { positions });
    const commit = async () => {
      if (duplicateOnCommit) {
        const origin = dragOriginFor(primaryId, nodes);
        const destination = positions.find((position) => position.id === primaryId);
        if (!origin || !destination) return;
        return client.dispatch('clipboard.duplicateSelectionAt', {
          offset: { x: destination.x - origin.x, y: destination.y - origin.y },
        });
      }
      if (commitReferenceDrop(referenceSourceIds(primaryId, positions), clientX, clientY)) return;
      const surface = surfaceRef.current;
      if (!membershipActive || !surface) return moveNormally();
      const pointer = screenToWorld(clientX, clientY, cameraRef.current, surface);
      let target: GroupDropTarget | undefined;
      try {
        target = await client.request<GroupDropTarget | undefined>(
          'group.dropTarget@1',
          { nodeId: primaryId, pointer } satisfies GroupDropTargetRequest,
        );
      } catch {
        return moveNormally();
      }
      if (!target) return moveNormally();
      return client.dispatch('group.membership.drop', {
        nodeId: primaryId,
        positions,
        pointer,
        target,
      } satisfies GroupMembershipDropRequest);
    };
    void commit().finally(() => {
      clearReferenceDragPreview();
      return client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
    });
  };

  const activateNodeDrag = (request: PendingNodeDrag, ids: string[]) => {
    if (request.cancelled) return;
    const included = new Set(ids);
    const origins = nodes
      .filter((item) => included.has(item.id))
      .map((item) => ({ id: item.id, x: item.x, y: item.y }));
    if (pendingDrag.current === request) pendingDrag.current = undefined;
    if (origins.length === 0) {
      setNodeDragActive(false);
      setDragOriginPreview([]);
      clearReferenceDragPreview();
      void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
      return;
    }
    const dx = (request.latestX - request.startX) / camera.zoom;
    const dy = (request.latestY - request.startY) / camera.zoom;
    const rawLatest = origins.map((origin) => ({ ...origin, x: origin.x + dx, y: origin.y + dy }));
    const moved = Math.abs(dx) + Math.abs(dy) > 2;
    const latest = moved ? snapPositions(rawLatest) : rawLatest;
    if (request.released) {
      setNodeDragActive(false);
      setDragOriginPreview([]);
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      if (moved) {
        commitNodeDrag(
          request.primaryId,
          latest,
          request.membershipActiveOnRelease === true,
          request.latestX,
          request.latestY,
          request.duplicateOnCommit === true,
        );
      } else {
        clearReferenceDragPreview();
        finishNodeClick(request.primaryId, request.selectionMode);
      }
      return;
    }
    drag.current = {
      primaryId: request.primaryId,
      selectionMode: request.selectionMode,
      pointerX: request.startX,
      pointerY: request.startY,
      latestClientX: request.latestX,
      latestClientY: request.latestY,
      origins,
      latest,
      moved,
      duplicateOnCommit: request.duplicateOnCommit,
    };
    setDragOriginPreview(moved ? origins : []);
    if (moved) {
      client.emit('canvas.drag.preview', {
        positions: latest,
        duplicateOrigins: request.duplicateOnCommit ? origins : [],
      } satisfies DragPreview);
      syncReferenceDragPreview(
        referenceSourceIds(request.primaryId, origins),
        request.latestX,
        request.latestY,
      );
      syncGroupMembershipPreview(
        request.primaryId,
        request.latestX,
        request.latestY,
        client.isShortcutPressed('canvas.group-membership-modifier'),
      );
    }
  };

  const beginNodeDrag = (event: ReactPointerEvent<HTMLElement>, node: ContentSummary) => {
    if (event.button !== 0) return;
    if (panReady) return;
    event.preventDefault();
    event.stopPropagation();
    const duplicateOnCommit = event.altKey || duplicateModifierActive;
    const mode = duplicateOnCommit ? 'replace' : modifierMode(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    const request: PendingNodeDrag = {
      primaryId: node.id,
      selectionMode: mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      released: false,
      cancelled: false,
      duplicateOnCommit,
    };
    pendingDrag.current = request;
    setNodeDragActive(true);
    setDragOriginPreview([]);
    void client.dispatch('interaction.begin', { mode: 'dragging-node' }).then(() => {
      void client.request<SelectionResolution>('selection.resolve@1', {
        items: [{ id: node.id, kind: 'text-node' }],
        mode,
        preserveIfSelected: true,
        moveContainedItemsDirectly: true,
      }).then((resolution) => {
        if (request.cancelled) return;
        void client.dispatch('selection.set', { items: resolution.items, mode: 'replace' });
        if (!resolution.expandedIds.includes(node.id)) {
          if (pendingDrag.current === request) pendingDrag.current = undefined;
          setNodeDragActive(false);
          clearReferenceDragPreview();
          void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
          return;
        }
        activateNodeDrag(request, resolution.expandedIds);
      }).catch(() => {
        if (request.cancelled) return;
        const nextSelection = selectionAfterPointer(selectedIds, node.id, mode);
        void client.dispatch('selection.set', { ids: nextSelection, mode: 'replace' });
        if (mode === 'remove' || (mode === 'toggle' && selected.has(node.id))) {
          if (pendingDrag.current === request) pendingDrag.current = undefined;
          setNodeDragActive(false);
          clearReferenceDragPreview();
          void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
          return;
        }
        activateNodeDrag(request, nextSelection);
      });
    }).catch(() => {
      request.cancelled = true;
      if (pendingDrag.current === request) pendingDrag.current = undefined;
      setNodeDragActive(false);
      setDragOriginPreview([]);
      client.emit('canvas.drag.preview', { clear: true });
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      clearReferenceDragPreview();
    });
  };

  const finishNodeClick = (nodeId: string, mode: SelectionMode) => {
    const selection = mode === 'replace'
      ? client.dispatch('selection.set', {
          items: [{ id: nodeId, kind: 'text-node' }],
          mode: 'replace',
        })
      : Promise.resolve();
    void selection.catch(() => undefined).finally(() =>
      client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined));
  };

  const beginSurfaceGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const wantsPan = event.button === 1 || (event.button === 0 && panReady);
    if (!wantsPan && (event.target as HTMLElement).closest('.text-node-card, .connection-edge, .node-resize-handle')) return;
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
    if (wantsPan) {
      event.currentTarget.setPointerCapture(event.pointerId);
      pan.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        origin: camera,
        latest: camera,
      };
      void client.dispatch('interaction.begin', { mode: 'panning' }).catch(() => {
        const active = pan.current;
        if (!active) return;
        pan.current = undefined;
        client.emit('canvas.camera.preview', active.origin);
      });
      return;
    }
    const point = screenToWorld(event.clientX, event.clientY, camera, event.currentTarget);
    pendingLasso.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWorldX: point.x,
      startWorldY: point.y,
      mode: modifierMode(event),
      cameraOrigin: cameraRef.current,
      released: false,
    };
  };

  const scheduleLassoEdgePan = useCallback(() => {
    if (lassoPanFrame.current !== undefined) return;
    const tick = () => {
      lassoPanFrame.current = undefined;
      const session = lasso.current;
      const surface = surfaceRef.current;
      if (!session || !surface) return;
      const rect = surface.getBoundingClientRect();
      const vx = edgePanVelocity(session.latestClientX - rect.left, rect.width);
      const vy = edgePanVelocity(session.latestClientY - rect.top, rect.height);
      if (vx !== 0 || vy !== 0) {
        const current = cameraRef.current;
        const next = { ...current, x: current.x - vx, y: current.y - vy };
        session.cameraMoved = true;
        client.emit('canvas.camera.preview', next);
        const point = screenToWorld(session.latestClientX, session.latestClientY, next, surface);
        session.latestX = point.x;
        session.latestY = point.y;
        client.emit('canvas.lasso.preview', normalizeLasso(session));
      }
      lassoPanFrame.current = requestAnimationFrame(tick);
    };
    lassoPanFrame.current = requestAnimationFrame(tick);
  }, [client]);

  const moveGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pendingSurfaceLasso = pendingLasso.current;
    if (pendingSurfaceLasso?.pointerId === event.pointerId && !pendingSurfaceLasso.released) {
      const distance = Math.hypot(
        event.clientX - pendingSurfaceLasso.startClientX,
        event.clientY - pendingSurfaceLasso.startClientY,
      );
      if (distance <= 3) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const point = screenToWorld(event.clientX, event.clientY, cameraRef.current, event.currentTarget);
      lasso.current = {
        startX: pendingSurfaceLasso.startWorldX,
        startY: pendingSurfaceLasso.startWorldY,
        latestX: point.x,
        latestY: point.y,
        mode: pendingSurfaceLasso.mode,
        latestClientX: event.clientX,
        latestClientY: event.clientY,
        cameraOrigin: pendingSurfaceLasso.cameraOrigin,
        cameraMoved: false,
      };
      pendingLasso.current = undefined;
      client.emit('canvas.lasso.preview', normalizeLasso(lasso.current));
      scheduleLassoEdgePan();
    }
    if (pendingDrag.current?.pointerId === event.pointerId) {
      pendingDrag.current.latestX = event.clientX;
      pendingDrag.current.latestY = event.clientY;
      if (Math.hypot(
        pendingDrag.current.latestX - pendingDrag.current.startX,
        pendingDrag.current.latestY - pendingDrag.current.startY,
      ) > 2) {
        syncReferenceDragPreview(
          [pendingDrag.current.primaryId],
          event.clientX,
          event.clientY,
        );
        syncGroupMembershipPreview(
          pendingDrag.current.primaryId,
          event.clientX,
          event.clientY,
          client.isShortcutPressed('canvas.group-membership-modifier'),
        );
      }
    }
    if (connectionDraft.current) {
      const pointer = screenToWorld(event.clientX, event.clientY, camera, event.currentTarget);
      const session = updateConnectionSession(
        connectionDraft.current,
        pointer,
        event.clientX,
        event.clientY,
        visibleNodes,
        previews,
        resizePreviews,
        camera.zoom,
      );
      connectionDraft.current = session;
      setConnectionTargetId(session.to?.nodeId);
      client.emit('connection.draft.preview', connectionDraftPayload(session));
      return;
    }
    if (resize.current) {
      const rawWidth = clampSize(
        resize.current.originWidth + (event.clientX - resize.current.pointerX) / camera.zoom,
        resize.current.minWidth,
        resize.current.maxWidth,
      );
      const rawHeight = clampSize(
        resize.current.originHeight + (event.clientY - resize.current.pointerY) / camera.zoom,
        resize.current.minHeight,
        resize.current.maxHeight,
      );
      let snapped: SmartResizeSnapResult | undefined;
      try {
        snapped = client.requestSync<SmartResizeSnapResult>('layout.resizeSnap@1', {
          resized: {
            x: resize.current.x,
            y: resize.current.y,
            width: rawWidth,
            height: rawHeight,
          },
          resizingId: resize.current.id,
          threshold: SNAP_THRESHOLD_PX / Math.max(camera.zoom, 0.28),
        } satisfies SmartResizeSnapRequest);
      } catch {
        client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      }
      const snappedWidth = clampSize(
        snapped?.width ?? rawWidth,
        resize.current.minWidth,
        resize.current.maxWidth,
      );
      const snappedHeight = clampSize(
        snapped?.height ?? rawHeight,
        resize.current.minHeight,
        resize.current.maxHeight,
      );
      const guides = snapped?.guides.filter((guide) =>
        guide.orientation === 'vertical'
          ? snappedWidth === snapped.width
          : snappedHeight === snapped.height) ?? [];
      client.emit('canvas.snap.preview', guides.length > 0
        ? { guides } satisfies CanvasSnapPreview
        : { clear: true } satisfies CanvasSnapPreview);
      const next = {
        ...resize.current,
        width: snappedWidth,
        height: snappedHeight,
      };
      resize.current = next;
      client.emit('canvas.node.resize.preview', { id: next.id, width: next.width, height: next.height });
      return;
    }
    if (drag.current) {
      drag.current.latestClientX = event.clientX;
      drag.current.latestClientY = event.clientY;
      if (suspendedDragPan.current) {
        suspendedDragPan.current.latest = {
          ...cameraRef.current,
          x: suspendedDragPan.current.origin.x + event.clientX - suspendedDragPan.current.pointerX,
          y: suspendedDragPan.current.origin.y + event.clientY - suspendedDragPan.current.pointerY,
        };
        client.emit('canvas.camera.preview', suspendedDragPan.current.latest);
        return;
      }
      const dx = (event.clientX - drag.current.pointerX) / camera.zoom;
      const dy = (event.clientY - drag.current.pointerY) / camera.zoom;
      const wasMoved = drag.current.moved;
      drag.current.moved ||= Math.abs(dx) + Math.abs(dy) > 2;
      if (!drag.current.moved) return;
      if (!wasMoved) setDragOriginPreview(drag.current.origins);
      const rawLatest = drag.current.origins.map((origin) => ({
        id: origin.id,
        x: origin.x + dx,
        y: origin.y + dy,
      }));
      drag.current.latest = snapPositions(rawLatest);
      drag.current.duplicateOnCommit = event.altKey || duplicateModifierActive;
      client.emit('canvas.drag.preview', {
        positions: drag.current.latest,
        duplicateOrigins: drag.current.duplicateOnCommit ? drag.current.origins : [],
      } satisfies DragPreview);
      syncReferenceDragPreview(
        referenceSourceIds(drag.current.primaryId, drag.current.origins),
        event.clientX,
        event.clientY,
      );
      syncGroupMembershipPreview(
        drag.current.primaryId,
        event.clientX,
        event.clientY,
        client.isShortcutPressed('canvas.group-membership-modifier'),
      );
      return;
    }
    if (pan.current) {
      pan.current.latest = {
        ...camera,
        x: pan.current.origin.x + event.clientX - pan.current.pointerX,
        y: pan.current.origin.y + event.clientY - pan.current.pointerY,
      };
      client.emit('canvas.camera.preview', pan.current.latest);
      return;
    }
    if (lasso.current) {
      const point = screenToWorld(event.clientX, event.clientY, cameraRef.current, event.currentTarget);
      lasso.current.latestX = point.x;
      lasso.current.latestY = point.y;
      lasso.current.latestClientX = event.clientX;
      lasso.current.latestClientY = event.clientY;
      client.emit('canvas.lasso.preview', normalizeLasso(lasso.current));
      scheduleLassoEdgePan();
      return;
    }
  };

  const commitLassoSelection = useCallback(() => {
    const session = lasso.current;
    if (!session) return;
    const box = normalizeLasso(session);
    const movedCamera = session.cameraMoved;
    lasso.current = undefined;
    externalLassoPointerId.current = undefined;
    if (lassoPanFrame.current !== undefined) {
      cancelAnimationFrame(lassoPanFrame.current);
      lassoPanFrame.current = undefined;
    }
    client.emit('canvas.lasso.preview', { clear: true });
    if (movedCamera) void client.dispatch('canvas.camera.commit', cameraRef.current).catch(() => undefined);
    void client.dispatch('selection.box', box);
  }, [client]);

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pendingLasso.current?.pointerId === event.pointerId) {
      const pending = pendingLasso.current;
      pendingLasso.current = undefined;
      if (pending.mode === 'replace') void client.dispatch('selection.clear');
      return;
    }
    if (connectionDraft.current) {
      const pointer = screenToWorld(event.clientX, event.clientY, camera, event.currentTarget);
      const session = updateConnectionSession(
        connectionDraft.current,
        pointer,
        event.clientX,
        event.clientY,
        visibleNodes,
        previews,
        resizePreviews,
        camera.zoom,
      );
      connectionDraft.current = undefined;
      setConnectionTargetId(undefined);
      client.emit('connection.draft.preview', {});
      if (session.moved && session.to && session.from.nodeId !== session.to.nodeId) {
        void client.dispatch('connection.create', { from: session.from, to: session.to }).catch(() => undefined);
      }
      void client.dispatch('interaction.end', { mode: 'connecting' }).catch(() => undefined);
      return;
    }
    if (pendingDrag.current) {
      pendingDrag.current.latestX = event.clientX;
      pendingDrag.current.latestY = event.clientY;
      pendingDrag.current.duplicateOnCommit = event.altKey || duplicateModifierActive;
      pendingDrag.current.membershipActiveOnRelease =
        client.isShortcutPressed('canvas.group-membership-modifier');
      pendingDrag.current.released = true;
      setNodeDragActive(false);
      setDragOriginPreview([]);
      syncGroupMembershipPreview('', 0, 0, false);
    }
    if (resize.current) {
      const next = resize.current;
      resize.current = undefined;
      client.emit('canvas.node.resize.preview', { clear: true });
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      void client.dispatch('node.resize', {
        id: next.id,
        width: next.width,
        height: next.height,
        expectedRevision: next.expectedRevision,
      }).finally(() => client.dispatch('interaction.end', { mode: 'resizing' }).catch(() => undefined));
    }
    if (drag.current) {
      const current = drag.current;
      current.duplicateOnCommit = event.altKey || duplicateModifierActive;
      drag.current = undefined;
      setNodeDragActive(false);
      setDragOriginPreview([]);
      const suspended = suspendedDragPan.current;
      suspendedDragPan.current = undefined;
      if (suspended) void client.dispatch('canvas.camera.commit', suspended.latest).catch(() => undefined);
      client.emit('canvas.drag.preview', { clear: true });
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      const membershipActive = client.isShortcutPressed('canvas.group-membership-modifier');
      syncGroupMembershipPreview('', 0, 0, false);
      if (current.moved) {
        commitNodeDrag(
          current.primaryId,
          current.latest,
          membershipActive,
          event.clientX,
          event.clientY,
          current.duplicateOnCommit === true,
        );
      } else {
        clearReferenceDragPreview();
        finishNodeClick(current.primaryId, current.selectionMode);
      }
    }
    if (pan.current) {
      const next = pan.current.latest;
      pan.current = undefined;
      void client.dispatch('canvas.camera.commit', next)
        .finally(() => client.dispatch('interaction.end', { mode: 'panning' }).catch(() => undefined));
    }
    if (lasso.current) {
      commitLassoSelection();
    }
  };

  const cancelGesture = () => {
    const cancelledPendingDrag = pendingDrag.current;
    if (cancelledPendingDrag) cancelledPendingDrag.cancelled = true;
    pendingDrag.current = undefined;
    const cancelledDrag = drag.current;
    const cancelledPan = pan.current;
    drag.current = undefined;
    setNodeDragActive(false);
    setDragOriginPreview([]);
    pan.current = undefined;
    pendingLasso.current = undefined;
    lasso.current = undefined;
    externalLassoPointerId.current = undefined;
    suspendedDragPan.current = undefined;
    if (lassoPanFrame.current !== undefined) {
      cancelAnimationFrame(lassoPanFrame.current);
      lassoPanFrame.current = undefined;
    }
    const cancelledResize = resize.current;
    resize.current = undefined;
    const cancelledConnection = connectionDraft.current;
    connectionDraft.current = undefined;
    setConnectionTargetId(undefined);
    client.emit('canvas.drag.preview', { clear: true });
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
    clearReferenceDragPreview();
    syncGroupMembershipPreview('', 0, 0, false);
    client.emit('canvas.lasso.preview', { clear: true });
    client.emit('canvas.node.resize.preview', { clear: true });
    client.emit('connection.draft.preview', {});
    if (cancelledPan) {
      client.emit('canvas.camera.preview', cancelledPan.origin);
      void client.dispatch('interaction.end', { mode: 'panning' }).catch(() => undefined);
    }
    if (cancelledResize) void client.dispatch('interaction.end', { mode: 'resizing' }).catch(() => undefined);
    if (cancelledConnection) {
      void client.dispatch('interaction.end', { mode: 'connecting' }).catch(() => undefined);
    }
    if (cancelledPendingDrag || cancelledDrag) {
      void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
    }
  };

  const handleConnectionPort = (
    event: ReactPointerEvent<HTMLButtonElement>,
    node: ContentSummary,
    side: ConnectionSide,
  ) => {
    if (event.button !== 0 || panReady) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointer = connectionPortPoint(node, side, previews, resizePreviews);
    const session: ConnectionSession = {
      from: { nodeId: node.id, side },
      pointer,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    connectionDraft.current = session;
    setConnectionTargetId(undefined);
    client.emit('connection.draft.preview', connectionDraftPayload(session));
    void client.dispatch('interaction.begin', { mode: 'connecting' }).catch(() => {
      if (connectionDraft.current?.pointerId !== session.pointerId) return;
      connectionDraft.current = undefined;
      setConnectionTargetId(undefined);
      client.emit('connection.draft.preview', {});
    });
  };

  const beginNodeResize = (event: ReactPointerEvent<HTMLButtonElement>, node: ContentSummary) => {
    if (event.button !== 0 || panReady) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    void client.dispatch('selection.set', { ids: [node.id], mode: 'replace' });
    resize.current = {
      id: node.id,
      x: node.x,
      y: node.y,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      originWidth: node.width,
      originHeight: node.height,
      minWidth: node.resizeLimits?.minWidth ?? MIN_NODE_WIDTH,
      maxWidth: node.resizeLimits?.maxWidth ?? MAX_NODE_WIDTH,
      minHeight: node.resizeLimits?.minHeight ?? MIN_NODE_HEIGHT,
      maxHeight: node.resizeLimits?.maxHeight ?? MAX_NODE_HEIGHT,
      width: node.width,
      height: node.height,
      expectedRevision: node.nodeRevision,
    };
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
    client.emit('canvas.node.resize.preview', { id: node.id, width: node.width, height: node.height });
    void client.dispatch('interaction.begin', { mode: 'resizing' }).catch(() => {
      resize.current = undefined;
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      client.emit('canvas.node.resize.preview', { clear: true });
    });
  };

  const importDroppedDocuments = (event: ReactDragEvent<HTMLDivElement>) => {
    const materialized = event.dataTransfer.getData(ECHO8_CONTENT_DRAG_TYPE);
    if (materialized) {
      try {
        const source = JSON.parse(materialized) as { sourceId?: unknown; title?: unknown };
        if (typeof source.sourceId === 'string') {
          event.preventDefault();
          event.stopPropagation();
          setCanvasDropHint(undefined);
          const point = screenToWorld(event.clientX, event.clientY, cameraRef.current, event.currentTarget);
          void client.dispatch('content.materializeCopy', {
            sourceId: source.sourceId,
            title: typeof source.title === 'string' ? source.title : undefined,
            x: point.x - 140,
            y: point.y - 79,
          }).catch(() => undefined);
          return;
        }
      } catch {
        // Ignore malformed foreign drag data and continue with ordinary files.
      }
    }
    const droppedFiles = Array.from(event.dataTransfer.files);
    const projectFile = droppedFiles.find(isEcho8ProjectFile);
    setCanvasDropHint(undefined);
    if (projectFile && projectOpenAvailable) {
      event.preventDefault();
      event.stopPropagation();
      void client.dispatch('file.openProject', { file: projectFile }).catch(() => undefined);
      return;
    }
    const files = droppedFiles.filter(isSupportedDocumentDrop).slice(0, 20);
    if (files.length > 0 && importAvailable) {
      event.preventDefault();
      event.stopPropagation();
      const point = screenToWorld(event.clientX, event.clientY, camera, event.currentTarget);
      void client.dispatch('file.importDocuments', { files, x: point.x, y: point.y }).catch(() => undefined);
      return;
    }
    const plainText = normalizeDroppedText(event.dataTransfer.getData('text/plain'));
    if (!plainText) return;
    event.preventDefault();
    event.stopPropagation();
    const point = screenToWorld(event.clientX, event.clientY, cameraRef.current, event.currentTarget);
    void client.dispatch('node.create', {
      title: droppedTextTitle(plainText),
      body: plainText,
      x: point.x - 140,
      y: point.y - 79,
    }).catch(() => undefined);
  };

  const publishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    client.emit('canvas.pointer.preview', {
      point: clientPointInWorld(
        cameraRef.current,
        surface.getBoundingClientRect(),
        { x: event.clientX, y: event.clientY },
      ),
    } satisfies CanvasPointerSnapshot);
  };

  useEffect(() => {
    const unsubscribeStart = client.subscribeSignal<CanvasExternalLassoStartRequest>(
      'canvas.lasso.external.requested',
      (message) => {
        const payload = message.payload;
        const surface = surfaceRef.current;
        if (!surface || lasso.current || pan.current || drag.current || resize.current || connectionDraft.current) return;
        const start = screenToWorld(payload.startClientX, payload.startClientY, cameraRef.current, surface);
        const latest = screenToWorld(payload.clientX, payload.clientY, cameraRef.current, surface);
        pendingLasso.current = undefined;
        lasso.current = {
          startX: start.x,
          startY: start.y,
          latestX: latest.x,
          latestY: latest.y,
          mode: payload.mode,
          latestClientX: payload.clientX,
          latestClientY: payload.clientY,
          cameraOrigin: cameraRef.current,
          cameraMoved: false,
        };
        externalLassoPointerId.current = payload.pointerId;
        surface.focus({ preventScroll: true });
        try {
          surface.setPointerCapture(payload.pointerId);
        } catch {
          // A very short drag may have released before the coalesced request arrives.
        }
        client.emit('canvas.lasso.preview', normalizeLasso(lasso.current));
        scheduleLassoEdgePan();
      },
    );
    const unsubscribePreview = client.subscribeSignal<CanvasExternalLassoPointerRequest>(
      'canvas.lasso.external.preview',
      (message) => {
        const payload = message.payload;
        const surface = surfaceRef.current;
        const session = lasso.current;
        if (!surface || !session || externalLassoPointerId.current !== payload.pointerId) return;
        const point = screenToWorld(payload.clientX, payload.clientY, cameraRef.current, surface);
        session.latestX = point.x;
        session.latestY = point.y;
        session.latestClientX = payload.clientX;
        session.latestClientY = payload.clientY;
        client.emit('canvas.lasso.preview', normalizeLasso(session));
        scheduleLassoEdgePan();
      },
    );
    const unsubscribeFinish = client.subscribeSignal<CanvasExternalLassoPointerRequest>(
      'canvas.lasso.external.finished',
      (message) => {
        const payload = message.payload;
        if (externalLassoPointerId.current !== payload.pointerId) return;
        if (payload.cancel) {
          lasso.current = undefined;
          externalLassoPointerId.current = undefined;
          client.emit('canvas.lasso.preview', { clear: true });
          return;
        }
        const surface = surfaceRef.current;
        const session = lasso.current;
        if (surface && session) {
          const point = screenToWorld(payload.clientX, payload.clientY, cameraRef.current, surface);
          session.latestX = point.x;
          session.latestY = point.y;
          session.latestClientX = payload.clientX;
          session.latestClientY = payload.clientY;
        }
        commitLassoSelection();
      },
    );
    return () => {
      unsubscribeStart();
      unsubscribePreview();
      unsubscribeFinish();
    };
  }, [client, commitLassoSelection, scheduleLassoEdgePan]);

  return (
    <div
      ref={surfaceRef}
      className={`canvas-surface ${panReady ? 'space-pan-ready' : ''} ${nodeDragPanActive ? 'node-drag-pan-active' : ''}`}
      style={{
        '--document-canvas-background': renderedCanvasColor,
        ...canvasContrastStyle,
      } as CSSProperties}
      onPointerDown={beginSurfaceGesture}
      onPointerEnter={publishPointer}
      onPointerMove={(event) => {
        publishPointer(event);
        moveGesture(event);
      }}
      onPointerUpCapture={(event) => {
        if (pendingLasso.current?.pointerId === event.pointerId) pendingLasso.current.released = true;
      }}
      onPointerLeave={() => client.emit('canvas.pointer.preview', { clear: true } satisfies CanvasPointerSnapshot)}
      onPointerUp={finishGesture}
      onPointerCancel={cancelGesture}
      onDragEnter={(event) => {
        const carriesContent = event.dataTransfer.types.includes(ECHO8_CONTENT_DRAG_TYPE);
        const carriesFiles = (importAvailable || projectOpenAvailable) && event.dataTransfer.types.includes('Files');
        const carriesText = event.dataTransfer.types.includes('text/plain');
        if (!carriesContent && !carriesFiles && !carriesText) return;
        event.preventDefault();
        setCanvasDropHint(carriesContent ? undefined : carriesFiles ? 'documents' : 'text');
      }}
      onDragOver={(event) => {
        const carriesContent = event.dataTransfer.types.includes(ECHO8_CONTENT_DRAG_TYPE);
        const carriesFiles = (importAvailable || projectOpenAvailable) && event.dataTransfer.types.includes('Files');
        const carriesText = event.dataTransfer.types.includes('text/plain');
        if (!carriesContent && !carriesFiles && !carriesText) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setCanvasDropHint(undefined);
      }}
      onDrop={importDroppedDocuments}
      tabIndex={-1}
      aria-label="Echo-8 无限画布"
    >
      {canvasDropHint && (
        <div className="canvas-document-drop-hint" aria-hidden="true">
          <IconButton
            icon={canvasDropHint === 'text' ? 'text' : 'echo-file'}
            label={canvasDropHint === 'text'
              ? '松开以创建继承所选文字的文本节点'
              : '松开以打开 Echo-8 书籍，或导入 TXT、Word DOCX'}
            tabIndex={-1}
          />
        </div>
      )}
      {panReady && <div className="canvas-pan-shield" aria-hidden="true" />}
      {unavailable && (
        <div className="canvas-unavailable">
          <strong>内容渲染器未启用</strong>
          <span>画布仍在运行，已有内容数据不会被删除。</span>
        </div>
      )}
      {!unavailable && nodes.length === 0 ? renderSlot?.('canvas.empty') : null}
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        data-canvas-selection-count={selectedIds.length}
      >
        已选择 {selectedIds.length.toLocaleString()} 个画布项目
      </span>
      <CanvasEntityLayerProvider value={{
        camera,
        canvasColor: renderedCanvasColor,
        nodeById,
        duplicateOrigins,
        visibleNodes,
        previews,
        resizePreviews,
        appearancePreview,
        previewEntities,
        nodeCharacterCounts,
        selected,
        connectionTargetId,
        beginNodeDrag,
        handleConnectionPort,
        beginNodeResize,
      }}>
        {renderSlot?.('canvas.entities')}
      </CanvasEntityLayerProvider>
      {snapGuides.map((guide, index) => (
        <div
          className={`canvas-snap-guide ${guide.orientation} ${guide.kind}`}
          key={`${guide.orientation}:${guide.kind}:${guide.position}:${guide.start}:${index}`}
          style={guide.orientation === 'vertical'
            ? {
                left: camera.x + guide.position * camera.zoom,
                top: camera.y + guide.start * camera.zoom,
                height: Math.max(1, (guide.end - guide.start) * camera.zoom),
              }
            : {
                left: camera.x + guide.start * camera.zoom,
                top: camera.y + guide.position * camera.zoom,
                width: Math.max(1, (guide.end - guide.start) * camera.zoom),
              }}
          aria-hidden="true"
        />
      ))}
      {lassoPreview && (
        <div
          className="selection-lasso"
          style={{
            left: camera.x + lassoPreview.x * camera.zoom,
            top: camera.y + lassoPreview.y * camera.zoom,
            width: lassoPreview.width * camera.zoom,
            height: lassoPreview.height * camera.zoom,
          }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
