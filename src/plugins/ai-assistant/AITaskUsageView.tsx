'use client';
import { useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { AI_USAGE_CHANGED, type AITaskUsageSnapshot } from '../../protocols/ai-usage.ts';

const categories = { baseRules: '基础规则', operationProtocol: '操作协议', history: '历史对话', references: '引用正文', objectDirectory: '对象目录', tools: '工具定义与往返', userRequest: '用户要求', taskState: '任务状态' };
const purposes = { answer: '回答', plan: '操作计划', 'tool-roundtrip': '工具往返', 'format-correction': '格式纠正', continuation: '自动续写', 'memory-extraction': '记忆提炼', 'compatibility-retry': '兼容重试', retry: '重试', repeat: '重新回答' };
export function AITaskUsageView({ client, sessionId }: { client: ViewClient; sessionId: string }) {
  const [snapshot, setSnapshot] = useState<AITaskUsageSnapshot>();
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true, sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      void client.ask<AITaskUsageSnapshot | undefined>('ai.task.usage@1', { sessionId, ...(selected ? { taskId: selected } : {}) })
        .then(value => { if (current && request === sequence) setSnapshot(value); }).catch(() => undefined);
    };
    refresh();
    const stop = client.subscribeSignal(AI_USAGE_CHANGED, refresh);
    return () => { current = false; stop(); };
  }, [client, sessionId, selected]);
  const totals = snapshot?.totals;
  if (!totals) return null;
  const number = (value: number) => value.toLocaleString('zh-CN');
  return <details className="ai-task-usage" aria-label="任务累计 Token 用量">
    <summary>任务累计 Token · 平台 {number(totals.actualInput + totals.actualOutput)} · 估算 {number(totals.estimatedInput + totals.estimatedOutput)} · {number(totals.calls)} 次调用{totals.unknownInput + totals.unknownOutput > 0 ? ' · 含未知用量' : ''}</summary>
    <p>平台返回：输入 {number(totals.actualInput)} · 输出 {number(totals.actualOutput)}</p>
    <p>估算补充：输入 {number(totals.estimatedInput)} · 输出 {number(totals.estimatedOutput)}（不代表账单）</p>
    <p>用量未知：输入 {totals.unknownInput} 次 · 输出 {totals.unknownOutput} 次；进行中 {totals.pending} 次；修正、续写及重试 {totals.retries} 次。</p>
    <p>推理 {number(totals.reasoning)} · 缓存命中 {number(totals.cachedInput)} · 未命中 {number(totals.cacheMissInput)}（均为平台返回的子集，不重复计入总量）</p>
    <details><summary>输入分类（估算）</summary>{Object.entries(totals.inputBreakdown).map(([key, value]) => <p key={key}>{categories[key as keyof typeof categories]}：{number(value!)}</p>)}</details>
    <details><summary>输出分类</summary>{Object.entries(totals.outputBreakdown).map(([key, value]) => <p key={key}>{({ answer: '最终内容', plan: '操作计划', memory: '记忆提炼' })[key as 'answer' | 'plan' | 'memory']}：平台 {number(value!.actual)} · 估算 {number(value!.estimated)} · 未知 {value!.unknown} 次</p>)}</details>
    <details><summary>调用明细</summary>{snapshot.attempts.map(attempt => <p key={attempt.id}>{purposes[attempt.purpose]} · {attempt.model} · {({ pending: '进行中', complete: '完成', failed: '失败', cancelled: '取消' })[attempt.status]} · 输入 {attempt.usage?.inputTokens ?? (attempt.status === 'complete' ? `${attempt.inputEstimate}（估算）` : '未知')} · 输出 {attempt.usage?.outputTokens ?? (attempt.status === 'complete' ? `${attempt.outputEstimate ?? 0}（估算）` : '未知')}</p>)}{snapshot.omittedAttempts > 0 && <p>较早 {snapshot.omittedAttempts} 条明细已清理，累计用量仍保留。</p>}</details>
    <label>查看任务 <select aria-label="查看任务用量" value={selected || snapshot.taskId} onChange={event => setSelected(event.target.value)}>{snapshot.availableTaskIds?.map((id, index) => <option key={id} value={id}>任务 {index + 1}</option>)}</select></label>
    <button type="button" onClick={() => void client.dispatch('ai.task.new@1', { sessionId }).then(() => { setSelected(''); setError(''); }).catch(reason => setError(String(reason)))}>新任务</button>
    <p>连续追问、纠正和重试累计到当前任务，点击“新任务”另起统计。统计仅保留在当前打开期间；失败且未返回用量的调用标为未知。</p>
    {error && <p role="alert">{error}</p>}
  </details>;
}
