'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

import type { ViewClient } from '../../core/contracts.ts';
import type { CameraState } from '../../protocols/canvas.ts';
import type { ConnectionJunction, ConnectionNodeGeometry } from '../../protocols/connections.ts';
import { canvasDetailWorldScale } from '../../ui/canvas-screen-scale.ts';
import { useJunctionDrag } from './use-junction-drag.ts';
import { useJunctionConnect } from './use-junction-connect.ts';
import { OverlapCycle } from './overlap-cycle.ts';
import { OverlapHint, type OverlapHintState } from './OverlapHint.tsx';
import { JUNCTION_MOVE_RADIUS, JUNCTION_PORT_OFFSET, JUNCTION_PORT_RADIUS } from './junction-controls.ts';

export function ConnectionJunctionMarkers({ client, camera, junctions, allJunctions, selected, nodes, titleJunctionIds, targetId, color, hitJunctions }: {
  hitJunctions(x: number, y: number, radius: number): ConnectionJunction[];
  color: string;
  client: ViewClient;
  camera: CameraState;
  junctions: ConnectionJunction[];
  allJunctions: ConnectionJunction[];
  selected: ReadonlySet<string>;
  nodes: ReadonlyMap<string, ConnectionNodeGeometry>;
  titleJunctionIds: ReadonlySet<string>;
  targetId?: string;
}) {
  const drag = useJunctionDrag(client, camera, allJunctions, selected);
  const connect = useJunctionConnect(client, camera, nodes);
  const scale = canvasDetailWorldScale(camera.zoom);
  const paintOrder = useMemo(() => {
    const ordinary: Array<{ point: ConnectionJunction; index: number }> = [], picked: typeof ordinary = [];
    junctions.forEach((point, index) => (selected.has(point.id) ? picked : ordinary).push({ point, index }));
    return [...ordinary, ...picked];
  }, [junctions, selected]);
  const cycle = useRef(new OverlapCycle());
  const [hint, setHint] = useState<OverlapHintState>();
  const noPoints = junctions.length === 0;
  const viewKey = `${camera.x}:${camera.y}:${camera.zoom}`;
  useEffect(() => client.subscribeSignal('canvas.camera.preview', () => { cycle.current.reset(); setHint(undefined); }), [client]);
  const beginDrag = (event: PointerEvent<SVGGElement>, point: ConnectionJunction) => {
    if (event.button !== 0) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) { cycle.current.reset(); setHint(undefined); drag.begin(event, point); return; }
    const svg = event.currentTarget.ownerSVGElement!, rect = svg.getBoundingClientRect();
    const x = (event.clientX - rect.left - camera.x) / camera.zoom, y = (event.clientY - rect.top - camera.y) / camera.zoom;
    const hits = hitJunctions(x, y, JUNCTION_MOVE_RADIUS / camera.zoom)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y) || a.id.localeCompare(b.id));
    if (hits.length < 2) { cycle.current.reset(); setHint(undefined); drag.begin(event, point); return; }
    const byId = new Map(hits.map(p => [p.id, p])), ids = [...byId.keys()].sort(), signature = `${camera.x}:${camera.y}:${camera.zoom}:` + ids.map(id => {
      const p = byId.get(id)!; return `${id}:${p.x}:${p.y}:${p.revision}`;
    }).join('|');
    const next = cycle.current.next(ids, event.clientX, event.clientY, signature, hits[0].id)!;
    const moving = hits.find(p => selected.has(p.id)) ?? hits[0];
    drag.begin(event, moving, () => {
      cycle.current.commit(next, event.clientX, event.clientY, signature);
      setHint({ id: next, x, y, index: ids.indexOf(next), count: ids.length, label: '中转点', viewKey });
      void client.dispatch('selection.set', { items: [{ id: next, kind: 'connection-junction' }], mode: 'replace' });
    });
  };
  const finishDrag = (event: PointerEvent<SVGGElement>, cancel = false) => {
    drag.finish(event, cancel);
  };
  return <g className="connection-junction-layer" tabIndex={-1} style={{ '--connection-junction-color': color } as CSSProperties}
    onPointerLeave={() => { cycle.current.reset(); setHint(undefined); }}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { cycle.current.reset(); setHint(undefined); connect.cancel(); drag.cancel(); event.preventDefault(); event.stopPropagation(); return; }
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      const id = allJunctions.find(point => selected.has(point.id))?.id;
      if (!direction || !id) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      void client.dispatch('connection.nudgeJunction', { id, dx: direction[0] * step, dy: direction[1] * step });
    }}
    onPointerMove={event => {
      if (hint) {
        const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
        if (Math.hypot(event.clientX - rect.left - camera.x - hint.x * camera.zoom, event.clientY - rect.top - camera.y - hint.y * camera.zoom) > 6) { setHint(undefined); cycle.current.reset(); }
      }
      drag.move(event);
    }} onPointerUp={event => finishDrag(event)}
    onPointerCancel={event => finishDrag(event, true)} onLostPointerCapture={event => finishDrag(event, true)}>
    {paintOrder.map(({ point, index }) => <g
      key={point.id}
      className={`connection-junction ${selected.has(point.id) ? 'selected' : ''} ${targetId === point.id ? 'connection-target' : ''}`}
      transform={`translate(${point.x} ${point.y})`}
      data-junction-id={point.id}
      role="button"
      tabIndex={0}
      aria-label={`连接中转点 ${index + 1}`}
      aria-pressed={selected.has(point.id)}
      onPointerDown={(event) => beginDrag(event, point)}
      onPointerEnter={() => client.emit('canvas.entity.hover.preview', { id: point.id })}
      onPointerLeave={() => client.emit('canvas.entity.hover.preview', { id: point.id, clear: true })}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { cycle.current.reset(); setHint(undefined); connect.cancel(); drag.cancel(); event.stopPropagation(); return; }
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 10 : 1;
        void client.dispatch('connection.nudgeJunction', {
          id: point.id, dx: direction[0] * step, dy: direction[1] * step,
        });
      }}
    >
      <title>拖动圆点移动；拖动上方加号拉线；Delete 删除并恢复节点连接</title>
      <circle className="connection-junction-hit" r={JUNCTION_MOVE_RADIUS / camera.zoom} />
      <rect className="connection-junction-port-bridge" x={-14 / camera.zoom} y={-JUNCTION_PORT_OFFSET / camera.zoom} width={28 / camera.zoom} height={(JUNCTION_PORT_OFFSET - JUNCTION_MOVE_RADIUS) / camera.zoom}
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} />
      <circle className="connection-junction-ring" r={9 * scale} strokeWidth={2 * scale} />
      <circle className="connection-junction-dot" r={5 * scale} strokeWidth={1.5 * scale} />
      <g className="connection-junction-port" role="button" tabIndex={0} aria-label="从中转点拉出连接线"
        transform={`translate(0 ${-JUNCTION_PORT_OFFSET / camera.zoom})`}
        onPointerDown={(event) => connect.begin(event, point, titleJunctionIds.has(point.id))}
        onPointerMove={connect.move} onPointerUp={(event) => connect.finish(event)}
        onPointerCancel={(event) => connect.finish(event, true)}
        onLostPointerCapture={(event) => connect.finish(event, true)}>
        <circle className="connection-junction-port-hit" r={JUNCTION_PORT_RADIUS / camera.zoom} />
        <circle className="connection-junction-port-dot" r={6 / camera.zoom} />
        <path d={`M ${-3 / camera.zoom} 0 H ${3 / camera.zoom} M 0 ${-3 / camera.zoom} V ${3 / camera.zoom}`} />
      </g>
    </g>)}
    <OverlapHint hint={!noPoints && hint && selected.has(hint.id) ? hint : undefined} zoom={camera.zoom} viewKey={viewKey} />
  </g>;
}
