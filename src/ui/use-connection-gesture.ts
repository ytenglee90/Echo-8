'use client';

import { useEffect, useRef, type PointerEvent } from 'react';
import { createId, type ViewClient } from '../core/contracts.ts';
import type { CameraState, CanvasViewportSize } from '../protocols/canvas.ts';
import type { ConnectionDraft, ConnectionEndpoint, ConnectionNodeGeometry } from '../protocols/connections.ts';

interface ConnectGesture {
  token: string; pointerId: number; startX: number; startY: number; point: ConnectionNodeGeometry;
  draft: ConnectionDraft; moved: boolean; admitted: boolean; title: boolean;
}

/** Shared governed endpoint drag adapter. Feature providers supply target geometry and endpoint kinds. */
export function useConnectionGesture(client: ViewClient, camera: CameraState, nodes: ReadonlyMap<string, ConnectionNodeGeometry>) {
  const active = useRef<ConnectGesture | undefined>(undefined);
  useEffect(() => () => {
    const session = active.current;
    active.current = undefined;
    if (!session) return;
    client.emit('connection.draft.preview', {});
    void client.dispatch('interaction.end', { mode: 'connecting', sessionId: session.token }).catch(() => undefined);
  }, [client]);
  const begin = (event: PointerEvent<SVGElement | HTMLElement>, point: ConnectionNodeGeometry, title = false, side: ConnectionEndpoint['side'] = 'right') => {
    if (event.button !== 0 || active.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const session: ConnectGesture = {
      token: createId('connection-drag'), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      point, moved: false, admitted: false, title,
      draft: { from: { nodeId: point.id, kind: point.kind, side }, pointer: { x: point.x + (side === 'right' ? point.width : 0), y: point.y + point.height / 2 } },
    };
    active.current = session;
    client.emit('connection.draft.preview', session.draft);
    void client.dispatch('interaction.begin', { mode: 'connecting', sessionId: session.token }).then(() => {
      session.admitted = true;
    }).catch(() => {
      if (active.current !== session) return;
      active.current = undefined;
      client.emit('connection.draft.preview', {});
    });
  };
  const move = (event: PointerEvent<SVGElement | HTMLElement>) => {
    const session = active.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    let box: { left: number; top: number };
    const svg = 'ownerSVGElement' in event.currentTarget ? event.currentTarget.ownerSVGElement : undefined;
    if (svg) box = svg.getBoundingClientRect();
    else { const viewport = client.requestSync<CanvasViewportSize>('canvas.viewport@1'); box = { left: viewport.left ?? 0, top: viewport.top ?? 0 }; }
    const pointer = { x: (event.clientX - box.left - camera.x) / camera.zoom, y: (event.clientY - box.top - camera.y) / camera.zoom };
    session.moved ||= Math.hypot(event.clientX - session.startX, event.clientY - session.startY) > 3;
    let target: ConnectionEndpoint | undefined;
    let nearest = Infinity;
    // Point targets take priority over nearby node rectangles.
    for (const [id, node] of nodes) {
      if (id === session.point.id || node.kind !== 'junction') continue;
      const distance = Math.hypot(pointer.x - node.x, pointer.y - node.y);
      if (distance <= 18 / camera.zoom && distance < nearest) { target = { nodeId: id, kind: 'junction', side: 'left' }; nearest = distance; }
    }
    if (!target) for (const [id, node] of nodes) {
      if (node.kind === 'junction' || id === session.point.id) continue;
      if (node.kind === 'group') {
        for (const side of ['left', 'right'] as const) {
          const distance = Math.hypot(pointer.x - node.x - (side === 'right' ? node.width : 0), pointer.y - node.y - node.height / 2);
          if (distance < nearest && distance <= 18 / camera.zoom) { nearest = distance; target = { nodeId: id, kind: 'group', side }; }
        }
        continue;
      }
      const slop = 18 / camera.zoom;
      if (pointer.x < node.x - slop || pointer.x > node.x + node.width + slop || pointer.y < node.y - slop || pointer.y > node.y + node.height + slop) continue;
      const distance = Math.hypot(pointer.x - node.x - node.width / 2, pointer.y - node.y - node.height / 2);
      if (distance < nearest) {
        nearest = distance;
        target = { nodeId: id, side: session.title || (session.point.kind === 'group' && pointer.y <= node.y + 42 && (pointer.x <= node.x + 24 || pointer.x >= node.x + node.width - 24)) ? 'title' : session.point.x < node.x + node.width / 2 ? 'left' : 'right' };
      }
    }
    session.draft = { ...session.draft, from: { nodeId: session.point.id, kind: session.point.kind, side: pointer.x < session.point.x + session.point.width / 2 ? 'left' : 'right' }, to: target, pointer };
    client.emit('connection.draft.preview', session.draft);
  };
  const finish = (event?: PointerEvent<SVGElement | HTMLElement>, cancel = false) => {
    const session = active.current;
    if (!session || (event && session.pointerId !== event.pointerId)) return;
    event?.preventDefault(); event?.stopPropagation();
    if (event && !cancel) move(event);
    active.current = undefined;
    client.emit('connection.draft.preview', {});
    void client.dispatch('interaction.end', { mode: 'connecting', sessionId: session.token }).then(() => {
      if (cancel || !session.admitted || !session.moved || !session.draft.to) return;
      return client.dispatch('connection.create', { from: session.draft.from!, to: session.draft.to });
    }).catch(() => undefined);
  };
  return { begin, move, finish, cancel: () => finish(undefined, true) };
}
