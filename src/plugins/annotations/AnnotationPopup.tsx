'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { AnnotationOpenState, AnnotationRecord } from '../../protocols/annotations.ts';
import { FloatingPanel } from '../../ui/FloatingPanel.tsx';
import { IconButton } from '../../ui/Icon.tsx';
import { ProcessingLabel } from '../../ui/ProcessingIndicator.tsx';

interface AnnotationState {
  open?: AnnotationOpenState;
  records: AnnotationRecord[];
}

export function AnnotationPopup({
  client,
  surface = 'floating',
}: {
  client: ViewClient;
  surface?: 'floating' | 'immersive';
}) {
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const workspaceVersion = useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  const [state, setState] = useState<AnnotationState>({ records: [] });
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const recordRef = useRef<AnnotationRecord | undefined>(undefined);
  const draftRef = useRef('');
  const dirty = useRef(false);
  const savePromise = useRef<Promise<boolean> | undefined>(undefined);
  const composing = useRef(false);
  const mounted = useRef(true);
  const [compositionRevision, setCompositionRevision] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dirty.current = false;
    };
  }, []);

  const refresh = () => {
    void client.request<AnnotationState>('annotations.state@1').then((next) => {
      if (!mounted.current) return;
      setState(next);
      const record = next.open ? next.records.find((item) => item.id === next.open?.id) : undefined;
      recordRef.current = record;
      if (!dirty.current) {
        draftRef.current = record?.body ?? '';
        setDraft(draftRef.current);
      }
    }).catch(() => {
      if (mounted.current) setState({ records: [] });
    });
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilityVersion, client, workspaceVersion]);
  useEffect(
    () => client.subscribeSignal('annotations.invalidated', refresh),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );

  const save = useCallback((): Promise<boolean> => {
    if (savePromise.current) return savePromise.current;
    const run = async () => {
      if (dirty.current && composing.current) {
        if (mounted.current) setStatus('请先结束输入法组合文本');
        return false;
      }
      while (mounted.current && dirty.current && !composing.current) {
        const record = recordRef.current;
        if (!record) return false;
        const body = draftRef.current;
        setStatus('保存中…');
        try {
          const result = await client.dispatch('annotation.update', {
            id: record.id,
            body,
            expectedRevision: record.revision,
          });
          recordRef.current = { ...record, body, revision: result.revision, updatedAt: Date.now() };
          dirty.current = draftRef.current !== body;
          if (mounted.current) setStatus(dirty.current ? '未保存' : '已保存');
        } catch (error) {
          if (mounted.current) setStatus(error instanceof Error ? error.message : '保存失败');
          return false;
        }
      }
      return mounted.current && !dirty.current;
    };
    const pending = run().finally(() => {
      if (savePromise.current === pending) savePromise.current = undefined;
    });
    savePromise.current = pending;
    return pending;
  }, [client]);

  useEffect(() => {
    if (!dirty.current || !state.open) return;
    const timer = globalThis.setTimeout(() => void save(), 700);
    return () => globalThis.clearTimeout(timer);
  }, [compositionRevision, draft, save, state.open]);

  const open = state.open;
  const record = open ? state.records.find((item) => item.id === open.id) : undefined;
  useEffect(() => {
    if (!record || record.id === recordRef.current?.id) return;
    recordRef.current = record;
    dirty.current = false;
    draftRef.current = record.body;
    setDraft(record.body);
    setStatus('');
  }, [record]);
  if (!open || !record || (open.surface ?? 'floating') !== surface) return null;

  return (
    <FloatingPanel
      avoidRightRail={false}
      title="注释"
      icon="comment"
      rect={open.rect}
      className="annotation-floating-panel"
      localHistory
      onActivate={() => void client.dispatch('annotation.focus')}
      onCommit={(rect) => void client.dispatch('annotation.setPanelRect', rect)}
      onClose={() => {
        void save().then((saved) => saved ? client.dispatch('annotation.close') : undefined);
      }}
      headerActions={(
        <IconButton
          icon="trash"
          label="删除注释"
          onClick={() => {
            dirty.current = false;
            void client.dispatch('annotation.delete', { id: record.id });
          }}
        />
      )}
    >
      <div className="annotation-popup-body">
        <textarea
          autoFocus
          value={draft}
          maxLength={200_000}
          aria-label="注释正文"
          placeholder="输入注释内容…"
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            dirty.current = true;
            draftRef.current = event.currentTarget.value;
            setDraft(event.currentTarget.value);
            setStatus('未保存');
            setCompositionRevision((value) => value + 1);
          }}
          onChange={(event) => {
            dirty.current = true;
            draftRef.current = event.target.value;
            setStatus('未保存');
            setDraft(event.target.value);
          }}
          onBlur={() => void save()}
        />
        <span className="annotation-save-state" aria-live="polite">
          {status === '保存中…' ? <ProcessingLabel size={9}>{status}</ProcessingLabel> : status}
        </span>
      </div>
    </FloatingPanel>
  );
}
