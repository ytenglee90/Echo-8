'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { OPERATION_LOG_CHANGED, OPERATION_LOG_QUERY_V2, type OperationDetail, type OperationLogEntryV2 as OperationLogEntry, type OperationLogSnapshotV2 as OperationLogSnapshot, type OperationStatus } from '../../protocols/operation-log.ts';
import { ProcessingLabel } from '../../ui/ProcessingIndicator.tsx';

const STATUS: Record<OperationStatus, string> = {
  queued: '排队中', running: '进行中', paused: '已暂停', retrying: '等待重试', waiting: '等待中',
  pending: '待确认', completed: '已完成', applied: '已应用', failed: '失败', 'timed-out': '超时',
  cancelled: '已取消', dismissed: '已放弃', expired: '已过期',
};

const LABELS: Readonly<Record<string, string>> = {
  'ai-conversation-autosave-delay': '等待自动保存对话', 'search-index-rebuild': '更新画布检索索引',
  'ai-routing': '识别本轮要求', 'canvas-targets': '定位画布对象', 'canvas-validation': '校验画布计划',
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
const STEPS = { route: '识别意图', targets: '定位对象', model: '生成计划', validate: '校验计划', review: '等待执行', commit: '提交修改', done: '结束' };
const ROUTES = { local: '本地执行规则', model: '模型规划', conversation: '普通对话或正文任务' };
const SCOPES = { canvas: '当前全画布', selection: '当前选区', named: '指定名称或会话对象', conversation: '当前对话' };
const INTENTS = { create: '创建节点', content: '写入节点正文', connect: '连接节点', arrange: '排列节点', move: '移动节点',
  color: '调整颜色', presentation: '切换卡片或文本框', group: '处理群组', find: '查找对象', other: '其他画布操作' };
const ACTIONS = { 'create-node': '新建节点', 'update-node': '更新节点', 'create-group': '新建群组', 'update-group': '更新群组',
  'create-connection': '新建连线', 'update-connection': '更新连线', delete: '删除对象' };
const REASONS = {
  'local-rule': '已由本地规则解析，无需调用模型', 'model-plan': '使用当前模型生成画布计划',
  'needs-target': '需要补充操作对象', 'ambiguous-target': '有多个候选，请在画布控制中点选',
  'empty-targets': '本轮尚未定位可操作对象', 'review-existing': '计划涉及现有对象，请在画布控制中应用',
  'review-preference': '已选择先预览，请在画布控制中应用', 'ready-direct': '校验通过，等待提交到画布',
  'invalid-plan': '返回计划未通过格式或操作校验', 'stale-target': '对象已变化或计划已过期，请重新生成',
  'plugin-unavailable': '执行所需能力未启用', 'commit-failed': '提交失败，画布计划已保留',
  'model-http-error': '模型请求失败，可在 AI 助手中重试', 'model-timeout': '等待模型超过时限',
  'scope-limit': '本轮对象范围超过上限，请缩小范围后重试',
  'no-change': '本轮未产生修改动作', cancelled: '操作已取消', expired: '计划已过期', applied: '修改已提交到画布，可撤销',
};

function DetailText({ detail }: { detail: OperationDetail }) {
  return <>
    {detail.route && <span>{ROUTES[detail.route]}</span>}
    {detail.intent && <span>{INTENTS[detail.intent]}</span>}
    {detail.scope && <span>范围 · {SCOPES[detail.scope]}</span>}
    {detail.matched !== undefined && <span>命中 {detail.matched} 个对象</span>}
    {detail.candidates !== undefined && detail.candidates > 0 && <span>{detail.candidates} 个待选候选</span>}
    {detail.httpStatus !== undefined && <span>HTTP {detail.httpStatus}</span>}
    {detail.actions?.map(action => <span key={action.type}>{ACTIONS[action.type]} {action.count} 项</span>)}
  </>;
}

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
      void client.ask<OperationLogSnapshot>(OPERATION_LOG_QUERY_V2).then(
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
    {entry.detail && <div className="operation-log-row-meta"><DetailText detail={entry.detail} /></div>}
    {entry.detail?.reason && <p className="operation-log-explanation">{REASONS[entry.detail.reason]}</p>}
    {entry.kind === 'task' && entry.status === 'running' &&
      <progress aria-label={`${label} 进度`} max={100} value={percent > 0 ? percent : undefined} />}
    <div className="operation-log-row-meta">
      <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>
      <span>{entry.status === 'pending' ? '已等待确认' : entry.status === 'waiting' ? '已等待' : '耗时'} {duration(elapsed)}</span>
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
    {entry.steps?.length && <details>
      <summary>步骤与执行详情</summary>
      <ol>{entry.steps.map((step, index) => <li key={index}>
        <div className="operation-log-row-meta">
          <time>{new Date(step.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
          <span>{step.detail?.step ? STEPS[step.detail.step] : label}</span><span>{STATUS[step.status]}</span>
        </div>
        {step.detail && <div className="operation-log-row-meta"><DetailText detail={step.detail} /></div>}
        {step.detail?.reason && <p>{REASONS[step.detail.reason]}</p>}
      </li>)}</ol>
    </details>}
  </li>;
}
