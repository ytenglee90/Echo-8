'use client';
import { useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { AIRequestInspectionState } from '../../protocols/ai-request-inspection.ts';
import { IconButton } from '../../ui/Icon.tsx';

export function AIRequestInspectionDialog({ client }: { client: ViewClient }) {
  const [state, setState] = useState<AIRequestInspectionState>();
  useEffect(() => {
    let current = true;
    const refresh = () => void client.ask<AIRequestInspectionState | undefined>('ai.request.inspection@1').then(next => { if (current) setState(next); }).catch(() => undefined);
    refresh();
    const stop = client.subscribeSignal('ai.request.inspection.changed@1', refresh);
    return () => { current = false; stop(); };
  }, [client]);
  if (!state) return null;
  const close = () => void client.dispatch('ai.request.closeInspection@1').catch(() => undefined);
  return <div className="confirmation-dialog-backdrop" onPointerDown={close}>
    <section className="ai-request-inspection-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-request-inspection-title" onPointerDown={event => event.stopPropagation()}>
      <header><div><strong id="ai-request-inspection-title">本轮发送内容</strong><p>显示实际发出的请求，密钥已隐藏。仅保留在当前打开期间，刷新或关闭页面后清除。</p></div><IconButton icon="close" label="关闭发送内容" onClick={close} /></header>
      <div className="ai-request-inspection-body">
        {state.error && <p role="alert">{state.error}</p>}
        {!state.requests.length && <p>没有保留这一轮的请求。它可能来自刷新前、已被清理，或尚未真正发送。</p>}
        {state.requests.map((request, index) => <section key={request.id} aria-label={`实际请求 ${index + 1}`}>
          <h3>请求 {index + 1} · {new Date(request.timestamp).toLocaleString('zh-CN', { hour12: false })}</h3>
          <p>{request.method} {request.endpoint}</p>
          <details><summary>请求头（密钥已隐藏）</summary><pre>{JSON.stringify(request.headers, null, 2)}</pre></details>
          {request.omitted ? <p>请求正文超过单条查看上限，本次未缓存。实际发送了 {request.bodyLength.toLocaleString()} 个字符。</p> : <pre aria-label="实际请求正文">{formatBody(request.body ?? '')}</pre>}
        </section>)}
      </div>
    </section>
  </div>;
}
function formatBody(body: string): string { try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; } }
