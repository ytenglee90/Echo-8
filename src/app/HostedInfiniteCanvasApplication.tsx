'use client';

import { InfiniteCanvasRuntime } from './InfiniteCanvasRuntime.tsx';
import type { PersistenceLaunchPolicy } from '../core/persistence.ts';

export function HostedInfiniteCanvasApplication() {
  return <InfiniteCanvasRuntime createKernel={loadHostedApplication} />;
}

async function loadHostedApplication(policy?: PersistenceLaunchPolicy) {
  const { createHostedApplication } = await import('./create-hosted-application.ts');
  return createHostedApplication(policy);
}
