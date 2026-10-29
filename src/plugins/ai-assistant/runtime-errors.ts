export { isAbortError } from '../../services/abort.ts';

export function isCapabilityUnavailable(error: unknown, key: string): boolean {
  return error instanceof Error && (
    error.message === `Capability unavailable: ${key}` ||
    error.message.includes(`No provider for capability ${key}`)
  );
}
