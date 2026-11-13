import type { AITokenUsage } from './ai.ts';

export type AIInputCategory = 'baseRules' | 'operationProtocol' | 'history' | 'references' | 'objectDirectory' | 'tools' | 'userRequest' | 'taskState';
export type AIUsagePurpose = 'answer' | 'plan' | 'tool-roundtrip' | 'format-correction' | 'continuation' | 'memory-extraction' | 'compatibility-retry' | 'retry' | 'repeat';
/** Local accounting metadata. Never part of the model's request body. */
export interface AIUsageContext {
  taskId: string;
  sessionId: string;
  purpose: AIUsagePurpose;
  outputKind?: 'answer' | 'plan' | 'memory';
  inputBreakdown?: Partial<Record<AIInputCategory, number>>;
}
export interface AIUsageAttempt {
  id: string;
  taskId: string;
  sessionId: string;
  purpose: AIUsagePurpose;
  outputKind: 'answer' | 'plan' | 'memory';
  provider: string;
  model: string;
  startedAt: number;
  status: 'pending' | 'complete' | 'failed' | 'cancelled';
  usage?: AITokenUsage;
  inputEstimate: number;
  outputEstimate?: number;
  inputBreakdown: Partial<Record<AIInputCategory, number>>;
}
export interface AIUsageTotals {
  calls: number;
  retries: number;
  actualInput: number;
  actualOutput: number;
  estimatedInput: number;
  estimatedOutput: number;
  unknownInput: number;
  unknownOutput: number;
  pending: number;
  reasoning: number;
  cachedInput: number;
  cacheMissInput: number;
  outputBreakdown: Partial<Record<'answer' | 'plan' | 'memory', { actual: number; estimated: number; unknown: number }>>;
  inputBreakdown: Partial<Record<AIInputCategory, number>>;
}
export interface AITaskUsageSnapshot {
  taskId: string;
  totals: AIUsageTotals;
  attempts: AIUsageAttempt[];
  /** Counts are preserved when detailed old attempts are evicted. */
  omittedAttempts: number;
  availableTaskIds?: string[];
}
export const AI_USAGE_CHANGED = 'ai.usage.changed@1';

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'ai.task.new@1': CommandContract<{ sessionId: string }>;
  }
}
declare module './messages.ts' {
  interface ApplicationCapabilityMap {
    'ai.provider.taskUsage@1': MessageContract<{ taskId: string }, AITaskUsageSnapshot>;
  }
  interface ApplicationQueryMap {
    'ai.task.usage@1': MessageContract<{ sessionId: string; taskId?: string }, AITaskUsageSnapshot | undefined>;
  }
}
