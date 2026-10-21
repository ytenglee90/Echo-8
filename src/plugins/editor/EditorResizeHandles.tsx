'use client';

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useRef,
} from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { MIN_EDITOR_PANE_WIDTH } from './constants.ts';
import { resizePaneLayout } from './pane-layout.ts';

interface PaneIdentity {
  id: string;
}

export function DockResizeHandle({
  client,
  width,
  minimumWidth,
  boundaryWidth,
  onPreview,
}: {
  client: ViewClient;
  width: number;
  minimumWidth: number;
  boundaryWidth: number;
  onPreview: (width: number | undefined) => void;
}) {
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    latest: number;
  } | undefined>(undefined);
  const preview = (next: number) => {
    const clamped = Math.min(boundaryWidth, Math.max(minimumWidth, Math.round(next)));
    if (gesture.current) gesture.current.latest = clamped;
    client.emit('editor.dock.resize.preview', { width: clamped });
    onPreview(clamped);
  };
  const finish = (element: HTMLElement) => {
    const current = gesture.current;
    if (!current) return;
    if (element.hasPointerCapture(current.pointerId)) element.releasePointerCapture(current.pointerId);
    gesture.current = undefined;
    void (async () => {
      await client.dispatch('editor.setDockWidth', { width: current.latest, boundaryWidth });
      await client.dispatch('interaction.end', { mode: 'resizing-dock' }).catch(() => undefined);
    })();
    onPreview(undefined);
  };
  return (
    <div
      className="dock-resize-handle"
      role="separator"
      aria-label="调整文本编辑区宽度"
      aria-orientation="vertical"
      aria-valuemin={minimumWidth}
      aria-valuemax={boundaryWidth}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
          latest: width,
        };
        void client.dispatch('interaction.begin', { mode: 'resizing-dock' }).catch(() => undefined);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        preview(current.startWidth + current.startX - event.clientX);
      }}
      onPointerUp={(event) => finish(event.currentTarget)}
      onPointerCancel={(event) => {
        gesture.current = undefined;
        onPreview(undefined);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        void client.dispatch('interaction.end', { mode: 'resizing-dock' }).catch(() => undefined);
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = width + (event.key === 'ArrowLeft' ? 24 : -24);
        void client.dispatch('editor.setDockWidth', { width: next, boundaryWidth });
      }}
    />
  );
}

export function PaneResizeHandle({
  client,
  listRef,
  documents,
  dividerIndex,
  dockWidth,
  maximumDockWidth,
  ratios,
  onDockPreview,
  onPreview,
}: {
  client: ViewClient;
  listRef: RefObject<HTMLDivElement | null>;
  documents: PaneIdentity[];
  dividerIndex: number;
  dockWidth: number;
  maximumDockWidth: number;
  ratios: Record<string, number>;
  onDockPreview: (width: number | undefined) => void;
  onPreview: (ratios: Record<string, number> | undefined) => void;
}) {
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    paneWidths: number[];
    startDockWidth: number;
    latestRatios: Record<string, number>;
    latestDockWidth: number;
  } | undefined>(undefined);
  const resize = (delta: number, paneWidths: number[]) => {
    if (paneWidths.length !== documents.length) return { ratios, dockWidth };
    const layout = resizePaneLayout(
      paneWidths,
      dividerIndex,
      delta,
      MIN_EDITOR_PANE_WIDTH,
      gesture.current?.startDockWidth ?? dockWidth,
      maximumDockWidth,
    );
    const nextWidths = layout.widths;
    const totalWidth = nextWidths.reduce((sum, paneWidth) => sum + paneWidth, 0);
    const ratioTotal = documents.reduce((sum, document) => sum + (ratios[document.id] ?? 1), 0);
    if (totalWidth <= 0 || ratioTotal <= 0) return { ratios, dockWidth };
    return {
      dockWidth: layout.dockWidth,
      ratios: Object.fromEntries(documents.map((document, index) => [
        document.id,
        ratioTotal * ((nextWidths[index] ?? 0) / totalWidth),
      ])),
    };
  };
  const paneWidths = () => {
    const panes = listRef.current?.querySelectorAll<HTMLElement>(':scope > .editor-pane');
    if (!panes || panes.length !== documents.length) return undefined;
    const widths = [...panes].map((pane) => pane.getBoundingClientRect().width);
    return widths.every((paneWidth) => paneWidth > 0) ? widths : undefined;
  };
  const finish = (element: HTMLElement) => {
    const current = gesture.current;
    if (!current) return;
    if (element.hasPointerCapture(current.pointerId)) element.releasePointerCapture(current.pointerId);
    gesture.current = undefined;
    void (async () => {
      await client.dispatch('editor.setPaneLayout', {
        width: current.latestDockWidth,
        boundaryWidth: maximumDockWidth,
        ratios: current.latestRatios,
      });
      await client.dispatch('interaction.end', { mode: 'resizing-dock' }).catch(() => undefined);
    })();
    onDockPreview(undefined);
    onPreview(undefined);
  };
  return (
    <div
      className="editor-pane-resize-handle"
      role="separator"
      aria-label={`调整第 ${dividerIndex + 1} 与第 ${dividerIndex + 2} 个编辑器宽度`}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(event) => {
        const widths = paneWidths();
        if (!widths) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          paneWidths: widths,
          startDockWidth: dockWidth,
          latestRatios: ratios,
          latestDockWidth: dockWidth,
        };
        void client.dispatch('interaction.begin', { mode: 'resizing-dock' }).catch(() => undefined);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const next = resize(event.clientX - current.startX, current.paneWidths);
        current.latestRatios = next.ratios;
        current.latestDockWidth = next.dockWidth;
        client.emit('editor.panes.resize.preview', next);
        client.emit('editor.dock.resize.preview', { width: next.dockWidth });
        onDockPreview(next.dockWidth);
        onPreview(next.ratios);
      }}
      onPointerUp={(event) => finish(event.currentTarget)}
      onPointerCancel={(event) => {
        gesture.current = undefined;
        onDockPreview(undefined);
        onPreview(undefined);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        void client.dispatch('interaction.end', { mode: 'resizing-dock' }).catch(() => undefined);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const widths = paneWidths();
        if (!widths) return;
        event.preventDefault();
        const next = resize(event.key === 'ArrowLeft' ? -24 : 24, widths);
        void client.dispatch('editor.setPaneLayout', {
          width: next.dockWidth,
          boundaryWidth: maximumDockWidth,
          ratios: next.ratios,
        });
      }}
    />
  );
}
