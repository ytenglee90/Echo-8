/** Throws before bounded work continues, preserving a caller-provided abort reason. */
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Task cancelled', 'AbortError');
  }
}

/** Yields one event-loop turn so bounded work does not monopolize the UI thread. */
export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Cancel a caller's wait without cancelling work shared with other callers. */
export async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  assertNotAborted(signal);
  if (!signal) return promise;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** One cancellation-aware timer implementation for feature background work. */
export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await waitForPromise(new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); }), signal);
  } finally { clearTimeout(timer); }
}
