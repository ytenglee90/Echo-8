'use client';

import { useEffect, useRef, type RefObject } from 'react';

/** Owns one element-local non-passive wheel listener with deterministic cleanup. */
export function useNonPassiveWheel<T extends HTMLElement>(
  target: RefObject<T | null>,
  listener: (event: WheelEvent) => void,
): void {
  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  }, [listener]);
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const handle = (event: WheelEvent) => listenerRef.current(event);
    element.addEventListener('wheel', handle, { passive: false });
    return () => element.removeEventListener('wheel', handle);
  }, [target]);
}
