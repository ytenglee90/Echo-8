import { ApplicationKernel } from '../core/kernel.ts';
import type { PersistenceLaunchPolicy } from '../core/persistence.ts';
import { hostedPlugins } from '../plugins/hosted-lazy.ts';

export function createHostedApplication(
  persistenceLaunchPolicy: PersistenceLaunchPolicy = 'restore-session',
): ApplicationKernel {
  return new ApplicationKernel(hostedPlugins, {
    persistenceLaunchPolicy,
    workerFactory: () => new Worker(
      new URL('../workers/builtin.worker.ts', import.meta.url),
      { type: 'module', name: 'echo8-background' },
    ),
  });
}
