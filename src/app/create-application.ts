import { ApplicationKernel } from '../core/kernel.ts';
import type { PersistenceLaunchPolicy } from '../core/persistence.ts';
import { builtInPlugins } from '../plugins/index.ts';
import BuiltinBackgroundWorker from '../workers/builtin.worker.ts?worker&inline';

export function createApplication(
  persistenceLaunchPolicy: PersistenceLaunchPolicy = 'fresh-session',
): ApplicationKernel {
  return new ApplicationKernel(builtInPlugins, {
    persistenceLaunchPolicy,
    workerFactory: () => new BuiltinBackgroundWorker(),
  });
}
