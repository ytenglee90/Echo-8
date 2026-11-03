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
  origin: ConnectionJunction;
  latest: { x: number; y: number };
  moved: boolean;
  admitted: boolean;
}

/** An owned gesture with coalesced previews and one revision-checked durable move. */
export function useJunctionDrag(client: ViewClient, camera: CameraState) {
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
    const active: JunctionDrag = {
      id: createId('junction-drag'), pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY,
      origin: point, latest: { x: point.x, y: point.y }, moved: false, admitted: false,
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
    void client.dispatch('selection.set', {
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
    const raw = { x: active.origin.x + dx, y: active.origin.y + dy };
    let snap: SmartSnapResult = { offsetX: 0, offsetY: 0, guides: [] };
    try {
      snap = client.requestSync<SmartSnapResult>('layout.snap@1', {
        dragged: { ...raw, width: 0, height: 0 }, movingIds: [active.origin.id],
        mode: 'nodes', threshold: 18 / camera.zoom,
      } satisfies SmartSnapRequest);
    } catch { /* Stopping smart layout leaves free positioning available. */ }
    active.latest = { x: raw.x + snap.offsetX, y: raw.y + snap.offsetY };
    client.emit('canvas.snap.preview', snap.guides.length
      ? { guides: snap.guides } satisfies CanvasSnapPreview
      : { clear: true } satisfies CanvasSnapPreview);
    client.emit('connection.junction.preview', { id: active.origin.id, ...active.latest } satisfies ConnectionJunctionPreview);
  };

  const finish = (event: PointerEvent<SVGGElement>, cancel = false) => {
    const active = session.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    session.current = undefined;
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
    // Queue the end before another gesture can begin. It cannot release a
    // different owner's or newer gesture's session, even after a failed begin.
    void client.dispatch('interaction.end', { mode: 'dragging-node', sessionId: active.id }).then(() => {
      if (cancel || !active.admitted || !active.moved) return;
      return client.dispatch('connection.moveJunction', {
        id: active.origin.id, ...active.latest, expectedRevision: active.origin.revision,
      });
    }).finally(() => clear(active.id)).catch(() => undefined);
  };
  return { begin, move, finish };
}
