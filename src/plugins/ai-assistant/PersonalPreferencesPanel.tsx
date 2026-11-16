'use client';

import { useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { createId } from '../../core/contracts.ts';
import { SettingsPageHeader } from '../../ui/SettingsPageHeader.tsx';
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
  const [edit, setEdit] = useState<Edit>(emptyEdit);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [imported, setImported] = useState<AssistantPreferences>();
  const [removeAll, setRemoveAll] = useState(false);
  useEffect(() => {
    let active = true;
    const unsubscribe = client.subscribeSignal<AssistantPreferenceState>(PERSONAL_PREFERENCES_CHANGED, event => setState(event.payload));
    void client.ask<AssistantPreferenceState>('ai.personal.state@1').then(result => { if (active) setState(result); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; unsubscribe(); };
  }, [client]);
  const account = state.account;
  const preferences = state.snapshot?.preferences;
  const disabled = state.busy || !account?.available;
  const change = async (next: AssistantPreferences) => {
    if (!account || !state.snapshot || disabled) return;
    setError('');
    try { await client.dispatch('ai.personal.update@1', { account, expectedRevision: state.snapshot.revision, preferences: next }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const run = (operation: Promise<unknown>) => { void operation.catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); };
  const saveEdit = () => {
    if (!preferences) return;
    const base = { id: edit.id ?? createId('ai-personal'), enabled: preferences.entries.find(item => item.id === edit.id)?.enabled ?? true,
      bookId: edit.bookId, origin: 'manual' as const };
    const entry: AssistantPreferenceEntry = edit.kind === 'phrase'
      ? { ...base, kind: 'phrase', phrase: edit.phrase.trim(), action: edit.action, status: 'active', evidence: 1 }
      : { ...base, kind: 'gap', gap: Number(edit.gap) };
    if (preferences.entries.some(item => item.id !== entry.id && sameEntry(item, entry))) return setError('这一范围已有相同的用语或参数，请编辑已有设置。');
    if (entry.kind === 'gap' && !edit.gap.trim() || !isAssistantPreferences({ ...preferences, entries: [entry] })) return setError('请填写有效的用语或间距。');
    run(change({ ...preferences, entries: putPreferenceEntry(preferences.entries, entry) }));
    setEdit(emptyEdit);
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
  return <section className="retrieval-settings-panel" aria-label="AI 个人用语与偏好">
    <SettingsPageHeader title="个人用语与偏好" description="随当前账户保存。可以管理用语、排列习惯和从纠正中学到的候选。"
      closeLabel="关闭个人用语与偏好" onClose={() => run(client.dispatch('ai.personal.close@1'))} />
    {!account?.available && <p>{account ? '请在云同步中升级个人数据服务后使用。' : '请先在云同步中连接账户。'}</p>}
    {state.busy && <p role="status">正在同步账户设置…</p>}
    {preferences && <fieldset disabled={disabled}>
      <label className="ai-field"><span>使用个人用语与偏好</span><input type="checkbox" checked={preferences.enabled}
        onChange={event => run(change({ ...preferences, enabled: event.target.checked }))} /></label>
      <label className="ai-field"><span>从反馈学习</span><input type="checkbox" checked={preferences.learning}
        onChange={event => run(change({ ...preferences, learning: event.target.checked }))} /></label>
      <div className="ai-field">
        <label>类型 <select value={edit.kind} onChange={event => setEdit({ ...emptyEdit, kind: event.target.value as Edit['kind'] })}>
          <option value="phrase">个人用语</option><option value="gap">排列间距</option>
        </select></label>
        {edit.kind === 'phrase' ? <>
          <input aria-label="个人用语" placeholder="例如：收一下" maxLength={80} value={edit.phrase}
            onChange={event => setEdit({ ...edit, phrase: event.target.value })} />
          <select aria-label="对应动作" value={edit.action} onChange={event => setEdit({ ...edit, action: event.target.value as AssistantPreferenceAction })}>
            {ASSISTANT_PREFERENCE_ACTIONS.map(action => <option key={action} value={action}>{PREFERENCE_ACTION_LABELS[action]}</option>)}
          </select>
        </> : <input aria-label="横排默认间距" type="number" min={0} max={2000} value={edit.gap}
          onChange={event => setEdit({ ...edit, gap: event.target.value })} />}
        <select aria-label="适用范围" value={edit.bookId ?? ''} onChange={event => setEdit({ ...edit, bookId: event.target.value || undefined })}>
          <option value="">全部书籍</option>
          {account?.bookId && <option value={account.bookId}>当前云端书籍</option>}
          {edit.bookId && edit.bookId !== account?.bookId && <option value={edit.bookId}>原指定书籍</option>}
        </select>
        <button type="button" onClick={saveEdit}>{edit.id ? '保存修改' : '添加'}</button>
      </div>
      <input aria-label="搜索个人偏好" placeholder="搜索个人用语和偏好" value={search} onChange={event => setSearch(event.target.value)} />
      <ul>
        {preferences.entries.filter(entry => entryLabel(entry).includes(search.trim())).map(entry => {
          const candidate = entry.kind === 'phrase' && entry.status === 'candidate';
          return <li key={entry.id}>
            <label><input type="checkbox" checked={selected.includes(entry.id)} disabled={candidate}
              onChange={() => setSelected(current => current.includes(entry.id) ? current.filter(id => id !== entry.id) : [...current, entry.id])} />{entryLabel(entry)}</label>
            <small> · {entry.bookId ? '指定书籍' : '全部书籍'} · {entry.origin === 'feedback' ? '反馈学习' : entry.origin === 'explicit' ? '对话中设置' : '手动配置'}
              {' · '}{candidate ? `待确认，纠正 ${entry.evidence} 次` : entry.enabled ? '已启用' : '已停用'}</small>
            {candidate ? <button type="button" onClick={() => run(change({ ...preferences,
              entries: putPreferenceEntry(preferences.entries.filter(item => item.id !== entry.id), { ...entry, status: 'active' }) }))}>确认生效</button>
              : <>
                <button type="button" onClick={() => setEdit(entry.kind === 'phrase' ? { ...emptyEdit, ...entry } : { ...emptyEdit, ...entry, gap: String(entry.gap) })}>编辑</button>
                <button type="button" onClick={() => run(change({ ...preferences, entries: preferences.entries.map(item => item.id === entry.id ? { ...item, enabled: !item.enabled } : item) }))}>{entry.enabled ? '停用' : '启用'}</button>
              </>}
            <button type="button" onClick={() => run(change({ ...preferences, entries: preferences.entries.filter(item => item.id !== entry.id) }))}>删除</button>
          </li>;
        })}
      </ul>
      <button type="button" onClick={() => run(download())}>导出全部</button>
      <button type="button" disabled={!selected.length} onClick={() => run(download(selected))}>导出选中</button>
      <label>导入 JSON <input type="file" accept=".json,application/json" onChange={event => {
        const file = event.currentTarget.files?.[0];
        if (file) run(readImport(file));
        event.currentTarget.value = '';
      }} /></label>
      {imported && <div>
        <p>将导入 {imported.entries.length} 条，其中 {imported.entries.filter(entry => preferences.entries.some(item => sameEntry(item, entry))).length} 条与已有设置冲突。</p>
        <ul>{imported.entries.map(entry => <li key={entry.id}>{entryLabel(entry)} {preferences.entries.some(item => sameEntry(item, entry)) ? '（冲突）' : ''}</li>)}</ul>
        <button type="button" onClick={() => applyImport(false)}>保留已有冲突项</button>
        <button type="button" onClick={() => applyImport(true)}>使用导入冲突项</button>
        <button type="button" onClick={() => setImported(undefined)}>取消导入</button>
      </div>}
      {removeAll ? <>
        <button type="button" onClick={() => { run(change({ ...preferences, entries: [] })); setRemoveAll(false); }}>确认清空</button>
        <button type="button" onClick={() => setRemoveAll(false)}>取消</button>
      </> : <button type="button" disabled={!preferences.entries.length} onClick={() => setRemoveAll(true)}>清空条目</button>}
    </fieldset>}
    {account?.available && <button type="button" disabled={state.busy} onClick={() => run(client.dispatch('ai.personal.refresh@1'))}>重新载入账户设置</button>}
    {(error || state.error) && <p role="alert" className="ai-error">{error || state.error}</p>}
  </section>;
}
