'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { OPERATION_LOG_CHANGED, OPERATION_LOG_QUERY, type OperationLogEntry, type OperationLogSnapshot, type OperationStatus } from '../../protocols/operation-log.ts';
import { ProcessingLabel } from '../../ui/ProcessingIndicator.tsx';

const STATUS: Record<OperationStatus, string> = {
  queued: '排队中', running: '进行中', paused: '已暂停', retrying: '等待重试', waiting: '等待中',
  pending: '待确认', completed: '已完成', applied: '已应用', failed: '失败', 'timed-out': '超时',
  cancelled: '已取消', dismissed: '已放弃', expired: '已过期',
};

const LABELS: Readonly<Record<string, string>> = {
  'ai-context-retrieval': '准备 AI 上下文', 'ai-context-review': 'AI 上下文确认', 'ai-model-response': '模型响应',
  'ai-answer': 'AI 回答', 'ai-generation': 'AI 生成', 'ai-memory-index': '建立 AI 记忆索引',
  'ai-writeback': 'AI 正文写回', 'ai.proposal.accept': '应用 AI 正文', 'ai.generation.start': '记录本轮提问',
  'ai.generation.record': '保存本轮回答', 'canvas-plan': 'AI 画布计划', 'canvas-background': '画布背景预览',
  'canvasControl.commit@1': '提交 AI 画布修改', 'canvasControl.apply@1': '应用 AI 画布计划',
  'canvasControl.generate@1': '直接生成到画布', 'canvasControl.background.apply@1': '应用画布背景',
  'canvas.focusSelection': '定位选区', 'selection.set': '切换选区', 'palette.setPreferences': '更新外观设置',
  'node.create': '新建节点', 'node.rename': '修改节点标题', 'node.move': '移动节点', 'node.delete': '删除节点',
  'connection.create': '创建连线', 'connection.setLabel': '修改连线标签',
  'history.undo': '撤销画布修改', 'history.redo': '重做画布修改',
};

function isAI(entry: OperationLogEntry): boolean {
  return /^(?:ai[.-]|canvasControl\.|canvas-(?:plan|background)$)/u.test(entry.code) || entry.owner.startsWith('ai-');
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
}

export function OperationLogPanel({ client }: { client: ViewClient }) {
  const clock = useSyncExternalStore(client.subscribeClock, client.getClock, () => 0);
  const [snapshot, setSnapshot] = useState<OperationLogSnapshot>();
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('all');
  const [relatedId, setRelatedId] = useState<string>();
  const [limit, setLimit] = useState(30);

  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = () => {
      const sequence = ++request;
      void client.ask<OperationLogSnapshot>(OPERATION_LOG_QUERY).then(
        next => {
          if (!active || request !== sequence) return;
          setSnapshot(next);
          setError(false);
        },
        () => { if (active && request === sequence) setError(true); },
      );
    };
    const unsubscribe = client.subscribeSignal(OPERATION_LOG_CHANGED, refresh);
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [client]);

  const now = Math.max(clock, snapshot?.generatedAt ?? 0);
  const visible = snapshot?.entries.map(entry => (entry.status === 'pending' || entry.status === 'waiting') && entry.expiresAt !== undefined && now >= entry.expiresAt
    ? { ...entry, status: 'expired' as const, finishedAt: entry.expiresAt } : entry)
    .filter(entry => !relatedId || entry.relatedId === relatedId)
    .filter(entry => filter === 'all' || (filter === 'ai' ? isAI(entry) : ['failed', 'timed-out'].includes(entry.status)));

  return <section className="diagnostic-operation-log" aria-label="实时操作日志">
    <header><h3>实时操作日志</h3><label>显示
      <select aria-label="筛选操作日志" value={filter} onChange={event => { setFilter(event.target.value); setLimit(30); }}>
        <option value="all">全部</option><option value="ai">AI</option><option value="issues">失败与超时</option>
      </select>
    </label></header>
    {relatedId && <button type="button" className="toolbar-button" onClick={() => setRelatedId(undefined)}>清除同轮筛选</button>}
    <p>保留当前页面最近 240 条完成记录及进行中的操作。</p>
    {error ? <p role="alert">无法读取操作日志。</p>
      : !visible ? <p><ProcessingLabel size={10}>正在读取操作日志…</ProcessingLabel></p>
        : visible.length === 0 ? <p className="diagnostic-empty">暂无匹配的操作。</p>
          : <ol>{visible.slice(0, limit).map(entry => <OperationRow key={entry.id} entry={entry} now={now}
            onRelated={entry.relatedId && !relatedId ? () => { setRelatedId(entry.relatedId); setFilter('all'); setLimit(30); } : undefined} />)}</ol>}
    {visible && visible.length > limit && <button type="button" className="toolbar-button" onClick={() => setLimit(limit + 30)}>加载更多</button>}
  </section>;
}

function OperationRow({ entry, now, onRelated }: { entry: OperationLogEntry; now: number; onRelated?: () => void }) {
  const elapsed = (entry.finishedAt ?? now) - entry.createdAt;
  const percent = entry.progress && entry.progress > 0 ? Math.round(entry.progress * 100) : 0;
  const attemptElapsed = entry.startedAt === undefined ? undefined : (entry.finishedAt ?? now) - entry.startedAt;
  const label = LABELS[entry.code] ?? entry.code;
  const status = entry.code === 'ai-model-response' && entry.status === 'completed' ? '已收到响应' :
    entry.code === 'ai-model-response' && entry.status === 'waiting' ? '等待模型响应' :
    entry.code === 'ai-answer' && entry.status === 'completed' ? '回答已记录' : STATUS[entry.status];
  return <li>
    <div className="operation-log-row-title">
      <strong>{label}</strong><span data-status={entry.status}>{status}</span>
    </div>
    {entry.kind === 'task' && entry.status === 'running' &&
      <progress aria-label={`${label} 进度`} max={100} value={percent > 0 ? percent : undefined} />}
    <div className="operation-log-row-meta">
      <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>
      <span>耗时 {duration(elapsed)}</span>
      {entry.elapsedMs !== undefined && <span>响应延迟 {duration(entry.elapsedMs)}</span>}
      {entry.queueMs !== undefined && <span>排队 {duration(entry.queueMs)}</span>}
      {entry.status === 'running' && entry.kind === 'task' && now - entry.updatedAt >= 5_000 &&
        <span>{duration(now - entry.updatedAt)} 未报告新进度</span>}
      {entry.nextRunAt !== undefined && <span>预计等待 {duration(Math.max(0, entry.nextRunAt - now))}</span>}
      {entry.attempts !== undefined && entry.attempts > 0 && <span>第 {entry.attempts} 次</span>}
      {entry.timeoutMs !== undefined && <span>单次时限 {duration(entry.timeoutMs)}</span>}
      {entry.timeoutMs !== undefined && entry.status === 'running' && attemptElapsed !== undefined &&
        <span>剩余 {duration(Math.max(0, entry.timeoutMs - attemptElapsed))}</span>}
      {entry.status === 'running' && percent > 0 && <span>约 {percent}%</span>}
      {entry.count !== undefined && <span>{entry.count} 项</span>}
      {entry.status === 'pending' && entry.expiresAt !== undefined && <span>{duration(entry.expiresAt - now)} 后过期</span>}
      {onRelated && <button type="button" className="toolbar-button" onClick={onRelated}>查看同轮</button>}
    </div>
  </li>;
}
