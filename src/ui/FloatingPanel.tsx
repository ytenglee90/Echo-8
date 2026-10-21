'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { FloatingPanelRect } from '../protocols/floating.ts';
import { Icon, IconButton, type IconName } from './Icon.tsx';

let floatingSequence = 80;

export function FloatingPanel({
  title,
  titleDetail,
  titleDetailTitle,
  icon,
  rect,
  className = '',
  onPreview,
  onRenderedRectChange,
  onCommit,
  onClose,
  onActivate,
  avoidRightRail = true,
  localHistory = false,
  headerActions,
  children,
}: {
  title: string;
  titleDetail?: string;
  titleDetailTitle?: string;
  icon: IconName;
  rect: FloatingPanelRect;
  className?: string;
  onPreview?: (rect: FloatingPanelRect) => void;
  onRenderedRectChange?: (rect: FloatingPanelRect) => void;
  onCommit: (rect: FloatingPanelRect) => void;
  onClose: () => void;
  onActivate?: () => void;
  /** Keep workspace tools out of a visible dock; editor-anchored popups opt out. */
  avoidRightRail?: boolean;
  localHistory?: boolean;
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState(() => clampToViewport(rect, avoidRightRail));
  const [zIndex, setZIndex] = useState(() => ++floatingSequence);
  const interaction = useRef<{
    kind: 'move' | 'resize';
    pointerX: number;
    pointerY: number;
    origin: FloatingPanelRect;
  } | null>(null);

  useEffect(() => {
    if (!interaction.current) setDraft(clampToViewport(rect, avoidRightRail));
  }, [avoidRightRail, rect]);

  useEffect(() => {
    onRenderedRectChange?.(draft);
  }, [draft, onRenderedRectChange]);

  useEffect(() => {
    const keepClearOfDock = () => setDraft((current) => {
      const next = clampToViewport(current, avoidRightRail);
      return sameRect(current, next) ? current : next;
    });
    const rail = globalThis.document?.querySelector<HTMLElement>('.right-rail');
    const observer = rail && typeof ResizeObserver === 'function' ? new ResizeObserver(keepClearOfDock) : undefined;
    if (rail) observer?.observe(rail);
    globalThis.addEventListener?.('resize', keepClearOfDock);
    keepClearOfDock();
    return () => {
      observer?.disconnect();
      globalThis.removeEventListener?.('resize', keepClearOfDock);
    };
  }, [avoidRightRail]);

  const start = (kind: 'move' | 'resize', event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (kind === 'move' && (event.target as HTMLElement).closest('button,input,select,textarea')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setZIndex(++floatingSequence);
    interaction.current = {
      kind,
      pointerX: event.clientX,
      pointerY: event.clientY,
      origin: draft,
    };
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const active = interaction.current;
    if (!active) return;
    const dx = event.clientX - active.pointerX;
    const dy = event.clientY - active.pointerY;
    const next = clampToViewport(active.kind === 'move'
      ? { ...active.origin, x: active.origin.x + dx, y: active.origin.y + dy }
      : { ...active.origin, width: active.origin.width + dx, height: active.origin.height + dy }, avoidRightRail);
    setDraft(next);
    onPreview?.(next);
  };
  const finish = () => {
    if (!interaction.current) return;
    interaction.current = null;
    onCommit(draft);
  };
  const cancel = () => {
    interaction.current = null;
    setDraft(clampToViewport(rect, avoidRightRail));
  };

  return (
    <section
      className={`floating-panel ${className}`}
      aria-label={title}
      data-local-history={localHistory ? 'true' : undefined}
      style={{ left: draft.x, top: draft.y, width: draft.width, height: draft.height, zIndex }}
      onPointerDown={() => {
        setZIndex(++floatingSequence);
        onActivate?.();
      }}
    >
      <header
        className="floating-panel-header"
        onPointerDown={(event) => start('move', event)}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
      >
        <span className="floating-panel-title">
          <Icon name={icon} />
          <strong>{title}</strong>
          {titleDetail && <small title={titleDetailTitle ?? titleDetail}>{titleDetail}</small>}
        </span>
        <span className="floating-panel-actions">{headerActions}<IconButton icon="close" label={`关闭${title}`} onClick={onClose} /></span>
      </header>
      <div className="floating-panel-body">{children}</div>
      <button
        type="button"
        className="floating-resize-handle"
        aria-label={`调整${title}大小`}
        title={`调整${title}大小`}
        onPointerDown={(event) => start('resize', event)}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onKeyDown={(event) => {
          if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const step = event.shiftKey ? 40 : 12;
          const next = clampToViewport({
            ...draft,
            width: draft.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
            height: draft.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
          }, avoidRightRail);
          setDraft(next);
          onCommit(next);
        }}
      ><Icon name="resize" size={14} /></button>
    </section>
  );
}

function clampToViewport(rect: FloatingPanelRect, avoidRightRail: boolean): FloatingPanelRect {
  const viewportWidth = Math.max(360, globalThis.innerWidth || 1440);
  const viewportHeight = Math.max(420, globalThis.innerHeight || 900);
  const rail = globalThis.document?.querySelector<HTMLElement>('.right-rail');
  const railRect = rail?.getBoundingClientRect();
  const rightBoundary = avoidRightRail && railRect && railRect.width > 0
    ? Math.max(360, railRect.left - 8)
    : viewportWidth;
  const width = Math.min(Math.max(320, rect.width), rightBoundary - 16);
  const height = Math.min(Math.max(320, rect.height), viewportHeight - 64);
  return {
    width,
    height,
    x: Math.min(Math.max(8, rect.x), Math.max(8, rightBoundary - width - 8)),
    y: Math.min(Math.max(56, rect.y), Math.max(56, viewportHeight - height - 8)),
  };
}

function sameRect(left: FloatingPanelRect, right: FloatingPanelRect): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
