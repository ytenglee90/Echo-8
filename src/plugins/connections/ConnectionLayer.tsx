'use client';

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { SpatialHashIndex } from '../../core/spatial-index.ts';
import type { AppearancePreview } from '../../protocols/appearance.ts';
import type { CanvasWheelZoomRequest } from '../../protocols/canvas.ts';
import {
  connectionEndpointPoint,
  MAX_CONNECTION_LABEL_LENGTH,
  normalizeConnectionLabelSize,
  resolveConnectionRecordEndpoints,
  type ConnectionAppearanceSnapshot,
  type ConnectionDraft,
  type ConnectionEndpoint,
  type ConnectionRecord,
} from '../../protocols/connections.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { SelectionMode } from '../../protocols/selection.ts';
import { boundsIntersect, worldViewport } from '../../protocols/viewport.ts';
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
  connectionCurvePathWithArrow,
  connectionRenderMode,
  CONNECTION_LINE_SCREEN_WIDTH,
  distanceToConnectionCurve,
  orderConnectionsForPaint,
  type ConnectionRenderPoint,
} from './rendering.ts';

const CULL_MARGIN = 360;

interface DrawableConnection {
  connection: ConnectionRecord;
  from: ConnectionRenderPoint;
  to: ConnectionRenderPoint;
  midpoint?: ConnectionRenderPoint;
  curvePath: string;
  renderedPath: string;
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

export function ConnectionLayer({ client }: { client: ViewClient }) {
  const {
    capabilityVersion,
    nodeById,
    camera,
    previews,
    sizePreviews,
    selectedIds,
    canvasColor,
    surfaceSize,
    layerRef,
  } = useCanvasLayerEnvironment<SVGSVGElement>(client);
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [connectionAppearance, setConnectionAppearance] = useState<ConnectionAppearanceSnapshot>({ revision: 0 });
  const [previewConnectionColor, setPreviewConnectionColor] = useState<string>();
  const [draft, setDraft] = useState<ConnectionDraft>({});
  const [hoveredId, setHoveredId] = useState<string>();
  const [labelEditor, setLabelEditor] = useState<ConnectionLabelEditorState>();
  const [labelResizePreview, setLabelResizePreview] = useState<ConnectionLabelResizePreview>();
  const labelInputRef = useRef<HTMLTextAreaElement>(null);
  const labelResize = useRef<ConnectionLabelResizeSession | undefined>(undefined);
  const skipBlurCommitRef = useRef(false);

  useEffect(() => {
    let current = true;
    void client.request<ConnectionRecord[]>('connections.list@1').then((nextConnections) => {
      if (!current) return;
      setConnections(nextConnections);
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
      void client.request<ConnectionRecord[]>('connections.list@1')
        .then(setConnections)
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
      setPreviewConnectionColor(!preview.clear && preview.kind === 'connection-line'
        ? preview.color
        : undefined);
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

  const stableNodeMap = useMemo(
    () => new Map(nodeById),
    [nodeById],
  );
  const nodeMap = useMemo(
    () => new Map([...stableNodeMap].map(([id, node]) => [
      id,
      { ...node, ...previews[id], ...sizePreviews[id] },
    ])),
    [previews, sizePreviews, stableNodeMap],
  );
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
  const connectionIndex = useMemo(() => {
    const index = new SpatialHashIndex<ConnectionRecord>();
    index.rebuild(
      connections.filter((connection) => Boolean(connectionPoints(connection, stableNodeMap))),
      (connection) => connection.id,
      (connection) => {
        const points = connectionPoints(connection, stableNodeMap)!;
        return connectionBounds(points.from, points.to);
      },
    );
    return index;
  }, [connections, stableNodeMap]);
  const drawable = useMemo(() => {
    const viewport = worldViewport(camera, surfaceSize, CULL_MARGIN);
    const candidates = new Map(connectionIndex.query(viewport).map((connection) => [connection.id, connection]));
    for (const nodeId of [...Object.keys(previews), ...Object.keys(sizePreviews)]) {
      for (const id of connectionLookup.byNode.get(nodeId) ?? []) {
        const connection = connectionLookup.byId.get(id);
        if (connection) candidates.set(id, connection);
      }
    }
    return [...candidates.values()].filter((connection) => {
      const points = connectionPoints(connection, nodeMap);
      return Boolean(points && boundsIntersect(viewport, connectionBounds(points.from, points.to)));
    });
  }, [camera, connectionIndex, connectionLookup, nodeMap, previews, sizePreviews, surfaceSize]);
  const draftStart = draft.from ? endpointPoint(draft.from, nodeMap) : undefined;
  const draftEnd = draft.to ? endpointPoint(draft.to, nodeMap) : draft.pointer;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const editingConnectionId = labelEditor?.id;
  const drawableGeometry = useMemo<DrawableConnection[]>(() => drawable.flatMap((connection) => {
    const points = connectionPoints(connection, nodeMap);
    return points ? [{
      connection,
      ...points,
      midpoint: connection.label || connection.id === editingConnectionId
        ? connectionCurveMidpoint(points.from, points.to)
        : undefined,
      curvePath: connectionCurvePath(points.from, points.to),
      renderedPath: connectionCurvePathWithArrow(points.from, points.to, camera.zoom),
    }] : [];
  }), [camera.zoom, drawable, editingConnectionId, nodeMap]);
  const renderMode = connectionRenderMode(drawableGeometry.length);
  const batchRendered = renderMode === 'batched-svg';
  const paintOrderedGeometry = useMemo(
    () => orderConnectionsForPaint(drawableGeometry, selected),
    [drawableGeometry, selected],
  );
  const batchedPath = useMemo(
    () => batchRendered ? drawableGeometry.map((item) => item.renderedPath).join(' ') : '',
    [batchRendered, drawableGeometry],
  );
  const highlightedGeometry = useMemo(() => batchRendered
    ? drawableGeometry.filter((item) => selected.has(item.connection.id) || item.connection.id === hoveredId)
    : [], [batchRendered, drawableGeometry, hoveredId, selected]);
  const preferredConnectionColor = previewConnectionColor ?? connectionAppearance.color;
  const connectionLineColor = preferredConnectionColor
    ? ensureCanvasColorContrast(preferredConnectionColor, canvasColor)
    : canvasContrastColors(canvasColor).line;
  const detailWorldScale = canvasDetailWorldScale(camera.zoom);

  useEffect(() => {
    if (!editingConnectionId) return;
    labelInputRef.current?.focus();
    labelInputRef.current?.select();
  }, [editingConnectionId]);

  const selectConnection = (id: string, mode: SelectionMode) => {
    void client.dispatch('selection.set', { items: [{ id, kind: 'connection' }], mode });
  };

  const openLabelEditor = (connection: ConnectionRecord) => {
    selectConnection(connection.id, 'replace');
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
    event.currentTarget.setPointerCapture(event.pointerId);
    const size = normalizeConnectionLabelSize(connection.labelWidth, connection.labelHeight);
    const session: ConnectionLabelResizeSession = {
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
    selectConnection(connection.id, 'replace');
    client.emit('connection.label.resize.preview', {
      id: connection.id,
      width: size.width,
      height: size.height,
    } satisfies ConnectionLabelResizePreview);
    void client.dispatch('interaction.begin', { mode: 'resizing' }).catch(() => {
      if (labelResize.current?.pointerId !== session.pointerId) return;
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
    void client.dispatch('connection.resizeLabel', {
      id: session.id,
      width: session.width,
      height: session.height,
      expectedRevision: session.expectedRevision,
    }).finally(() => client.dispatch('interaction.end', { mode: 'resizing' }).catch(() => undefined));
    return true;
  };

  const cancelLabelResize = (pointerId?: number) => {
    const session = labelResize.current;
    if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) return;
    labelResize.current = undefined;
    client.emit('connection.label.resize.preview', { clear: true } satisfies ConnectionLabelResizePreview);
    void client.dispatch('interaction.end', { mode: 'resizing' }).catch(() => undefined);
  };

  const hitConnection = (clientX: number, clientY: number): ConnectionRecord | undefined => {
    const element = layerRef.current;
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    const point = {
      x: (clientX - rect.left - camera.x) / camera.zoom,
      y: (clientY - rect.top - camera.y) / camera.zoom,
    };
    const threshold = 12 / camera.zoom;
    const candidates = new Map(connectionIndex.query({
      x: point.x - threshold,
      y: point.y - threshold,
      width: threshold * 2,
      height: threshold * 2,
    }).map((connection) => [connection.id, connection]));
    for (const nodeId of [...Object.keys(previews), ...Object.keys(sizePreviews)]) {
      for (const id of connectionLookup.byNode.get(nodeId) ?? []) {
        const connection = connectionLookup.byId.get(id);
        if (connection) candidates.set(id, connection);
      }
    }
    let best: { connection: ConnectionRecord; distance: number } | undefined;
    for (const connection of candidates.values()) {
      const points = connectionPoints(connection, nodeMap);
      if (!points) continue;
      const distance = distanceToConnectionCurve(point, points.from, points.to);
      if (distance <= threshold && (!best || distance < best.distance)) best = { connection, distance };
    }
    return best?.connection;
  };

  return (
    <svg
      ref={layerRef}
      className={`connection-layer ${batchRendered ? 'is-batched' : ''}`}
      style={{
        ...canvasContrastVariables(canvasColor),
        '--connection-line': connectionLineColor,
        '--connection-label-background': canvasColor,
        '--connection-stroke-width': `${CONNECTION_LINE_SCREEN_WIDTH * detailWorldScale}px`,
      } as CSSProperties}
      aria-label="节点连线"
      data-render-mode={renderMode}
      onPointerDownCapture={(event) => {
        if (!labelEditor || event.target === labelInputRef.current) return;
        labelInputRef.current?.blur();
      }}
      onPointerMove={(event) => {
        if (updateLabelResize(event)) return;
        if (!batchRendered) return;
        const next = hitConnection(event.clientX, event.clientY)?.id;
        setHoveredId((current) => current === next ? current : next);
      }}
      onPointerUp={(event) => {
        finishLabelResize(event);
      }}
      onPointerCancel={(event) => {
        cancelLabelResize(event.pointerId);
      }}
      onPointerLeave={() => setHoveredId(undefined)}
      onPointerDown={(event) => {
        if (!batchRendered || event.button !== 0) return;
        const connection = hitConnection(event.clientX, event.clientY);
        if (!connection) return;
        event.preventDefault();
        event.stopPropagation();
        selectConnection(connection.id, modifierMode(event));
      }}
      onDoubleClick={(event) => {
        if (!batchRendered) return;
        const connection = hitConnection(event.clientX, event.clientY);
        if (!connection) return;
        event.preventDefault();
        event.stopPropagation();
        openLabelEditor(connection);
      }}
    >
      <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
        {batchRendered && batchedPath && (
          <path
            className="connection-path connection-path-batch"
            d={batchedPath}
            aria-hidden="true"
          />
        )}
        {batchRendered && highlightedGeometry.map(({ connection, renderedPath }) => (
          <path
            key={`highlight-${connection.id}`}
            className="connection-path selected"
            d={renderedPath}
            aria-hidden="true"
          />
        ))}
        {!batchRendered && paintOrderedGeometry.map(({ connection, curvePath, renderedPath }) => {
          const isSelected = selected.has(connection.id);
          return (
            <g key={connection.id}>
              <path
                className="connection-hit-area"
                d={curvePath}
                tabIndex={0}
                role="button"
                aria-pressed={isSelected}
                aria-label={`${isSelected ? '已选中，' : ''}节点连线${connection.label ? `：${connection.label}` : ''}；双击或按 F2 编辑文字`}
                onPointerEnter={() => setHoveredId(connection.id)}
                onPointerLeave={() => setHoveredId((current) => current === connection.id ? undefined : current)}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  selectConnection(connection.id, modifierMode(event));
                }}
                onDoubleClick={(event) => {
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
                  selectConnection(connection.id, 'replace');
                }}
              />
              <path
                className={`connection-path ${isSelected ? 'selected' : ''}`}
                d={renderedPath}
                aria-hidden="true"
              />
            </g>
          );
        })}
        {draftStart && draftEnd && (
          <path
            className="connection-path draft"
            d={connectionCurvePathWithArrow(draftStart, draftEnd, camera.zoom)}
          />
        )}
        {paintOrderedGeometry.map(({ connection, midpoint }) => {
          const isEditing = labelEditor?.id === connection.id;
          if ((!connection.label && !isEditing) || !midpoint) return null;
          const isSelected = selected.has(connection.id);
          const isHovered = connection.id === hoveredId;
          const committedSize = normalizeConnectionLabelSize(connection.labelWidth, connection.labelHeight);
          const size = labelResizePreview?.id === connection.id &&
            labelResizePreview.width !== undefined && labelResizePreview.height !== undefined
            ? { width: labelResizePreview.width, height: labelResizePreview.height }
            : committedSize;
          const renderedSize = {
            width: size.width * detailWorldScale,
            height: size.height * detailWorldScale,
          };
          return isEditing ? (
            <foreignObject
              key={`label-editor-${connection.id}`}
              className="connection-label-editor"
              x={midpoint.x - renderedSize.width / 2}
              y={midpoint.y - renderedSize.height / 2}
              width={renderedSize.width}
              height={renderedSize.height}
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
              x={midpoint.x - renderedSize.width / 2}
              y={midpoint.y - renderedSize.height / 2}
              width={renderedSize.width}
              height={renderedSize.height}
              onPointerDown={(event) => {
                event.stopPropagation();
                selectConnection(connection.id, modifierMode(event));
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openLabelEditor(connection);
              }}
            >
              <div
                className={`connection-label-display ${isSelected ? 'selected' : ''} ${isHovered ? 'hovered' : ''}`}
                style={{
                  width: size.width,
                  height: size.height,
                  transform: `scale(${detailWorldScale})`,
                  transformOrigin: 'top left',
                }}
                title={connection.label}
              >
                <span className="connection-label-text">{connection.label}</span>
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
                  onLostPointerCapture={(event) => cancelLabelResize(event.pointerId)}
                >
                  <Icon name="resize" size={13} />
                </button>
              </div>
            </foreignObject>
          );
        })}
      </g>
    </svg>
  );
}

function connectionPoints(
  connection: ConnectionRecord,
  nodes: Map<string, ContentSummary>,
): { from: ConnectionRenderPoint; to: ConnectionRenderPoint } | undefined {
  const fromNode = nodes.get(connection.from.nodeId);
  const toNode = nodes.get(connection.to.nodeId);
  if (!fromNode || !toNode) return undefined;
  const endpoints = resolveConnectionRecordEndpoints(connection, fromNode, toNode);
  const from = endpointPoint(endpoints.from, nodes);
  const to = endpointPoint(endpoints.to, nodes);
  return from && to ? { from, to } : undefined;
}

function modifierMode(event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectionMode {
  if (event.altKey) return 'remove';
  if (event.shiftKey) return 'add';
  if (event.ctrlKey || event.metaKey) return 'toggle';
  return 'replace';
}

function endpointPoint(
  endpoint: ConnectionEndpoint,
  nodes: Map<string, ContentSummary>,
): ConnectionRenderPoint | undefined {
  const node = nodes.get(endpoint.nodeId);
  if (!node) return undefined;
  return connectionEndpointPoint(endpoint, node);
}

function connectionBounds(
  from: ConnectionRenderPoint,
  to: ConnectionRenderPoint,
): { x: number; y: number; width: number; height: number } {
  return connectionCurveBounds(from, to);
}
