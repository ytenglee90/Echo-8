'use client';

import { InfiniteCanvasRuntime } from './InfiniteCanvasRuntime.tsx';

export function HostedInfiniteCanvasApplication() {
  return <InfiniteCanvasRuntime createKernel={loadHostedApplication} />;
}

async function loadHostedApplication() {
  const { createHostedApplication } = await import('./create-hosted-application.ts');
  return createHostedApplication();
}
