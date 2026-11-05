'use client';

import {
  Fragment,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createId, type ViewClient } from '../../core/contracts.ts';
import { SpatialHashIndex } from '../../services/spatial-index.ts';
import { appearancePreviewTarget, type AppearancePreview } from '../../protocols/appearance.ts';
import type {
  CanvasExternalLassoPointerRequest,
  CanvasExternalLassoStartRequest,
  CanvasWheelZoomRequest,
} from '../../protocols/canvas.ts';
import {
  isTitleConnection,
  MAX_CONNECTION_LABEL_LENGTH,
  normalizeConnectionLabelSize,
  type ConnectionAppearanceSnapshot,
  type ConnectionDraft,
  type ConnectionRecord,
  type ConnectionJunction,
  type ConnectionGraphSnapshot,
  type ConnectionJunctionPreview,
  type ConnectionNodeGeometry,
} from '../../protocols/connections.ts';
import { connectionGraphPoints, connectionStrokeForEndpoints } from './routing.ts';
import { createConnectionScenePlanner } from './connection-scene.ts';
import type { GroupMembershipPreview } from '../../protocols/groups.ts';
import { ConnectionJunctionMarkers } from './ConnectionJunctionMarkers.tsx';
import { overviewNetwork } from './overview-network.ts';
import { OVERLAP_CLICK_SLOP, OverlapCycle } from './overlap-cycle.ts';
import { OverlapHint, type OverlapHintState } from './OverlapHint.tsx';
import { junctionGeometry, logicalConnectionPaths } from './junctions.ts';
import type { SelectionMode } from '../../protocols/selection.ts';
import { boundsIntersect, worldViewport } from '../../protocols/viewport.ts';
import { useConnectionGesture } from '../../ui/use-connection-gesture.ts';
import { useConnectionTargets } from '../../ui/use-connection-targets.ts';
import { useCanvasLayerEnvironment } from '../../ui/use-canvas-layer-environment.ts';
import { Icon } from '../../ui/Icon.tsx';
import {
  canvasContrastColors,
  canvasContrastVariables,
  ensureCanvasColorContrast,
} from '../../ui/canvas-contrast.ts';
import { canvasDetailWorldScale } from '../../ui/canvas-screen-scale.ts';
import {
  connectionCurveBounds,
  connectionCurveMidpoint,
  connectionCurvePath,
  connectionOverviewMode,
  connectionRenderMode,
  connectionVisibleForOverview,
  CONNECTION_LINE_SCREEN_WIDTH,
  CONNECTION_HIGHLIGHT_SCREEN_WIDTH,
  distanceToConnectionCurve,
  orderConnectionsForPaint,
  type ConnectionRenderPoint,
} from './rendering.ts';

const CULL_MARGIN = 360;
const CONNECTION_HOVER_TOLERANCE_PX = 12;
const CONNECTION_CLICK_TOLERANCE_PX = 5;

interface DrawableConnection {
  connection: ConnectionRecord;
  from: ConnectionRenderPoint;
  to: ConnectionRenderPoint;
  midpoint?: ConnectionRenderPoint;
  curvePath: string;
  shaftPath: string;
  arrowPath: string;
  arrowEnd?: 'from' | 'to';
}

interface ConnectionLabelEditorState {
  id: string;
  value: string;
  expectedRevision: number;
}

interface ConnectionLabelResizePreview {
  id?: string;
  width?: number;
  height?: number;
  clear?: boolean;
}

interface ConnectionLabelResizeSession {
  token: string;
  id: string;
  pointerId: number;
  pointerX: number;
  pointerY: number;
  originWidth: number;
  originHeight: number;
  width: number;
  height: number;
  expectedRevision: number;
}

interface PendingConnectionSelection {
  id: string;
  part: 'line' | 'label-background' | 'label-text';
  mode: SelectionMode;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  lassoRequested: boolean;
  cycle?: { ids: string[]; signature: string };
}

interface PendingConnectionBackground {
  mode: SelectionMode;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  lassoRequested: boolean;
}

