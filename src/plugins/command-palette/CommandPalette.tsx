'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RegisteredAction, RegisteredShortcut, ViewClient } from '../../core/contracts.ts';
import { formatShortcutChord } from '../../ui/shortcut-presentation.ts';
import { groupActionsByCategory, sortActionsByCategory } from './action-groups.ts';
import { COMMAND_PALETTE_NAMESPACE } from './model.ts';

export function CommandPalette({ client }: { client: ViewClient }) {
  const stateVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion(COMMAND_PALETTE_NAMESPACE),
    () => 0,
  );
  const uiVersion = useSyncExternalStore(client.subscribeUI, client.getUIVersion, () => 0);
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<RegisteredAction[]>([]);
  const [shortcuts, setShortcuts] = useState<RegisteredShortcut[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    void Promise.all([
      client.ask<{ open: boolean }>('commandPalette.state'),
      client.ask<RegisteredAction[]>('system.actions'),
      client.ask<RegisteredShortcut[]>('system.shortcuts'),
    ]).then(([state, nextActions, nextShortcuts]) => {
      if (!current) return;
      setOpen(state.open);
      setActions(nextActions);
      setShortcuts(nextShortcuts);
    });
    return () => { current = false; };
  }, [client, stateVersion, uiVersion]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    const matches = !needle ? actions : actions.filter((action) =>
      [action.label, action.category, action.command, ...(action.keywords ?? [])]
        .join(' ')
        .toLocaleLowerCase('zh-CN')
        .includes(needle),
    );
    return sortActionsByCategory(matches);
  }, [actions, query]);
  const grouped = useMemo(() => groupActionsByCategory(filtered), [filtered]);

  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1));

  const close = async () => {
    setQuery('');
    setSelected(0);
    setError('');
    await client.dispatch('commandPalette.close');
  };

  const execute = async (action: RegisteredAction) => {
    setError('');
    try {
      await client.dispatch('system.action.execute', { owner: action.owner, id: action.id });
      await close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (!open) return null;
  const chordFor = (action: RegisteredAction) =>
    shortcuts.find((shortcut) => shortcut.owner === action.owner && shortcut.command === action.command)?.chord;

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void close();
      }}
    >
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="command-search-row">
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                void close();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelected((index) => Math.min(filtered.length - 1, index + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((index) => Math.max(0, index - 1));
              } else if (event.key === 'Enter' && filtered[safeSelected]) {
                event.preventDefault();
                void execute(filtered[safeSelected]);
              }
            }}
            placeholder="输入功能、命令或关键词…"
            aria-label="搜索命令"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-results" role="listbox" aria-label="可用命令">
          {grouped.map((group) => (
            <div
              className="command-result-group"
              role="group"
              aria-label={group.category}
              key={group.category}
            >
              <div className="command-result-group-heading" aria-hidden="true">{group.category}</div>
              {group.actions.map((action) => {
                const index = filtered.indexOf(action);
                return (
                  <button
                    key={`${action.owner}:${action.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === safeSelected}
                    className={index === safeSelected ? 'selected' : ''}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => void execute(action)}
                  >
                    <span><strong>{action.label}</strong></span>
                    {chordFor(action) && <kbd>{formatShortcutChord(chordFor(action)!)}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && <p>没有匹配的命令</p>}
        </div>
        {error && <p className="command-error">{error}</p>}
        <footer><span>↑↓ 选择</span><span>Enter 执行</span><span>{actions.length} 个已注册动作</span></footer>
      </section>
    </div>
  );
}
