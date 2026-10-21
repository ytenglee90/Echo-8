export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function isCapabilityUnavailable(error: unknown, key: string): boolean {
  return error instanceof Error && (
    error.message === `Capability unavailable: ${key}` ||
    error.message.includes(`No provider for capability ${key}`)
  );
}
