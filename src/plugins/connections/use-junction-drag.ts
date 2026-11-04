'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { createId, type ViewClient } from '../../core/contracts.ts';
import type { CameraState, CanvasSnapPreview } from '../../protocols/canvas.ts';
import type { ConnectionGraphSnapshot, ConnectionJunction, ConnectionJunctionPreview } from '../../protocols/connections.ts';
import type { SmartSnapRequest, SmartSnapResult } from '../../protocols/layout.ts';

interface JunctionDrag {
  id: string;
  pointerId: number;
  capture: SVGGElement;
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
  const commitTail = useRef<Promise<unknown>>(Promise.resolve());
  const ownRevisions = useRef(new Map<string, { revision: number; x: number; y: number }>());
  const optimistic = useRef(new Map<string, { owner: string; x: number; y: number }>());
  const mounted = useRef(true);
  const settlement = useRef<{ owner: string; positions: ConnectionJunction[] } | undefined>(undefined);
  const [settlementOwner, setSettlementOwner] = useState<string>();
  const clear = useCallback((owner: string) => {
    for (const [id, pending] of optimistic.current) if (pending.owner === owner) optimistic.current.delete(id);
    if (previewOwner.current !== owner) return;
    previewOwner.current = undefined;
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
    client.emit('connection.junction.preview', { clear: true } satisfies ConnectionJunctionPreview);
  }, [client]);
  useEffect(() => {
    const projection = new Map(junctions.map(point => [point.id, point]));
    for (const id of ownRevisions.current.keys()) if (!projection.has(id)) ownRevisions.current.delete(id);
    for (const id of optimistic.current.keys()) if (!projection.has(id)) optimistic.current.delete(id);
    const pending = settlement.current;
    if (!pending || pending.owner !== settlementOwner) return;
    const matches = (point: ConnectionJunction | undefined, target: ConnectionJunction | undefined) =>
      point && target ? point.revision === target.revision && point.x === target.x && point.y === target.y : point === target;
    const projected = pending.positions.every(target => matches(projection.get(target.id), target));
    if (!projected) {
      let current: Map<string, ConnectionJunction>;
      try { current = new Map(client.requestSync<ConnectionGraphSnapshot>('connections.graph@1').junctions.map(point => [point.id, point])); }
      catch { return; }
      // An unrelated earlier graph refresh is not an acknowledgement. Undo/deletion wins only once its owner projection is visible.
      const changed = pending.positions.some(target => !matches(current.get(target.id), target));
      const synchronized = pending.positions.every(target => matches(projection.get(target.id), current.get(target.id)));
      if (!changed || !synchronized) return;
    }
    clear(pending.owner); settlement.current = undefined;
  }, [clear, client, junctions, settlementOwner]);
  useEffect(() => {
    mounted.current = true;
    const optimisticCache = optimistic.current, revisionCache = ownRevisions.current;
    return () => {
      mounted.current = false;
      const active = session.current;
      const hadPreview = previewOwner.current !== undefined;
      session.current = undefined;
      previewOwner.current = undefined;
      if (active?.capture.hasPointerCapture(active.pointerId)) active.capture.releasePointerCapture(active.pointerId);
      if (active || hadPreview) {
        client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
        client.emit('connection.junction.preview', { clear: true } satisfies ConnectionJunctionPreview);
      }
      optimisticCache.clear(); revisionCache.clear(); settlement.current = undefined;
      if (!active) return;
      void client.dispatch('interaction.end', { mode: 'dragging-node', sessionId: active.id }).catch(() => undefined);
    };
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
    let current = junctions;
    try { current = client.requestSync<ConnectionGraphSnapshot>('connections.graph@1').junctions; } catch { /* Owner may be stopping. */ }
    const origins = (selected.has(point.id) || event.shiftKey || toggle
      ? current.filter(item => selected.has(item.id) || item.id === point.id) : [current.find(item => item.id === point.id) ?? point])
      .map(item => {
        const pending = optimistic.current.get(item.id);
        if (pending) return { ...item, x: pending.x, y: pending.y };
        return item.id === point.id && item.revision === point.revision ? { ...item, x: point.x, y: point.y } : item;
      });
    const pendingAtBegin = new Set(origins.filter(item => optimistic.current.has(item.id)).map(item => item.id));
    const active: JunctionDrag = {
      id: createId('junction-drag'), pointerId: event.pointerId, capture: event.currentTarget,
      startX: event.clientX, startY: event.clientY,
      origins, primaryId: point.id, collapseOnClick: !event.shiftKey && !toggle,
      latest: origins.map(({ id, x, y }) => ({ id, x, y })), moved: false, admitted: false,
    };
    session.current = active;
    previewOwner.current = active.id;
    void client.dispatch('interaction.begin', { mode: 'dragging-node', sessionId: active.id }).then(() => {
      active.admitted = true;
      // Earlier node moves may have committed while admission was queued. Read their current owner geometry once.
      const graph = client.requestSync<ConnectionGraphSnapshot>('connections.graph@1');
      const fresh = new Map(graph.junctions.map(item => [item.id, item]));
      const old = new Map(active.origins.map(item => [item.id, item]));
      active.origins = active.origins.map(item => pendingAtBegin.has(item.id) ? item : fresh.get(item.id) ?? item);
      const refreshed = new Map(active.origins.map(item => [item.id, item]));
      active.latest = active.latest.map(target => {
        const before = old.get(target.id)!, origin = refreshed.get(target.id)!;
        return { id: target.id, x: origin.x + target.x - before.x, y: origin.y + target.y - before.y };
      });
      if (active.moved && previewOwner.current === active.id) {
        for (const target of active.latest) if (optimistic.current.get(target.id)?.owner === active.id) optimistic.current.set(target.id, { owner: active.id, x: target.x, y: target.y });
        client.emit('connection.junction.preview', { positions: active.latest } satisfies ConnectionJunctionPreview);
      }
    }).catch(() => {
      if (session.current !== active) return;
      session.current = undefined;
      if (active.admitted) void client.dispatch('interaction.end', { mode: 'dragging-node', sessionId: active.id }).catch(() => undefined);
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
    if (event && event.currentTarget !== active.capture) return;
    if (cancel && event?.type === 'lostpointercapture' && active.capture.hasPointerCapture(active.pointerId)) return;
    event?.preventDefault(); event?.stopPropagation();
    // Pointer moves may be coalesced; the release sample owns the final coordinates.
    if (event && !cancel) move(event);
    session.current = undefined;
    if (active.capture.hasPointerCapture(active.pointerId)) active.capture.releasePointerCapture(active.pointerId);
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
    if (!cancel && active.moved) for (const point of active.latest) optimistic.current.set(point.id, { owner: active.id, x: point.x, y: point.y });
    // Queue the end immediately so a later gesture cannot overtake its release.
    const ended = client.dispatch('interaction.end', { mode: 'dragging-node', sessionId: active.id });
    const operation = commitTail.current.catch(() => undefined).then(async () => {
      await ended;
      if (cancel || !active.admitted || !mounted.current) { clear(active.id); return; }
      if (!active.moved) {
        clear(active.id);
        if (active.collapseOnClick) await client.dispatch('selection.set', { items: [{ id: active.primaryId, kind: 'connection-junction' }], mode: 'replace' });
        return;
      }
      const graph = client.requestSync<ConnectionGraphSnapshot>('connections.graph@1');
      const current = new Map(graph.junctions.map(point => [point.id, point]));
      const origins = new Map(active.origins.map(point => [point.id, point]));
      const positions = active.latest.map(target => {
        const origin = origins.get(target.id)!, point = current.get(target.id);
        // Rebase only over this adapter's preceding commits. Foreign changes still fail owner revision validation.
        const last = ownRevisions.current.get(target.id);
        const own = point && last && point.revision === last.revision && point.x === last.x && point.y === last.y;
        return { id: target.id, x: own ? point.x + target.x - origin.x : target.x,
          y: own ? point.y + target.y - origin.y : target.y, expectedRevision: own ? point.revision : origin.revision };
      });
      await client.dispatch('connection.moveJunctions', { positions });
      const committed = positions.flatMap(position => {
        const old = current.get(position.id);
        if (!old) return [];
        const revision = position.expectedRevision + (position.x === old.x && position.y === old.y ? 0 : 1);
        ownRevisions.current.set(position.id, { revision, x: position.x, y: position.y });
        return [{ ...old, x: position.x, y: position.y, revision }];
      });
      if (mounted.current) { settlement.current = { owner: active.id, positions: committed }; setSettlementOwner(active.id); }
    }).catch(() => clear(active.id));
    commitTail.current = operation;
  };
  return { begin, move, finish, cancel: () => finish(undefined, true) };
}
