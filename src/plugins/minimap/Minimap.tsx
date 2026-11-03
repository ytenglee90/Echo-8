'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import { createId, type ViewClient } from '../../core/contracts.ts';
import type { AppearancePreview } from '../../protocols/appearance.ts';
import type { CameraState, CanvasAppearanceSnapshot, CanvasPanRequest, CanvasViewportSize } from '../../protocols/canvas.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { CanvasOverviewEntity } from '../../protocols/canvas.ts';
import type { MinimapState } from '../../protocols/minimap.ts';
import { viewportCenterInWorld, worldViewport } from '../../protocols/viewport.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { parseColor, relativeLuminance } from '../../ui/color-math.ts';
import { useCommandAvailability, useCommandTooltip, useContentCatalog } from '../../ui/runtime-hooks.ts';
import { MAP_HEIGHT, MAP_WIDTH, mapPoint, mapProjection, type MapProjection } from './geometry.ts';

function useOpen(client: ViewClient) {
  useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  try { return client.requestSync<MinimapState>('minimap.state@1').open; }
  catch { return false; }
}

export function MinimapToggle({ client }: { client: ViewClient }) {
  const open = useOpen(client);
  const enabled = useCommandAvailability(client, 'minimap.toggle');
  const label = useCommandTooltip(client, 'minimap.toggle', open ? '关闭小地图' : '打开小地图');
  return <IconButton icon="map" label={label} aria-pressed={open} disabled={!enabled}
    onClick={() => void client.dispatch('minimap.toggle')} />;
}

export function Minimap({ client }: { client: ViewClient }) {
  return useOpen(client) ? <MapView client={client} /> : null;
}

interface Gesture {
  id: string; pointerId: number; startX: number; startY: number;
  projection: MapProjection; origin: { x: number; y: number }; point: { x: number; y: number };
  nodeId?: string; moved: boolean; admitted: boolean; admission: Promise<boolean>;
}

function MapView({ client }: { client: ViewClient }) {
  const { summaries } = useContentCatalog(client, { visualOnly: true });
  const capabilities = useSyncExternalStore(client.subscribeCapabilities, client.getCapabilityVersion, () => 0);
  const [overviewRevision, setOverviewRevision] = useState(0);
  useEffect(() => client.subscribeSignal('canvas.overview.invalidated', () => setOverviewRevision(version => version + 1)), [client]);
  const groups = useMemo(() => {
    try { return client.requestSync<CanvasOverviewEntity[]>('canvas.overview@1', {
      nodes: summaries.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
    }); } catch { return []; }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Provider lifecycle and owner invalidation revisions expire the geometry cache.
  }, [client, summaries, capabilities, overviewRevision]);
  const [camera, setCamera] = useState<CameraState>(() => client.requestSync<CameraState>('canvas.camera@1'));
  const [size, setSize] = useState<CanvasViewportSize>(() => {
    try { return client.requestSync<CanvasViewportSize>('canvas.viewport@1'); }
    catch { return { width: 0, height: 0 }; }
  });
  const [background, setBackground] = useState('#efefec');
  const [previewBackground, setPreviewBackground] = useState<string>();
  const [pulse, setPulse] = useState<{ x: number; y: number; key: string }>();
  const projection = useMemo(() => mapProjection([...groups, ...summaries]), [groups, summaries]);
  const [frozenProjection, setFrozenProjection] = useState<MapProjection>();
  const shownProjection = frozenProjection ?? projection;
  const session = useRef<Gesture | undefined>(undefined);
  const mounted = useRef(true);
  const available = useCommandAvailability(client, 'canvas.focusEntity');

  const pan = useCallback((point: { x: number; y: number }, commit = false) =>
    client.emit('canvas.pan.requested', { point, commit } satisfies CanvasPanRequest), [client]);
  const focus = useCallback((id: string) => {
    if (!available) return;
    void client.dispatch('selection.set', { ids: [id], mode: 'replace' })
      .then(() => client.dispatch('canvas.focusEntity', { id })).catch(() => undefined);
  }, [available, client]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const active = session.current;
      session.current = undefined;
      if (!active) return;
      if (active.admitted && active.moved) client.emit('canvas.pan.requested', { point: active.origin });
      void client.dispatch('interaction.end', { mode: 'panning', sessionId: active.id }).catch(() => undefined);
    };
  }, [client]);
  useEffect(() => client.subscribeSignal<CameraState>('canvas.camera.preview', (message) => setCamera(message.payload)), [client]);
  useEffect(() => client.subscribeSignal<CanvasViewportSize>('canvas.viewport.preview', (message) => setSize(message.payload)), [client]);
  useEffect(() => {
    let current = true;
    const refresh = () => void client.request<CanvasAppearanceSnapshot>('canvas.appearance@1')
      .then((next) => { if (current) setBackground(next.color); }).catch(() => undefined);
    refresh();
    const unsubscribe = client.subscribeSignal('canvas.appearance.invalidated', refresh);
    return () => { current = false; unsubscribe(); };
  }, [client]);
  useEffect(() => client.subscribeSignal<AppearancePreview>('appearance.color.preview', ({ payload }) => {
    setPreviewBackground(!payload.clear && payload.kind === 'canvas-background' ? payload.color : undefined);
  }), [client]);

  const local = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(MAP_WIDTH, (event.clientX - box.left) * MAP_WIDTH / box.width)),
      y: Math.max(0, Math.min(MAP_HEIGHT, (event.clientY - box.top) * MAP_HEIGHT / box.height)) };
  };
  const finish = (cancel = false) => {
    const active = session.current;
    if (!active) return;
    session.current = undefined;
    setFrozenProjection(undefined);
    // Queue release before another pointer-down can enqueue its begin.
    const ended = client.dispatch('interaction.end', { mode: 'panning', sessionId: active.id });
    void Promise.all([active.admission, ended]).then(([admitted]) => {
      if (!admitted) return;
      if (mounted.current) {
        if (cancel) { if (active.moved) pan(active.origin); }
        else if (active.moved || !active.nodeId) pan(active.point, true);
        else focus(active.nodeId);
      } else if (active.moved) pan(active.origin);
    }).catch(() => undefined);
  };
  const viewport = worldViewport(camera, size, 0);
  const dark = relativeLuminance(parseColor(previewBackground ?? background) ?? [239, 239, 236]) < 0.179;

  return <section className="canvas-minimap" aria-label="画布小地图" data-tone={dark ? 'dark' : 'light'}>
    <svg className="minimap-surface" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} tabIndex={0}
      role="group" aria-label="小地图导航；单击色块聚焦，单击空白或拖动平移；方向键移动视图"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0 || session.current) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = local(event);
        setPulse({ ...point, key: createId('map-pulse') });
        const active: Gesture = {
          id: createId('map-pan'), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
          projection, origin: viewportCenterInWorld(camera, size), point: mapPoint(projection, point),
          nodeId: (event.target as Element).closest('[data-map-node], [data-map-group]')?.getAttribute('data-map-node') ??
            (event.target as Element).closest('[data-map-group]')?.getAttribute('data-map-group') ?? undefined,
          moved: false, admitted: false, admission: Promise.resolve(false),
        };
        session.current = active;
        active.admission = client.dispatch('interaction.begin', { mode: 'panning', sessionId: active.id })
          .then(() => { active.admitted = true; return true; }).catch(() => false);
        setFrozenProjection(projection);
      }}
      onPointerMove={(event) => {
        const active = session.current;
        if (!active || active.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        active.moved ||= Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 3;
        active.point = mapPoint(active.projection, local(event));
        if (active.moved && active.admitted) pan(active.point);
      }}
      onPointerUp={(event) => {
        if (session.current?.pointerId !== event.pointerId) return;
        session.current.point = mapPoint(session.current.projection, local(event));
        event.preventDefault(); event.stopPropagation(); finish();
      }}
      onPointerCancel={(event) => { if (session.current?.pointerId === event.pointerId) finish(true); }}
      onLostPointerCapture={(event) => { if (session.current?.pointerId === event.pointerId) finish(true); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && session.current) { event.stopPropagation(); finish(true); return; }
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!direction) return;
        event.preventDefault(); event.stopPropagation();
        const center = viewportCenterInWorld(camera, size);
        pan({ x: center.x + direction[0] * size.width / camera.zoom * 0.1,
          y: center.y + direction[1] * size.height / camera.zoom * 0.1 }, true);
      }}
    >
      <MapGroups groups={groups} projection={shownProjection} focus={focus} />
      <MapBlocks nodes={summaries} projection={shownProjection} focus={focus} />
      <rect className="minimap-viewport" aria-hidden="true"
        x={viewport.x * shownProjection.scale + shownProjection.x}
        y={viewport.y * shownProjection.scale + shownProjection.y}
        width={viewport.width * shownProjection.scale} height={viewport.height * shownProjection.scale} />
      {pulse && <circle key={pulse.key} className="minimap-click-pulse" cx={pulse.x} cy={pulse.y} r={5}
        aria-hidden="true" onAnimationEnd={() => setPulse(undefined)} />}
    </svg>
  </section>;
}

