'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { RegisteredAction, RegisteredShortcut, ViewClient } from '../../core/contracts.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { formatShortcutChord } from '../../ui/shortcut-presentation.ts';
import { SHORTCUT_CENTER_NAMESPACE } from './model.ts';
import type { ShortcutCenterState } from './types.ts';

const CLOSED_STATE: ShortcutCenterState = { open: false, overrides: [] };

interface OperationRow {
  key: string;
  label: string;
  category: string;
  detail: string;
  shortcuts: RegisteredShortcut[];
}

export function ShortcutCenterPanel({ client }: { client: ViewClient }) {
  const stateVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion(SHORTCUT_CENTER_NAMESPACE),
    () => 0,
  );
  const uiVersion = useSyncExternalStore(client.subscribeUI, client.getUIVersion, () => 0);
  const [state, setState] = useState<ShortcutCenterState>(CLOSED_STATE);
  const [shortcuts, setShortcuts] = useState<RegisteredShortcut[]>([]);
  const [actions, setActions] = useState<RegisteredAction[]>([]);
  const [capturing, setCapturing] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    void Promise.all([
      client.ask<ShortcutCenterState>('shortcuts.state'),
      client.ask<RegisteredShortcut[]>('system.shortcuts'),
      client.ask<RegisteredAction[]>('system.actions'),
    ]).then(([nextState, nextShortcuts, nextActions]) => {
      if (!current) return;
      setState(nextState);
      setShortcuts(nextShortcuts);
      setActions(nextActions);
    });
    return () => { current = false; };
  }, [client, stateVersion, uiVersion]);

  const operations = useMemo(() => buildOperationRows(actions, shortcuts), [actions, shortcuts]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    if (!needle) return operations;
    return operations.filter((operation) =>
      `${operation.label} ${operation.category} ${operation.detail}`.toLocaleLowerCase('zh-CN').includes(needle),
    );
  }, [operations, query]);
  const grouped = useMemo(() => groupOperations(filtered), [filtered]);

  if (!state.open) return null;

  const update = async (shortcut: RegisteredShortcut, chord: string) => {
    setError('');
    try {
      await client.dispatch('shortcuts.setOverride', {
        targetOwner: shortcut.owner,
        targetId: shortcut.id,
        chord,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCapturing('');
    }
  };
  const clear = async (shortcut: RegisteredShortcut) => {
    setError('');
    try {
      await client.dispatch('shortcuts.clearOverride', {
        targetOwner: shortcut.owner,
        targetId: shortcut.id,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCapturing('');
    }
  };

  return (
    <section className="shortcut-center" aria-label="快捷键中心">
      <div className="panel-heading">
        <div><span className="eyebrow">全部操作 · 统一裁决</span><h2>快捷键中心</h2></div>
        <IconButton icon="close" label="关闭快捷键中心" onClick={() => void client.dispatch('shortcuts.close')} />
      </div>
      <p className="panel-copy">这里列出所有公开操作、交互指令和当前按键。修改时会先检查冲突，再由统一键盘管理器接管。</p>
      <div className="shortcut-center-toolbar">
        <span>{operations.length} 项操作 · {shortcuts.length} 组按键 · {shortcuts.filter((item) => item.overridden).length} 项已自定义</span>
        <IconButton icon="reset" label="全部恢复默认" onClick={() => void client.dispatch('shortcuts.resetAll')} />
      </div>
      <label className="shortcut-filter">
        <span className="sr-only">查找操作指令</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找操作、命令或分类…" />
      </label>
      {error && <p className="shortcut-error" role="alert">{error}</p>}
      <div className="shortcut-list">
        {grouped.map(([category, rows]) => (
          <section className="shortcut-category" key={category}>
            <h3>{category}</h3>
            {rows.map((operation) => (
              <div className="shortcut-row" key={operation.key}>
                <div className="shortcut-operation-copy">
                  <strong>{operation.label}</strong>
                  <span>{operation.detail}</span>
                </div>
                <div className="shortcut-bindings">
                  {operation.shortcuts.map((shortcut) => {
                    const target = `${shortcut.owner}:${shortcut.id}`;
                    return (
                      <div className="shortcut-binding" key={target}>
                        <input
                          readOnly
                          value={capturing === target ? '请按新组合键…' : shortcut.disabled ? '未设置' : formatShortcutChord(shortcut.chord)}
                          aria-label={`修改${shortcut.label}的快捷键`}
                          title={shortcut.instruction ?? shortcut.label}
                          onFocus={() => setCapturing(target)}
                          onBlur={() => setCapturing('')}
                          onKeyDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (event.key === 'Escape') {
                              event.currentTarget.blur();
                              return;
                            }
                            const chord = chordFromCapture(event);
                            if (chord) void update(shortcut, chord);
                          }}
                        />
                        <small>{shortcut.mode === 'hold' ? shortcut.instruction ?? '按住使用' : shortcut.label}</small>
                        <IconButton
                          icon="dismiss"
                          label={`清空${shortcut.label}的快捷键`}
                          disabled={shortcut.disabled}
                          onClick={() => void clear(shortcut)}
                        />
                        <IconButton
                          icon="reset"
                          label={`恢复${shortcut.label}的默认快捷键`}
                          disabled={!shortcut.overridden}
                          onClick={() => void client.dispatch('shortcuts.resetOverride', {
                            targetOwner: shortcut.owner,
                            targetId: shortcut.id,
                          })}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        ))}
        {grouped.length === 0 && <p className="shortcut-empty">没有匹配的操作指令。</p>}
      </div>
    </section>
  );
}

function buildOperationRows(actions: RegisteredAction[], shortcuts: RegisteredShortcut[]): OperationRow[] {
  const matched = new Set<string>();
  const rows = actions.map((action) => {
    const bindings = shortcuts.filter((shortcut) =>
      shortcut.owner === action.owner && shortcut.command === action.command,
    );
    for (const shortcut of bindings) matched.add(`${shortcut.owner}:${shortcut.id}`);
    return {
      key: `action:${action.owner}:${action.id}`,
      label: action.label,
      category: action.category,
      detail: `${action.command} · ${action.owner}`,
      shortcuts: bindings,
    };
  });
  for (const shortcut of shortcuts) {
    const key = `${shortcut.owner}:${shortcut.id}`;
    if (matched.has(key)) continue;
    rows.push({
      key: `shortcut:${key}`,
      label: shortcut.label,
      category: shortcut.category ?? (shortcut.mode === 'hold' ? '画布交互' : '其他操作'),
      detail: shortcut.instruction ?? `${shortcut.command ?? '交互修饰键'} · ${shortcut.owner}`,
      shortcuts: [shortcut],
    });
  }
  return rows.sort((left, right) => left.category.localeCompare(right.category, 'zh-CN') || left.label.localeCompare(right.label, 'zh-CN'));
}

function groupOperations(operations: OperationRow[]): Array<[string, OperationRow[]]> {
  const groups = new Map<string, OperationRow[]>();
  for (const operation of operations) {
    const rows = groups.get(operation.category) ?? [];
    rows.push(operation);
    groups.set(operation.category, rows);
  }
  return [...groups.entries()];
}

function chordFromCapture(event: React.KeyboardEvent<HTMLInputElement>): string | undefined {
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  if (['control', 'meta', 'alt', 'shift'].includes(key)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}