export function ConnectionLayer({ client }: { client: ViewClient }) {
  const {
    capabilityVersion,
    nodeById,
    camera,
    previews,
    duplicateOriginIds,
    sizePreviews,
    selectedIds,
    lassoActive,
    canvasColor,
    surfaceSize,
    layerRef,
  } = useCanvasLayerEnvironment<SVGSVGElement>(client);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [junctions, setJunctions] = useState<ConnectionJunction[]>([]);
  const [junctionPreview, setJunctionPreview] = useState<Record<string, { x: number; y: number }>>({});
  const [membershipPreview, setMembershipPreview] = useState<GroupMembershipPreview>();
  useEffect(() => client.subscribeSignal<GroupMembershipPreview>('group.membership.preview', message => setMembershipPreview(message.payload)), [client]);
  const [connectionAppearance, setConnectionAppearance] = useState<ConnectionAppearanceSnapshot>({ revision: 0 });
  const [appearancePreview, setAppearancePreview] = useState<AppearancePreview>();
  const [draft, setDraft] = useState<ConnectionDraft>({});
  const [hoveredId, setHoveredId] = useState<string>();
  const [labelEditor, setLabelEditor] = useState<ConnectionLabelEditorState>();
  const [labelResizePreview, setLabelResizePreview] = useState<ConnectionLabelResizePreview>();
  const labelInputRef = useRef<HTMLTextAreaElement>(null);
  const labelResize = useRef<ConnectionLabelResizeSession | undefined>(undefined);
  useEffect(() => () => {
    const session = labelResize.current;
    labelResize.current = undefined;
    if (session) {
      client.emit('connection.label.resize.preview', { clear: true });
      void client.dispatch('interaction.end', { mode: 'resizing', sessionId: session.token }).catch(() => undefined);
    }
  }, [client]);
  const pendingSelection = useRef<PendingConnectionSelection | undefined>(undefined);
  const lineCycle = useRef(new OverlapCycle());
  const [overlapHint, setOverlapHint] = useState<OverlapHintState>();
  const viewKey = `${camera.x}:${camera.y}:${camera.zoom}`;
  useEffect(() => client.subscribeSignal('canvas.camera.preview', () => { lineCycle.current.reset(); setOverlapHint(undefined); }), [client]);
  const pendingBackground = useRef<PendingConnectionBackground | undefined>(undefined);
  const skipBlurCommitRef = useRef(false);

  useEffect(() => {
    let current = true;
    void client.request<ConnectionGraphSnapshot>('connections.graph@1').then((graph) => {
      if (!current) return;
      setConnections(graph.connections);
      setJunctions(graph.junctions);
      setDraft(current => current.reconnectId && graph.connections.find(edge => edge.id === current.reconnectId)?.revision !== current.reconnectRevision ? {} : current);
    }).catch(() => {
      if (!current) return;
      setConnections([]);
    });
    return () => {
      current = false;
    };
  }, [capabilityVersion, client]);

  useEffect(
    () => client.subscribeSignal('connections.invalidated', () => {
      void client.request<ConnectionGraphSnapshot>('connections.graph@1')
        .then((graph) => {
          setConnections(graph.connections); setJunctions(graph.junctions);
          setDraft(current => current.reconnectId && graph.connections.find(edge => edge.id === current.reconnectId)?.revision !== current.reconnectRevision ? {} : current);
        })
        .catch(() => setConnections([]));
    }),
    [client],
  );

  useEffect(() => {
    let current = true;
    void client.request<ConnectionAppearanceSnapshot>('connections.appearance@1')
      .then((appearance) => current && setConnectionAppearance(appearance))
      .catch(() => current && setConnectionAppearance({ revision: 0 }));
    return () => {
      current = false;
    };
  }, [capabilityVersion, client]);

  useEffect(
    () => client.subscribeSignal('connections.appearance.invalidated', () => {
      void client.request<ConnectionAppearanceSnapshot>('connections.appearance@1')
        .then(setConnectionAppearance)
        .catch(() => setConnectionAppearance({ revision: 0 }));
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<AppearancePreview>('appearance.color.preview', (message) => {
      const preview = message.payload;
      setAppearancePreview(preview.clear ? undefined : preview);
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<ConnectionDraft>('connection.draft.preview', (message) => setDraft(message.payload)),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<ConnectionLabelResizePreview>(
      'connection.label.resize.preview',
      (message) => {
        const preview = message.payload;
        if (preview.clear || !preview.id || preview.width === undefined || preview.height === undefined) {
          setLabelResizePreview(undefined);
          return;
        }
        setLabelResizePreview(preview);
      },
    ),
    [client],
  );

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const forwardWheelZoom = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      client.emit('canvas.wheel.requested', {
        clientX: event.clientX,
        clientY: event.clientY,
        deltaY: event.deltaY,
      } satisfies CanvasWheelZoomRequest);
    };
    layer.addEventListener('wheel', forwardWheelZoom, { passive: false });
    return () => layer.removeEventListener('wheel', forwardWheelZoom);
  }, [client, layerRef]);

  useEffect(() => client.subscribeSignal<ConnectionJunctionPreview>('connection.junction.preview', (message) => {
    const payload = message.payload;
    setJunctionPreview('clear' in payload ? {} : Object.fromEntries(('positions' in payload ? payload.positions : [payload]).map(point => [point.id, { x: point.x, y: point.y }])));
  }), [client]);

  const stableTargets = useConnectionTargets(client, nodeById);
  const stableNodeMap = useMemo(
    () => new Map<string, ConnectionNodeGeometry>([...nodeById, ...stableTargets.map(target => [target.id, target] as const),
      ...junctions.map((point): [string, ConnectionNodeGeometry] => [point.id, { ...junctionGeometry(point), kind: 'junction' }])]),
    [junctions, nodeById, stableTargets],
  );
  const previewNodes = useMemo(() => new Map([...nodeById].map(([id, node]) => [id,
    { ...node, ...(duplicateOriginIds.has(id) ? {} : previews[id]), ...sizePreviews[id] } ])),
  [duplicateOriginIds, nodeById, previews, sizePreviews]);
  const liveTargets = useConnectionTargets(client, previewNodes, membershipPreview && !('clear' in membershipPreview) && membershipPreview.active ? membershipPreview : undefined);
  const liveJunctions = useMemo(() => junctions.map(point => ({ ...point, ...(duplicateOriginIds.has(point.id) ? {} : previews[point.id]), ...junctionPreview[point.id] })), [junctions, junctionPreview, previews, duplicateOriginIds]);
  const nodeMap = useMemo(() => new Map<string, ConnectionNodeGeometry>([...previewNodes, ...liveTargets.map(target => [target.id, target] as const),
    ...liveJunctions.map((point): [string, ConnectionNodeGeometry] => [point.id, { ...junctionGeometry(point), kind: 'junction' }])]),
  [liveJunctions, liveTargets, previewNodes]);
  const reconnect = useConnectionGesture(client, camera, nodeMap);
  const stablePoints = useMemo(() => connectionGraphPoints(connections, stableNodeMap), [connections, stableNodeMap]);
  const scenePlanner = useMemo(() => createConnectionScenePlanner(), []);
  const scene = useMemo(() => scenePlanner(connections, nodeMap, draft), [connections, nodeMap, draft, scenePlanner]);
  const livePoints = scene.points;
  const connectionLookup = useMemo(() => {
    const byId = new Map<string, ConnectionRecord>();
    const byNode = new Map<string, Set<string>>();
    for (const connection of connections) {
      byId.set(connection.id, connection);
      for (const nodeId of [connection.from.nodeId, connection.to.nodeId]) {
        const ids = byNode.get(nodeId) ?? new Set<string>();
        ids.add(connection.id);
        byNode.set(nodeId, ids);
      }
    }
    return { byId, byNode };
  }, [connections]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const titleRouteIds = useMemo(() => {
    const ids = new Set(connections.filter(isTitleConnection).map((edge) => edge.id));
    for (const route of logicalConnectionPaths(connections)) if (isTitleConnection(route.record)) {
      for (const edge of route.path) ids.add(edge.id);
    }
    return ids;
  }, [connections]);
  const isTitleRoute = (connection: ConnectionRecord) => connection.id === draft.reconnectId
    ? Boolean(draft.titleRoute || draft.from?.side === 'title' || draft.to?.side === 'title')
    : titleRouteIds.has(connection.id);
  const titleJunctionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of connections) if (titleRouteIds.has(edge.id)) {
      if (edge.from.kind === 'junction') ids.add(edge.from.nodeId);
      if (edge.to.kind === 'junction') ids.add(edge.to.nodeId);
    }
    return ids;
  }, [connections, titleRouteIds]);
  const junctionIndex = useMemo(() => {
    const index = new SpatialHashIndex<ConnectionJunction>();
    index.rebuild(liveJunctions, (point) => point.id, (point) => ({ x: point.x - 12, y: point.y - 12, width: 24, height: 24 }));
    return index;
  }, [liveJunctions]);
  const visibleJunctions = useMemo(() => {
    const candidates = new Map(junctionIndex.query(worldViewport(camera, surfaceSize, CULL_MARGIN)).map((point) => [point.id, point]));
    return [...candidates.values()];
  }, [camera, junctionIndex, surfaceSize]);
  const editingConnectionId = labelEditor?.id;
  const overviewMode = connectionOverviewMode(camera.zoom);
  const selectedAnchors = useMemo(() => [...selected].filter(id => stableNodeMap.has(id) && stableNodeMap.get(id)?.kind !== 'junction'), [selected, stableNodeMap]);
  const anchorKey = selectedAnchors.join('\u0000');
  const [overviewSelection, setOverviewSelection] = useState({ selected, anchorKey, anchors: selectedAnchors });
  const contextAnchors = useMemo(() => selectedAnchors.length ? selectedAnchors : selected.size ? overviewSelection.anchors : [], [selectedAnchors, selected.size, overviewSelection.anchors]);
  if (overviewSelection.selected !== selected || overviewSelection.anchorKey !== anchorKey) setOverviewSelection({ selected, anchorKey, anchors: contextAnchors });
  const overviewContext = useMemo(() => {
    const network = overviewNetwork(selectedAnchors.length ? selectedAnchors : contextAnchors, connectionLookup.byNode, connectionLookup.byId);
    if (selectedAnchors.length || [...selected].some(id => network.edges.has(id) || network.points.has(id))) return network;
    return overviewNetwork([], connectionLookup.byNode, connectionLookup.byId);
  }, [selectedAnchors, contextAnchors, selected, connectionLookup]);
  const focusedNodeIds = overviewContext.nodes, emphasizedConnectionIds = overviewContext.edges;
  const connectionIndex = useMemo(() => {
    const index = new SpatialHashIndex<ConnectionRecord>();
    index.rebuild(
      connections.filter((connection) => Boolean(stablePoints.get(connection.id))),
      (connection) => connection.id,
      (connection) => {
        const points = stablePoints.get(connection.id)!;
        return connectionBounds(points.from, points.to);
      },
    );
    return index;
  }, [connections, stablePoints]);
  const previewAffectedIds = useMemo(() => {
    const ids = new Set<string>();
    const movedTargets = liveTargets.filter(target => { const stable = stableNodeMap.get(target.id); return !stable || target.x !== stable.x || target.y !== stable.y || target.width !== stable.width || target.height !== stable.height; }).map(target => target.id);
    const moving = [...movedTargets, ...Object.keys(previews), ...Object.keys(sizePreviews), ...liveJunctions.filter(point => {
      const stable = stableNodeMap.get(point.id); return stable?.x !== point.x || stable.y !== point.y;
    }).map(point => point.id), ...[draft.from, draft.to, ...(draft.reconnectId ? [connectionLookup.byId.get(draft.reconnectId)?.from, connectionLookup.byId.get(draft.reconnectId)?.to] : [])]
      .filter(endpoint => endpoint?.kind === 'junction').map(endpoint => endpoint!.nodeId)];
    for (const nodeId of moving) for (const edgeId of connectionLookup.byNode.get(nodeId) ?? []) {
      ids.add(edgeId);
      const edge = connectionLookup.byId.get(edgeId)!;
      for (const endpoint of [edge.from, edge.to]) if (endpoint.kind === 'junction') {
        for (const related of connectionLookup.byNode.get(endpoint.nodeId) ?? []) ids.add(related);
      }
    }
    return ids;
  }, [connectionLookup, liveJunctions, liveTargets, previews, sizePreviews, stableNodeMap, draft.from, draft.to, draft.reconnectId]);
  const drawable = useMemo(() => {
    if (overviewMode && focusedNodeIds.size === 0 && emphasizedConnectionIds.size === 0) return [];
    const viewport = worldViewport(camera, surfaceSize, CULL_MARGIN);
    const candidates = new Map(connectionIndex.query(viewport).map((connection) => [connection.id, connection]));
    for (const id of previewAffectedIds) {
      const connection = connectionLookup.byId.get(id);
      if (connection) candidates.set(id, connection);
    }
    return [...candidates.values()].filter((connection) => {
      if (overviewMode && !connectionVisibleForOverview(
        connection,
        focusedNodeIds,
        emphasizedConnectionIds,
      )) return false;
      const points = livePoints.get(connection.id);
      return Boolean(points && boundsIntersect(viewport, connectionBounds(points.from, points.to)));
    });
  }, [
    camera,
    connectionIndex,
    connectionLookup,
    emphasizedConnectionIds,
    focusedNodeIds,
    livePoints,
    overviewMode,
    previewAffectedIds,
    surfaceSize,
  ]);
  const draftGeometry = scene.draft ? connectionStrokeForEndpoints(scene.draft.record, scene.draft.points, camera.zoom) : undefined;
  const renderableConnections = drawable;
  const committedGeometry = useMemo<DrawableConnection[]>(() => renderableConnections.flatMap((connection) => {
    const points = livePoints.get(connection.id);
    return points ? [{
      connection,
      ...points,
      midpoint: connection.label || connection.id === editingConnectionId
        ? connectionCurveMidpoint(points.from, points.to)
        : undefined,
      curvePath: connectionCurvePath(points.from, points.to),
      ...connectionStrokeForEndpoints({ ...connection, titleRoute: titleRouteIds.has(connection.id) }, points, camera.zoom),
    }] : [];
  }), [camera.zoom, editingConnectionId, livePoints, renderableConnections, titleRouteIds]);
  const reconnectGeometry = useMemo<DrawableConnection | undefined>(() => {
    const connection = draft.reconnectId ? connectionLookup.byId.get(draft.reconnectId) : undefined;
    if (!connection || !scene.draft || !draftGeometry) return undefined;
    const { from, to } = scene.draft.points;
    return { connection, from, to, midpoint: connectionCurveMidpoint(from, to), curvePath: connectionCurvePath(from, to), ...draftGeometry };
  }, [connectionLookup.byId, draft.reconnectId, draftGeometry, scene.draft]);
  const drawableGeometry = useMemo(() => reconnectGeometry
    ? [...committedGeometry.filter(item => item.connection.id !== reconnectGeometry.connection.id), reconnectGeometry]
    : committedGeometry, [committedGeometry, reconnectGeometry]);
  const beginArrowReconnect = (event: ReactPointerEvent<SVGPathElement>, connection: ConnectionRecord, end: 'from' | 'to' = 'to') => {
    const fixed = end === 'from' ? connection.to : connection.from;
    const node = nodeMap.get(fixed.nodeId);
    if (!node) return;
    const fixedPoint = livePoints.get(connection.id)?.[end === 'from' ? 'to' : 'from'];
    const startSide = fixedPoint?.side === 'left' || fixedPoint?.side === 'right' ? fixedPoint.side : undefined;
    reconnect.begin(event, node, isTitleRoute(connection), fixed.side, { startSide, id: connection.id, expectedRevision: connection.revision, end,
      ...(end === 'to' && !fixed.kind ? { titleOrigin: connection.titleOrigin } : {}) });
  };
  const renderedConnectionIds = useMemo(
    () => new Set(renderableConnections.map((connection) => connection.id)),
    [renderableConnections],
  );
  const paintedJunctions = useMemo(() => overviewMode ? visibleJunctions.filter(point => overviewContext.points.has(point.id)) : visibleJunctions,
  [overviewContext.points, overviewMode, visibleJunctions]);
  const paintedPointIds = useMemo(() => new Set(paintedJunctions.map(point => point.id)), [paintedJunctions]);
  const hitJunctions = (x: number, y: number, radius: number) => junctionIndex.query({ x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 })
    .filter(point => paintedPointIds.has(point.id) && Math.hypot(point.x - x, point.y - y) <= radius);
  const renderMode = connectionRenderMode(drawableGeometry.length);
  const batchRendered = renderMode === 'batched-svg';
  const paintOrderedGeometry = useMemo(
    () => orderConnectionsForPaint(drawableGeometry, selected),
    [drawableGeometry, selected],
  );
  const linePreview = useMemo(
    () => appearancePreviewTarget(appearancePreview, 'connection-line'),
    [appearancePreview],
  );
  const labelTextPreview = appearancePreviewTarget(appearancePreview, 'connection-label-text');
  const junctionPreviewColor = appearancePreviewTarget(appearancePreview, 'connection-junction');
  const junctionColor = junctionPreviewColor?.color ?? connectionAppearance.junctionColor;
  const globalLinePreview = linePreview?.entityIds.includes('line')
    ? linePreview.color
    : undefined;
  const globalConnectionSourceColor = globalLinePreview ?? connectionAppearance.color;
  const globalConnectionLineColor = globalConnectionSourceColor
    ? ensureCanvasColorContrast(globalConnectionSourceColor, canvasColor)
    : canvasContrastColors(canvasColor).line;
  const previewIds = useMemo(
    () => new Set(linePreview?.entityIds ?? []),
    [linePreview],
  );
  const lineColorFor = (connection: ConnectionRecord) => {
    const localPreview = previewIds.has(connection.id)
      ? linePreview?.color
      : undefined;
    const localSource = localPreview ?? connection.lineColor;
    return localSource ?? globalConnectionLineColor;
  };
  const batchedPaths = useMemo(() => {
    if (!batchRendered) return [];
    const batchPreviewIds = new Set(linePreview?.entityIds ?? []);
    const batchGlobalPreview = batchPreviewIds.has('line')
      ? linePreview?.color
      : undefined;
    const batchGlobalSource = batchGlobalPreview ?? connectionAppearance.color;
    const batchGlobalLine = batchGlobalSource
      ? ensureCanvasColorContrast(batchGlobalSource, canvasColor)
      : canvasContrastColors(canvasColor).line;
    const paths = new Map<string, { color: string; title: boolean; paths: string[]; arrows: string[] }>();
    for (const item of committedGeometry) {
      if (item.connection.id === draft.reconnectId) continue;
      const localPreview = batchPreviewIds.has(item.connection.id)
        ? linePreview?.color
        : undefined;
      const source = localPreview ?? item.connection.lineColor ?? batchGlobalSource;
      const color = source ? ensureCanvasColorContrast(source, canvasColor) : batchGlobalLine;
      const title = titleRouteIds.has(item.connection.id);
      const key = color + ':' + String(title);
      const entries = paths.get(key) ?? { color, title, paths: [], arrows: [] };
      entries.paths.push(item.shaftPath);
      if (item.arrowPath) entries.arrows.push(item.arrowPath);
      paths.set(key, entries);
    }
    return [...paths.values()].map((entry) => ({ color: entry.color, title: entry.title, path: entry.paths.join(' '), arrows: entry.arrows.join(' ') }));
  }, [
    batchRendered,
    canvasColor,
    connectionAppearance.color,
    committedGeometry,
    draft.reconnectId,
    linePreview,
    titleRouteIds,
  ]);
  const highlightedGeometry = useMemo(() => batchRendered
    ? orderConnectionsForPaint(drawableGeometry.filter((item) => selected.has(item.connection.id) || item.connection.id === hoveredId || item.connection.id === draft.reconnectId), selected)
    : [], [batchRendered, drawableGeometry, hoveredId, selected, draft.reconnectId]);
  const detailWorldScale = canvasDetailWorldScale(camera.zoom);

  useEffect(() => {
    if (!editingConnectionId) return;
    labelInputRef.current?.focus();
    labelInputRef.current?.select();
  }, [editingConnectionId]);

  const selectConnection = (id: string, mode: SelectionMode, part: 'line' | 'label-background' | 'label-text' = 'line') => {
    void client.dispatch('selection.set', { items: [{ id, kind: 'connection', part }], mode });
  };

  const beginConnectionSelection = (
    event: ReactPointerEvent<SVGSVGElement>,
    connection: ConnectionRecord,
    part: PendingConnectionSelection['part'],
    cycle?: PendingConnectionSelection['cycle'],
  ) => {
    pendingBackground.current = undefined;
    pendingSelection.current = {
      id: connection.id,
      part,
      mode: modifierMode(event),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      lassoRequested: false,
      cycle,
    };
  };

  const beginConnectionBackground = (event: ReactPointerEvent<SVGSVGElement>) => {
    pendingSelection.current = undefined;
    pendingBackground.current = {
      mode: modifierMode(event),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      lassoRequested: false,
    };
  };

  const movePendingConnectionSelection = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const pending = pendingSelection.current ?? pendingBackground.current;
    if (!pending || pending.pointerId !== pointerId) return;
    // A small tremor during overlap cycling is still one click, not a lasso
    // selecting every coincident curve. Keep ordinary drag admission unchanged.
    const threshold = pendingSelection.current?.cycle ? OVERLAP_CLICK_SLOP : 3;
    const moved = Math.hypot(clientX - pending.startX, clientY - pending.startY) > threshold;
    if (moved && !pending.lassoRequested) {
      pending.moved = true;
      pending.lassoRequested = true;
      client.emit('canvas.lasso.external.requested', {
        pointerId,
        startClientX: pending.startX,
        startClientY: pending.startY,
        clientX,
        clientY,
        mode: pending.mode,
      } satisfies CanvasExternalLassoStartRequest);
    }
    if (pending.lassoRequested) client.emit('canvas.lasso.external.preview', {
      pointerId,
      clientX,
      clientY,
    } satisfies CanvasExternalLassoPointerRequest);
  }, [client]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      // WebKit does not consistently bubble pointer moves from HTML inside an SVG
      // foreignObject. The window capture listener preserves lasso arbitration for
      // connection labels without retargeting ordinary clicks or double clicks.
      movePendingConnectionSelection(event.pointerId, event.clientX, event.clientY);
    };
    window.addEventListener('pointermove', move, { capture: true });
    return () => window.removeEventListener('pointermove', move, { capture: true });
  }, [movePendingConnectionSelection]);

  const openLabelEditor = (connection: ConnectionRecord) => {
    selectConnection(connection.id, 'replace', 'label-text');
    setLabelEditor({
      id: connection.id,
      value: connection.label ?? '',
      expectedRevision: connection.revision,
    });
  };

  const commitLabelEditor = () => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    const editor = labelEditor;
    if (!editor) return;
    setLabelEditor(undefined);
    void client.dispatch('connection.setLabel', {
      id: editor.id,
      label: editor.value,
      expectedRevision: editor.expectedRevision,
    }).catch(() => {
      setLabelEditor((current) => current ?? editor);
    });
  };

  const beginLabelResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    connection: ConnectionRecord,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    layerRef.current?.setPointerCapture(event.pointerId);
    pendingSelection.current = undefined;
    pendingBackground.current = undefined;
    const size = normalizeConnectionLabelSize(connection.labelWidth, connection.labelHeight);
    const session: ConnectionLabelResizeSession = {
      token: createId('connection-resize'),
      id: connection.id,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      originWidth: size.width,
      originHeight: size.height,
      width: size.width,
      height: size.height,
      expectedRevision: connection.revision,
    };
    labelResize.current = session;
    selectConnection(connection.id, 'replace', 'label-background');
    client.emit('connection.label.resize.preview', {
      id: connection.id,
      width: size.width,
      height: size.height,
    } satisfies ConnectionLabelResizePreview);
    void client.dispatch('interaction.begin', { mode: 'resizing', sessionId: session.token }).catch(() => {
      if (labelResize.current !== session) return;
      labelResize.current = undefined;
      client.emit('connection.label.resize.preview', { clear: true } satisfies ConnectionLabelResizePreview);
    });
  };

  const updateLabelResize = (event: ReactPointerEvent<SVGSVGElement>): boolean => {
    const session = labelResize.current;
    if (!session || session.pointerId !== event.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    const screenScale = Math.max(0.01, camera.zoom * detailWorldScale);
    const size = normalizeConnectionLabelSize(
      session.originWidth + (event.clientX - session.pointerX) / screenScale,
      session.originHeight + (event.clientY - session.pointerY) / screenScale,
    );
    session.width = size.width;
    session.height = size.height;
    client.emit('connection.label.resize.preview', {
      id: session.id,
      width: size.width,
      height: size.height,
    } satisfies ConnectionLabelResizePreview);
    return true;
  };

  const finishLabelResize = (event: ReactPointerEvent<SVGSVGElement>): boolean => {
    const session = labelResize.current;
    if (!session || session.pointerId !== event.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    labelResize.current = undefined;
    client.emit('connection.label.resize.preview', { clear: true } satisfies ConnectionLabelResizePreview);
    void client.dispatch('interaction.end', { mode: 'resizing', sessionId: session.token }).then(() => client.dispatch('connection.resizeLabel', {
      id: session.id,
      width: session.width,
      height: session.height,
      expectedRevision: session.expectedRevision,
    })).catch(() => undefined);
    return true;
  };

  const cancelLabelResize = (pointerId?: number) => {
    const session = labelResize.current;
    if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) return;
    labelResize.current = undefined;
    client.emit('connection.label.resize.preview', { clear: true } satisfies ConnectionLabelResizePreview);
    void client.dispatch('interaction.end', { mode: 'resizing', sessionId: session.token }).catch(() => undefined);
  };

  const hitConnections = (
    clientX: number,
    clientY: number,
    screenTolerance = CONNECTION_HOVER_TOLERANCE_PX,
  ): Array<{ connection: ConnectionRecord; distance: number }> => {
    if (lassoActive || draft.reconnectId) return [];
    const element = layerRef.current;
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    const point = {
      x: (clientX - rect.left - camera.x) / camera.zoom,
      y: (clientY - rect.top - camera.y) / camera.zoom,
    };
    const threshold = screenTolerance / camera.zoom;
    const candidates = new Map(connectionIndex.query({
      x: point.x - threshold,
      y: point.y - threshold,
      width: threshold * 2,
      height: threshold * 2,
    }).map((connection) => [connection.id, connection]));
    for (const id of previewAffectedIds) {
      const connection = connectionLookup.byId.get(id);
      if (connection) candidates.set(id, connection);
    }
    const hits: Array<{ connection: ConnectionRecord; distance: number }> = [];
    for (const connection of candidates.values()) {
      if (!renderedConnectionIds.has(connection.id)) continue;
      const points = livePoints.get(connection.id);
      if (!points) continue;
      const distance = distanceToConnectionCurve(point, points.from, points.to);
      if (distance <= threshold) hits.push({ connection, distance });
    }
    return hits.sort((a, b) => a.distance - b.distance || a.connection.id.localeCompare(b.connection.id));
  };
  const hitConnection = (x: number, y: number, tolerance = CONNECTION_HOVER_TOLERANCE_PX) => hitConnections(x, y, tolerance)[0]?.connection;

  return (
    <svg
      ref={layerRef}
      className={`connection-layer ${batchRendered ? 'is-batched' : ''} ${lassoActive ? 'lasso-hit-disabled' : ''}`}
      style={{
        ...canvasContrastVariables(canvasColor),
        '--connection-line': globalConnectionLineColor,
        '--connection-label-background': canvasColor,
        '--connection-stroke-width': `${CONNECTION_LINE_SCREEN_WIDTH * detailWorldScale}px`,
        '--connection-highlight-stroke-width': `${CONNECTION_HIGHLIGHT_SCREEN_WIDTH * detailWorldScale}px`,
        '--connection-dash-length': `${6 * detailWorldScale}px`,
        '--connection-dash-gap': `${4 * detailWorldScale}px`,
        pointerEvents: lassoActive ? 'none' : undefined,
      } as CSSProperties}
      aria-label="节点连线"
      data-reconnecting-id={draft.reconnectId}
      data-render-mode={renderMode}
      data-detail-mode={overviewMode ? 'overview-focus' : 'full'}
      onPointerDownCapture={(event) => {
        if (labelEditor && event.target !== labelInputRef.current) labelInputRef.current?.blur();
        if (lassoActive || draft.reconnectId || event.button !== 0) return;
        const target = event.target as Element;
        if (target.closest('textarea, .connection-label-resize-handle, [data-junction-id], [data-arrow-for]')) { lineCycle.current.reset(); setOverlapHint(undefined); return; }
        const declaredTarget = target.closest<SVGElement>('[data-connection-id]');
        const declaredId = declaredTarget?.dataset.connectionId;
        const declaredConnection = declaredId ? connectionLookup.byId.get(declaredId) : undefined;
        const part = declaredTarget?.dataset.connectionPart;
        const declaredLabel = part === 'label-background' || part === 'label-text';
        const hits = declaredLabel ? [] : hitConnections(event.clientX, event.clientY, CONNECTION_CLICK_TOLERANCE_PX);
        let connection = declaredLabel ? declaredConnection : hits[0]?.connection;
        let cycle: PendingConnectionSelection['cycle'];
        if (hits.length > 1 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const ids = hits.map(hit => hit.connection.id).sort();
          const signature = camera.x + ':' + camera.y + ':' + camera.zoom + ':' + ids.map(id => {
            const edge = connectionLookup.byId.get(id)!, pair = livePoints.get(id)!;
            return id + ':' + edge.revision + ':' + (pair.from.route?.key ?? [pair.from.x, pair.from.y, pair.to.x, pair.to.y].join(','));
          }).join('|');
          const id = lineCycle.current.next(ids, event.clientX, event.clientY, signature, hits[0].connection.id)!;
          connection = connectionLookup.byId.get(id); cycle = { ids, signature };
        } else { lineCycle.current.reset(); setOverlapHint(undefined); }
        if (!connection) {
          beginConnectionBackground(event);
          return;
        }
        beginConnectionSelection(
          event,
          connection,
          part === 'label-background' || part === 'label-text' ? part : 'line', cycle,
        );
      }}
      onPointerMove={(event) => {
        if (overlapHint) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (Math.hypot(event.clientX - rect.left - camera.x - overlapHint.x * camera.zoom, event.clientY - rect.top - camera.y - overlapHint.y * camera.zoom) > 6) { lineCycle.current.reset(); setOverlapHint(undefined); }
        }
        reconnect.move(event);
        const rect = event.currentTarget.getBoundingClientRect();
        client.emit('canvas.pointer.preview', { point: {
          x: (event.clientX - rect.left - camera.x) / camera.zoom,
          y: (event.clientY - rect.top - camera.y) / camera.zoom,
        } });
        if ((event.target as Element).closest('[data-junction-id]')) return;
        movePendingConnectionSelection(event.pointerId, event.clientX, event.clientY);
        if (updateLabelResize(event)) return;
        if (!batchRendered) return;
        const next = hitConnection(event.clientX, event.clientY)?.id;
        setHoveredId((current) => current === next ? current : next);
      }}
      onPointerUp={(event) => {
        reconnect.finish(event);
        if (finishLabelResize(event)) {
          pendingSelection.current = undefined;
          pendingBackground.current = undefined;
          return;
        }
        const pending = pendingSelection.current;
        const background = pendingBackground.current;
        const pointer = pending ?? background;
        if (!pointer || pointer.pointerId !== event.pointerId) return;
        pendingSelection.current = undefined;
        pendingBackground.current = undefined;
        if (pointer.moved || lassoActive) {
          lineCycle.current.reset(); setOverlapHint(undefined);
          event.preventDefault();
          event.stopPropagation();
          client.emit('canvas.lasso.external.finished', {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
          } satisfies CanvasExternalLassoPointerRequest);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (pending) {
          if (pending.cycle) {
            lineCycle.current.commit(pending.id, event.clientX, event.clientY, pending.cycle.signature);
            const rect = event.currentTarget.getBoundingClientRect();
            setOverlapHint({ id: pending.id, x: (event.clientX - rect.left - camera.x) / camera.zoom, y: (event.clientY - rect.top - camera.y) / camera.zoom,
              index: pending.cycle.ids.indexOf(pending.id), count: pending.cycle.ids.length, label: '连接线', viewKey });
          }
          selectConnection(pending.id, pending.mode, pending.part);
        }
        else if (background?.mode === 'replace') void client.dispatch('selection.clear');
      }}
      onPointerCancel={(event) => {
        lineCycle.current.reset(); setOverlapHint(undefined);
        reconnect.finish(event, true);
        const pending = pendingSelection.current ?? pendingBackground.current;
        if (pending?.pointerId === event.pointerId) {
          pendingSelection.current = undefined;
          pendingBackground.current = undefined;
          if (pending.lassoRequested) client.emit('canvas.lasso.external.finished', {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            cancel: true,
          } satisfies CanvasExternalLassoPointerRequest);
        }
        cancelLabelResize(event.pointerId);
      }}
      onLostPointerCapture={event => { cancelLabelResize(event.pointerId); reconnect.finish(event, true); }}
      onKeyDown={event => { if (event.key === 'Escape') { lineCycle.current.reset(); setOverlapHint(undefined); cancelLabelResize(); reconnect.cancel(); } }}
      onPointerLeave={() => { setHoveredId(undefined); lineCycle.current.reset(); setOverlapHint(undefined); }}
      onDoubleClickCapture={event => {
        if ((event.target as Element).closest('[data-junction-id], [data-arrow-for], [data-connection-part="label-background"], [data-connection-part="label-text"], textarea, .connection-label-resize-handle')) return;
        if (hitConnections(event.clientX, event.clientY, CONNECTION_CLICK_TOLERANCE_PX).length > 1) { event.preventDefault(); event.stopPropagation(); }
      }}
      onDoubleClick={(event) => {
        if (!batchRendered) return;
        const connection = hitConnection(
          event.clientX,
          event.clientY,
          CONNECTION_CLICK_TOLERANCE_PX,
        );
        if (!connection) return;
        event.preventDefault();
        event.stopPropagation();
        openLabelEditor(connection);
      }}
      onContextMenu={(event) => {
        if ((event.target as Element).closest('textarea, input')) return;
        if (!selectedIds.some((id) => connectionLookup.byId.has(id))) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        void client.dispatch('connection.addJunctionFromContext', { point: {
          x: (event.clientX - rect.left - camera.x) / camera.zoom,
          y: (event.clientY - rect.top - camera.y) / camera.zoom,
        } }).catch(() => undefined);
      }}
    >
      <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
        {batchRendered && batchedPaths.map(({ color, title, path, arrows }) => (
          <g key={`${color}:${title}`}>
          <path
            className={`connection-path connection-path-batch ${title ? 'title-connection' : ''}`}
            d={path}
            style={{ '--connection-line': color } as CSSProperties}
            aria-hidden="true"
          />
          <path className="connection-arrow connection-arrow-batch" d={arrows} style={{ '--connection-line': color } as CSSProperties} aria-hidden="true" />
          </g>
        ))}
        {batchRendered && highlightedGeometry.map(({ connection, shaftPath, arrowPath, arrowEnd }) => (
          <g key={`highlight-${connection.id}`}>
          <path
            className={`connection-path ${selected.has(connection.id) || connection.id === draft.reconnectId ? 'selected' : 'hovered'} ${isTitleRoute(connection) ? 'title-connection' : ''} ${connection.lineColor ||
              previewIds.has(connection.id)
              ? 'custom-color'
              : ''}`}
            d={shaftPath}
            style={{ '--connection-line': lineColorFor(connection) } as CSSProperties}
            aria-hidden="true"
          />
          {arrowPath && <path className={`connection-arrow ${selected.has(connection.id) || connection.id === draft.reconnectId ? 'selected' : 'hovered'} ${connection.lineColor || previewIds.has(connection.id) ? 'custom-color' : ''}`} d={arrowPath} data-arrow-for={connection.id} data-arrow-end={arrowEnd} tabIndex={-1}
                onPointerEnter={() => setHoveredId(connection.id)} onPointerLeave={() => setHoveredId(current => current === connection.id ? undefined : current)} style={{ '--connection-line': lineColorFor(connection) } as CSSProperties}
            onPointerDown={event => beginArrowReconnect(event, connection, arrowEnd)} aria-label="拖动箭头重新连接" />}
          </g>
        ))}
        {!batchRendered && paintOrderedGeometry.map(({ connection, curvePath, shaftPath, arrowPath, arrowEnd }) => {
          const isSelected = selected.has(connection.id) || connection.id === draft.reconnectId;
          const hasLocalColor = Boolean(connection.lineColor ||
            previewIds.has(connection.id));
          return (
            <g key={connection.id}>
              <path
                className="connection-hit-area"
                d={curvePath}
                data-connection-id={connection.id}
                data-connection-part="line"
                tabIndex={0}
                role="button"
                aria-pressed={isSelected}
                aria-label={`${isSelected ? '已选中，' : ''}节点连线${connection.label ? `：${connection.label}` : ''}；双击或按 F2 编辑文字；重叠时重复单击切换`}
                onPointerEnter={() => setHoveredId(connection.id)}
                onPointerLeave={() => setHoveredId((current) => current === connection.id ? undefined : current)}
                onDoubleClick={(event) => {
                  if (hitConnection(
                    event.clientX,
                    event.clientY,
                    CONNECTION_CLICK_TOLERANCE_PX,
                  )?.id !== connection.id) return;
                  event.preventDefault();
                  event.stopPropagation();
                  openLabelEditor(connection);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'F2') {
                    event.preventDefault();
                    openLabelEditor(connection);
                    return;
                  }
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  selectConnection(connection.id, 'replace', 'line');
                }}
              />
              <path
                className={`connection-path ${isTitleRoute(connection) ? 'title-connection' : ''} ${isSelected ? 'selected' : ''} ${connection.id === hoveredId ? 'hovered' : ''} ${hasLocalColor ? 'custom-color' : ''}`}
                d={shaftPath}
                style={{ '--connection-line': lineColorFor(connection) } as CSSProperties}
                aria-hidden="true"
              />
              {arrowPath && <path className={`connection-arrow ${isSelected ? 'selected' : ''} ${connection.id === hoveredId ? 'hovered' : ''} ${hasLocalColor ? 'custom-color' : ''}`} data-arrow-for={connection.id} data-arrow-end={arrowEnd} tabIndex={-1}
                onPointerEnter={() => setHoveredId(connection.id)} onPointerLeave={() => setHoveredId(current => current === connection.id ? undefined : current)} d={arrowPath} style={{ '--connection-line': lineColorFor(connection) } as CSSProperties}
                onPointerDown={event => beginArrowReconnect(event, connection, arrowEnd)}
                aria-label="拖动箭头重新连接" />}
            </g>
          );
        })}
        {draftGeometry && !reconnectGeometry && (<g>
          <path
            className={`connection-path draft ${draft.titleRoute || draft.from?.side === 'title' || draft.to?.side === 'title' ? 'title-connection' : ''}`}
            d={draftGeometry.shaftPath}
          />
          {draftGeometry.arrowPath && <path className="connection-arrow draft" data-arrow-end={draftGeometry.arrowEnd} d={draftGeometry.arrowPath} />}
        </g>)}
        {paintOrderedGeometry.map(({ connection, midpoint }) => {
          const isEditing = labelEditor?.id === connection.id;
          if ((!connection.label && !isEditing) || !midpoint) return null;
          const isSelected = selected.has(connection.id);
          const isHovered = connection.id === hoveredId;
          const labelBackground = canvasColor;
          const labelText = labelTextPreview?.entityIds.includes(connection.id)
            ? labelTextPreview.color ?? lineColorFor(connection)
            : connection.labelTextColor ?? lineColorFor(connection);
          const hasCustomLabelText = Boolean(connection.labelTextColor ||
            labelTextPreview?.entityIds.includes(connection.id));
          const committedSize = normalizeConnectionLabelSize(connection.labelWidth, connection.labelHeight);
          const size = labelResizePreview?.id === connection.id &&
            labelResizePreview.width !== undefined && labelResizePreview.height !== undefined
            ? { width: labelResizePreview.width, height: labelResizePreview.height }
            : committedSize;
          const renderedSize = {
            width: size.width * detailWorldScale,
            height: size.height * detailWorldScale,
          };
          const frame = <rect className={`connection-label-border ${isTitleRoute(connection) ? 'title-connection' : ''} ${isSelected || isEditing ? 'selected' : ''} ${isHovered ? 'hovered' : ''}`}
            data-label-border-for={connection.id} x={midpoint.x - renderedSize.width / 2} y={midpoint.y - renderedSize.height / 2}
            width={renderedSize.width} height={renderedSize.height} rx={7 * detailWorldScale}
            style={{ '--connection-line': lineColorFor(connection) } as CSSProperties} />;
          return <Fragment key={`label-pair-${connection.id}`}>{frame}{isEditing ? (
            <foreignObject
              key={`label-editor-${connection.id}`}
              className={`connection-label-editor ${isTitleRoute(connection) ? 'title-connection' : ''}`}
              x={midpoint.x - renderedSize.width / 2}
              y={midpoint.y - renderedSize.height / 2}
              width={renderedSize.width}
              height={renderedSize.height}
              style={{
                '--connection-line': lineColorFor(connection),
                '--connection-label-background': labelBackground,
                '--connection-label-text': labelText,
              } as CSSProperties}
            >
              <textarea
                ref={labelInputRef}
                aria-label="连接文字"
                maxLength={MAX_CONNECTION_LABEL_LENGTH}
                style={{
                  width: size.width,
                  height: size.height,
                  transform: `scale(${detailWorldScale})`,
                  transformOrigin: 'top left',
                }}
                value={labelEditor.value}
                onChange={(event) => setLabelEditor({ ...labelEditor, value: event.currentTarget.value })}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onBlur={commitLabelEditor}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const target = event.currentTarget;
                    const start = target.selectionStart;
                    const end = target.selectionEnd;
                    if (target.value.length - (end - start) >= MAX_CONNECTION_LABEL_LENGTH) return;
                    target.setRangeText('\n', start, end, 'end');
                    setLabelEditor({ ...labelEditor, value: target.value });
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                    return;
                  }
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  event.stopPropagation();
                  skipBlurCommitRef.current = true;
                  event.currentTarget.blur();
                  setLabelEditor(undefined);
                }}
              />
            </foreignObject>
          ) : (
            <foreignObject
              key={`label-${connection.id}`}
              className="connection-label-foreign"
              data-connection-id={connection.id}
              data-connection-part="label-background"
              x={midpoint.x - renderedSize.width / 2}
              y={midpoint.y - renderedSize.height / 2}
              width={renderedSize.width}
              height={renderedSize.height}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openLabelEditor(connection);
              }}
            >
              <div
                className={`connection-label-display ${isTitleRoute(connection) ? 'title-connection' : ''} ${isSelected ? 'selected' : ''} ${isHovered ? 'hovered' : ''} ${hasCustomLabelText ? 'custom-label-text' : ''}`}
                style={{
                  width: size.width,
                  height: size.height,
                  transform: `scale(${detailWorldScale})`,
                  transformOrigin: 'top left',
                  '--connection-line': lineColorFor(connection),
                  '--connection-label-background': labelBackground,
                  '--connection-label-text': labelText,
                } as CSSProperties}
                title={connection.label}
              >
                <span
                  className="connection-label-text"
                  data-connection-id={connection.id}
                  data-connection-part="label-text"
                >
                  {connection.label}
                </span>
                <button
                  type="button"
                  className="connection-label-resize-handle"
                  aria-label="调整连接文字框大小"
                  title="拖动调整连接文字框大小"
                  onPointerDown={(event) => beginLabelResize(event, connection)}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <Icon name="resize" size={13} />
                </button>
              </div>
            </foreignObject>
          )}</Fragment>;
        })}
        <OverlapHint hint={overlapHint && selected.has(overlapHint.id) ? overlapHint : undefined} zoom={camera.zoom} viewKey={viewKey} />
        <ConnectionJunctionMarkers client={client} camera={camera} junctions={paintedJunctions} allJunctions={junctions} selected={selected}
          hitJunctions={hitJunctions}
          color={junctionColor ? ensureCanvasColorContrast(junctionColor, canvasColor) : canvasContrastColors(canvasColor).line}
          nodes={nodeMap} titleJunctionIds={titleJunctionIds}
          targetId={draft.to?.kind === 'junction' ? draft.to.nodeId : undefined} />
      </g>
    </svg>
  );
}

function modifierMode(event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectionMode {
  if (event.altKey) return 'remove';
  if (event.shiftKey) return 'add';
  if (event.ctrlKey || event.metaKey) return 'toggle';
  return 'replace';
}

function connectionBounds(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
): { x: number; y: number; width: number; height: number } {
  return connectionCurveBounds(from, to);
}
