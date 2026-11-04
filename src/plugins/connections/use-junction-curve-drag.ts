'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { createId, type ViewClient } from '../../core/contracts.ts';
import type { CameraState } from '../../protocols/canvas.ts';
import type { ConnectionGraphSnapshot, ConnectionJunction, ConnectionJunctionHandlePreview, ConnectionRecord } from '../../protocols/connections.ts';

interface CurveDrag {
  token: string; pointerId: number; capture: SVGSVGElement; point: ConnectionJunction;
  startX: number; startY: number; startAngle: number; angle: number;
  moved: boolean; ready: Promise<unknown>; admitted: boolean;
}

/** Selected junctions own nearby curve steering; the document changes once, after release. */
export function useJunctionCurveDrag(client: ViewClient, camera: CameraState, junctions: readonly ConnectionJunction[], selected: ReadonlySet<string>) {
  const active = useRef<CurveDrag | undefined>(undefined), owner = useRef<string | undefined>(undefined);
  const pending = useRef<{ token: string; id: string; revision: number; angle: number } | undefined>(undefined);
  const [settlement, setSettlement] = useState<string>();
  const clear = useCallback((token: string) => {
    if (owner.current !== token) return;
    owner.current = undefined; pending.current = undefined;
    client.emit('connection.junction.handle.preview@1', { clear: true } satisfies ConnectionJunctionHandlePreview);
  }, [client]);
  useEffect(() => {
    const target = pending.current;
    if (!target || target.token !== settlement) return;
    const point = junctions.find(point => point.id === target.id);
    if (!point || (point.revision === target.revision && (point.handleAngle ?? 0) === target.angle)) clear(target.token);
    else {
      try {
        const current = client.requestSync<ConnectionGraphSnapshot>('connections.graph@1').junctions.find(point => point.id === target.id);
        if (point.revision === current?.revision && (point.handleAngle ?? 0) === (current?.handleAngle ?? 0) && current.revision !== target.revision) clear(target.token);
      } catch { clear(target.token); }
    }
  }, [clear, client, junctions, settlement]);
  useEffect(() => () => {
    const session = active.current; active.current = undefined;
    if (owner.current) clear(owner.current);
    if (session) {
      if (session.capture.hasPointerCapture(session.pointerId)) session.capture.releasePointerCapture(session.pointerId);
      void client.dispatch('interaction.end', { mode: 'dragging-node', sessionId: session.token }).catch(() => undefined);
    }
  }, [clear, client]);
  const world = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left - camera.x) / camera.zoom, y: (event.clientY - box.top - camera.y) / camera.zoom };
  };
  const begin = (event: PointerEvent<SVGSVGElement>, edge: ConnectionRecord) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || active.current || owner.current) return false;
    const pointer = world(event), ids = new Set([edge.from, edge.to].filter(end => end.kind === 'junction' && selected.has(end.nodeId)).map(end => end.nodeId));
    const point = junctions.filter(point => ids.has(point.id)).map(point => ({ point, distance: Math.hypot(pointer.x - point.x, pointer.y - point.y) }))
      .filter(hit => hit.distance <= 48 / camera.zoom && hit.distance >= 8 / camera.zoom).sort((a, b) => a.distance - b.distance)[0]?.point;
    if (!point) return false;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
    const session: CurveDrag = { token: createId('junction-curve'), pointerId: event.pointerId, capture: event.currentTarget, point,
      startX: event.clientX, startY: event.clientY, startAngle: Math.atan2(pointer.y - point.y, pointer.x - point.x),
      angle: point.handleAngle ?? 0, moved: false, admitted: false, ready: Promise.resolve() };
    active.current = session; owner.current = session.token;
    session.ready = client.dispatch('interaction.begin', { mode: 'dragging-node', sessionId: session.token }).then(() => { session.admitted = true; }).catch(() => {
      if (active.current === session) { active.current = undefined; clear(session.token); }
    });
    return true;
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const session = active.current;
    if (!session || session.pointerId !== event.pointerId) return false;
    event.preventDefault(); event.stopPropagation();
    session.moved ||= Math.hypot(event.clientX - session.startX, event.clientY - session.startY) > 3;
    const pointer = world(event);
    if (!session.moved || Math.hypot(pointer.x - session.point.x, pointer.y - session.point.y) < 6 / camera.zoom) return true;
    const delta = (Math.atan2(pointer.y - session.point.y, pointer.x - session.point.x) - session.startAngle) * 180 / Math.PI;
    const turn = ((delta + 270) % 180 + 180) % 180 - 90;
    session.angle = ((Math.round(((session.point.handleAngle ?? 0) + turn) / 15) * 15) % 360 + 360) % 360;
    client.emit('connection.junction.handle.preview@1', { id: session.point.id, handleAngle: session.angle, expectedRevision: session.point.revision } satisfies ConnectionJunctionHandlePreview);
    return true;
  };
  const finish = (event?: PointerEvent<SVGSVGElement>, cancel = false) => {
    const session = active.current;
    if (!session || (event && event.pointerId !== session.pointerId)) return false;
    if (cancel && event?.type === 'lostpointercapture' && session.capture.hasPointerCapture(session.pointerId)) return false;
    if (event && !cancel) move(event);
    event?.preventDefault(); event?.stopPropagation(); active.current = undefined;
    if (session.capture.hasPointerCapture(session.pointerId)) session.capture.releasePointerCapture(session.pointerId);
    const ended = client.dispatch('interaction.end', { mode: 'dragging-node', sessionId: session.token });
    if (cancel) clear(session.token);
    void ended.then(async () => {
      await session.ready;
      if (cancel || !session.admitted || !session.moved || session.angle === (session.point.handleAngle ?? 0) || owner.current !== session.token) { clear(session.token); return; }
      const result = await client.dispatch('connection.setJunctionHandle@1', { id: session.point.id, handleAngle: session.angle, expectedRevision: session.point.revision });
      if (owner.current !== session.token) return;
      pending.current = { token: session.token, id: session.point.id, revision: result.revision, angle: result.handleAngle };
      setSettlement(session.token);
    }).catch(() => clear(session.token));
    return true;
  };
  return { begin, move, finish, cancel: () => finish(undefined, true) };
}
