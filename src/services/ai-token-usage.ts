import type { AITokenUsage } from '../protocols/ai.ts';

export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeTokenUsage(value: unknown): AITokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = tokenCount(record.inputTokens), outputTokens = tokenCount(record.outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { ...(inputTokens !== undefined ? { inputTokens, ...(record.inputEstimated === true ? { inputEstimated: true } : {}) } : {}), ...(outputTokens !== undefined ? { outputTokens, ...(record.outputEstimated === true ? { outputEstimated: true } : {}) } : {}) };
}

export function withTokenUsageEstimates(value: unknown, inputEstimate: number, outputEstimate: number): AITokenUsage {
  const usage = normalizeTokenUsage(value);
  return { ...usage,
    ...(usage?.inputTokens === undefined ? { inputTokens: tokenCount(inputEstimate) ?? 0, inputEstimated: true } : {}),
    ...(usage?.outputTokens === undefined ? { outputTokens: tokenCount(outputEstimate) ?? 0, outputEstimated: true } : {}),
  };
}

/** Add successful request totals once, never summing cumulative stream chunks. */
export function aggregateTokenUsage(requests: readonly (AITokenUsage | undefined)[]): AITokenUsage | undefined {
  const normalized = requests.map(normalizeTokenUsage);
  const sum = (key: 'inputTokens' | 'outputTokens') => {
    const values = normalized.flatMap(usage => usage?.[key] === undefined ? [] : [usage[key]!]);
    return values.length ? tokenCount(values.reduce((total, value) => total + value, 0)) : undefined;
  };
  const usage = normalizeTokenUsage({ inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens') });
  if (!usage) return undefined;
  return { ...usage,
    ...(normalized.some(item => item?.inputEstimated || item?.inputTokens === undefined) ? { inputEstimated: true } : {}),
    ...(normalized.some(item => item?.outputEstimated || item?.outputTokens === undefined) ? { outputEstimated: true } : {}),
  };
}

export function formatTokenUsage(usage: AITokenUsage | undefined): string {
  const normalized = normalizeTokenUsage(usage);
  const format = (value: number | undefined, estimated?: boolean) => value === undefined ? '未提供' : `${value.toLocaleString('zh-CN')}${estimated ? '（估算）' : ''}`;
  return `本轮 Token：输入 ${format(normalized?.inputTokens, normalized?.inputEstimated)} · 输出 ${format(normalized?.outputTokens, normalized?.outputEstimated)}`;
}
