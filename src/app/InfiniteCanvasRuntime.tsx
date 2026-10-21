'use client';

import { useEffect, useRef, useState } from 'react';
import type { ApplicationKernel } from '../core/kernel.ts';
import { InfiniteCanvasShell } from '../shell/InfiniteCanvasShell.tsx';

export function InfiniteCanvasRuntime({
  createKernel,
}: {
  createKernel: () => ApplicationKernel | Promise<ApplicationKernel>;
}) {
  const initializationRef = useRef<Promise<ApplicationKernel> | null>(null);
  const [kernel, setKernel] = useState<ApplicationKernel | null>(null);
  const [status, setStatus] = useState<'starting' | 'active' | 'error'>('starting');
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    const initialization = initializationRef.current ?? Promise.resolve().then(createKernel);
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

  if (status === 'error') {
    return (
      <main className="fatal-screen">
        <span>启动保护</span>
        <h1>内核没有进入不完整状态</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!kernel || status === 'starting') {
    return (
      <main className="boot-screen" aria-live="polite">
        <div className="boot-mark"><i /><i /><i /></div>
        <strong>正在建立广播与插件边界</strong>
        <span>恢复数据 · 验证能力 · 注入界面</span>
      </main>
    );
  }

  return <InfiniteCanvasShell kernel={kernel} />;
}
