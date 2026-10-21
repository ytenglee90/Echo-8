'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type PointerEvent } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { useCommandTooltip } from '../../ui/runtime-hooks.ts';
import { AI_UI_NAMESPACE } from './model.ts';
import type { AIAssistantState } from './types.ts';

export function AIAssistantToolbar({ client }: { client: ViewClient }) {
  const version = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion(AI_UI_NAMESPACE),
    () => 0,
  );
  const [state, setState] = useState<AIAssistantState>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const launcherRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tooltip = useCommandTooltip(client, 'ai.open', '打开 AI 助手');

  useEffect(() => {
    let current = true;
    void client.ask<AIAssistantState>('ai.state').then((next) => current && setState(next));
    return () => { current = false; };
  }, [client, version]);

  const sessions = new Map(state?.sessions.map((session) => [session.id, session]) ?? []);
  const opened = state?.assistants ?? [];
  const menuVisible = menuOpen && opened.length > 1;
  const showMenu = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
    if (opened.length < 2) return;
    const bounds = launcherRef.current?.getBoundingClientRect();
    if (bounds) {
      const width = 248;
      setMenuPosition({
        left: Math.max(8, Math.min(bounds.left, globalThis.innerWidth - width - 8)),
        top: bounds.bottom + 7,
      });
    }
    setMenuOpen(true);
  };
  const leaveMenu = (event: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (launcherRef.current?.contains(next) || menuRef.current?.contains(next))) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = undefined;
      setMenuOpen(false);
    }, 220);
  };
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu || typeof menu.showPopover !== 'function') return;
    if (menuVisible && !menu.matches(':popover-open')) menu.showPopover();
    if (!menuVisible && menu.matches(':popover-open')) menu.hidePopover();
  }, [menuVisible]);
  return (
    <div
      ref={launcherRef}
      className="ai-toolbar-launcher"
      onPointerEnter={showMenu}
      onPointerLeave={leaveMenu}
      onFocus={showMenu}
      onBlur={leaveMenu}
    >
      <span className="ai-toolbar-button-wrap">
        <IconButton
          icon="sparkles"
          label={opened.length > 1 ? `${tooltip}；当前打开 ${opened.length} 个窗口` : tooltip}
          className="toolbar-icon-button"
          onClick={() => void client.dispatch('ai.open')}
        />
        {opened.length > 1 && <span className="ai-toolbar-count" aria-hidden="true">{opened.length}</span>}
      </span>
      {opened.length > 1 && (
        <div
          ref={menuRef}
          className="ai-toolbar-menu"
          role="menu"
          aria-label="已打开的 AI 助手"
          popover="manual"
          style={menuPosition}
          onPointerEnter={showMenu}
          onPointerLeave={leaveMenu}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {opened.map((assistant, index) => {
            const session = sessions.get(assistant.sessionId);
            return <div className="ai-toolbar-menu-row" key={assistant.id}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void client.dispatch('ai.assistant.focus', { assistantId: assistant.id });
                }}
              >
                <span>{session?.title || `AI 助手 ${index + 1}`}</span>
                <small>{assistant.view === 'chat' ? '对话' : assistant.view === 'memory' ? '记忆' : assistant.view === 'prompt' ? 'Prompt' : '模型'}</small>
              </button>
              <IconButton
                icon="trash"
                label={`删除${session?.title || `AI 助手 ${index + 1}`}及其当前对话`}
                onClick={() => {
                  setMenuOpen(false);
                  void client.dispatch('ai.assistant.delete', { assistantId: assistant.id });
                }}
              />
            </div>
          })}
        </div>
      )}
    </div>
  );
}
