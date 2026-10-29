/** Cross-realm abort detection for browser APIs, workers, and test doubles. */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'name' in error && (error as { name?: unknown }).name === 'AbortError';
}
