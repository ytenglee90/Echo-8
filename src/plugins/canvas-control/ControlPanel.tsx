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
  const [state, setState] = useState<CanvasControlState>({ open: false, scope: 'selection', reviews: [] });
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
    <div className="canvas-control-content" aria-busy={busy}>
      <p>在 AI 助手输入 <strong>@画布操作</strong> 后描述要求，例如“新建三个人物节点，按类目分组，并连接关系”。</p>
      <label>下一次请求的对象范围
        <select aria-label="画布控制范围" value={state.scope} disabled={busy} onChange={event => void client.dispatch('canvasControl.scope@1', { scope: event.target.value as 'selection' | 'canvas' }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}>
          <option value="selection">选中及 @ 引用对象，可新建对象</option>
          <option value="canvas">整个画布，最多 80 个对象</option>
        </select>
      </label>
      <p className="canvas-control-note">AI 会获得该范围内的对象目录。修改正文时可在聊天中 @ 引用节点。每份计划十分钟内有效，应用后可用全局撤销恢复。</p>
      {error && <p role="alert">{error}</p>}
      {!state.reviews.length && <p className="canvas-control-empty">操作计划将在这里显示。</p>}
      {[...state.reviews].reverse().map(review => <section className="canvas-control-review" key={review.id} aria-label="画布操作计划">
        <header><strong>{review.actions.length} 项操作</strong><span>{review.status === 'applied' ? '已应用' : review.status === 'dismissed' ? '已放弃' : '等待确认'}</span></header>
        <ol>{review.actions.map((action, index) => <li key={index}>
          <strong>{controlActionLabel(action, review.titles)}</strong>
          <ActionDetails action={action} titles={review.titles} />
        </li>)}</ol>
        {review.status === 'pending' && <footer>
          <button className="primary-button" disabled={busy} onClick={() => void apply(review)}>应用整份计划</button>
          <button disabled={busy} onClick={() => dismiss(review.id)}>放弃</button>
        </footer>}
      </section>)}
    </div>
  </FloatingPanel>;
}
function ActionDetails({ action, titles }: { action: CanvasControlAction; titles: Record<string, string> }) {
  const name = (id: string) => titles[id] ?? id;
  if (action.type === 'delete') return <p>同时清理这些对象的关联连线和群组成员关系。</p>;
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
    {('text' in action || 'append' in action) && (action.text !== undefined || action.append !== undefined) && <details open>
      <summary>{action.append === undefined ? '正文全文' : '追加正文'}</summary><pre>{action.text ?? action.append}</pre>
    </details>}
  </>;
}
