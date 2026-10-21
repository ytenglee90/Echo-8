'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import {
  LOCAL_SEMANTIC_PROVIDER_CHANGED_SIGNAL,
  LOCAL_SEMANTIC_PROVIDER_COMMANDS,
  LOCAL_SEMANTIC_PROVIDER_STATE_QUERY,
  type LocalSemanticProviderPanelState,
} from '../../protocols/local-semantic.ts';
import { Icon } from '../../ui/Icon.tsx';

const EMPTY_STATE: LocalSemanticProviderPanelState = {
  enabled: true,
  modelLoaded: false,
  cache: { status: 'idle', indexedSources: 0, indexedChunks: 0, totalSources: 0, partialSources: 0 },
};

export function LocalSemanticProviderSettings({ client }: { client: ViewClient }) {
  const commandVersion = useSyncExternalStore(client.subscribeCommands, client.getCommandVersion, () => 0);
  const available = client.isCommandAvailable(LOCAL_SEMANTIC_PROVIDER_COMMANDS.setEnabled);
  const [state, setState] = useState<LocalSemanticProviderPanelState>(EMPTY_STATE);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!available) return;
    const next = await client.ask<LocalSemanticProviderPanelState>(LOCAL_SEMANTIC_PROVIDER_STATE_QUERY);
    setState(next);
  }, [available, client]);

  useEffect(() => {
    let current = true;
    if (!available) return undefined;
    void client.ask<LocalSemanticProviderPanelState>(LOCAL_SEMANTIC_PROVIDER_STATE_QUERY).then((next) => {
      if (current) setState(next);
    }).catch(() => {
      if (current) setState(EMPTY_STATE);
    });
    return () => { current = false; };
  }, [available, client, commandVersion]);
  useEffect(() => {
    if (!available) return undefined;
    return client.subscribeSignal(LOCAL_SEMANTIC_PROVIDER_CHANGED_SIGNAL, () => { void refresh().catch(() => undefined); });
  }, [available, client, refresh]);

  if (!available) {
    return <section className="local-semantic-provider-settings is-unavailable" aria-label="本机理解检索">
      <header className="local-semantic-hero">
        <div>
          <span className="local-semantic-eyebrow">检索方式</span>
          <h2>本机理解检索</h2>
          <p>插件未启用；AI 会使用关键词检索。</p>
        </div>
        <strong className="local-semantic-badge">未启用</strong>
      </header>
    </section>;
  }

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setError('');
    try {
      await operation();
      setMessage(success);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const busy = state.cache.status === 'downloading' || state.cache.status === 'indexing';
  // Rebuild/download commands return as soon as their managed task starts.
  // Surface asynchronous task failures from provider state as well as a
  // synchronous command rejection, otherwise users only see a vague fallback.
  const taskError = state.cache.status === 'error' ? state.cache.error : undefined;
  const presentation = localSemanticPresentation(state);
  const canPrepare = state.enabled && !busy && ['idle', 'error'].includes(state.cache.status);

  return <section className={`local-semantic-provider-settings status-${state.cache.status}`} aria-label="本机理解检索">
    <header className="local-semantic-hero">
      <div>
        <span className="local-semantic-eyebrow">检索方式</span>
        <h2>本机理解检索</h2>
        <p>不需要 API KEY，文本不离开设备。</p>
      </div>
      <strong className="local-semantic-badge">{localAvailabilityLabel(state)}</strong>
    </header>
    <div className={`local-semantic-status status-${state.cache.status}`} role="status">
      <i />
      <span><strong>{presentation.title}</strong><small>{presentation.detail}</small></span>
    </div>
    <div className="local-semantic-primary-actions">
      {!state.enabled && <button
        type="button"
        onClick={() => void run(
          () => client.dispatch(LOCAL_SEMANTIC_PROVIDER_COMMANDS.setEnabled, { enabled: true }),
          '已开启，可下载公开模型',
        )}
      ><Icon name="sparkles" size={14} />开启本机理解检索</button>}
      {canPrepare && <button
        type="button"
        onClick={() => void run(
          () => client.dispatch(LOCAL_SEMANTIC_PROVIDER_COMMANDS.rebuild, { force: true }),
          '正在下载并准备本机模型',
        )}
      ><Icon name={state.cache.status === 'error' ? 'reset' : 'download'} size={14} />{state.cache.status === 'error' ? '重试下载' : '下载模型（约 40 MB）'}</button>}
      {state.enabled && state.cache.status === 'ready' && <span className="local-semantic-ready-note">已开启，无需操作</span>}
    </div>
    {message && <p className="ai-message">{message}</p>}
    {(error || taskError) && <p className="ai-error" role="alert">{error || taskError}</p>}
  </section>;
}

function localAvailabilityLabel(state: LocalSemanticProviderPanelState): string {
  if (!state.enabled || state.cache.status === 'disabled') return '已关闭';
  if (state.cache.status === 'ready') return state.modelLoaded ? '已下载并可用' : '索引已就绪';
  if (state.cache.status === 'downloading') return '正在下载';
  if (state.cache.status === 'indexing') return '正在建立索引';
  if (state.cache.status === 'dirty') return '等待更新';
  if (state.cache.status === 'error') return '准备失败';
  return '尚未下载';
}

function localSemanticPresentation(state: LocalSemanticProviderPanelState): { title: string; detail: string } {
  if (!state.enabled || state.cache.status === 'disabled') {
    return { title: '本机理解检索已关闭', detail: 'AI 当前使用关键词检索。' };
  }
  if (state.cache.status === 'downloading') {
    const download = state.cache.download;
    return { title: '正在下载公开模型', detail: download ? `正在准备 ${download.label}（${download.current}/${download.total}）` : '正在准备本机模型文件。' };
  }
  if (state.cache.status === 'indexing') {
    return { title: '正在建立索引', detail: `正在整理 ${state.cache.indexedSources}/${state.cache.totalSources} 个来源。` };
  }
  if (state.cache.status === 'ready') {
    return { title: state.modelLoaded ? '公开模型已下载，可直接使用' : '本机索引已就绪', detail: `已索引 ${state.cache.indexedSources} 个来源。` };
  }
  if (state.cache.status === 'dirty') {
    return { title: '资料已更新', detail: '下次提问时会自动更新。' };
  }
  if (state.cache.status === 'error') {
    return { title: '公开模型准备失败', detail: state.cache.error || '可重试下载；AI 会暂时使用关键词检索。' };
  }
  return { title: '尚未下载公开模型', detail: '下载约 40 MB 后即可在本机理解相近说法。' };
}
