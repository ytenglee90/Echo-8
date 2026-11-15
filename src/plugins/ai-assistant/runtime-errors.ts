export { isAbortError } from '../../services/abort.ts';

export function isCapabilityUnavailable(error: unknown, key: string): boolean {
  return error instanceof Error && (
    error.message === `Capability unavailable: ${key}` ||
    error.message.includes(`No provider for capability ${key}`)
  );
}
export function isCanvasRevisionConflict(error: unknown): boolean {
  return error instanceof Error && !/HTTP\s+\d+/u.test(error.message) &&
    /(?:节点|卡片|对象|群组|连线|正文|来源).{0,100}(?:已变化|已经变化|发生变化|已修改)/u.test(error.message);
}
