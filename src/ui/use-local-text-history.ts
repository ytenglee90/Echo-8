'use client';

import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

const LOCAL_HISTORY_LIMIT = 300;

/**
 * Private history for controlled text fields that must not enter document undo.
 * The caller remains the owner of the value; this hook only records user edits.
 */
export function useLocalTextHistory(
  value: string,
  onChange: (value: string) => void,
): {
  change: (value: string) => void;
  startComposition: () => void;
  endComposition: (value: string) => void;
  cancelComposition: () => string | undefined;
  reset: (value: string) => void;
  handleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => boolean;
} {
  const current = useRef(value);
  const undo = useRef<string[]>([]);
  const redo = useRef<string[]>([]);
  const compositionBase = useRef<string | undefined>(undefined);

  useEffect(() => {
    current.current = value;
  }, [value]);

  const change = useCallback((next: string) => {
    const previous = current.current;
    if (next === previous) return;
    if (compositionBase.current !== undefined) {
      current.current = next;
      onChange(next);
      return;
    }
    undo.current.push(previous);
    if (undo.current.length > LOCAL_HISTORY_LIMIT) undo.current.shift();
    redo.current = [];
    current.current = next;
    onChange(next);
  }, [onChange]);

  const startComposition = useCallback(() => {
    if (compositionBase.current === undefined) compositionBase.current = current.current;
  }, []);

  const endComposition = useCallback((next: string) => {
    const base = compositionBase.current;
    compositionBase.current = undefined;
    if (base === undefined) {
      change(next);
      return;
    }
    if (next !== base) {
      undo.current.push(base);
      if (undo.current.length > LOCAL_HISTORY_LIMIT) undo.current.shift();
      redo.current = [];
    }
    current.current = next;
    onChange(next);
  }, [change, onChange]);

  const cancelComposition = useCallback((): string | undefined => {
    const base = compositionBase.current;
    if (base === undefined) return undefined;
    compositionBase.current = undefined;
    current.current = base;
    onChange(base);
    return base;
  }, [onChange]);

  const reset = useCallback((next: string) => {
    compositionBase.current = undefined;
    undo.current = [];
    redo.current = [];
    current.current = next;
    onChange(next);
  }, [onChange]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (event.nativeEvent.isComposing) return false;
    if ((!event.ctrlKey && !event.metaKey) || event.altKey) return false;
    const key = event.key.toLowerCase();
    const wantsUndo = key === 'z' && !event.shiftKey;
    const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey);
    if (!wantsUndo && !wantsRedo) return false;
    const source = wantsUndo ? undo.current : redo.current;
    const target = wantsUndo ? redo.current : undo.current;
    const next = source.pop();
    event.preventDefault();
    event.stopPropagation();
    if (next === undefined) return true;
    target.push(current.current);
    if (target.length > LOCAL_HISTORY_LIMIT) target.shift();
    current.current = next;
    onChange(next);
    return true;
  }, [onChange]);

  return { change, startComposition, endComposition, cancelComposition, reset, handleKeyDown };
}
