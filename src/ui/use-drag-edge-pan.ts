'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { ViewClient } from '../core/contracts.ts';
import type { CameraState } from '../protocols/canvas.ts';
import { edgePanVelocity } from './canvas-edge-pan.ts';

/** The gesture retains capture; this adapter only pans and asks it to reproject its last pointer. */
export function useDragEdgePan(client: ViewClient, camera: CameraState) {
  const current = useRef(camera), frame = useRef<number | undefined>(undefined);
  const active = useRef<{ surface: Element; x: number; y: number; replay: () => void; time?: number; moved: boolean; origin: CameraState } | undefined>(undefined);
  const offset = useRef({ x: 0, y: 0 });
  useEffect(() => client.subscribeSignal<CameraState>('canvas.camera.preview', message => { current.current = message.payload; }), [client]);
  useEffect(() => { current.current = camera; }, [camera]);
  const stopFrame = useCallback(() => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; }, []);
  const finish = useCallback((cancel = false) => {
    stopFrame(); const session = active.current; active.current = undefined; offset.current = { x: 0, y: 0 };
    if (!session?.moved) return;
    if (cancel) { current.current = session.origin; client.emit('canvas.camera.preview', session.origin); }
    else void client.dispatch('canvas.camera.commit', current.current).catch(() => undefined);
  }, [client, stopFrame]);
  useEffect(() => () => finish(true), [finish]);
  const track = (target: Element, x: number, y: number, replay: () => void) => {
    const surface = target.closest('.canvas-host'); if (!surface) return;
    const session = active.current ?? { surface, x, y, replay, moved: false, origin: current.current };
    Object.assign(session, { x, y, replay }); active.current = session;
    if (frame.current !== undefined) return;
    const tick = (time: number) => {
      const state = active.current;
      if (!state || !state.surface.isConnected) { finish(true); return; }
      const rect = state.surface.getBoundingClientRect(), scale = Math.min(32, Math.max(0, time - (state.time ?? time - 1000 / 60))) / (1000 / 60);
      const vx = edgePanVelocity(state.x - rect.left, rect.width) * scale, vy = edgePanVelocity(state.y - rect.top, rect.height) * scale;
      if (!vx && !vy) { state.time = undefined; frame.current = undefined; return; }
      state.time = time; state.moved = true;
      offset.current = { x: offset.current.x + vx / current.current.zoom, y: offset.current.y + vy / current.current.zoom };
      current.current = { ...current.current, x: current.current.x - vx, y: current.current.y - vy };
      client.emit('canvas.camera.preview', current.current);
      frame.current = requestAnimationFrame(tick);
      state.replay();
    };
    frame.current = requestAnimationFrame(tick);
  };
  return { track, finish, pause: stopFrame, offset: () => offset.current };
}
