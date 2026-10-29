'use client';

import { useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { Icon, IconButton } from '../../ui/Icon.tsx';
import { ProcessingIndicator } from '../../ui/ProcessingIndicator.tsx';

interface PendingMemoryDeletion {
  sourceId: string;
  title: string;
}

/** Core-owned modal surface for confirming the durable memory deletion command. */
export function AIMemoryDeleteDialog({ client }: { client: ViewClient }) {
  const [pending, setPending] = useState<PendingMemoryDeletion>();
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let current = true;
    const refresh = () => {
      void client.ask<PendingMemoryDeletion | undefined>('ai.memory.deleteConfirmation').then(
        (next) => {
          if (!current) return;
          setPending(next);
          if (!next) {
            setDeleting(false);
            setError('');
          }
        },
        (reason) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); },
      );
    };
    refresh();
    const unsubscribe = client.subscribeSignal('ai.memory.deleteConfirmation.changed', refresh);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [client]);

  if (!pending) return null;

  const cancel = () => {
    if (deleting) return;
    void client.dispatch('ai.memory.delete.cancel', { sourceId: pending.sourceId })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const confirm = () => {
    if (deleting) return;
    setDeleting(true);
    setError('');
    void client.dispatch('ai.memory.delete.confirm', { sourceId: pending.sourceId })
      .catch((reason) => {
        setDeleting(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <div className="ai-memory-delete-backdrop" onPointerDown={cancel}>
      <section
        className="ai-memory-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-memory-delete-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong id="ai-memory-delete-title">删除这份记忆？</strong>
            <span>“{pending.title}”的对话原文和检索索引都会被删除。</span>
          </div>
          <IconButton icon="close" label="取消删除" disabled={deleting} onClick={cancel} />
        </header>
        {error && <p className="ai-memory-delete-error" role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={deleting} onClick={cancel}>取消</button>
          <button type="button" className="ai-memory-delete-confirm" disabled={deleting} onClick={confirm}>
            {deleting ? <ProcessingIndicator size={11} /> : <Icon name="trash" size={15} />}
            {deleting ? '正在删除…' : '删除记忆'}
          </button>
        </footer>
      </section>
    </div>
  );
}
