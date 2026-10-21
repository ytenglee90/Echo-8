import type { PluginContext, TaskHandle } from '../../core/contracts.ts';
import type {
  AIGenerateResult,
  AIMemoryIndexRecord,
  AIPreparedContext,
  AISessionRecord,
  AIStatusSignal,
} from '../../protocols/ai.ts';
import { explicitAtOperation } from './command-parser.ts';
import {
  isGenerationCancelPayload,
  isGenerationRetryPayload,
  isPreparationIdPayload,
  isPreparePayload,
  type GenerationCancelPayload,
  type GenerationRetryPayload,
  type PreparationIdPayload,
  type PreparePayload,
} from './command-payloads.ts';
import { prepareAIContext } from './context-preparation.ts';
import {
  readContextSourceRevision,
  revalidatePreparedSources,
} from './context-source-reader.ts';
import { isAbortError } from './runtime-errors.ts';
import {
  AI_SESSION_NAMESPACE,
  formatAITranscriptEntry,
  planTranscriptAppend,
  sessionTranscriptSourceId,
} from './transcript-storage.ts';
import {
  AI_GENERATION_ACTION_TTL_MS,
  type AIGenerationAction,
  type AIAssistantInstanceState,
  type AIAssistantState,
} from './types.ts';

export type PreparedGeneration = AIPreparedContext & {
  transcriptRevisionAfterUser?: number;
  transcriptRevisionAfterAssistant?: number;
  followupAction?: 'retry' | 'repeat';
  userEntryStart?: number;
  userEntryLength?: number;
};

export interface AIRequestRuntimeOptions {
  preparations: Map<string, PreparedGeneration>;
  preparationTasks: Map<string, TaskHandle<AIPreparedContext>>;
  generationTasks: Map<string, TaskHandle<AIGenerateResult>>;
  generationStateBySession: Map<
    string,
    AIAssistantState['generationRuntimeBySession'][string]
  >;
  generationActionBySession: Map<string, AIGenerationAction>;
  lastPrepareRequestBySession: Map<string, PreparePayload>;
  lastMemoryUseBySession: Map<
    string,
    AIAssistantState['lastMemoryUseBySession'][string]
  >;
  readSessions(): Record<string, AISessionRecord>;
  readMemoryIndexes(): Record<string, AIMemoryIndexRecord>;
  readAssistantInstances(): AIAssistantInstanceState[];
}

