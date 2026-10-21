'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type WheelEvent,
} from 'react';
import {
  resolveAIChatScrollMetrics,
  resolveAIChatScrollTopFromThumb,
  type AIChatScrollMetrics,
} from './chat-scroll.ts';

const EMPTY_METRICS: AIChatScrollMetrics = {
  canScroll: false,
  maxScrollTop: 0,
  maxThumbTop: 0,
  thumbHeight: 0,
  thumbTop: 0,
};

function sameMetrics(left: AIChatScrollMetrics, right: AIChatScrollMetrics): boolean {
  return left.canScroll === right.canScroll
    && Math.abs(left.maxScrollTop - right.maxScrollTop) < 0.5
    && Math.abs(left.maxThumbTop - right.maxThumbTop) < 0.5
    && Math.abs(left.thumbHeight - right.thumbHeight) < 0.5
    && Math.abs(left.thumbTop - right.thumbTop) < 0.5;
}

export function scrollAIChatToLatest(feed: HTMLDivElement): void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  feed.scrollTo({
    top: Math.max(0, feed.scrollHeight - feed.clientHeight),
    behavior: reducedMotion ? 'auto' : 'smooth',
  });
}

export function AIChatScrollbar({
  feedId,
  feedRef,
}: {
  feedId: string;
  feedRef: RefObject<HTMLDivElement | null>;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startClientY: number;
    startThumbTop: number;
    metrics: AIChatScrollMetrics;
  } | undefined>(undefined);
  const [metrics, setMetrics] = useState(EMPTY_METRICS);

  const updateMetrics = useCallback(() => {
    const feed = feedRef.current;
    const rail = railRef.current;
    if (!feed || !rail) return;
    const next = resolveAIChatScrollMetrics({
      clientHeight: feed.clientHeight,
      scrollHeight: feed.scrollHeight,
      scrollTop: feed.scrollTop,
      trackHeight: rail.clientHeight,
    });
    setMetrics((current) => sameMetrics(current, next) ? current : next);
  }, [feedRef]);

  useEffect(() => {
    const feed = feedRef.current;
    const rail = railRef.current;
    if (!feed || !rail) return undefined;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateMetrics();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    const mutationObserver = new MutationObserver(scheduleUpdate);
    resizeObserver.observe(feed);
    resizeObserver.observe(rail);
    mutationObserver.observe(feed, { childList: true, characterData: true, subtree: true });
    feed.addEventListener('scroll', scheduleUpdate, { passive: true });
    scheduleUpdate();
    return () => {
      feed.removeEventListener('scroll', scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [feedRef, updateMetrics]);

  const handleDoubleClick = useCallback(() => {
    const feed = feedRef.current;
    if (feed) scrollAIChatToLatest(feed);
  }, [feedRef]);

  const stopDragging = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const feed = feedRef.current;
    if (!feed || !metrics.canScroll || event.button !== 0) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    if (target.closest('.ai-chat-scrollbar-thumb')) {
      dragRef.current = {
        pointerId: event.pointerId,
        startClientY: event.clientY,
        startThumbTop: metrics.thumbTop,
        metrics,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const thumbBounds = event.currentTarget.querySelector<HTMLElement>('.ai-chat-scrollbar-thumb')
      ?.getBoundingClientRect();
    if (!thumbBounds) return;
    feed.scrollBy({
      top: event.clientY < thumbBounds.top ? -feed.clientHeight * 0.85 : feed.clientHeight * 0.85,
      behavior: 'auto',
    });
  }, [feedRef, metrics]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const feed = feedRef.current;
    if (!drag || !feed || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    feed.scrollTop = resolveAIChatScrollTopFromThumb(
      drag.startThumbTop + event.clientY - drag.startClientY,
      drag.metrics,
    );
  }, [feedRef]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const feed = feedRef.current;
    if (!feed || !metrics.canScroll) return;
    const line = 48;
    const page = feed.clientHeight * 0.85;
    let next: number | undefined;
    if (event.key === 'ArrowUp') next = feed.scrollTop - line;
    if (event.key === 'ArrowDown') next = feed.scrollTop + line;
    if (event.key === 'PageUp') next = feed.scrollTop - page;
    if (event.key === 'PageDown') next = feed.scrollTop + page;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = metrics.maxScrollTop;
    if (next === undefined) return;
    event.preventDefault();
    feed.scrollTo({ top: next, behavior: 'auto' });
  }, [feedRef, metrics]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const feed = feedRef.current;
    if (!feed || !metrics.canScroll) return;
    event.preventDefault();
    feed.scrollBy({ top: event.deltaY, left: event.deltaX, behavior: 'auto' });
  }, [feedRef, metrics.canScroll]);

  return (
    <div
      ref={railRef}
      className={`ai-chat-scrollbar${metrics.canScroll ? '' : ' is-hidden'}`}
      role="scrollbar"
      aria-label="AI 对话滚动条，双击跳到最新对话"
      aria-controls={feedId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.round(metrics.maxScrollTop)}
      aria-valuenow={Math.round(Math.min(metrics.maxScrollTop, metrics.maxScrollTop * (
        metrics.maxThumbTop > 0 ? metrics.thumbTop / metrics.maxThumbTop : 0
      )))}
      aria-hidden={!metrics.canScroll}
      tabIndex={metrics.canScroll ? 0 : -1}
      title="双击跳到最新对话"
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
    >
      <span
        className="ai-chat-scrollbar-thumb"
        style={{ height: `${metrics.thumbHeight}px`, transform: `translateY(${metrics.thumbTop}px)` }}
      />
    </div>
  );
}
