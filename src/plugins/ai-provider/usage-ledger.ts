import type { AIGenerateRequest, AITokenUsage } from '../../protocols/ai.ts';
import type { AITaskUsageSnapshot, AIUsageAttempt, AIUsageTotals } from '../../protocols/ai-usage.ts';
import { estimateAITokens } from '../../services/ai-token-estimate.ts';
import { normalizeTokenUsage } from '../../services/ai-token-usage.ts';

export const emptyUsageTotals = (): AIUsageTotals => ({ calls: 0, retries: 0, actualInput: 0, actualOutput: 0,
  estimatedInput: 0, estimatedOutput: 0, unknownInput: 0, unknownOutput: 0, pending: 0, reasoning: 0,
  cachedInput: 0, cacheMissInput: 0, inputBreakdown: {}, outputBreakdown: {} });

/** Contains numbers only. Detailed evictions never reduce cumulative task totals. */
export class AIUsageLedger {
  private sequence = 0;
  private readonly tasks = new Map<string, { totals: AIUsageTotals; attempts: AIUsageAttempt[]; omitted: number }>();
  private readonly changed: () => void;
  private readonly detailLimit: number;
  constructor(changed: () => void = () => undefined, detailLimit = 128) { this.changed = changed; this.detailLimit = detailLimit; }
  clear() { this.tasks.clear(); this.changed(); }
  begin(request: AIGenerateRequest, provider: string, model: string, retry = false): AIUsageAttempt | undefined {
    const identity = request.usageContext;
    if (!identity) return undefined;
    let task = this.tasks.get(identity.taskId);
    if (!task) { task = { totals: emptyUsageTotals(), attempts: [], omitted: 0 }; this.tasks.set(identity.taskId, task); }
    const inputEstimate = 3 + request.messages.reduce((sum, message) => sum + 4 + estimateAITokens(message.content) +
      (message.toolCalls ? estimateAITokens(JSON.stringify(message.toolCalls)) : 0), 0) +
      (request.tools ? estimateAITokens(JSON.stringify(request.tools)) : 0) + (request.responseSchema ? estimateAITokens(JSON.stringify(request.responseSchema)) : 0);
    const inputBreakdown = { ...identity.inputBreakdown };
    if (!request.tools) delete inputBreakdown.tools;
    const classified = Object.values(inputBreakdown).reduce((sum, count) => sum + (count ?? 0), 0);
    // Follow-up messages and schemas change between calls. Classify the delta explicitly.
    if (classified < inputEstimate) inputBreakdown[identity.purpose === 'tool-roundtrip' ? 'tools' : 'operationProtocol'] =
      (inputBreakdown[identity.purpose === 'tool-roundtrip' ? 'tools' : 'operationProtocol'] ?? 0) + inputEstimate - classified;
    const attempt: AIUsageAttempt = { id: `usage:${++this.sequence}`, taskId: identity.taskId, sessionId: identity.sessionId,
      purpose: retry ? 'retry' : identity.purpose, outputKind: identity.outputKind ?? (identity.purpose === 'plan' ? 'plan' : identity.purpose === 'memory-extraction' ? 'memory' : 'answer'), provider, model, startedAt: Date.now(), status: 'pending', inputEstimate, inputBreakdown };
    task.attempts.push(attempt);
    task.totals.calls += 1;
    if (retry || ['retry', 'format-correction', 'compatibility-retry', 'continuation'].includes(identity.purpose)) task.totals.retries += 1;
    task.totals.pending += 1;
    for (const [key, count] of Object.entries(inputBreakdown)) {
      const category = key as keyof typeof inputBreakdown;
      task.totals.inputBreakdown[category] = (task.totals.inputBreakdown[category] ?? 0) + count!;
    }
    // Only finalized details may be dropped: pending attempts must remain finishable.
    while (task.attempts.length > this.detailLimit) {
      const index = task.attempts.findIndex(item => item.status !== 'pending');
      if (index < 0) break;
      task.attempts.splice(index, 1); task.omitted += 1;
    }
    this.changed();
    return attempt;
  }
  finish(attempt: AIUsageAttempt | undefined, status: Exclude<AIUsageAttempt['status'], 'pending'>, usage?: AITokenUsage, output?: string) {
    if (!attempt || attempt.status !== 'pending') return;
    const task = this.tasks.get(attempt.taskId);
    if (!task || !task.attempts.includes(attempt)) return;
    attempt.status = status;
    attempt.usage = normalizeTokenUsage(usage);
    if (status === 'complete') attempt.outputEstimate = estimateAITokens(output ?? '');
    task.totals.pending -= 1;
    for (const direction of ['Input', 'Output'] as const) {
      const value = attempt.usage?.[direction === 'Input' ? 'inputTokens' : 'outputTokens'];
      const estimated = attempt.usage?.[direction === 'Input' ? 'inputEstimated' : 'outputEstimated'];
      if (value !== undefined) task.totals[`${estimated ? 'estimated' : 'actual'}${direction}`] += value;
      else if (status === 'complete') task.totals[`estimated${direction}`] += direction === 'Input' ? attempt.inputEstimate : attempt.outputEstimate ?? 0;
      else task.totals[`unknown${direction}`] += 1;
    }
    task.totals.reasoning += attempt.usage?.reasoningTokens ?? 0;
    const outputCategory = task.totals.outputBreakdown[attempt.outputKind] ??= { actual: 0, estimated: 0, unknown: 0 };
    if (attempt.usage?.outputTokens !== undefined) outputCategory[attempt.usage.outputEstimated ? 'estimated' : 'actual'] += attempt.usage.outputTokens;
    else if (status === 'complete') outputCategory.estimated += attempt.outputEstimate ?? 0;
    else outputCategory.unknown += 1;
    task.totals.cachedInput += attempt.usage?.cachedInputTokens ?? 0;
    task.totals.cacheMissInput += attempt.usage?.cacheMissInputTokens ?? 0;
    this.changed();
  }
  read(taskId: string): AITaskUsageSnapshot {
    const task = this.tasks.get(taskId);
    return structuredClone({ taskId, totals: task?.totals ?? emptyUsageTotals(), attempts: task?.attempts ?? [], omittedAttempts: task?.omitted ?? 0 });
  }
  /** Late error-body usage replaces unknown directions, never adds a second attempt. */
  amendFailureUsage(attempt: AIUsageAttempt | undefined, value?: AITokenUsage) {
    if (!attempt || !['failed', 'cancelled'].includes(attempt.status)) return;
    const task = this.tasks.get(attempt.taskId), usage = normalizeTokenUsage(value);
    if (!task || !task.attempts.includes(attempt) || !usage) return;
    for (const direction of ['Input', 'Output'] as const) {
      const key = direction === 'Input' ? 'inputTokens' : 'outputTokens';
      const estimatedKey = direction === 'Input' ? 'inputEstimated' : 'outputEstimated';
      if (attempt.usage?.[key] !== undefined || usage[key] === undefined) continue;
      task.totals[`unknown${direction}`] -= 1;
      task.totals[`${usage[estimatedKey] ? 'estimated' : 'actual'}${direction}`] += usage[key];
      if (direction === 'Output') {
        const category = task.totals.outputBreakdown[attempt.outputKind]!;
        category.unknown -= 1; category[usage.outputEstimated ? 'estimated' : 'actual'] += usage.outputTokens!;
      }
    }
    if (attempt.usage?.reasoningTokens === undefined) task.totals.reasoning += usage.reasoningTokens ?? 0;
    if (attempt.usage?.cachedInputTokens === undefined) task.totals.cachedInput += usage.cachedInputTokens ?? 0;
    if (attempt.usage?.cacheMissInputTokens === undefined) task.totals.cacheMissInput += usage.cacheMissInputTokens ?? 0;
    attempt.usage = { ...usage, ...attempt.usage };
    this.changed();
  }
}
