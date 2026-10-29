'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import {
  TEXT_ASSIST_RULE_FILE_REQUESTED_SIGNAL,
  type TextAssistResourceStatus,
} from '../../protocols/text-assist.ts';
import { Icon } from '../../ui/Icon.tsx';
import { ProcessingIndicator } from '../../ui/ProcessingIndicator.tsx';

const MAX_RULE_FILE_BYTES = 16 * 1024 * 1024;

export function TextAssistAssociationNotice({ client }: { client: ViewClient }) {
  const [status, setStatus] = useState<TextAssistResourceStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectionRequested, setSelectionRequested] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    void client.request<TextAssistResourceStatus>('text.assist.resources@3')
      .then(setStatus)
      .catch(() => setStatus(undefined));
  }, [client]);

  useEffect(() => {
    refresh();
    return client.subscribeSignal('text.assist.resources.status', refresh);
  }, [client, refresh]);
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = client.subscribeSignal(TEXT_ASSIST_RULE_FILE_REQUESTED_SIGNAL, () => {
      setSelectionRequested(true);
      setError('');
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [client]);

  const importFile = async (file: File) => {
    try {
      if (!file.name.toLocaleLowerCase().endsWith('.txt')) throw new Error('请选择 TXT 规则文件');
      if (file.size > MAX_RULE_FILE_BYTES) throw new Error('规则文件不能超过 16 MiB');
      setBusy(true);
      setError('');
      const text = await file.text();
      if (!mountedRef.current) return;
      await client.dispatch('textAssist.importRulesFile', { name: file.name, text });
      if (!mountedRef.current) return;
      setSelectionRequested(false);
      refresh();
    } catch (reason) {
      if (mountedRef.current) {
        setError(reason instanceof Error ? reason.message : '导入纠错规则失败');
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const visible = Boolean(status && (
    status.association.state === 'unassociated' || selectionRequested
  ));

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,text/plain"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          input.value = '';
          if (file) void importFile(file);
        }}
      />
      {visible && (
        <aside className="text-assist-association-notice" role="status" aria-live="polite">
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
            <span className="text-assist-association-icon">
              {busy ? <ProcessingIndicator size={16} /> : <Icon name="link" size={20} />}
            </span>
            <span className="text-assist-association-copy">
              <strong>{busy ? '正在导入纠错规则…' : selectionRequested ? '选择新的纠错规则' : '纠错规则尚未导入'}</strong>
              <small>选择 Echo-8-text-assist-rules.txt；导入一次后会保存在本机</small>
              {error && <em>{error}</em>}
            </span>
            <span className="text-assist-association-action">导入</span>
          </button>
        </aside>
      )}
    </>
  );
}
