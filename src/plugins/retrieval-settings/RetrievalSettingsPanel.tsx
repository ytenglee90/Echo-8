'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { UISlot, ViewClient } from '../../core/contracts.ts';
import type { RetrievalMode, RetrievalSettingsState } from '../../protocols/retrieval.ts';
import { SettingsPageHeader } from '../../ui/SettingsPageHeader.tsx';

export function RetrievalSettingsPanel({ client, renderSlot }: { client: ViewClient; renderSlot?: (slot: UISlot) => ReactNode }) {
  const [state, setState] = useState<RetrievalSettingsState>({ open: false, mode: 'local' });
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    const refresh = () => void client.ask<RetrievalSettingsState>('retrieval.state@1').then(next => { if (current) setState(next); }).catch(reason => { if (current) setError(String(reason)); });
    refresh();
    const unsubscribe = client.subscribeState(refresh);
    return () => { current = false; unsubscribe(); };
  }, [client]);
  if (!state.open) return null;
  return <section className="retrieval-settings-panel" aria-label="检索设置">
    <SettingsPageHeader title="检索" description="自动选择当前任务需要的来源，管理本地和云端语义检索。" closeLabel="关闭检索设置"
      onClose={() => void client.dispatch('retrieval.close@1').catch(reason => setError(String(reason)))} />
    <label className="ai-field"><span>检索方式</span><select aria-label="检索方式" value={state.mode} onChange={event => {
      setError('');
      void client.dispatch('retrieval.configure@1', { mode: event.target.value as RetrievalMode }).catch(reason => setError(String(reason)));
    }}>
      <option value="keyword">仅关键词</option><option value="local">本地优先</option><option value="cloud-fallback">允许云端补查</option>
    </select></label>
    <p>按名字操作画布或处理明确选区时直接读取目标。需要按意思找正文时，才调用当前允许的语义检索。</p>
    <p>{state.mode === 'keyword' ? '当前使用标题和 BM25，本轮自动检索跳过语义模型。' : state.mode === 'local' ? '当前结合 BM25 与本地 BGE。检索在设备上完成，API Token 为 0。' : '本地关键词和语义结果各不足 3 个候选来源时补查云端。云端连接仍需独立授权，可能发送查询及授权片段并产生费用。'}</p>
    <details><summary>关键词索引版本与更新</summary>
      <p>索引格式 · 压缩倒排索引 v1。检索策略 · 中文关键词与 BM25、短语匹配。</p>
      <p>优点 · 标题、专有名词和原话可精确匹配。代价 · 同义表达可能漏检，可结合本地语义补查。</p>
      <p>当前没有已验证的可升级关键词版本。涉及分词或格式的更新会说明是否重建，排序调整会说明是否可复用索引。</p>
    </details>
    {renderSlot?.('ai.retrieval')}
    {error && <p role="alert" className="ai-error">{error}</p>}
  </section>;
}
