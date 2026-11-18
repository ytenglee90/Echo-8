'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { type ViewClient, createId } from '../../core/contracts.ts';
import { SettingsPageHeader } from '../../ui/SettingsPageHeader.tsx';
import { Icon, IconButton } from '../../ui/Icon.tsx';
import {
  ASSISTANT_PREFERENCE_ACTIONS, isAssistantPreferences, preferencePhrase, upgradeAssistantPreferences, type AssistantInstruction, type AssistantPreferenceAction,
  type AssistantPreferenceEntry, type AssistantPreferenceState, type AssistantPreferences,
} from '../../protocols/assistant-preferences.ts';
import { isPreferenceCandidate, PERSONAL_PREFERENCES_CHANGED, PREFERENCE_ACTION_LABELS, putPreferenceEntry } from './personal-preferences.ts';
import { preferenceActionLabel, preferenceInstruction } from '../../services/assistant-instructions.ts';
import { classifyAITurn } from './turn-route.ts';

type Edit = { id?: string; kind: 'phrase' | 'gap'; phrase: string; action: AssistantPreferenceAction; gap: string; bookId?: string; layout?: 'horizontal' | 'vertical' | 'grid' };
const emptyEdit: Edit = { kind: 'phrase', phrase: '', action: 'group', gap: '80' };
const entryLabel = (entry: AssistantPreferenceEntry) => entry.kind === 'phrase'
  ? `「${entry.phrase}」→ ${preferenceActionLabel(entry.action)}${entry.gap === undefined ? '' : `，间距 ${entry.gap}`}` : `${entry.layout === 'vertical' ? '竖排' : entry.layout === 'grid' ? '网格' : '横排'}默认间距 ${entry.gap}`;
