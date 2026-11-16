'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { createId } from '../../core/contracts.ts';
import { SettingsPageHeader } from '../../ui/SettingsPageHeader.tsx';
import { Icon, IconButton } from '../../ui/Icon.tsx';
import {
  ASSISTANT_PREFERENCE_ACTIONS, isAssistantPreferences, preferencePhrase, type AssistantPreferenceAction,
  type AssistantPreferenceEntry, type AssistantPreferenceState, type AssistantPreferences,
} from '../../protocols/assistant-preferences.ts';
import { PERSONAL_PREFERENCES_CHANGED, PREFERENCE_ACTION_LABELS, putPreferenceEntry } from './personal-preferences.ts';

type Edit = { id?: string; kind: 'phrase' | 'gap'; phrase: string; action: AssistantPreferenceAction; gap: string; bookId?: string };
const emptyEdit: Edit = { kind: 'phrase', phrase: '', action: 'group', gap: '80' };
const entryLabel = (entry: AssistantPreferenceEntry) => entry.kind === 'phrase'
  ? `「${entry.phrase}」→ ${PREFERENCE_ACTION_LABELS[entry.action]}` : `横排默认间距 ${entry.gap}`;
const sameEntry = (a: AssistantPreferenceEntry, b: AssistantPreferenceEntry) => a.bookId === b.bookId &&
  (a.kind === 'gap' && b.kind === 'gap' || a.kind === 'phrase' && b.kind === 'phrase' &&
    a.status === b.status && preferencePhrase(a.phrase) === preferencePhrase(b.phrase));

