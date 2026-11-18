import { isRecord } from '../../core/contracts.ts';
import type { WorkspaceStepReceipt } from '../../protocols/workspace-actions.ts';

export interface ResultReference { $step: string; path?: string[] }
export function isResultReference(value: unknown): value is ResultReference {
  return isRecord(value) && Object.keys(value).every(key => key === '$step' || key === 'path') &&
    typeof value.$step === 'string' && /^[\p{L}\p{N}._:-]{1,120}$/u.test(value.$step) &&
    (value.path === undefined || Array.isArray(value.path) && value.path.length <= 8 && value.path.every(part =>
      typeof part === 'string' && /^[\p{L}\p{N}_-]{1,100}$/u.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part)));
}
export function resultDependencies(value: unknown): string[] {
  return isResultReference(value) ? [value.$step] : Array.isArray(value) ? value.flatMap(resultDependencies) :
    isRecord(value) ? Object.values(value).flatMap(resultDependencies) : [];
}
export function bindResults(value: unknown, results: Map<string, WorkspaceStepReceipt>): unknown {
  if (isResultReference(value)) {
    const source = results.get(value.$step);
    if (source?.status !== 'completed') throw new Error('引用的步骤尚未完成：' + value.$step);
    let result = source.result;
    for (const part of value.path ?? []) {
      if (!isRecord(result) || !Object.hasOwn(result, part)) throw new Error('前置步骤没有所需字段：' + part);
      result = result[part];
    }
    if (result === undefined) throw new Error('前置步骤没有返回所需结果');
    return structuredClone(result);
  }
  if (Array.isArray(value)) return value.map(item => bindResults(item, results));
  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindResults(item, results)])) : value;
}
