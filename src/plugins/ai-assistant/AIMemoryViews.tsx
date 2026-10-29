'use client';

import { useRef, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type {
  AIContextMode,
  AIMemoryCandidateRecord,
  AIMemoryCatalogSnapshot,
  AIStatusSignal,
} from '../../protocols/ai.ts';
import { Icon } from '../../ui/Icon.tsx';
import { ProcessingIndicator, ProcessingLabel } from '../../ui/ProcessingIndicator.tsx';
import {
  chooseNativeAIMemoryFiles,
} from '../../ui/native-save.ts';
import { chooseAIMemoryDirectory } from './memory-directory-picker.ts';
import type { AIAssistantState } from './types.ts';

export function AIMemoryShortcut({
  client,
  assistantId,
  catalog,
  selectedSourceIds,
  contextMode,
}: {
  client: ViewClient;
  assistantId: string;
  catalog: AIMemoryCatalogSnapshot;
  selectedSourceIds: ReadonlySet<string>;
  contextMode: AIContextMode;
}) {
  const available = catalog.entries.filter((entry) => entry.status === 'ready' && entry.memory.enabled !== false);
  const selectedTitles = available
    .filter((entry) => selectedSourceIds.has(entry.memory.sourceId))
    .map((entry) => entry.memory.title);
  const explicitOnly = contextMode === 'explicit-only';
  return (
    <button
      type="button"
      className={`ai-memory-picker${selectedTitles.length > 0 || explicitOnly ? ' is-active' : ''}`}
      aria-label="选择本轮记忆，前往记忆中心"
      title={selectedTitles.length > 0
        ? `已选择：${selectedTitles.join('、')}。点击前往记忆中心调整。`
        : explicitOnly
          ? '当前仅读取明确选择或 @ 引用的记忆。点击前往记忆中心调整。'
          : '当前会自动检索可用记忆。点击前往记忆中心选择本轮记忆。'}
      onClick={() => void client.dispatch('ai.setView', { assistantId, view: 'memory' })}
    >
      <Icon name="at" size={14} />
      <span>选择记忆 · {selectedTitles.length > 0 ? `${selectedTitles.length} 份` : explicitOnly ? '仅明确' : '自动'}</span>
    </button>
  );
}

export function AIMemoryCenter({
  client,
  catalog,
  assistantId,
  selectedSourceIds,
  contextMode,
  memoryCandidates,
  currentSessionId,
  currentSessionTurns,
  memoryFiles,
  status,
  onSaveSession,
  onCorrectMemory,
  error,
  onError,
}: {
  client: ViewClient;
  catalog: AIMemoryCatalogSnapshot;
  assistantId: string;
  selectedSourceIds: ReadonlySet<string>;
  contextMode: AIContextMode;
  memoryCandidates: AIMemoryCandidateRecord[];
  currentSessionId?: string;
  currentSessionTurns: number;
  memoryFiles: AIAssistantState['memoryFiles'];
  status: AIStatusSignal;
  onSaveSession: () => void;
  onCorrectMemory: (directive: string) => void;
  error: string;
  onError: (message: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [editingTitleId, setEditingTitleId] = useState<string>();
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const cancelledTitleEditRef = useRef<string | undefined>(undefined);
  const query = filter.trim().toLocaleLowerCase('zh-CN');
  const entries = catalog.entries.filter(({ memory }) => !query ||
    `${memory.title} ${memory.scope ?? ''} ${memory.keywords.join(' ')}`.toLocaleLowerCase('zh-CN').includes(query));
  const currentMemory = catalog.entries.find(({ memory }) => memory.sessionId === currentSessionId)?.memory;
  const savingCurrentSession = status.state === 'indexing' && status.sessionId === currentSessionId;
  const pendingCandidates = memoryCandidates.filter((candidate) =>
    candidate.sessionId === currentSessionId && candidate.status === 'pending');
  const dispatch = async (type: string, payload: unknown) => {
    onError('');
    try {
      await client.dispatch(type, payload);
    } catch (reason) {
      onError(errorMessage(reason));
    }
  };
  const saveMemoryTitle = async (sourceId: string, currentTitle: string) => {
    const title = (titleDrafts[sourceId] ?? currentTitle).trim();
    if (!title) {
      onError('记忆名称不能为空');
      return;
    }
    if (title === currentTitle) {
      setEditingTitleId((current) => current === sourceId ? undefined : current);
      return;
    }
    onError('');
    try {
      await client.dispatch('ai.memory.rename', { sourceId, title });
      setTitleDrafts((drafts) => {
        const next = { ...drafts };
        delete next[sourceId];
        return next;
      });
      setEditingTitleId((current) => current === sourceId ? undefined : current);
    } catch (reason) {
      onError(errorMessage(reason));
    }
  };
  const setMemoryUsage = (sourceId: string, checked: boolean) => {
    const next = new Set(selectedSourceIds);
    if (checked) next.add(sourceId);
    else next.delete(sourceId);
    void dispatch('ai.assistant.setMemories', { assistantId, sourceIds: [...next] });
  };
  const chooseMemoryDirectory = async () => {
    onError('');
    try {
      const directory = await chooseAIMemoryDirectory(client);
      if (!directory) throw new Error('当前浏览器不支持选择文件夹，请使用 Chromium 版 Echo-8');
      await client.dispatch('ai.memory.linkDirectory', { directory });
    } catch (reason) {
      if ((reason as { name?: string })?.name !== 'AbortError') onError(errorMessage(reason));
    }
  };
  const importMemoryFiles = async () => {
    onError('');
    try {
      const sources = await chooseNativeAIMemoryFiles();
      if (sources.length > 0) await client.dispatch('ai.memory.importFiles', { sources });
    } catch (reason) {
      if ((reason as { name?: string })?.name !== 'AbortError') onError(errorMessage(reason));
    }
  };
  const unresolvedConflicts = catalog.conflicts.filter((item) => item.resolution === 'unresolved');
  return (
    <section className="ai-memory-center" aria-label="AI 记忆中心">
      <header className="ai-memory-center-overview">
        <div>
          <h2>记忆库</h2>
          <p>{catalog.counts.total === 0 ? '保存对话后，AI 才能在以后找到它。' : `已保存 ${catalog.counts.total} 份 · 可用 ${catalog.counts.ready} 份`}</p>
        </div>
        <div className="ai-memory-file-actions" role="group" aria-label="记忆文件操作">
          <small>{memoryFiles.linked
            ? `保存路径：${memoryFiles.directoryName}`
            : '默认：书籍所在文件夹（首次需确认）'}</small>
          <span>
            <button type="button" onClick={() => void chooseMemoryDirectory()}><Icon name="folder-open" size={14} />{memoryFiles.linked ? '更改保存路径' : '选择保存路径'}</button>
            <button type="button" onClick={() => void importMemoryFiles()}><Icon name="folder-open" size={14} />从本地导入记忆</button>
          </span>
          {memoryFiles.writingSourceIds.length > 0 && (
            <small className="ai-memory-files-progress">
              <ProcessingLabel size={9}>正在保存 {memoryFiles.writingSourceIds.length} 份记忆…</ProcessingLabel>
            </small>
          )}
        </div>
      </header>
      <section className="ai-memory-daily-action" aria-label="保存当前对话">
        <div>
          <strong>保存当前对话</strong>
          <small>{!currentSessionId || currentSessionTurns === 0
            ? '先回到对话并完成至少一轮交流后再保存。'
            : currentMemory
              ? `会更新“${currentMemory.title}”。`
              : memoryFiles.linked
                ? '保存后，AI 可以在以后的相关提问中找到本轮内容。'
                : '第一次保存会优先定位到书籍所在文件夹；确认后直接保存本轮对话。'}</small>
          {savingCurrentSession && (
            <small className="ai-memory-save-progress" role="status">
              <ProcessingLabel size={9}>正在保存原文并建立索引；完成后会自动显示在下方。</ProcessingLabel>
            </small>
          )}
        </div>
        <button
          type="button"
          disabled={!currentSessionId || currentSessionTurns === 0 || savingCurrentSession}
          onClick={onSaveSession}
          title={savingCurrentSession ? '正在保存原文并建立索引，请稍候' : currentMemory ? '更新当前对话原文和检索索引' : '保存当前对话原文并建立检索索引'}
        >{savingCurrentSession && <ProcessingIndicator size={10} />}{savingCurrentSession ? '正在保存…' : currentMemory ? '保存更新' : '保存本轮对话'}</button>
      </section>
      {(selectedSourceIds.size > 0 || contextMode === 'explicit-only') && <div className="ai-memory-selection-summary" role="status">
        <span>{selectedSourceIds.size > 0
          ? `当前助手只会从已选择的 ${selectedSourceIds.size} 份记忆中检索原文。`
          : '当前助手仅使用 @ 引用，不会自动检索全部历史。'}</span>
        <span className="ai-memory-selection-actions">
          {selectedSourceIds.size > 0 && <button
            type="button"
            onClick={() => void dispatch('ai.assistant.setMemories', { assistantId, sourceIds: [] })}
          >恢复自动检索</button>}
          {contextMode === 'explicit-only' && <button
            type="button"
            onClick={() => void dispatch('ai.assistant.setContextMode', { assistantId, mode: 'automatic' })}
          >允许自动检索</button>}
        </span>
      </div>}
      {pendingCandidates.length > 0 && <section className="ai-memory-center-candidates" aria-label="待确认的长期决定">
        <header><strong>待确认的长期决定</strong><em>{pendingCandidates.length} 项</em></header>
        {pendingCandidates.map((candidate) => (
          <article key={candidate.id} className="ai-memory-candidate-card">
            <strong>{candidate.subject}{candidate.scope ? `（${candidate.scope}）` : ''}</strong>
            <span>{candidateLabel(candidate)}</span>
            <blockquote>{candidate.sourceQuote}</blockquote>
            <footer>
              <button type="button" onClick={() => void dispatch('ai.memory.candidate.accept', { candidateId: candidate.id })}>确认</button>
              <button type="button" onClick={() => void dispatch('ai.memory.candidate.dismiss', { candidateId: candidate.id })}>忽略</button>
            </footer>
          </article>
        ))}
      </section>}
      {catalog.counts.total > 3 && <label className="ai-memory-filter">
        <span className="sr-only">筛选记忆</span>
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索已保存的记忆" />
      </label>}
      {status.state !== 'idle' && (
        <div className={`ai-status ai-status-${status.state}`} role="status">
          {status.state === 'preparing' || status.state === 'indexing' || status.state === 'generating'
            ? <ProcessingIndicator size={10} />
            : <i />}
          {status.message}
        </div>
      )}
      {memoryFiles.lastError && <p className="ai-error" role="alert">{memoryFiles.lastError}</p>}
      {error && <p className="ai-error" role="alert">{error}</p>}
      {unresolvedConflicts.length > 0 && (
        <section className="ai-memory-center-conflicts" aria-label="未解决的记忆冲突">
          <strong>有 {unresolvedConflicts.length} 条记忆需要你确认</strong>
          <p>系统会保留原文，不会擅自覆盖。点击修正后补上正确的新值并发送；保存本轮对话时会记录这次修改。</p>
          {unresolvedConflicts.map((conflict) => (
            <article key={conflict.key}>
              <b>{conflict.subject}{conflict.scope ? `（${conflict.scope}）` : ''}</b>
              <span>{conflict.evidence.map((evidence) => evidence.value).join(' / ')}</span>
              <button
                type="button"
                title={`在聊天中修正“${conflict.subject}”`}
                onClick={() => {
                  const previous = conflict.evidence.find((evidence) => evidence.effectiveStatus === 'competing')?.value
                    ?? conflict.evidence[0]?.value
                    ?? '';
                  onCorrectMemory(`@修改 ${conflict.scope ? `${conflict.scope}｜` : ''}${conflict.subject}：${previous} -> `);
                }}
              >在聊天中修正</button>
            </article>
          ))}
        </section>
      )}
      <div className="ai-memory-center-list">
        {entries.map(({ memory, status }) => (
          <article key={memory.sourceId} className={`ai-memory-center-entry status-${status}${memory.sessionId === currentSessionId ? ' is-current' : ''}`}>
            <div className="ai-memory-center-title">
              <span className="ai-memory-title-copy">
                {editingTitleId === memory.sourceId ? (
                  <input
                    className="ai-memory-title-inline-input"
                    aria-label={`修改记忆名称：${memory.title}`}
                    autoFocus
                    value={titleDrafts[memory.sourceId] ?? memory.title}
                    maxLength={120}
                    onChange={(event) => setTitleDrafts((drafts) => ({ ...drafts, [memory.sourceId]: event.target.value }))}
                    onBlur={() => {
                      if (cancelledTitleEditRef.current === memory.sourceId) {
                        cancelledTitleEditRef.current = undefined;
                        return;
                      }
                      void saveMemoryTitle(memory.sourceId, memory.title);
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void saveMemoryTitle(memory.sourceId, memory.title);
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelledTitleEditRef.current = memory.sourceId;
                        setTitleDrafts((drafts) => {
                          const next = { ...drafts };
                          delete next[memory.sourceId];
                          return next;
                        });
                        setEditingTitleId(undefined);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="ai-memory-title-inline-button"
                    title="双击修改记忆名称"
                    onDoubleClick={() => {
                      setTitleDrafts((drafts) => ({ ...drafts, [memory.sourceId]: memory.title }));
                      setEditingTitleId(memory.sourceId);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setTitleDrafts((drafts) => ({ ...drafts, [memory.sourceId]: memory.title }));
                        setEditingTitleId(memory.sourceId);
                      }
                    }}
                  ><strong>{memory.title}</strong></button>
                )}
                <small>创建于 {formatTime(memory.createdAt)}</small>
              </span>
              {status !== 'ready' && <span className="ai-memory-center-badges"><em>{memoryStatusLabel(status)}</em></span>}
            </div>
            <p className="ai-memory-summary">{memory.summary || '尚未生成摘要；可打开原文查看完整对话。'}</p>
            <div className="ai-memory-center-actions">
              <span className="ai-memory-card-direct-actions" aria-label="记忆操作">
                <button
                  type="button"
                  draggable
                  title="打开保存的对话原文；也可拖到画布生成副本"
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('application/x-echo8-content', JSON.stringify({
                      sourceId: memory.sourceId,
                      title: memory.title,
                    }));
                  }}
                  onClick={() => void dispatch('editor.open', { id: memory.sourceId })}
                ><Icon name="file" size={14} />打开原文</button>
                {memory.indexNodeId && <button
                  type="button"
                  draggable
                  title="打开这份记忆的检索索引；也可拖到画布生成副本"
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('application/x-echo8-content', JSON.stringify({
                      sourceId: memory.indexNodeId,
                      title: `${memory.title} · 记忆索引`,
                    }));
                  }}
                  onClick={() => void dispatch('editor.open', { id: memory.indexNodeId })}
                ><Icon name="find-replace" size={14} />打开检索索引</button>}
                <button
                  type="button"
                  className="ai-memory-delete-action"
                  title={`删除记忆：${memory.title}`}
                  onClick={() => void dispatch('ai.memory.delete.request', { sourceId: memory.sourceId })}
                ><Icon name="trash" size={14} />删除记忆</button>
              </span>
              <span className="ai-memory-card-right-actions">
                {memory.enabled === false && <button
                  type="button"
                  onClick={() => void dispatch('ai.memory.setEnabled', { sourceId: memory.sourceId, enabled: true })}
                >恢复使用</button>}
                <label className="ai-memory-card-use">
                  <input
                    type="checkbox"
                    checked={selectedSourceIds.has(memory.sourceId)}
                    disabled={memory.enabled === false || status !== 'ready'}
                    onChange={(event) => setMemoryUsage(memory.sourceId, event.target.checked)}
                  />
                  <span>本轮使用</span>
                </label>
                {memory.sessionId !== currentSessionId && (
                  <span className="ai-memory-primary-actions">
                  <button
                    type="button"
                    disabled={memory.enabled === false || status !== 'ready'}
                    onClick={() => void dispatch('ai.assistant.continueMemory', {
                      assistantId,
                      sourceId: memory.sourceId,
                    })}
                  >继续对话</button>
                  </span>
                )}
              </span>
            </div>
          </article>
        ))}
        {entries.length === 0 && <p className="ai-memory-center-empty">没有符合条件的记忆。</p>}
      </div>
    </section>
  );
}

function memoryStatusLabel(status: AIMemoryCatalogSnapshot['entries'][number]['status']): string {
  return ({
    ready: '可以使用',
    paused: '已经暂停',
    'source-missing': '原文不存在',
    'source-revision-changed': '原文已修改',
    'index-node-missing': '索引不存在',
    'hub-node-missing': '旧版记忆关系异常',
  })[status];
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function candidateLabel(candidate: AIMemoryCandidateRecord): string {
  const value = candidate.value ? `：${candidate.value}` : '';
  if (candidate.kind === 'modify') return `建议修改 ${candidate.previousValue ?? '旧值'} → ${candidate.value ?? '新值'}`;
  if (candidate.kind === 'deprecate') return `建议废弃${value}`;
  if (candidate.kind === 'branch') return `建议建立分支${value}`;
  return `建议确认${value}`;
}
