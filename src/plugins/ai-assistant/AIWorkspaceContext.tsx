'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { CanvasControlState } from '../../protocols/canvas-control.ts';
import type { CloudSyncState } from '../../cloud/contracts.ts';

export function AIWorkspaceContext({ client }: { client: ViewClient }) {
  const version = useSyncExternalStore(client.subscribeCommands, client.getCommandVersion, () => 0);
  const workspaceVersion = useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  const [invalidation, setInvalidation] = useState(0);
  const [book, setBook] = useState('当前本地书籍');
  const [scope, setScope] = useState<'selection' | 'canvas'>();
  const [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => setInvalidation(value => value + 1);
    const cloud = client.subscribeSignal('cloudSync.updated', refresh);
    const control = client.subscribeSignal('canvasControl.updated@1', refresh);
    return () => { cloud(); control(); };
  }, [client]);
  useEffect(() => {
    let active = true;
    void Promise.all([
      client.ask<CloudSyncState>('cloudSync.state').catch(() => undefined),
      client.ask<CanvasControlState>('canvasControl.state@1').catch(() => undefined),
    ]).then(([cloud, control]) => {
      if (!active) return;
      setBook(cloud?.activeProjectName || '当前本地书籍'); setScope(control?.scope);
    });
    return () => { active = false; };
  }, [client, version, workspaceVersion, invalidation]);
  return <div className="ai-workspace-context">
    <span title={book}>当前书籍：{book}</span>
    {scope && <label>默认控制范围<select aria-label="助手默认控制范围" value={scope} onChange={event => {
      setError(''); void client.dispatch('canvasControl.scope@1', { scope: event.target.value as 'selection' | 'canvas' })
        .catch(reason => setError(String(reason)));
    }}><option value="selection">选中对象</option><option value="canvas">整个画布</option></select></label>}
    <button type="button" onClick={() => { void client.dispatch('ai.personal.open@1').catch(reason => setError(String(reason))); }}>查看指令</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
