'use client';

import { useEffect, useRef, type PointerEvent } from 'react';
import { createId, type ViewClient } from '../../core/contracts.ts';
import type { CameraState, CanvasSnapPreview } from '../../protocols/canvas.ts';
import type { ConnectionJunction, ConnectionJunctionPreview } from '../../protocols/connections.ts';
import type { SmartSnapRequest, SmartSnapResult } from '../../protocols/layout.ts';

interface JunctionDrag {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  origins: ConnectionJunction[];
  primaryId: string;
  collapseOnClick: boolean;
  latest: Array<{ id: string; x: number; y: number }>;
  moved: boolean;
  admitted: boolean;
}

/** An owned gesture with coalesced previews and one revision-checked durable move. */
export function useJunctionDrag(client: ViewClient, camera: CameraState, junctions: ConnectionJunction[], selected: ReadonlySet<string>) {
  const session = useRef<JunctionDrag | undefined>(undefined);
  const previewOwner = useRef<string | undefined>(undefined);
  const clear = (owner: string) => {
    if (previewOwner.current !== owner) return;
    previewOwner.current = undefined;
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
    client.emit('connection.junction.preview', { clear: true } satisfies ConnectionJunctionPreview);
  };
  useEffect(() => () => {
    const active = session.current;
    const hadPreview = previewOwner.current !== undefined;
    session.current = undefined;
    previewOwner.current = undefined;
    if (active || hadPreview) {
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      client.emit('connection.junction.preview', { clear: true } satisfies ConnectionJunctionPreview);
    }
    if (!active) return;
    void client.dispatch('interaction.end', { mode: 'dragging-node', sessionId: active.id }).catch(() => undefined);
  }, [client]);

  const begin = (event: PointerEvent<SVGGElement>, point: ConnectionJunction) => {
    if (event.button !== 0 || session.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const toggle = event.ctrlKey || event.metaKey;
    if (toggle && selected.has(point.id)) {
      void client.dispatch('selection.set', { items: [{ id: point.id, kind: 'connection-junction' }], mode: 'toggle' });
      return;
    }
    const origins = selected.has(point.id) || event.shiftKey || toggle
      ? junctions.filter(item => selected.has(item.id) || item.id === point.id) : [point];
    const active: JunctionDrag = {
      id: createId('junction-drag'), pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY,
      origins, primaryId: point.id, collapseOnClick: !event.shiftKey && !toggle,
      latest: origins.map(({ id, x, y }) => ({ id, x, y })), moved: false, admitted: false,
    };
    session.current = active;
    previewOwner.current = active.id;
    void client.dispatch('interaction.begin', { mode: 'dragging-node', sessionId: active.id }).then(() => {
      active.admitted = true;
    }).catch(() => {
      if (session.current !== active) return;
      session.current = undefined;
      clear(active.id);
    });
    if (!selected.has(point.id) || event.shiftKey || toggle) void client.dispatch('selection.set', {
      items: [{ id: point.id, kind: 'connection-junction' }],
      mode: event.shiftKey ? 'add' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace',
    });
  };

  const move = (event: PointerEvent<SVGGElement>) => {
    const active = session.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = (event.clientX - active.startX) / camera.zoom;
    const dy = (event.clientY - active.startY) / camera.zoom;
    active.moved ||= Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 3;
    if (!active.moved) return;
    const raw = active.origins.map(point => ({ id: point.id, x: point.x + dx, y: point.y + dy }));
    const left = Math.min(...raw.map(point => point.x)), top = Math.min(...raw.map(point => point.y));
    let snap: SmartSnapResult = { offsetX: 0, offsetY: 0, guides: [] };
    try {
      snap = client.requestSync<SmartSnapResult>('layout.snap@1', {
        dragged: { x: left, y: top, width: Math.max(...raw.map(point => point.x)) - left, height: Math.max(...raw.map(point => point.y)) - top }, movingIds: active.origins.map(point => point.id),
        mode: 'nodes', threshold: 18 / camera.zoom,
      } satisfies SmartSnapRequest);
    } catch { /* Stopping smart layout leaves free positioning available. */ }
    active.latest = raw.map(point => ({ ...point, x: point.x + snap.offsetX, y: point.y + snap.offsetY }));
    client.emit('canvas.snap.preview', snap.guides.length
      ? { guides: snap.guides } satisfies CanvasSnapPreview
      : { clear: true } satisfies CanvasSnapPreview);
    client.emit('connection.junction.preview', { positions: active.latest } satisfies ConnectionJunctionPreview);
  };

  const finish = (event?: PointerEvent<SVGGElement>, cancel = false) => {
    const active = session.current;
    if (!active || (event && active.pointerId !== event.pointerId)) return;
    event?.preventDefault();
    event?.stopPropagation();
    session.current = undefined;
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
    // Queue the end before another gesture can begin. It cannot release a
    // different owner's or newer gesture's session, even after a failed begin.
    void client.dispatch('interaction.end', { mode: 'dragging-node', sessionId: active.id }).then(() => {
      if (cancel || !active.admitted) return;
      if (!active.moved) return active.collapseOnClick ? client.dispatch('selection.set', { items: [{ id: active.primaryId, kind: 'connection-junction' }], mode: 'replace' }) : undefined;
      const revisions = new Map(active.origins.map(point => [point.id, point.revision]));
      return client.dispatch('connection.moveJunctions', { positions: active.latest.map(point => ({ ...point, expectedRevision: revisions.get(point.id)! })) });
    }).finally(() => clear(active.id)).catch(() => undefined);
  };
  return { begin, move, finish, cancel: () => finish(undefined, true) };
}
