'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { CameraState, CanvasZoomRequest } from '../../protocols/canvas.ts';
import { useNonPassiveWheel } from '../../ui/use-non-passive-wheel.ts';
import { MAX_ZOOM, MIN_ZOOM } from './surface-geometry.ts';

const DEFAULT_ZOOM = 1;
const MIN_PERCENT = MIN_ZOOM * 100;
const MAX_PERCENT = MAX_ZOOM * 100;

export function CanvasToolbarStatus({ client }: { client: ViewClient }) {
  const workspaceVersion = useSyncExternalStore(
    client.subscribeState,
    client.getWorkspaceVersion,
    () => 0,
  );
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: DEFAULT_ZOOM });
  const [draft, setDraft] = useState('100');
  const [editing, setEditing] = useState(false);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const skipBlurCommit = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    void client.request<CameraState>('canvas.camera@1').then((next) => {
      if (!current) return;
      setCamera(next);
      if (!editing) setDraft(String(Math.round(next.zoom * 100)));
    });
    return () => {
      current = false;
    };
  }, [client, editing, workspaceVersion]);

  useEffect(
    () => client.subscribeSignal<CameraState>('canvas.camera.preview', (message) => {
      setCamera(message.payload);
      if (!editing) setDraft(String(Math.round(message.payload.zoom * 100)));
    }),
    [client, editing],
  );

  useEffect(() => () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
  }, []);

  const requestZoom = (percent: number, commit = false) => {
    const normalized = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
    client.emit('canvas.zoom.requested', {
      zoom: normalized / 100,
      commit,
    } satisfies CanvasZoomRequest);
  };

  const commitDraft = () => {
    const parsed = Number.parseFloat(draft);
    const percent = Number.isFinite(parsed)
      ? Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, parsed))
      : Math.round(camera.zoom * 100);
    setEditing(false);
    setDraft(String(Math.round(percent)));
    requestZoom(percent, true);
  };

  const resetZoom = () => {
    setEditing(false);
    setDraft('100');
    requestZoom(DEFAULT_ZOOM * 100, true);
  };

  useNonPassiveWheel(inputRef, (event) => {
    event.preventDefault();
    const step = event.deltaY < 0 ? 5 : -5;
    const percent = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(camera.zoom * 100) + step));
    setDraft(String(percent));
    requestZoom(percent);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => requestZoom(percent, true), 140);
  });

  return (
    <label
      className="canvas-zoom-status"
      title="画布缩放；双击恢复 100%"
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={draft}
        aria-label={`画布缩放 ${Math.round(camera.zoom * 100)}%`}
        onFocus={(event) => {
          setEditing(true);
          event.currentTarget.select();
        }}
        onChange={(event) => {
          const value = event.currentTarget.value.replace(/[^\d.]/gu, '');
          setDraft(value);
          const parsed = Number.parseFloat(value);
          if (Number.isFinite(parsed) && parsed >= MIN_PERCENT && parsed <= MAX_PERCENT) {
            requestZoom(parsed);
          }
        }}
        onBlur={() => {
          if (skipBlurCommit.current) {
            skipBlurCommit.current = false;
            setEditing(false);
            return;
          }
          commitDraft();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            skipBlurCommit.current = true;
            setDraft(String(Math.round(camera.zoom * 100)));
            event.currentTarget.blur();
          }
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          resetZoom();
          event.currentTarget.select();
        }}
      />
      <span aria-hidden="true">%</span>
    </label>
  );
}
