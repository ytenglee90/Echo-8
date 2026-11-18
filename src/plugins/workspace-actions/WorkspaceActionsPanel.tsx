'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { isRecord, type ViewClient } from '../../core/contracts.ts';
import type { WorkspaceActionIndex, WorkspaceCoverageReport, WorkspacePlan, WorkspacePlanReceipt, WorkspacePlanResume } from '../../protocols/workspace-actions.ts';
import { SettingsPageHeader } from '../../ui/SettingsPageHeader.tsx';
import { WORKSPACE_ACTIONS_NAMESPACE } from './model.ts';

const sample: WorkspacePlan = { version: 1, id: 'local-view-1', constraints: { effectScope: 'workspace' }, steps: [
  { id: 'focus', action: 'viewport.set', arguments: { target: { title: '空白1' }, zoom: 0.6 } },
  { id: 'map', action: 'minimap.open' },
], verify: [{ action: 'viewport.read', field: ['zoom'], equals: 0.6 }, { action: 'minimap.read', field: ['open'], equals: true }] };

export function WorkspaceActionsPanel({ client }: { client: ViewClient }) {
  const version = useSyncExternalStore(client.subscribeState, () => client.getOwnStateVersion(WORKSPACE_ACTIONS_NAMESPACE), () => 0);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<WorkspaceActionIndex>();
  const [coverage, setCoverage] = useState<WorkspaceCoverageReport>();
  const [filter, setFilter] = useState('');
  const [text, setText] = useState(JSON.stringify(sample, null, 2));
  const [receipt, setReceipt] = useState<WorkspacePlanReceipt>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => Promise.all([
    client.ask<WorkspaceActionIndex>('workspace.actions@1').then(setIndex),
    client.ask<WorkspaceCoverageReport>('workspace.coverage@1').then(setCoverage),
  ]);
  useEffect(() => {
    let live = true;
    void client.ask<{ open: boolean }>('workspace.actions.state@1').then(state => { if (live) setOpen(state.open); });
    void client.ask<WorkspaceActionIndex>('workspace.actions@1').then(result => { if (live) setIndex(result); });
    void client.ask<WorkspaceCoverageReport>('workspace.coverage@1').then(result => { if (live) setCoverage(result); });
    void client.ask<{ plan: WorkspacePlan; receipt: WorkspacePlanReceipt } | undefined>('workspace.plan.latest@1').then(result => {
      if (live && result) { setText(JSON.stringify(result.plan, null, 2)); setReceipt(result.receipt); }
    });
    return () => { live = false; };
  }, [client, version]);
  if (!open) return null;
  const perform = async (operation: 'run' | 'resume' | 'cancel', resume?: Omit<WorkspacePlanResume, 'id'>) => {
    setBusy(true); setError('');
    try {
      if (operation === 'run') {
        if (text.length > 256 * 1024) throw new Error('计划超过大小限制');
        setReceipt(await client.dispatch('workspace.plan.run@1', JSON.parse(text)));
      } else if (receipt) setReceipt(await client.dispatch(
        operation === 'resume' ? 'workspace.plan.resume@1' : 'workspace.plan.cancel@1', { id: receipt.id, ...resume },
      ));
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const actions = index?.actions.filter(action => (action.id + action.label + action.category + action.owner).toLowerCase().includes(filter.toLowerCase())) ?? [];
  const statusLabel = { completed: '已完成', waiting: '等待处理', failed: '失败', skipped: '已跳过', partial: '部分完成', cancelled: '已取消', expired: '已过期' };
  return <section className="workspace-actions-panel diagnostic-center" aria-label="工作区动作">
    <SettingsPageHeader title="开发者工具：工作区动作" description="查看内部协议、调试固定计划并核对执行回执。" closeLabel="关闭工作区动作" onClose={() => void client.dispatch('workspace.actions.close@1')} />
    <div className="workspace-actions-body">
      <p role="status">{index?.actions.filter(action => action.status === 'available').length ?? 0} 个动作可执行；{index?.registry.commands.length ?? 0} 个命令、{index?.registry.queries.length ?? 0} 个查询、{index?.registry.capabilities.length ?? 0} 个能力已注册。</p>
      <label>筛选动作<input aria-label="筛选动作" value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <button type="button" className="toolbar-button" onClick={() => void refresh().catch(err => setError(String(err)))}>刷新目录</button>
      <details><summary>全工作区覆盖清单（{coverage?.categories.length ?? 0} 类 / {coverage?.crossCategory.length ?? 0} 项跨类别能力）</summary>
        <p>{coverage?.note}</p>{coverage?.categories.map(entry => <details key={entry.id}><summary>{entry.id} {entry.name} · {entry.actions.filter(action => action.status === 'available').length} 个动作当前可执行</summary>
          <p>{entry.scope}</p><p>代表验收：{entry.acceptance.input}</p><p>通过条件：{entry.acceptance.expected}</p>
          <p>动作：{entry.actions.map(action => action.id).join('、') || '暂无可执行适配'}</p>
          {entry.limits.length > 0 && <p>限制：{entry.limits.join('、')}</p>}
          <p>固定计划验收以测试报告为准。</p></details>)}
        {coverage?.crossCategory.map(entry => <details key={entry.id}><summary>{entry.id} {entry.name}</summary><p>{entry.scope}</p><p>{entry.acceptance.expected}</p>
          {Boolean(entry.actions?.length) && <p>已接入动作：{entry.actions!.map(action => action.id + ' · ' + action.status).join('；')}</p>}</details>)}
      </details>
      <details><summary>动作目录（{actions.length}）</summary><div className="workspace-actions-catalog">
        {actions.map(action => <details key={action.id}><summary>{action.label} · {action.status === 'available' ? '可执行' : action.status === 'inactive' ? '当前不可用' : '界面入口'}</summary>
          <code>{action.id}</code><p>{action.owner} · {action.category} · {action.effect}</p><pre>{JSON.stringify(action.inputSchema ?? action.parameters, null, 2)}</pre>
          {Boolean(action.sourceKeys?.length) && <pre aria-label="动作协议来源">{action.sourceKeys!.join('\n')}</pre>}
        </details>)}
      </div></details>
      <label>固定计划<textarea aria-label="固定计划" spellCheck={false} value={text} onChange={event => setText(event.target.value)} rows={14} /></label>
      <div className="workspace-actions-buttons"><button type="button" className="toolbar-button" disabled={busy} onClick={() => void perform('run')}>运行固定计划</button>
        <button type="button" className="toolbar-button" disabled={busy || !receipt} onClick={() => void perform('resume')}>回读并继续</button>
        <button type="button" className="toolbar-button" disabled={busy || !receipt || receipt.status === 'completed'} onClick={() => void perform('cancel')}>取消剩余步骤</button></div>
      {error && <p role="alert" className="diagnostic-error">{error}</p>}
      {receipt && <div aria-label="计划回执"><p role="status">{receipt.id}：{statusLabel[receipt.status]}</p>{receipt.steps.map(step => <div className="workspace-action-receipt" key={step.id}>
        <strong>{step.id} · {statusLabel[step.status]}</strong><p>{step.message}</p>
        {step.status === 'waiting' && isRecord(step.result) && typeof step.result.reviewId === 'string' && <button type="button" className="toolbar-button" disabled={busy} onClick={() => void perform('resume', { apply: [step.id] })}>应用此文档预览并继续</button>}
        {step.status === 'waiting' && isRecord(step.result) && Array.isArray(step.result.candidates) && step.result.candidates.map(candidate => {
          if (!isRecord(candidate) || typeof candidate.id !== 'string') return null;
          const id = candidate.id;
          const result = step.result as Record<string, unknown>;
          if (typeof result.argument !== 'string') return null;
          const argument = result.argument; const index = typeof result.index === 'number' ? result.index : undefined;
          return <button type="button" className="toolbar-button" disabled={busy} key={id} onClick={() => void perform('resume', { choices: { [step.id]: { argument, index, id } } })}>{String(candidate.title)} · {id}</button>;
        })}
        <details><summary>实际结果</summary><pre>{JSON.stringify(step.result, null, 2)}</pre></details>
      </div>)}</div>}
    </div>
  </section>;
}
