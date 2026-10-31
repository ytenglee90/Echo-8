'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ApplicationKernel } from '../core/kernel.ts';
import type { PersistenceLaunchPolicy } from '../core/persistence.ts';
import { InfiniteCanvasShell } from '../shell/InfiniteCanvasShell.tsx';
import { BrandLoadingMark } from '../ui/ProcessingIndicator.tsx';
import {
  StartupFailureView,
  StartupSafeModeBanner,
  type StartupDiscardState,
} from './StartupRecoveryView.tsx';
import {
  getSafeStartServerSnapshot,
  isSafeStartRequested,
  reloadWithSafeStart,
  subscribeSafeStart,
} from './startup-recovery.ts';

export function InfiniteCanvasRuntime({
  createKernel,
}: {
  createKernel: (policy?: PersistenceLaunchPolicy) => ApplicationKernel | Promise<ApplicationKernel>;
}) {
  const initializationRef = useRef<Promise<ApplicationKernel> | null>(null);
  const [kernel, setKernel] = useState<ApplicationKernel | null>(null);
  const [status, setStatus] = useState<'starting' | 'active' | 'error'>('starting');
  const [error, setError] = useState('');
  const safeMode = useSyncExternalStore(
    subscribeSafeStart,
    isSafeStartRequested,
    getSafeStartServerSnapshot,
  );
  const [discardState, setDiscardState] = useState<StartupDiscardState>('idle');

  useEffect(() => {
    let current = true;
    const launchSafeMode = isSafeStartRequested();
    const initialization = initializationRef.current ?? Promise.resolve().then(() =>
      createKernel(launchSafeMode ? 'memory-only' : undefined));
    initializationRef.current = initialization;
    void initialization.then(
      (nextKernel) => current && setKernel(nextKernel),
      (reason) => {
        if (!current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus('error');
      },
    );
    return () => {
      current = false;
    };
  }, [createKernel]);

  useEffect(() => {
    if (!kernel) return;
    let current = true;
    void kernel.start().then(
      () => current && setStatus('active'),
      (reason) => {
        if (!current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus('error');
      },
    );
    return () => {
      current = false;
    };
  }, [kernel]);

  const reload = (memoryOnly: boolean) => {
    reloadWithSafeStart(memoryOnly);
  };

  const discardAndReload = async () => {
    if (!kernel || discardState !== 'confirm') return;
    setDiscardState('working');
    try {
      await kernel.discardLocalRecovery();
      reload(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setDiscardState('idle');
    }
  };

  if (status === 'error') {
    return (
      <StartupFailureView
        error={error}
        canDiscard={kernel !== null}
        discardState={discardState}
        onRetry={() => reload(false)}
        onSafeStart={() => reload(true)}
        onRequestDiscard={() => setDiscardState('confirm')}
        onDiscard={() => void discardAndReload()}
        onCancelDiscard={() => setDiscardState('idle')}
      />
    );
  }

  if (!kernel || status === 'starting') {
    return (
      <main className="boot-screen" aria-live="polite">
        <div className="boot-mark"><BrandLoadingMark size={52} /></div>
        <strong>正在建立广播与插件边界</strong>
        <span>恢复数据 · 验证能力 · 注入界面</span>
      </main>
    );
  }

  return (
    <>
      {safeMode === true && (
        <StartupSafeModeBanner onRetryRecovery={() => reload(false)} />
      )}
      <InfiniteCanvasShell kernel={kernel} />
    </>
  );
}
