'use client';

import { useEffect, useRef, type PointerEvent } from 'react';
import { createId, type ViewClient } from '../core/contracts.ts';
import type { CameraState, CanvasViewportSize } from '../protocols/canvas.ts';
import { connectionJunctionRequest, connectionTargetSide, connectionUsesTextBoxRegions, connectionGroupPortHit, connectionTitlePortHit, type ConnectionDraft, type ConnectionEndpoint, type ConnectionReconnectRequest, type ConnectionNodeGeometry, type ConnectionGraphSnapshot } from '../protocols/connections.ts';

type ReconnectGesture = Pick<ConnectionReconnectRequest, 'id' | 'expectedRevision' | 'titleOrigin'> & { end?: 'from' | 'to'; startSide?: 'left' | 'right' };

interface ConnectGesture {
  token: string; pointerId: number; startX: number; startY: number; point: ConnectionNodeGeometry;
  reconnect?: ReconnectGesture;
  draft: ConnectionDraft; moved: boolean; admitted: boolean; title: boolean;
}

/** Shared governed endpoint drag adapter. Feature providers supply target geometry and endpoint kinds. */
export function useConnectionGesture(client: ViewClient, camera: CameraState, nodes: ReadonlyMap<string, ConnectionNodeGeometry>) {
  const active = useRef<ConnectGesture | undefined>(undefined);
  const previewOwner = useRef<string | undefined>(undefined);
  const clear = (session: ConnectGesture) => {
    if (previewOwner.current !== session.token) return;
    previewOwner.current = undefined;
    client.emit('connection.draft.preview', {});
  };
  useEffect(() => () => {
    const session = active.current;
    active.current = undefined;
    if (previewOwner.current) { previewOwner.current = undefined; client.emit('connection.draft.preview', {}); }
    if (!session) return;
    void client.dispatch('interaction.end', { mode: 'connecting', sessionId: session.token }).catch(() => undefined);
  }, [client]);
  const begin = (event: PointerEvent<SVGElement | HTMLElement>, point: ConnectionNodeGeometry, title = false, side: ConnectionEndpoint['side'] = 'right', reconnect?: ReconnectGesture) => {
    if (event.button !== 0 || active.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const capture = reconnect && 'ownerSVGElement' in event.currentTarget ? event.currentTarget.ownerSVGElement ?? event.currentTarget : event.currentTarget;
    capture.setPointerCapture(event.pointerId);
    const session: ConnectGesture = {
      token: createId('connection-drag'), pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      point, moved: false, admitted: false, title, reconnect,
      draft: { titleStartSide: reconnect?.startSide, titleOrigin: reconnect?.titleOrigin, reconnectId: reconnect?.id, reconnectRevision: reconnect?.expectedRevision, from: { nodeId: point.id, kind: point.kind, side }, titleRoute: title, pointer: { x: point.x + (side === 'right' ? point.width : 0), y: point.y + point.height / 2 } },
    };
    active.current = session;
    previewOwner.current = session.token;
    client.emit('connection.draft.preview', session.draft);
    void client.dispatch('interaction.begin', { mode: 'connecting', sessionId: session.token }).then(() => {
      session.admitted = true;
    }).catch(() => {
      if (active.current !== session) return;
      active.current = undefined;
      clear(session);
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
    // An explicit title port wins over a surrounding group's larger input region.
    if (!target) for (const [id, node] of nodes) {
      if (id === session.point.id || !connectionTitlePortHit(node, pointer)) continue;
      const distance = Math.hypot(Math.min(Math.abs(pointer.x - node.x), Math.abs(pointer.x - node.x - node.width)), pointer.y - node.y - 21);
      if (distance < nearest) { target = { nodeId: id, side: 'title' }; nearest = distance; }
    }
    if (!target) for (const [id, node] of nodes) {
      if (node.kind === 'junction' || id === session.point.id) continue;
      if (node.kind === 'group') {
        const hit = connectionGroupPortHit(node, pointer, camera.zoom);
        if (hit && hit.distance < nearest) { nearest = hit.distance; target = { nodeId: id, kind: 'group', side: hit.side }; }
        continue;
      }
      const slop = 18 / camera.zoom;
      if (pointer.x < node.x - slop || pointer.x > node.x + node.width + slop || pointer.y < node.y - slop || pointer.y > node.y + node.height + slop) continue;
      const distance = Math.hypot(pointer.x - node.x - node.width / 2, pointer.y - node.y - node.height / 2);
      if (distance < nearest) {
        nearest = distance;
        target = { nodeId: id, side: connectionTargetSide(node, pointer, session.title, session.point) };
      }
    }
    const boxPair = target && connectionUsesTextBoxRegions(session.point, nodes.get(target.nodeId));
    const title = boxPair ? target?.side === 'title' : session.title || target?.side === 'title';
    const targetNode = target ? nodes.get(target.nodeId) : undefined;
    const titleStartSide = session.reconnect?.end === 'from' && targetNode && !targetNode.kind && title
      ? pointer.x < targetNode.x + targetNode.width / 2 ? 'left' as const : 'right' as const : session.draft.titleStartSide;
    session.draft = { ...session.draft, titleRoute: title, titleStartSide, from: { nodeId: session.point.id, kind: session.point.kind,
      side: title && !session.point.kind ? 'title' : pointer.x < session.point.x + session.point.width / 2 ? 'left' : 'right' }, to: target, pointer };
    if (target && targetNode && session.draft.from) {
      try {
        const graph = client.requestSync<ConnectionGraphSnapshot>('connections.graph@1');
        session.draft = { ...session.draft, ...connectionJunctionRequest({ from: session.draft.from, to: target }, session.point, targetNode, graph.connections) };
      } catch { /* Optional owner may be stopping. */ }
    }
    client.emit('connection.draft.preview', session.draft);
  };
  const finish = (event?: PointerEvent<SVGElement | HTMLElement>, cancel = false) => {
    const session = active.current;
    if (!session || (event && session.pointerId !== event.pointerId)) return;
    event?.preventDefault(); event?.stopPropagation();
    if (event && !cancel) move(event);
    active.current = undefined;
    if (!session.reconnect || cancel || !session.moved || !session.draft.to) clear(session);
    void client.dispatch('interaction.end', { mode: 'connecting', sessionId: session.token }).then(() => {
      if (cancel || !session.admitted || !session.moved || !session.draft.to) { clear(session); return; }
      if (!session.reconnect) return client.dispatch('connection.create', { from: session.draft.from!, to: session.draft.to });
      const from = session.reconnect.end === 'from' ? session.draft.to : session.draft.from!;
      const to = session.reconnect.end === 'from' ? session.draft.from! : session.draft.to;
      const fromNode = nodes.get(from.nodeId), toNode = nodes.get(to.nodeId);
      const titleOrigin = session.draft.titleStartSide && !from.kind && !to.kind && (from.side === 'title' || to.side === 'title') && fromNode && toNode
        ? { side: session.draft.titleStartSide, sourceIsLeft: fromNode.x + fromNode.width / 2 <= toNode.x + toNode.width / 2 } : undefined;
      return client.dispatch('connection.reconnect', { id: session.reconnect.id, expectedRevision: session.reconnect.expectedRevision, from, to, titleOrigin });
    }).then(() => { if (previewOwner.current === session.token) previewOwner.current = undefined; }).catch(() => clear(session));
  };
  return { begin, move, finish, cancel: () => finish(undefined, true) };
}