export function PersonalPreferencesPanel({ client }: { client: ViewClient }) {
  const [state, setState] = useState<AssistantPreferenceState>({ busy: false });
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [edit, setEdit] = useState<Edit>();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [imported, setImported] = useState<AssistantPreferences>();
  const [removeAll, setRemoveAll] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const editorInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnToAdd = useRef(false);
  useEffect(() => {
    let active = true;
    const unsubscribe = client.subscribeSignal<AssistantPreferenceState>(PERSONAL_PREFERENCES_CHANGED, event => setState(event.payload));
    void client.ask<AssistantPreferenceState>('ai.personal.state@1').then(result => { if (active) setState(result); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; unsubscribe(); };
  }, [client]);
  const editing = Boolean(edit);
  const editId = edit?.id;
  useEffect(() => {
    if (editing) editorInput.current?.focus();
    else if (returnToAdd.current) {
      returnToAdd.current = false;
      addButton.current?.focus();
    }
  }, [editing, editId]);
  const account = state.account;
  const preferences = state.snapshot?.preferences;
  const disabled = state.busy || !account?.available;
  const entries = preferences?.entries ?? [];
  const matchingEntries = entries.filter(entry => entryLabel(entry).includes(search.trim()));
  const exportableEntries = entries.filter(entry => entry.kind === 'gap' || entry.status === 'active');
  const selectedIds = exportableEntries.filter(entry => selected.includes(entry.id)).map(entry => entry.id);
  const change = async (next: AssistantPreferences) => {
    if (!account || !state.snapshot || disabled) return;
    setError('');
    try { await client.dispatch('ai.personal.update@1', { account, expectedRevision: state.snapshot.revision, preferences: next }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const run = (operation: Promise<unknown>) => { void operation.catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); };
  const openEditor = (next: Edit) => { setFormError(''); setEdit(next); };
  const closeEditor = () => { returnToAdd.current = true; setEdit(undefined); setFormError(''); };
  const saveEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!preferences || !edit || disabled) return;
    const base = { id: edit.id ?? createId('ai-personal'), enabled: preferences.entries.find(item => item.id === edit.id)?.enabled ?? true,
      bookId: edit.bookId, origin: 'manual' as const };
    const entry: AssistantPreferenceEntry = edit.kind === 'phrase'
      ? { ...base, kind: 'phrase', phrase: edit.phrase.trim(), action: edit.action, status: 'active', evidence: 1 }
      : { ...base, kind: 'gap', gap: Number(edit.gap) };
    if (entries.some(item => item.id !== entry.id && sameEntry(item, entry))) {
      setFormError('这个适用范围已有同名条目，请编辑原条目。');
      return;
    }
    const next = { ...preferences, entries: putPreferenceEntry(entries, entry) };
    if (!isAssistantPreferences(next)) {
      setFormError(edit.kind === 'gap' ? '请输入 0 到 2000 的整数。' : '请输入 1 到 80 个字符的用语。');
      return;
    }
    run(change(next));
    closeEditor();
  };
  const download = async (ids?: string[]) => {
    const result = await client.dispatch('ai.personal.export@1', { ids });
    const url = URL.createObjectURL(new Blob([result.text], { type: 'application/json' }));
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = 'Echo-8-个人用语与偏好.json';
      link.click();
    } finally { URL.revokeObjectURL(url); }
  };
  const readImport = async (file: File) => {
    if (file.size > 256 * 1024) throw new Error('导入文件超过 256 KiB');
    const parsed: unknown = JSON.parse(await file.text());
    if (!isAssistantPreferences(parsed)) throw new Error('不支持的个人偏好文件格式');
    setImported({ ...parsed, entries: parsed.entries.filter(item => item.kind === 'gap' || item.status === 'active') });
  };
  const applyImport = (replace: boolean) => {
    if (!imported || !preferences) return;
    let entries = preferences.entries;
    for (const entry of imported.entries) {
      if (!replace && entries.some(item => sameEntry(item, entry))) continue;
      entries = putPreferenceEntry(entries, { ...entry, id: createId('ai-personal') });
    }
    if (!isAssistantPreferences({ ...preferences, entries })) return setError('合并后的设置超过账户容量。');
    run(change({ ...preferences, entries }));
    setImported(undefined);
  };
  return <section className="ai-personal-page" aria-label="AI 个人用语与偏好">
    <SettingsPageHeader title="个人用语与偏好" description="随账户保存，可在其他设备使用。"
      closeLabel="关闭个人用语与偏好" onClose={() => run(client.dispatch('ai.personal.close@1'))}
      actions={account?.available && <IconButton icon="sync" label="重新载入账户设置" disabled={state.busy}
        onClick={() => { setError(''); run(client.dispatch('ai.personal.refresh@1')); }} />} />
    {!account?.available && <p className="settings-empty">{account ? '请在云同步中升级个人数据服务后使用。' : '请先在云同步中连接账户。'}</p>}
    {state.busy && <p role="status" className="settings-page-summary">正在同步账户设置…</p>}
    {(error || state.error) && <p role="alert" className="ai-personal-error">{error || state.error}</p>}
    {preferences && <>
      <div className="ai-personal-switches" role="group" aria-label="使用与学习">
        <PreferenceSwitch label="使用个人用语与偏好" description="在识别画布指令时应用已启用的条目。"
          checked={preferences.enabled} disabled={disabled} toggle={() => run(change({ ...preferences, enabled: !preferences.enabled }))} />
        <PreferenceSwitch label="从反馈学习" description="根据你的纠正生成候选，确认后生效。"
          checked={preferences.learning} disabled={disabled} toggle={() => run(change({ ...preferences, learning: !preferences.learning }))} />
      </div>

      <div className="ai-personal-list">
        <div className="ai-personal-heading">
          <h3>全部条目</h3>
          <button ref={addButton} type="button" className="toolbar-button" hidden={editing} disabled={disabled}
            onClick={() => openEditor(emptyEdit)}><Icon name="add" size={14} />添加条目</button>
        </div>

        {edit && <form className="ai-personal-editor" aria-label={edit.id ? '编辑条目' : '添加条目'} onSubmit={saveEdit}>
          <h4>{edit.id ? '编辑条目' : '添加条目'}</h4>
          <fieldset disabled={disabled}>
            <label className="ai-personal-field">条目类型
              <select value={edit.kind} onChange={event => openEditor({ ...edit, kind: event.target.value as Edit['kind'] })}>
                <option value="phrase">个人用语</option><option value="gap">横排默认间距</option>
              </select>
            </label>
            <label className="ai-personal-field">适用范围
              <select value={edit.bookId ?? ''} onChange={event => openEditor({ ...edit, bookId: event.target.value || undefined })}>
                <option value="">全部书籍</option>
                {account?.bookId && <option value={account.bookId}>当前云端书籍</option>}
                {edit.bookId && edit.bookId !== account?.bookId && <option value={edit.bookId}>原指定书籍</option>}
              </select>
            </label>
            {edit.kind === 'phrase' ? <>
              <label className="ai-personal-field">个人用语
                <input ref={editorInput} placeholder="例如：收一下" maxLength={80} value={edit.phrase}
                  onChange={event => openEditor({ ...edit, phrase: event.target.value })} />
              </label>
              <label className="ai-personal-field">对应动作
                <select value={edit.action} onChange={event => openEditor({ ...edit, action: event.target.value as AssistantPreferenceAction })}>
                  {ASSISTANT_PREFERENCE_ACTIONS.map(action => <option key={action} value={action}>{PREFERENCE_ACTION_LABELS[action]}</option>)}
                </select>
              </label>
            </> : <label className="ai-personal-field">横排默认间距
              <input ref={editorInput} type="number" min={0} max={2000} value={edit.gap}
                onChange={event => openEditor({ ...edit, gap: event.target.value })} />
            </label>}
          </fieldset>
          {formError && <p className="ai-personal-error" role="alert">{formError}</p>}
          <div className="ai-personal-actions ai-personal-actions-end">
            <button type="button" className="toolbar-button" onClick={closeEditor}>取消</button>
            <button type="submit" className="primary-button" disabled={disabled || !(edit.kind === 'phrase' ? preferencePhrase(edit.phrase) : edit.gap.trim())}>
              {edit.id ? '保存修改' : '添加'}
            </button>
          </div>
        </form>}

        {entries.length ? <>
          <label className="ai-personal-search">
            <Icon name="search" size={15} />
            <input type="search" aria-label="搜索个人偏好" placeholder="搜索条目" value={search} onChange={event => setSearch(event.target.value)} />
          </label>
          {matchingEntries.length ? <ul className="ai-personal-entries">
            {matchingEntries.map(entry => {
              const candidate = entry.kind === 'phrase' && entry.status === 'candidate';
              const label = entryLabel(entry);
              return <li key={entry.id}>
                <div className="ai-personal-entry-copy">
                  {!candidate && <input type="checkbox" aria-label={`选择导出 ${label}`} checked={selectedIds.includes(entry.id)}
                    onChange={() => setSelected(current => current.includes(entry.id) ? current.filter(id => id !== entry.id) : [...current, entry.id])} />}
                  <div>
                    <strong>{label}</strong>
                    <small>{[entry.bookId ? '指定书籍' : '全部书籍',
                      entry.origin === 'feedback' ? '反馈学习' : entry.origin === 'explicit' ? '对话中设置' : '手动配置',
                      candidate ? `待确认，纠正 ${entry.evidence} 次` : entry.enabled ? '已启用' : '已停用'].join(' · ')}</small>
                  </div>
                </div>
                <div className="ai-personal-actions">
                  {candidate ? <button type="button" className="toolbar-button" disabled={disabled} onClick={() => run(change({ ...preferences,
                    entries: putPreferenceEntry(entries.filter(item => item.id !== entry.id), { ...entry, status: 'active' }) }))}>确认生效</button>
                    : <>
                      <button type="button" className="toolbar-button" disabled={disabled}
                        onClick={() => openEditor(entry.kind === 'phrase' ? { ...emptyEdit, ...entry } : { ...emptyEdit, ...entry, gap: String(entry.gap) })}>编辑</button>
                      <button type="button" className="toolbar-button" disabled={disabled}
                        onClick={() => run(change({ ...preferences, entries: entries.map(item => item.id === entry.id ? { ...item, enabled: !item.enabled } : item) }))}>
                        {entry.enabled ? '停用' : '启用'}
                      </button>
                    </>}
                  <button type="button" className="toolbar-button ai-personal-danger" disabled={disabled}
                    onClick={() => run(change({ ...preferences, entries: entries.filter(item => item.id !== entry.id) }))}>删除</button>
                </div>
              </li>;
            })}
          </ul> : <p className="settings-empty">没有匹配的条目。</p>}
        </> : !edit && <div className="ai-personal-empty">
          <strong>还没有条目</strong>
          <p>可以把「收一下」设为编组，或设置横排默认间距。</p>
        </div>}
      </div>

      <details className="settings-details ai-personal-transfer">
        <summary>导入与导出</summary>
        <div className="ai-personal-actions">
          <button type="button" className="toolbar-button" disabled={disabled} onClick={() => importInput.current?.click()}>
            <Icon name="folder-open" size={14} />导入 JSON
          </button>
          <input ref={importInput} type="file" hidden accept=".json,application/json" aria-label="选择导入文件" onChange={event => {
            const file = event.currentTarget.files?.[0];
            if (file) { setError(''); run(readImport(file)); }
            event.currentTarget.value = '';
          }} />
          <button type="button" className="toolbar-button" disabled={disabled || !exportableEntries.length} onClick={() => run(download())}>
            <Icon name="download" size={14} />导出全部
          </button>
          <button type="button" className="toolbar-button" disabled={disabled || !selectedIds.length} onClick={() => run(download(selectedIds))}>导出选中</button>
        </div>
        {imported && <div className="ai-personal-import-preview">
          <p>预览 {imported.entries.length} 条，其中 {imported.entries.filter(entry => entries.some(item => sameEntry(item, entry))).length} 条冲突。</p>
          <ul>{imported.entries.map(entry => <li key={entry.id}>{entryLabel(entry)} {entries.some(item => sameEntry(item, entry)) ? '（冲突）' : ''}</li>)}</ul>
          <div className="ai-personal-actions">
            <button type="button" className="toolbar-button" disabled={disabled} onClick={() => applyImport(false)}>保留已有冲突项</button>
            <button type="button" className="toolbar-button" disabled={disabled} onClick={() => applyImport(true)}>使用导入冲突项</button>
            <button type="button" className="toolbar-button" onClick={() => setImported(undefined)}>取消导入</button>
          </div>
        </div>}
        {entries.length > 0 && <div className="ai-personal-clear">
          {removeAll ? <><p>清空当前账户的全部用语和偏好？</p>
            <div className="ai-personal-actions">
              <button type="button" className="toolbar-button ai-personal-danger" disabled={disabled} onClick={() => {
                run(change({ ...preferences, entries: [] })); setRemoveAll(false); setSelected([]);
              }}>确认清空</button>
              <button type="button" className="toolbar-button" onClick={() => setRemoveAll(false)}>取消</button>
            </div>
          </> : <button type="button" className="toolbar-button ai-personal-danger" disabled={disabled} onClick={() => setRemoveAll(true)}>清空条目</button>}
        </div>}
      </details>
    </>}
  </section>;
}

function PreferenceSwitch({ label, description, checked, disabled, toggle }: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  toggle: () => void;
}) {
  return <div className="ai-personal-switch-row">
    <div><strong>{label}</strong><p>{description}</p></div>
    <button type="button" role="switch" className={`switch${checked ? ' on' : ''}`}
      aria-label={label} aria-checked={checked} disabled={disabled} onClick={toggle}><i aria-hidden="true" /></button>
  </div>;
}