const MapBlocks = memo(function MapBlocks({ nodes, projection, focus }: {
  nodes: ContentSummary[]; projection: MapProjection; focus: (id: string) => void;
}) {
  return <g className="minimap-blocks">
    {nodes.map((node) => {
      const x = node.x * projection.scale + projection.x, y = node.y * projection.scale + projection.y;
      const width = Math.max(2, node.width * projection.scale), height = Math.max(node.presentation === 'text-box' ? 4 : 2, node.height * projection.scale);
      const common = { 'data-map-node': node.id, role: 'button', tabIndex: 0,
        'aria-label': `聚焦${node.presentation === 'text-box' ? '文本框' : '节点'}：${node.title}`,
        onKeyDown: (event: import('react').KeyboardEvent<SVGElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault(); event.stopPropagation(); focus(node.id);
        } };
      return node.presentation === 'text-box' ? <g key={node.id} {...common} className="minimap-text-box" fill="none" stroke={node.titleColor} strokeWidth={1.2}>
        <rect className="minimap-entity-hit" x={x} y={y} width={width} height={height} fill="transparent" stroke="none" />
        <rect className="minimap-text-box-outline" x={x} y={y} width={width} height={height} rx={1} />
        <line className="minimap-text-box-bar" x1={x} x2={x + width} y1={y + height / 2} y2={y + height / 2} />
      </g> : <rect key={node.id} {...common}
      x={x} y={y} width={width} height={height}
      fill={node.titleColor} rx={1}
      />;
    })}
  </g>;
});

const MapGroups = memo(function MapGroups({ groups, projection, focus }: {
  groups: CanvasOverviewEntity[]; projection: MapProjection; focus: (id: string) => void;
}) {
  return <g className="minimap-groups">{groups.map((group, index) => <rect key={group.id} data-map-group={group.id}
    role="button" tabIndex={0} aria-label={`聚焦群组 ${index + 1}`}
    x={group.x * projection.scale + projection.x} y={group.y * projection.scale + projection.y}
    width={Math.max(2, group.width * projection.scale)} height={Math.max(2, group.height * projection.scale)}
    fill={group.color ?? 'var(--minimap-ink)'} fillOpacity={0.16} stroke="none" rx={2}
    onKeyDown={event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); event.stopPropagation(); focus(group.id);
    }} />)}</g>;
});
