'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { CanvasControlState, CanvasControlReview, CanvasControlAction } from '../../protocols/canvas-control.ts';
import { FloatingPanel } from '../../ui/FloatingPanel.tsx';
import { IconButton } from '../../ui/Icon.tsx';
import { controlActionLabel } from './planning.ts';

export function CanvasControlToolbar({ client }: { client: ViewClient }) {
  const state = useControlState(client);
  if (!state.open && !state.reviews.length) return null;
  return <IconButton icon="pointer" label="画布控制" onClick={() => void client.dispatch('canvasControl.open@1').catch(() => undefined)} />;
}
function useControlState(client: ViewClient): CanvasControlState {
  const version = useSyncExternalStore(client.subscribeState, () => client.getOwnStateVersion('canvasControlUI'), () => 0);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<CanvasControlState>({ open: false, scope: 'selection', execution: 'direct', reviews: [] });
  useEffect(() => client.subscribeSignal('canvasControl.updated@1', () => setRefresh(value => value + 1)), [client]);
  useEffect(() => {
    let current = true;
    void client.ask<CanvasControlState>('canvasControl.state@1').then(next => { if (current) setState(next); }).catch(() => undefined);
    return () => { current = false; };
  }, [client, refresh, version]);
  return state;
}
export function CanvasControlPanel({ client }: { client: ViewClient }) {
  const state = useControlState(client);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rect, setRect] = useState({ x: 780, y: 100, width: 460, height: 620 });
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const pending = state.reviews.filter(review => review.status === 'pending');
  const activeReview = pending.find(review => review.id === selectedPlanId) ?? pending.at(-1);
  if (!state.open) return null;
  const apply = async (review: CanvasControlReview) => {
    setBusy(true); setError('');
    try {
      const result = await client.dispatch('canvasControl.apply@1', { id: review.id });
      if (result.createdIds.length) {
        await client.dispatch('selection.set', { ids: result.createdIds, mode: 'replace' });
        await client.dispatch('canvas.focusSelection');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const dismiss = (id: string) => void client.dispatch('canvasControl.dismiss@1', { id }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  return <FloatingPanel title="画布控制" icon="pointer" className="canvas-control-panel" rect={rect} onCommit={setRect}
    onActivate={() => void client.dispatch('canvasControl.open@1').catch(() => undefined)}
    onClose={() => void client.dispatch('canvasControl.close@1').catch(() => undefined)}>
    <div className="canvas-control-layout" aria-busy={busy}>
    <div className="canvas-control-content" role="region" aria-label="画布控制内容" tabIndex={0}>
      <p>在 AI 助手直接说要做什么，例如「把主角连到武器，用虚线」。也可以用 @ 指定节点。</p>
      {state.navigation && <section aria-label={state.navigation.heading} className="canvas-control-review">
        <header><strong>{state.navigation.heading}</strong></header>
        <ol>{state.navigation.items.map(item => <li key={item.id}><button type="button" onClick={() => void client.dispatch('canvasControl.navigate@1', { id: item.id }).catch(reason => setError(String(reason)))}>{item.label}</button></li>)}</ol>
      </section>}
      {state.background && <section aria-label="画布背景预览" className="canvas-control-review">
        <p>画布背景 · {state.background.previous} → {state.background.color}</p>
        <span aria-label="新背景颜色" style={{ backgroundColor: state.background.color, display: 'inline-block', width: 60, height: 22 }} />
        <button type="button" onClick={() => void client.dispatch('canvasControl.background.apply@1').catch(reason => setError(String(reason)))}>应用背景</button>
        <button type="button" onClick={() => void client.dispatch('canvasControl.background.dismiss@1')}>放弃背景</button>
      </section>}
      <label>生成方式
        <select aria-label="画布生成方式" value={state.execution} disabled={busy} onChange={event => void client.dispatch('canvasControl.execution@1', { execution: event.target.value as 'direct' | 'review' }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}>
          <option value="direct">直接生成新对象和空白正文</option>
          <option value="review">先预览，再应用</option>
        </select>
      </label>
      <label>下一次请求的对象范围
        <select aria-label="画布控制范围" value={state.scope} disabled={busy} onChange={event => void client.dispatch('canvasControl.scope@1', { scope: event.target.value as 'selection' | 'canvas' }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}>
          <option value="selection">选中、引用与本轮相关对象</option>
          <option value="canvas">整个画布，最多 80 个对象</option>
        </select>
      </label>
      <p className="canvas-control-note">新对象和空白节点正文默认直接生成。覆盖已有内容或删除对象需确认。修改正文时可 @ 引用节点。待应用计划十分钟内有效，整批操作可一次撤销。</p>
      {!state.reviews.length && <p className="canvas-control-empty">操作计划将在这里显示。</p>}
      {[...state.reviews].reverse().map(review => <section className="canvas-control-review" key={review.id} aria-label="画布操作计划">
        <header><strong>{review.replacement ? `${review.replacement.nodeCount} 个节点 · ${review.replacement.count} 处正文` : `${review.actions.length} 项操作`}</strong><span>{review.status === 'applied' ? '已应用' : review.status === 'dismissed' ? '已放弃' : '等待确认'}</span></header>
        {review.replacement && <><p>「{review.replacement.from}」 → 「{review.replacement.to}」</p>
          <ul>{review.replacement.examples.map((example, index) => <li key={index}>{example}</li>)}</ul></>}
        <ol>{review.actions.map((action, index) => <li key={index}>
          <strong>{controlActionLabel(action, review.titles)}</strong>
          <ActionDetails action={action} titles={review.titles} />
        </li>)}</ol>
      </section>)}
    </div>
    <footer className="canvas-control-actions" aria-label="画布计划操作">
      {(error || activeReview?.error) && <p role="alert">{error || activeReview?.error}</p>}
      {pending.length > 1 && <label>待应用计划<select aria-label="选择待应用计划" value={activeReview?.id ?? ''} onChange={event => { setSelectedPlanId(event.target.value); setError(''); }} disabled={busy}>
        {[...pending].reverse().map(review => <option key={review.id} value={review.id}>{review.replacement ? `${review.replacement.count} 处替换` : `${review.actions.length} 项`} · {new Date(review.createdAt).toLocaleTimeString('zh-CN')}</option>)}
      </select></label>}
      {activeReview ? <div className="canvas-control-action-row"><span>{activeReview.replacement ? `${activeReview.replacement.count} 处待替换` : `${activeReview.actions.length} 项待应用`}</span><button className="primary-button" disabled={busy} onClick={() => void apply(activeReview)}>{busy ? '正在应用…' : '应用整份计划'}</button><button disabled={busy} onClick={() => dismiss(activeReview.id)}>放弃</button></div>
        : <span className="canvas-control-note">{state.reviews.length ? '没有待应用计划，已生成的内容可在画布查看。' : '生成结果会直接出现在画布；也可切换为先预览。'}</span>}
    </footer>
    </div>
  </FloatingPanel>;
}
function ActionDetails({ action, titles }: { action: CanvasControlAction; titles: Record<string, string> }) {
  const name = (id: string) => titles[id] ?? id;
  if (action.type === 'delete') return <p>取消群组会保留其中的节点。删除节点时会同时清理关联连线和成员关系。</p>;
  return <>
    {'title' in action && action.title !== undefined && <p>标题 · {action.title}</p>}
    {'color' in action && action.color && <p>颜色 · {action.color}</p>}
    {'presentation' in action && action.presentation && <p>显示 · {action.presentation === 'text-box' ? '文本框' : '文字卡片'}</p>}
    {'x' in action && (action.x !== undefined || action.y !== undefined) && <p>位置 · {action.x ?? '保持横坐标'}，{action.y ?? '保持纵坐标'}</p>}
    {'width' in action && (action.width !== undefined || action.height !== undefined) && <p>尺寸 · {action.width ?? '保持宽度'} × {action.height ?? '保持高度'}</p>}
    {'members' in action && action.members && <p>成员 · {action.members.map(name).join('、')}</p>}
    {('from' in action || 'to' in action) && <p>连接 · {action.from ? name(action.from) : '原起点'} → {action.to ? name(action.to) : '原终点'}</p>}
    {'line' in action && action.line && <p>线型 · {action.line === 'dashed' ? '虚线' : '实线'}</p>}
    {'label' in action && action.label !== undefined && <p>标签 · {action.label || '清空'}</p>}
    {'edit' in action && action.edit && <details open><summary>局部替换 · 修订 {action.edit.expectedRevision} · 位置 {action.edit.start} · 删除 {action.edit.deleteCount} 字符</summary><pre>{action.edit.insert}</pre></details>}
    {('text' in action || 'append' in action) && (action.text !== undefined || action.append !== undefined) && <details open>
      <summary>{action.append === undefined ? '正文全文' : '追加正文'}</summary><pre>{action.text ?? action.append}</pre>
    </details>}
  </>;
}
