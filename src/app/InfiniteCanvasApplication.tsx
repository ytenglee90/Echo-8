import { createApplication } from './create-application.ts';
import { InfiniteCanvasRuntime } from './InfiniteCanvasRuntime.tsx';

export function InfiniteCanvasApplication() {
  return <InfiniteCanvasRuntime createKernel={createApplication} />;
}
