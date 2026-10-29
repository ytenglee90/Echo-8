'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { RuntimeSnapshot } from '../../protocols/runtime.ts';
import { DIAGNOSTIC_CENTER_NAMESPACE } from './model.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { ProcessingLabel } from '../../ui/ProcessingIndicator.tsx';

interface SearchIndexStatus {
  state: 'idle' | 'building' | 'ready' | 'error';
  indexedSources: number;
  totalSources: number;
  approximateBytes: number;
  lastBuiltAt?: number;
}

export function DiagnosticCenterPanel({ client }: { client: ViewClient }) {
  const stateVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion(DIAGNOSTIC_CENTER_NAMESPACE),
    () => 0,
  );
  const clock = useSyncExternalStore(client.subscribeClock, client.getClock, () => 0);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>();
  const [searchIndex, setSearchIndex] = useState<SearchIndexStatus>();
  const [error, setError] = useState('');
  const refreshTick = Math.floor(clock / 2000);

  useEffect(() => {
    let current = true;
    void client.ask<{ open: boolean }>('diagnostics.state').then((state) => {
      if (current) setOpen(state.open);
    });
    return () => { current = false; };
  }, [client, stateVersion]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void Promise.all([
      client.ask<RuntimeSnapshot>('system.runtime'),
      client.request<SearchIndexStatus>('search.index.status@1').catch(() => undefined),
    ]).then(
      ([next, indexStatus]) => {
        if (!current) return;
        setSnapshot(next);
        setSearchIndex(indexStatus);
        setError('');
      },
      (reason) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => { current = false; };
  }, [client, open, refreshTick]);

  if (!open) return null;
  const activePlugins = snapshot?.plugins.filter((plugin) => plugin.status === 'active').length ?? 0;
  const faultedPlugins = snapshot?.plugins.filter((plugin) => plugin.status === 'faulted') ?? [];
  const documentScale = snapshot?.store.find((domain) => domain.domain === 'document');
  const recentErrors = snapshot?.diagnostics.records.filter((record) => record.level === 'error').slice(-6).reverse() ?? [];

  return (
    <section className="diagnostic-center" aria-label="诊断中心">
      <div className="panel-heading">
        <div><span className="eyebrow">只读 · 已脱敏</span><h2>诊断中心</h2></div>
        <IconButton icon="close" label="关闭诊断中心" onClick={() => void client.dispatch('diagnostics.close')} />
      </div>
      <p className="panel-copy">这里只读取内核公开的规模、队列和健康状态，不读取节点正文或插件私有内容。打开时每两秒刷新。</p>
      {error && <p className="diagnostic-error">{error}</p>}
      {!snapshot ? <p className="diagnostic-empty"><ProcessingLabel size={10}>正在读取运行状态…</ProcessingLabel></p> : (
        <>
          <div className="diagnostic-cards">
            <Metric label="活动插件" value={`${activePlugins}/${snapshot.plugins.length}`} tone={faultedPlugins.length ? 'danger' : 'good'} />
            <Metric label="文档记录" value={String(documentScale?.recordCount ?? 0)} />
            <Metric label="撤销 / 重做" value={`${snapshot.history.undoCount} / ${snapshot.history.redoCount}`} />
            <Metric
              label="任务运行 / 排队 / 暂停"
              value={`${snapshot.tasks.active} / ${snapshot.tasks.queued} / ${snapshot.tasks.paused}`}
            />
          </div>

          <DiagnosticSection title="保存与运行">
            <dl className="diagnostic-grid">
              <div><dt>保存状态</dt><dd>{snapshot.persistence.state}</dd></div>
              <div><dt>恢复日志</dt><dd>{snapshot.persistence.journalEntries} 条</dd></div>
              <div><dt>恢复点</dt><dd>{snapshot.persistence.recoveryPoints} 个</dd></div>
              <div><dt>最近检查点耗时</dt><dd>{snapshot.persistence.checkpointPerformance
                ? `${snapshot.persistence.checkpointPerformance.durationMs} ms`
                : '尚未测量'}</dd></div>
              <div><dt>检查点准备线程</dt><dd>{snapshot.persistence.checkpointPerformance
                ? snapshot.persistence.checkpointPerformance.usedWorker ? '后台 Worker' : '主线程降级'
                : '尚未测量'}</dd></div>
              <div><dt>检查点最长主线程阻塞</dt><dd>{snapshot.persistence.checkpointPerformance
                ? `${snapshot.persistence.checkpointPerformance.longestMainThreadBlockMs} ms`
                : '尚未测量'}</dd></div>
              <div><dt>交互状态</dt><dd>{snapshot.interaction}</dd></div>
              <div><dt>消息指令</dt><dd>{snapshot.diagnostics.counters.commands ?? 0}</dd></div>
              <div><dt>事件 / 查询</dt><dd>{snapshot.diagnostics.counters.events ?? 0} / {snapshot.diagnostics.counters.queries ?? 0}</dd></div>
              <div><dt>动作 / 快捷键</dt><dd>{snapshot.actions.length} / {snapshot.shortcuts.length}</dd></div>
              <div><dt>任务资源预算</dt><dd>{snapshot.tasks.activeCost} / {snapshot.tasks.costBudget}</dd></div>
              <div><dt>检索索引</dt><dd>{searchIndex ? `${searchIndex.state} · ${searchIndex.indexedSources}/${searchIndex.totalSources}` : '未启用'}</dd></div>
              <div><dt>索引内存估算</dt><dd>{searchIndex ? bytes(searchIndex.approximateBytes) : '—'}</dd></div>
              <div><dt>JS 堆内存</dt><dd>{snapshot.memory ? `${bytes(snapshot.memory.used)} / ${bytes(snapshot.memory.limit)}` : '浏览器未公开'}</dd></div>
            </dl>
          </DiagnosticSection>

          <DiagnosticSection title="状态仓库（只有数量，没有内容）">
            <div className="diagnostic-domain-list">
              {snapshot.store.map((domain) => (
                <div key={domain.domain}>
                  <strong>{domain.domain}</strong>
                  <span>修订 {domain.revision} · {domain.namespaceCount} 命名空间 · {domain.recordCount} 记录</span>
                </div>
              ))}
            </div>
          </DiagnosticSection>

          <DiagnosticSection title="插件健康">
            <div className="diagnostic-plugin-list">
              {snapshot.plugins.map((plugin) => (
                <div key={plugin.id}>
                  <i className={plugin.status === 'active' ? 'good' : plugin.status === 'faulted' ? 'danger' : ''} />
                  <span><strong>{plugin.name}</strong><small>{plugin.status} · {plugin.resources} 资源</small></span>
                </div>
              ))}
            </div>
          </DiagnosticSection>

          <DiagnosticSection title="后台任务">
            {snapshot.tasks.tasks.length === 0 ? <p className="diagnostic-empty">当前没有后台任务。</p> : (
              <div className="diagnostic-task-list">
                {snapshot.tasks.tasks.map((task) => (
                  <div key={task.id}>
                    <strong>{task.category}</strong>
                    <span>
                      {task.owner} · {task.state} · {Math.round(task.progress * 100)}% · 第 {task.attempts} 次
                    </span>
                  </div>
                ))}
              </div>
            )}
          </DiagnosticSection>

          <DiagnosticSection title="最近错误（已脱敏）">
            {recentErrors.length === 0 ? <p className="diagnostic-empty">没有记录到错误。</p> : (
              <div className="diagnostic-error-list">
                {recentErrors.map((record) => (
                  <div key={record.id}><strong>{record.source}</strong><span>{record.message}</span><time>{new Date(record.timestamp).toLocaleTimeString()}</time></div>
                ))}
              </div>
            )}
          </DiagnosticSection>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className={tone}><span>{label}</span><strong>{value}</strong></div>;
}

function DiagnosticSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="diagnostic-section"><h3>{title}</h3>{children}</section>;
}

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
