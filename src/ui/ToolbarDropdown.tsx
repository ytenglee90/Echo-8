'use client';

import { cloneElement, useEffect, useRef, useState, type ButtonHTMLAttributes, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';

/** Shared view-owned hover/focus menu, using the browser's managed popover layer. */
export function ToolbarDropdown({ trigger, children, label, enabled = true, width = 144, className = '', menuClassName = '', decoration, indicator = true }: {
  trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  children: ReactNode;
  label: string;
  enabled?: boolean;
  width?: number | 'max-content';
  className?: string;
  menuClassName?: string;
  decoration?: ReactNode;
  indicator?: boolean;
}) {
  const launcher = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const suppressFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 48 });
  const visible = enabled && open;
  const clearTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = undefined; };
  const show = () => {
    clearTimer();
    if (!enabled || suppressFocus.current) return;
    const bounds = launcher.current?.getBoundingClientRect();
    const menuWidth = typeof width === 'number' ? width : menu.current?.getBoundingClientRect().width || 144;
    if (bounds) setPosition({ left: Math.max(8, Math.min(bounds.left, globalThis.innerWidth - menuWidth - 8)), top: bounds.bottom + 7 });
    setOpen(true);
  };
  const close = (restoreFocus = false) => {
    clearTimer(); setOpen(false);
    if (menu.current?.matches(':popover-open')) menu.current.hidePopover();
    if (restoreFocus) {
      suppressFocus.current = true;
      launcher.current?.querySelector('button')?.focus();
      queueMicrotask(() => { suppressFocus.current = false; });
    }
  };
  const leave = (event: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (launcher.current?.contains(next) || menu.current?.contains(next))) return;
    clearTimer(); timer.current = setTimeout(() => { timer.current = undefined; setOpen(false); }, 220);
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !enabled) return;
    event.preventDefault(); event.stopPropagation(); show();
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    const key = event.key;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : current < 0 ? key === 'ArrowUp' ? items.length - 1 : 0 : (current + (key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    });
  };
  useEffect(() => {
    const element = menu.current;
    if (!element || typeof element.showPopover !== 'function') return;
    if (visible && !element.matches(':popover-open')) element.showPopover();
    if (!visible && element.matches(':popover-open')) element.hidePopover();
  }, [visible]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
  }, []);
  return <div ref={launcher} className={`toolbar-dropdown ${className}`} onPointerEnter={show} onPointerLeave={leave} onFocus={show} onBlur={leave} onKeyDown={keyDown}>
    <span className="toolbar-dropdown-trigger">
      {cloneElement(trigger, { 'aria-haspopup': enabled ? 'menu' : undefined, 'aria-expanded': enabled ? visible : undefined })}
      {decoration}
      {enabled && indicator && <Icon name="chevron-right" size={8} />}
    </span>
    <div ref={menu} popover="auto" role="menu" aria-label={label} className={`toolbar-dropdown-menu ${menuClassName}`} style={{ ...position, width }}
      onToggle={(event) => { if (event.newState === 'closed') setOpen(false); }}
      onPointerEnter={show} onPointerLeave={leave} onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { if (event.target instanceof Element && event.target.closest('button:not(:disabled)')) close(); }}>
      {children}
    </div>
  </div>;
}