const sameEntry = (a: AssistantPreferenceEntry, b: AssistantPreferenceEntry) => a.bookId === b.bookId &&
  (a.kind === 'gap' && b.kind === 'gap' && (a.layout ?? 'horizontal') === (b.layout ?? 'horizontal') || a.kind === 'phrase' && b.kind === 'phrase' &&
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
  const [tab, setTab] = useState<'all' | 'phrases'>('all');
  const [learningFilter, setLearningFilter] = useState<'all' | 'pending' | 'confirmed'>('all');
  const [instructions, setInstructions] = useState<AssistantInstruction[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [category, setCategory] = useState('');
  const [actionCategory, setActionCategory] = useState('');
  const refreshCatalog = () => client.ask<{ instructions: AssistantInstruction[] }>('ai.instructions@1')
    .then(result => { setInstructions(result.instructions); setCatalogError(''); }).catch(reason => setCatalogError(String(reason)));
  const importInput = useRef<HTMLInputElement>(null);
  const editorInput = useRef<HTMLInputElement>(null);
  const phraseInput = useRef<HTMLTextAreaElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnToAdd = useRef(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refreshInstructions = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void client.ask<{ instructions: AssistantInstruction[] }>('ai.instructions@1').then(result => {
        if (active) { setInstructions(result.instructions); setCatalogError(''); }
      }).catch(reason => { if (active) setCatalogError(String(reason)); }); }, 120);
    };
    refreshInstructions();
    const unsubscribeCatalog = client.subscribeState(refreshInstructions);
    const unsubscribe = client.subscribeSignal<AssistantPreferenceState>(PERSONAL_PREFERENCES_CHANGED, event => setState(event.payload));
    void client.ask<AssistantPreferenceState>('ai.personal.state@1').then(result => { if (active) setState(result); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; clearTimeout(timer); unsubscribe(); unsubscribeCatalog(); };
  }, [client]);
  const editing = Boolean(edit);
  const editId = edit?.id;
  useEffect(() => {
    if (editing) { phraseInput.current?.focus(); editorInput.current?.focus(); }
    else if (returnToAdd.current) {
      returnToAdd.current = false;
      addButton.current?.focus();
    }
  }, [editing, editId]);
  const account = state.account;
  const preferences = state.snapshot?.preferences;
  const disabled = state.busy || !account?.available;
  const entries = preferences?.entries ?? [];
  const visibleEntries = entries.filter(entry => entry.kind === 'phrase' && entry.origin !== 'feedback');
  const matchingEntries = visibleEntries.filter(entry => entryLabel(entry).includes(search.trim()));
  const learningEntries = entries.filter(entry => entry.origin === 'feedback' || entry.kind === 'gap')
    .sort((left, right) => Number(isPreferenceCandidate(right)) - Number(isPreferenceCandidate(left)));
  const pendingCount = learningEntries.filter(isPreferenceCandidate).length;
  const filteredLearning = learningEntries.filter(entry => learningFilter === 'all' ||
    (learningFilter === 'pending' ? isPreferenceCandidate(entry) : !isPreferenceCandidate(entry)));
  const exportableEntries = entries.filter(entry => !isPreferenceCandidate(entry));
  const selectedIds = exportableEntries.filter(entry => selected.includes(entry.id)).map(entry => entry.id);
  const actionOptions = instructions.filter(item => item.customizable && (account?.extended || (ASSISTANT_PREFERENCE_ACTIONS as readonly string[]).includes(item.id)));
  const chosenAction = actionOptions.find(item => item.id === edit?.action);
  const preview = edit?.kind === 'phrase' ? preferenceInstruction(edit.action, chosenAction?.gap && edit.gap.trim() ? Number(edit.gap) : undefined, instructions) :
    `${edit?.layout === 'vertical' ? '竖排' : edit?.layout === 'grid' ? '网格排列' : '横排'}未指定间距时使用 ${edit?.gap ?? 80}。`;
  const categories = [...new Set(instructions.map(item => item.category))];
  const filteredInstructions = instructions.filter(item => (!category || item.category === category) &&
    `${item.label} ${item.example ?? ''} ${item.category}`.toLocaleLowerCase().includes(catalogSearch.trim().toLocaleLowerCase()));
  const change = async (next: AssistantPreferences) => {
    if (!account || !state.snapshot || disabled) return;
    setError('');
    try { await client.dispatch('ai.personal.update@1', { account, expectedRevision: state.snapshot.revision,
      preferences: account.extended ? upgradeAssistantPreferences(next) : next }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const run = (operation: Promise<unknown>) => { void operation.catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); };
  const openEditor = (next: Edit) => { setFormError(''); setEdit(next); setTab('phrases'); };
  const closeEditor = () => { returnToAdd.current = true; setEdit(undefined); setFormError(''); };
  const saveEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!preferences || !edit || disabled) return;
    const base = { id: edit.id ?? createId('ai-personal'), enabled: preferences.entries.find(item => item.id === edit.id)?.enabled ?? true,
      bookId: edit.bookId, origin: preferences.entries.find(item => item.id === edit.id)?.origin ?? 'manual' as const };
    const phrases = edit.phrase.split(/\r?\n/u).map(phrase => phrase.trim()).filter(Boolean);
    if (edit.kind === 'phrase' && (!phrases.length || edit.id && phrases.length > 1 || phrases.length > 30)) {
      setFormError(edit.id ? '编辑单条用语时请输入一种说法；添加条目可以每行填写一种。' : '每行一种说法，一次最多添加 30 种。'); return;
    }
    const entry: AssistantPreferenceEntry = edit.kind === 'phrase'
      ? { ...base, kind: 'phrase', phrase: edit.phrase.trim(), action: edit.action, status: 'active',
        evidence: preferences.entries.find((entry): entry is Extract<AssistantPreferenceEntry, { kind: 'phrase' }> => entry.kind === 'phrase' && entry.id === edit.id)?.evidence ?? 1,
        ...(account?.extended && chosenAction?.gap && edit.gap.trim() ? { gap: Number(edit.gap) } : {}) }
      : { ...base, kind: 'gap', gap: Number(edit.gap), ...(account?.extended ? { layout: edit.layout ?? 'horizontal' } : {}) };
    if (entry.kind === 'phrase') {
      const conflict = phrases.some(phrase => { const standard = classifyAITurn(phrase);
        return standard.local || standard.native || standard.workspaceSteps || standard.catalogIntent || standard.compound || standard.operation !== 'general'; });
      if (conflict) {
        setFormError('这句话已有内置含义，请换一种个人说法，避免覆盖标准指令。'); return;
      }
      if (!chosenAction || !preview) { setFormError('对应动作当前不可用，请重新选择。'); return; }
    }
    const additions: AssistantPreferenceEntry[] = entry.kind === 'phrase' ? phrases.map((phrase, index) => ({ ...entry, phrase, id: index === 0 ? entry.id : createId('ai-personal') })) : [entry];
    if (new Set(phrases.map(preferencePhrase)).size !== phrases.length || additions.some(entry => entries.some(item => item.id !== entry.id && sameEntry(item, entry)))) {
      setFormError('这个适用范围已有同名条目，请编辑原条目。');
      return;
    }
    const next = { ...(account?.extended ? upgradeAssistantPreferences(preferences) : preferences), entries: additions.reduce((all, entry) => putPreferenceEntry(all, entry), entries) };
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
  const renderEntry = (entry: AssistantPreferenceEntry) => {
    const candidate = isPreferenceCandidate(entry);
    const label = entryLabel(entry);
    const source = entry.origin === 'feedback' ? entry.kind === 'phrase' ? `反馈学习：明确纠正 ${entry.evidence} 次` : '反馈学习：相同横排间距重复应用 3 次'
      : entry.origin === 'explicit' ? '对话设置或确认保存' : '手动配置';
    const status = candidate ? '待确认' : !entry.enabled ? '已停用' : preferences?.enabled ? '已生效' : '已确认，总开关已关闭';
    return <li key={entry.id}>
      <div className="ai-personal-entry-copy">
        {!candidate && <input type="checkbox" aria-label={`选择导出 ${label}`} checked={selectedIds.includes(entry.id)}
          onChange={() => setSelected(current => current.includes(entry.id) ? current.filter(id => id !== entry.id) : [...current, entry.id])} />}
        <div><strong>{label}</strong><small>{[entry.bookId ? '指定书籍' : '全部书籍', `来源：${source}`, status].join(' · ')}</small></div>
      </div>
      <div className="ai-personal-actions">
        {candidate ? <button type="button" className="toolbar-button" disabled={disabled} onClick={() => run(change({ ...preferences!,
          entries: putPreferenceEntry(entries.filter(item => item.id !== entry.id), entry.kind === 'phrase'
            ? { ...entry, status: 'active' } : { ...entry, enabled: true, origin: 'explicit' }) }))}>确认生效</button>
          : <>
            <button type="button" className="toolbar-button" disabled={disabled}
              onClick={() => { setActionCategory(''); openEditor(entry.kind === 'phrase' ? { ...emptyEdit, ...entry, gap: entry.gap === undefined ? '' : String(entry.gap) } : { ...emptyEdit, ...entry, gap: String(entry.gap) }); }}>编辑</button>
            <button type="button" className="toolbar-button" disabled={disabled}
              onClick={() => run(change({ ...preferences!, entries: entries.map(item => item.id === entry.id ? { ...item, enabled: !item.enabled } : item) }))}>
              {entry.enabled ? '停用' : '启用'}
            </button>
          </>}
        <button type="button" className="toolbar-button ai-personal-danger" disabled={disabled}
          onClick={() => run(change({ ...preferences!, entries: entries.filter(item => item.id !== entry.id) }))}>{candidate ? '忽略' : '删除'}</button>
      </div>
    </li>;
  };
  return <section className="ai-personal-page" aria-label="AI 指令与偏好">
    <SettingsPageHeader title="指令与偏好" description="查看可用操作、管理个人用语和学习记录。"
      closeLabel="关闭指令与偏好" onClose={() => run(client.dispatch('ai.personal.close@1'))}
      actions={account?.available && <IconButton icon="sync" label="重新载入账户设置" disabled={state.busy}
        onClick={() => { setError(''); run(client.dispatch('ai.personal.refresh@1')); }} />} />
    <div className="ai-instruction-tabs" role="tablist" aria-label="指令与偏好分类" onKeyDown={event => {
      const tabs = ['all', 'phrases'] as const;
      const index = tabs.indexOf(tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % 2 : event.key === 'ArrowLeft' ? (index + 1) % 2 : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : -1;
      if (next < 0) return;
      event.preventDefault(); setTab(tabs[next]); setEdit(undefined);
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>
      {([['all', '全部指令'], ['phrases', '我的用语']] as const).map(([id, label]) =>
        <button key={id} id={`ai-instructions-${id}-tab`} role="tab" type="button" aria-selected={tab === id} aria-controls="ai-instructions-content"
          tabIndex={tab === id ? 0 : -1} onClick={() => { setTab(id); setEdit(undefined); }}>{label}</button>)}
    </div>
    <div id="ai-instructions-content" role="tabpanel" aria-labelledby={`ai-instructions-${tab}-tab`}>
    {tab === 'all' && <div className="ai-instruction-directory">
      <label className="ai-personal-field">搜索指令<input type="search" placeholder="搜索用途或示例说法" value={catalogSearch} onChange={event => setCatalogSearch(event.target.value)} /></label>
      <label className="ai-personal-field">动作类别<select value={category} onChange={event => setCategory(event.target.value)}>
        <option value="">全部类别</option>{categories.map(name => <option key={name}>{name}</option>)}
      </select></label>
      <div className="ai-personal-heading"><p>{instructions.length} 项动作 · {instructions.filter(item => item.customizable).length} 项支持个人用语</p>
        <button type="button" className="toolbar-button" onClick={() => void refreshCatalog()}>刷新指令</button></div>
      {catalogError && <p role="alert">暂时无法读取指令目录，请刷新重试。{catalogError}</p>}
      <p className="ai-instruction-help">本地指令直接解析；“模型解析”使用当前模型理解，修改计划先确认。“功能界面”需从对应界面使用。</p>
      <ul className="ai-instruction-cards">{filteredInstructions.map(item => <li key={item.id}>
        <div className="ai-personal-heading"><strong>{item.label}</strong><small>{item.category} · {item.available ? item.example ? '本地指令' : item.modelEligible ? '模型解析' : '功能界面' : '当前不可用'}</small></div>
        {item.example && <p className="ai-instruction-example">例如：{item.example}</p>}
        {item.example && item.requirement && item.requirement !== '沿用对应功能的参数校验、确认和撤销规则。' && <small className="ai-instruction-requirement">{item.requirement}</small>}
        {item.customizable && <button type="button" className="toolbar-button" disabled={disabled || !account?.extended && !(ASSISTANT_PREFERENCE_ACTIONS as readonly string[]).includes(item.id)}
          onClick={() => { setActionCategory(item.category); openEditor({ ...emptyEdit, action: item.id, gap: '' }); }}>设置个人用语</button>}
      </li>)}</ul>
      {!filteredInstructions.length && !catalogError && <p className="settings-empty">{instructions.length ? '没有匹配的指令。' : '正在读取当前功能的指令目录…'}</p>}
    </div>}
    {tab !== 'all' && !account?.available && <p className="settings-empty">{account ? '请在云同步中升级个人数据服务后保存个人设置。' : '连接账户后可以保存个人设置，全部指令可直接浏览。'}</p>}
    {tab !== 'all' && account?.available && !account.extended && <p className="settings-empty">升级云同步中的个人数据服务后，可为更多动作设置用语及竖排、网格间距。原有用语继续可用。</p>}
    {state.busy && <p role="status" className="settings-page-summary">正在同步账户设置…</p>}
    {(error || state.error) && <p role="alert" className="ai-personal-error">{error || state.error}</p>}
    {!preferences && tab === 'phrases' && <><p className="ai-preference-purpose">我的用语用于设置你习惯的说法，例如“收一下”“归到一块儿”都对应“给选中节点编组”。一个动作可保存多种说法。</p>
      <section className="ai-personal-learning" aria-label="学习记录"><h3>学习记录</h3><p className="settings-empty">连接账户后，可在这里查看反馈学习生成的候选和已确认条目。</p></section></>}
    {preferences && tab !== 'all' && <>
      <p className="ai-preference-purpose">把你的不同说法对应到同一个动作。一个动作可有多种用语。</p>
      {tab === 'phrases' && <>
      <div className="ai-personal-switches" role="group" aria-label="使用与学习">
        <PreferenceSwitch label="使用个人用语与偏好" description="在识别画布指令时应用已启用的条目。"
          checked={preferences.enabled} disabled={disabled} toggle={() => run(change({ ...preferences, enabled: !preferences.enabled }))} />
        <PreferenceSwitch label="从反馈学习" description="从你的纠正和重复使用的横排间距生成候选，确认后生效。"
          checked={preferences.learning} disabled={disabled} toggle={() => run(change({ ...preferences, learning: !preferences.learning }))} />
      </div>

      <section className="ai-personal-learning" aria-label="学习记录">
        <div className="ai-personal-heading"><h3>学习记录</h3><span>待确认 {pendingCount} · 已确认 {learningEntries.length - pendingCount}</span></div>
        <p className="ai-preference-purpose">明确纠正用语，或连续三次应用相同横排间距，会生成待确认条目。确认后才用于后续指令；已有排列设置也保留在这里。</p>
        {learningEntries.length > 0 && <label className="ai-personal-field">查看学习记录<select value={learningFilter}
          onChange={event => setLearningFilter(event.target.value as typeof learningFilter)}>
          <option value="all">全部记录</option><option value="pending">待确认</option><option value="confirmed">已确认</option>
        </select></label>}
        {filteredLearning.length ? <ul className="ai-personal-entries">{filteredLearning.map(renderEntry)}</ul>
          : <div className="ai-personal-empty"><strong>{learningEntries.length ? '没有匹配的学习记录' : '还没有学习记录'}</strong>
            <p>{learningEntries.length ? '可切换上方筛选查看其他记录。' : preferences.learning ? '反馈学习已开启，生成候选后会显示在这里。' : '开启“从反馈学习”后，才会收集新的候选。'}</p></div>}
      </section>

      <div className="ai-personal-list">
        <div className="ai-personal-heading">
          <h3>个人用语</h3>
          <button ref={addButton} type="button" className="toolbar-button" hidden={editing} disabled={disabled}
            onClick={() => { setActionCategory(''); openEditor({ ...emptyEdit, kind: 'phrase' }); }}><Icon name="add" size={14} />添加条目</button>
        </div>

        {edit && <form className="ai-personal-editor" aria-label={edit.id ? '编辑条目' : '添加条目'} onSubmit={saveEdit}>
          <h4>{edit.id ? '编辑条目' : '添加条目'}</h4>
          <fieldset disabled={disabled}>
            <label className="ai-personal-field">适用范围
              <select value={edit.bookId ?? ''} onChange={event => openEditor({ ...edit, bookId: event.target.value || undefined })}>
                <option value="">全部书籍</option>
                {account?.bookId && <option value={account.bookId}>当前云端书籍</option>}
                {edit.bookId && edit.bookId !== account?.bookId && <option value={edit.bookId}>原指定书籍</option>}
              </select>
            </label>
            {edit.kind === 'phrase' ? <>
              <label className="ai-personal-field">动作类别<select value={actionCategory} onChange={event => {
                const category = event.target.value; setActionCategory(category);
                openEditor({ ...edit, action: actionOptions.find(item => !category || item.category === category)?.id ?? '', gap: '' });
              }}><option value="">全部类别</option>{[...new Set(actionOptions.map(item => item.category))].map(name => <option key={name}>{name}</option>)}</select></label>
              <label className="ai-personal-field">对应动作
                <select value={edit.action} onChange={event => openEditor({ ...edit, action: event.target.value, gap: '' })}>
                  {!actionOptions.some(item => item.id === edit.action) && <option value={edit.action}>{PREFERENCE_ACTION_LABELS[edit.action] ?? preferenceActionLabel(edit.action)}（当前不可用）</option>}
                  {actionOptions.filter(item => !actionCategory || item.category === actionCategory).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              {chosenAction?.gap && account?.extended && <label className="ai-personal-field">本用语的间距（可选）<input type="number" min={0} max={2000} placeholder="使用默认间距" value={edit.gap}
                onChange={event => openEditor({ ...edit, gap: event.target.value })} /></label>}
              <label className="ai-personal-field">个人用语
                <textarea ref={phraseInput} placeholder={'每行一种说法，例如：\n收一下\n归到一块儿'} maxLength={2500} rows={3} value={edit.phrase}
                  onChange={event => openEditor({ ...edit, phrase: event.target.value })} />
              </label>
              <small>一个动作支持多种说法；每行一种，每种最多 80 字。</small>
            </> : <><label className="ai-personal-field">排列方式<select value={edit.layout ?? 'horizontal'} onChange={event => openEditor({ ...edit, layout: event.target.value as Edit['layout'] })}>
              <option value="horizontal">横排</option>{account?.extended && <><option value="vertical">竖排</option><option value="grid">网格</option></>}
            </select></label><label className="ai-personal-field">默认间距
              <input ref={editorInput} type="number" min={0} max={2000} value={edit.gap}
                onChange={event => openEditor({ ...edit, gap: event.target.value })} />
            </label></>}
          </fieldset>
          <p className="ai-instruction-preview" role="status">解释预览：{preview ?? '对应动作当前不可用。'}{chosenAction?.requirement && `。${chosenAction.requirement}`}</p>
          {formError && <p className="ai-personal-error" role="alert">{formError}</p>}
          <div className="ai-personal-actions ai-personal-actions-end">
            <button type="button" className="toolbar-button" onClick={closeEditor}>取消</button>
            <button type="submit" className="primary-button" disabled={disabled || !(edit.kind === 'phrase' ? preferencePhrase(edit.phrase) : edit.gap.trim())}>
              {edit.id ? '保存修改' : '添加'}
            </button>
          </div>
        </form>}

        {visibleEntries.length ? <>
          <label className="ai-personal-search">
            <Icon name="search" size={15} />
            <input type="search" aria-label="搜索个人偏好" placeholder="搜索条目" value={search} onChange={event => setSearch(event.target.value)} />
          </label>
          {matchingEntries.length ? <ul className="ai-personal-entries">
            {matchingEntries.map(renderEntry)}
          </ul> : <p className="settings-empty">没有匹配的条目。</p>}
        </> : !edit && <div className="ai-personal-empty">
          <strong>尚未添加个人用语</strong>
          <p>内置指令已经可用。可从全部指令选择动作，为它添加自己习惯的多种说法。</p>
        </div>}
      </div>
      </>}

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
    </div>
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
