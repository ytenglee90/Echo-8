import { ApplicationKernel } from '../core/kernel.ts';
import { hostedPlugins } from '../plugins/hosted-lazy.ts';

export function createHostedApplication(): ApplicationKernel {
  return new ApplicationKernel(hostedPlugins, {
    persistenceLaunchPolicy: 'restore-session',
    workerFactory: () => new Worker(
      new URL('../workers/builtin.worker.ts', import.meta.url),
      { type: 'module', name: 'echo8-background' },
    ),
  });
}
