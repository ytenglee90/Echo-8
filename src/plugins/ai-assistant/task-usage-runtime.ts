import { createId, isRecord, type PluginContext } from '../../core/contracts.ts';
import { AI_USAGE_CHANGED, type AITaskUsageSnapshot } from '../../protocols/ai-usage.ts';

/** Explicit task boundaries; continuations, retries and follow-ups keep their task identity. */
export function registerAITaskUsage(context: PluginContext) {
  const tasks = new Map<string, string[]>();
  const taskFor = (sessionId: string) => {
    let ids = tasks.get(sessionId);
    if (!ids) { ids = [createId('ai-task')]; tasks.set(sessionId, ids); }
    return ids.at(-1)!;
  };
  const sessionInput = (input: unknown): input is { sessionId: string } => isRecord(input) && typeof input.sessionId === 'string' && input.sessionId.length <= 200;
  context.commands.register({ type: 'ai.task.new@1', validate: sessionInput, handle: input => {
    const ids = tasks.get(input.sessionId) ?? [];
    ids.push(createId('ai-task')); tasks.set(input.sessionId, ids);
    context.signals.emit(AI_USAGE_CHANGED);
    return {};
  } });
  context.queries.register({ type: 'ai.task.usage@1',
    validate: (input): input is { sessionId: string; taskId?: string } => sessionInput(input) &&
      (!('taskId' in input) || typeof input.taskId === 'string'),
    handle: async input => {
      const ids = tasks.get(input.sessionId);
      const taskId = input.taskId ?? ids?.at(-1);
      if (!taskId || !ids?.includes(taskId)) return undefined;
      const snapshot = await context.capabilities.request<AITaskUsageSnapshot>('ai.provider.taskUsage@1', { taskId })
        .catch(() => undefined);
      return snapshot ? { ...snapshot, availableTaskIds: [...ids] } : undefined;
    },
  });
  context.events.subscribe('document.replaced', () => tasks.clear());
  return { taskFor };
}
