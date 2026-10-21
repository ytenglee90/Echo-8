import { ApplicationKernel } from '../core/kernel.ts';
import { builtInPlugins } from '../plugins/index.ts';
import BuiltinBackgroundWorker from '../workers/builtin.worker.ts?worker&inline';

export function createApplication(): ApplicationKernel {
  return new ApplicationKernel(builtInPlugins, {
    persistenceLaunchPolicy: 'fresh-session',
    workerFactory: () => new BuiltinBackgroundWorker(),
  });
}