export function registerAIRequestRuntime(
  context: PluginContext,
  options: AIRequestRuntimeOptions,
): void {
  context.commands.register<PreparePayload, { taskId: string }>({
    type: 'ai.context.prepare',
    validate: isPreparePayload,
    handle: (payload) => {
      const session = options.readSessions()[payload.sessionId];
      if (!session) throw new Error('AI 对话已经不存在');
      const boundAssistant = payload.assistantId
        ? options.readAssistantInstances().find((assistant) =>
            assistant.id === payload.assistantId && assistant.sessionId === payload.sessionId)
        : undefined;
      if (payload.assistantId && !boundAssistant) throw new Error('当前 AI 助手窗口已经不存在');
      const normalizedPayload: PreparePayload = {
        ...payload,
        operation: explicitAtOperation(payload.prompt) ?? payload.operation,
        ...(boundAssistant
          ? {
              memorySourceIds: boundAssistant.memorySourceIds ?? [],
              contextMode: boundAssistant.contextMode ?? 'automatic',
              webSearchEnabled: boundAssistant.webSearchEnabled === true,
            }
          : {}),
      };
      options.lastPrepareRequestBySession.set(session.id, normalizedPayload);
      options.generationActionBySession.delete(session.id);
      options.generationStateBySession.delete(session.id);
      options.preparationTasks.get(session.id)?.cancel();
      context.signals.emit('ai.state.invalidated');
      context.signals.emit('ai.status', {
        state: 'preparing',
        message: '正在按目录与关键词准备上下文',
        sessionId: session.id,
      } satisfies AIStatusSignal);
      const task = context.tasks.schedule<AIPreparedContext>({
        category: 'ai-context-retrieval',
        label: '正在准备 AI 上下文',
        priority: 18,
        timeoutMs: 2 * 60_000,
        estimatedCost: 4,
        run: (signal, report) => prepareAIContext(
          context,
          session,
          options.readMemoryIndexes(),
          normalizedPayload,
          signal,
          report,
        ),
      });
      options.preparationTasks.set(session.id, task);
      void task.result.then(
        (prepared) => {
          if (options.preparationTasks.get(session.id) === task) {
            options.preparationTasks.delete(session.id);
          }
          options.preparations.set(prepared.id, prepared);
          options.lastMemoryUseBySession.set(prepared.sessionId, {
            sourceIds: prepared.sources
              .filter((source) => source.reason === 'conversation-memory' ||
                prepared.selectedMemorySourceIds?.includes(source.sourceId))
              .map((source) => source.sourceId),
            candidatesMatched: prepared.memoryRetrieval?.candidatesMatched ?? 0,
            evidenceMemories: prepared.memoryRetrieval?.evidenceMemories ?? 0,
            at: Date.now(),
          });
          prunePreparedContexts(options.preparations);
          context.signals.emit('ai.state.invalidated');
          context.signals.emit('ai.context.ready', prepared);
          if (normalizedPayload.autoStart && !prepared.review) {
            void context.commands.dispatch('ai.generation.start', {
              preparationId: prepared.id,
            }).catch((error) => {
              recordRequestError(context, options, session.id, error, prepared.id);
              context.signals.emit('ai.status', {
                state: 'error',
                message: error instanceof Error ? error.message : String(error),
                sessionId: session.id,
              } satisfies AIStatusSignal);
            });
          } else {
            context.signals.emit('ai.status', {
              state: 'ready',
              message: prepared.review?.message ?? prepared.contextIntent === 'conversation'
                ? '已保留当前对话；未自动检索历史记忆'
                : prepared.contextMode === 'explicit-only'
                  ? `已准备 ${prepared.sources.length} 个明确来源；未自动检索`
                  : `已准备 ${prepared.sources.length} 个来源`,
              sessionId: session.id,
              preparationId: prepared.id,
            } satisfies AIStatusSignal);
          }
        },
        (error) => {
          if (options.preparationTasks.get(session.id) === task) {
            options.preparationTasks.delete(session.id);
          }
          if (isAbortError(error)) return;
          recordRequestError(context, options, session.id, error);
          context.signals.emit('ai.status', {
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
            sessionId: session.id,
          } satisfies AIStatusSignal);
        },
      );
      return { result: { taskId: task.id } };
    },
  });
  context.commands.register<PreparationIdPayload, { discarded: boolean }>({
    type: 'ai.context.discard',
    validate: isPreparationIdPayload,
    handle: (payload) => {
      const prepared = options.preparations.get(payload.preparationId);
      if (!prepared) return { result: { discarded: false } };
      options.preparations.delete(payload.preparationId);
      context.signals.emit('ai.status', {
        state: 'idle',
        message: '已返回修改本次要求',
        sessionId: prepared.sessionId,
      } satisfies AIStatusSignal);
      return { result: { discarded: true } };
    },
  });
  context.commands.register<PreparationIdPayload, { queued: true }>({
    type: 'ai.generation.start',
    validate: isPreparationIdPayload,
    handle: async (payload) => {
      const prepared = requirePreparedContext(options.preparations, payload.preparationId);
      const session = options.readSessions()[prepared.sessionId];
      if (!session) throw new Error('AI 对话已经不存在');
      await revalidatePreparedSources(context, prepared.sources);
      const transcriptSourceId = sessionTranscriptSourceId(session);
      const transcript = prepared.sources.find((source) =>
        source.sourceId === transcriptSourceId && source.reason === 'recent-conversation');
      const currentRevision = transcript?.revision ??
        await readContextSourceRevision(context, transcriptSourceId);
      const userEntry = formatAITranscriptEntry('用户', prepared.prompt, prepared.operation, Date.now());
      const append = await planTranscriptAppend(
        context,
        session,
        userEntry,
        currentRevision,
      );
      prepared.transcriptRevisionAfterUser = append.revision;
      prepared.transcriptRevisionAfterAssistant = undefined;
      prepared.followupAction = undefined;
      prepared.userEntryStart = append.start;
      prepared.userEntryLength = userEntry.length;
      const nextSession: AISessionRecord = {
        ...session,
        transcriptRevision: append.revision,
        transcriptLength: append.length,
        transcriptEntries: append.entries,
        revision: session.revision + 1,
        turns: session.turns + 1,
        updatedAt: Date.now(),
      };
      return {
        result: { queued: true },
        transaction: {
          label: '记录 AI 用户消息',
          patches: [
            ...append.patches,
            {
              op: 'set',
              domain: 'document',
              namespace: AI_SESSION_NAMESPACE,
              key: session.id,
              value: nextSession,
            },
          ],
          events: [
            ...(append.events ?? []),
            { type: 'ai.generation.requested', payload: { preparationId: prepared.id } },
          ],
        },
      };
    },
  });
  context.commands.register<GenerationRetryPayload, { queued: true; mode: 'retry' | 'repeat' }>({
    type: 'ai.generation.retry',
    validate: isGenerationRetryPayload,
    handle: async (payload) => {
      const session = options.readSessions()[payload.sessionId];
      if (!session) throw new Error('AI 对话已经不存在');
      if (options.generationTasks.has(session.id) || options.preparationTasks.has(session.id)) {
        throw new Error('当前内容仍在处理中，请稍候');
      }
      const action = options.generationActionBySession.get(session.id);
      if (!action || action.expiresAt < Date.now()) {
        options.generationActionBySession.delete(session.id);
        context.signals.emit('ai.state.invalidated');
        throw new Error('上一次发送已经失效，请重新输入要求');
      }
      if (!action.preparationId) {
        const previousRequest = options.lastPrepareRequestBySession.get(session.id);
        if (!previousRequest) throw new Error('没有可以重试的发送内容');
        options.generationActionBySession.delete(session.id);
        options.generationStateBySession.delete(session.id);
        context.signals.emit('ai.state.invalidated');
        context.commands.defer('ai.context.prepare', { ...previousRequest, autoStart: true });
        return { result: { queued: true, mode: 'retry' } };
      }
      const prepared = requirePreparedContext(options.preparations, action.preparationId);
      if (prepared.sessionId !== session.id) throw new Error('重试内容不属于当前 AI 对话');
      const transcriptSourceId = sessionTranscriptSourceId(session);
      const currentRevision = await readContextSourceRevision(context, transcriptSourceId);
      const expectedRevision = prepared.transcriptRevisionAfterAssistant ?? prepared.transcriptRevisionAfterUser;
      if (expectedRevision === undefined || currentRevision !== expectedRevision) {
        throw new Error('上次发送后对话内容已经变化，请重新输入要求');
      }
      const memoryIndexes = options.readMemoryIndexes();
      const currentConversationMemorySources = new Set(prepared.sources
        .filter((source) => source.reason === 'conversation-memory' &&
          memoryIndexes[source.sourceId]?.sessionId === session.id)
        .map((source) => source.sourceId));
      await revalidatePreparedSources(
        context,
        prepared.sources.filter((source) => source.sourceId !== transcriptSourceId),
        { allowUnchangedRangeRevisionAdvanceFor: currentConversationMemorySources },
      );
      const marker = action.kind === 'repeat' ? '再来一次' : '重试';
      const userEntry = formatAITranscriptEntry('用户', marker, prepared.operation, Date.now());
      const append = await planTranscriptAppend(context, session, userEntry, currentRevision);
      prepared.transcriptRevisionAfterUser = append.revision;
      prepared.transcriptRevisionAfterAssistant = undefined;
      prepared.followupAction = action.kind;
      prepared.expiresAt = Date.now() + AI_GENERATION_ACTION_TTL_MS;
      options.generationActionBySession.delete(session.id);
      options.generationStateBySession.delete(session.id);
      context.signals.emit('ai.state.invalidated');
      const nextSession: AISessionRecord = {
        ...session,
        transcriptRevision: append.revision,
        transcriptLength: append.length,
        transcriptEntries: append.entries,
        revision: session.revision + 1,
        turns: session.turns + 1,
        updatedAt: Date.now(),
      };
      return {
        result: { queued: true, mode: action.kind },
        transaction: {
          label: action.kind === 'repeat' ? '记录 AI 再来一次请求' : '记录 AI 重试请求',
          patches: [
            ...append.patches,
            {
              op: 'set',
              domain: 'document',
              namespace: AI_SESSION_NAMESPACE,
              key: session.id,
              value: nextSession,
            },
          ],
          events: [
            ...(append.events ?? []),
            { type: 'ai.generation.requested', payload: { preparationId: prepared.id } },
          ],
        },
      };
    },
  });
  context.commands.register<GenerationCancelPayload | undefined, { cancelled: boolean }>({
    type: 'ai.generation.cancel',
    validate: isGenerationCancelPayload,
    handle: (payload) => {
      const targets = payload?.sessionId
        ? [[payload.sessionId, options.generationTasks.get(payload.sessionId)] as const]
        : [...options.generationTasks.entries()];
      const cancelled = targets.some(([, task]) => Boolean(task));
      for (const [sessionId, task] of targets) {
        task?.cancel();
        if (options.generationTasks.get(sessionId) === task) options.generationTasks.delete(sessionId);
        options.generationStateBySession.delete(sessionId);
        options.generationActionBySession.delete(sessionId);
      }
      context.signals.emit('ai.state.invalidated');
      context.signals.emit('ai.status', {
        state: 'idle',
        message: cancelled ? '已停止本次生成；未保存不完整内容' : '当前没有正在生成的内容',
        sessionId: payload?.sessionId,
      } satisfies AIStatusSignal);
      return { result: { cancelled } };
    },
  });
}

