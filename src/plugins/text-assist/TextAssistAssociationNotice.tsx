'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { TextAssistResourceStatus } from '../../protocols/text-assist.ts';
import { Icon } from '../../ui/Icon.tsx';

export function TextAssistAssociationNotice({ client }: { client: ViewClient }) {
  const [status, setStatus] = useState<TextAssistResourceStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    void client.request<TextAssistResourceStatus>('text.assist.resources@3')
      .then(setStatus)
      .catch(() => setStatus(undefined));
  }, [client]);

  useEffect(() => {
    refresh();
    return client.subscribeSignal('text.assist.resources.status', refresh);
  }, [client, refresh]);

  if (!status || status.association.state !== 'unassociated') return null;

  const associate = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await client.dispatch('textAssist.loadRulesFile');
      refresh();
    } catch (reason) {
      if ((reason as { name?: string })?.name !== 'AbortError') {
        setError(reason instanceof Error ? reason.message : '导入纠错规则失败');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="text-assist-association-notice" role="status" aria-live="polite">
      <button type="button" onClick={() => void associate()} disabled={busy}>
        <span className="text-assist-association-icon"><Icon name="link" size={20} /></span>
        <span className="text-assist-association-copy">
          <strong>{busy ? '正在导入纠错规则…' : '纠错规则尚未导入'}</strong>
          <small>选择 Echo-8-text-assist-rules.txt；导入一次后会保存在本机</small>
          {error && <em>{error}</em>}
        </span>
        <span className="text-assist-association-action">导入</span>
      </button>
    </aside>
  );
}
