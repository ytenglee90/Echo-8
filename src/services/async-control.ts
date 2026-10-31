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