function recordRequestError(
  context: PluginContext,
  options: AIRequestRuntimeOptions,
  sessionId: string,
  error: unknown,
  preparationId?: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  options.generationStateBySession.set(sessionId, {
    state: 'error',
    message,
    ...(preparationId ? { preparationId } : {}),
    sequence: 0,
    text: '',
    reasoning: '',
  });
  options.generationActionBySession.set(sessionId, {
    kind: 'retry',
    ...(preparationId ? { preparationId } : {}),
    expiresAt: Date.now() + AI_GENERATION_ACTION_TTL_MS,
  });
  context.signals.emit('ai.state.invalidated');
}

export function requirePreparedContext(
  preparations: Map<string, PreparedGeneration>,
  id: string,
): PreparedGeneration {
  const prepared = preparations.get(id);
  if (!prepared) throw new Error('上下文预览已经不存在，请重新准备');
  if (prepared.expiresAt < Date.now()) {
    preparations.delete(id);
    throw new Error('上下文预览已经过期，请重新准备');
  }
  return prepared;
}

export function prunePreparedContexts(
  preparations: Map<string, PreparedGeneration>,
  limit = 8,
  now = Date.now(),
): void {
  for (const [id, prepared] of preparations) {
    if (prepared.expiresAt < now) preparations.delete(id);
  }
  while (preparations.size > limit) preparations.delete(preparations.keys().next().value!);
}
