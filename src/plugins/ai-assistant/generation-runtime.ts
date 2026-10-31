import type { PluginContext, TaskHandle } from '../../core/contracts.ts';
import type {
  AIGenerateResult,
  AIGenerateRequest,
  AIGenerateStream,
  AIGenerationDeltaSignal,
  AIMemoryIndexRecord,
  AIPreparedContext,
  AIPromptTemplateCatalog,
  AIStatusSignal,
  AISessionRecord,
} from '../../protocols/ai.ts';
import { assertNotAborted } from '../../services/async-control.ts';
import { buildGenerateRequest } from './generation-request.ts';
import { executeMemorySearchToolCalls } from './memory-search-tool.ts';
import { operationCreatesWriteback } from './operations.ts';
import { isAbortError, isCapabilityUnavailable } from './runtime-errors.ts';
import type { PreparedGeneration } from './request-runtime.ts';
import {
  AI_GENERATION_ACTION_TTL_MS,
  type AIGenerationAction,
  type AIAssistantState,
} from './types.ts';
type GenerationState = AIAssistantState['generationRuntimeBySession'][string];

export interface AIGenerationRuntimeOptions {
  preparations: Map<string, PreparedGeneration>;
  tasks: Map<string, TaskHandle<AIGenerateResult>>;
  stateBySession: Map<string, GenerationState>;
  actionBySession: Map<string, AIGenerationAction>;
  readPromptTemplates(): AIPromptTemplateCatalog;
  readMemoryIndexes(): Record<string, AIMemoryIndexRecord>;
  readSessions(): Record<string, AISessionRecord>;
  shouldAutoExtractMemoryCandidates(prepared: AIPreparedContext): boolean;
}

interface StreamConsumptionHooks {
  onDelta(event: { delta: string; channel: 'answer' | 'reasoning'; sequence: number }): void;
  report(progress: number): void;
}

const MAX_REASONING_DISPLAY_CHARACTERS = 800;
const MAX_AUTOMATIC_CONTINUATIONS = 1;

export async function consumeAIGenerationStream(
  stream: AIGenerateStream,
  signal: AbortSignal,
  hooks: StreamConsumptionHooks,
): Promise<AIGenerateResult> {
  let text = '';
  let reasoning = '';
  let sequence = 0;
  let usage: AIGenerateResult['usage'];
  let finishReason: AIGenerateResult['finishReason'];
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
  for await (const event of stream.events) {
    assertNotAborted(signal);
    if (event.type === 'complete') {
      usage = event.usage;
      finishReason = event.finishReason;
      continue;
    }
    if (event.type === 'tool-call') {
      const existing = toolCalls.get(event.index) ?? { arguments: '' };
      toolCalls.set(event.index, {
        id: event.id ?? existing.id,
        name: event.name ?? existing.name,
        arguments: `${existing.arguments}${event.argumentsDelta ?? ''}`.slice(0, 8_000),
      });
      continue;
    }
    if (!event.delta) continue;
    const channel = event.channel ?? 'answer';
    let visibleDelta = event.delta;
    if (channel === 'reasoning') {
      const remaining = Math.max(0, MAX_REASONING_DISPLAY_CHARACTERS - reasoning.length);
      visibleDelta = event.delta.slice(0, remaining);
      reasoning += visibleDelta;
    } else text += event.delta;
    if (!visibleDelta) continue;
    sequence += 1;
    hooks.onDelta({ delta: visibleDelta, channel, sequence });
    hooks.report(Math.min(0.95, 0.1 + (text.length + reasoning.length) / 12_000));
  }
  const normalized = text.trim();
  const completedToolCalls = [...toolCalls.entries()].sort(([left], [right]) => left - right)
    .flatMap(([, call]) => call.id && call.name && call.arguments.length <= 8_000
      ? [{ id: call.id, name: call.name, arguments: call.arguments }]
      : []);
  if (!normalized && completedToolCalls.length === 0) {
    if (reasoning.trim()) throw new Error('模型只返回了思考过程，没有返回最终答案；请重试或降低模型思考强度');
    throw new Error('模型返回了空内容');
  }
  const normalizedReasoning = reasoning.trim();
  return {
    text: normalized,
    ...(text.trim() && normalizedReasoning && normalizedReasoning !== normalized
      ? { reasoning: normalizedReasoning }
      : {}),
    provider: stream.provider,
    model: stream.model,
    usage,
    ...(finishReason ? { finishReason } : {}),
    ...(completedToolCalls.length > 0 ? { toolCalls: completedToolCalls } : {}),
  };
}

export function normalizeAIGenerateResult(result: AIGenerateResult): AIGenerateResult {
  const text = result.text.trim();
  if (!text && !result.toolCalls?.length) {
    if (result.reasoning?.trim()) {
      throw new Error('模型只返回了思考过程，没有返回最终答案；请重试或降低模型思考强度');
    }
    throw new Error('模型返回了空内容');
  }
  const reasoning = result.reasoning?.trim().slice(0, MAX_REASONING_DISPLAY_CHARACTERS);
  return {
    ...result,
    text,
    ...(reasoning ? { reasoning } : { reasoning: undefined }),
  };
}

export function registerAIGenerationRuntime(
  context: PluginContext,
  options: AIGenerationRuntimeOptions,
): void {
  context.events.subscribe<{ preparationId: string }>('ai.generation.requested', (message) => {
    const prepared = options.preparations.get(message.payload.preparationId);
    if (!prepared) return;
    options.tasks.get(prepared.sessionId)?.cancel();
    options.actionBySession.delete(prepared.sessionId);
    const generationMessage = operationCreatesWriteback(prepared.operation)
      ? '模型正在生成可审查的正文修改'
      : '模型正在回答';
    options.stateBySession.set(prepared.sessionId, {
      state: 'generating',
      message: generationMessage,
      preparationId: prepared.id,
      sequence: 0,
      text: '',
      reasoning: '',
    });
    context.signals.emit('ai.status', {
      state: 'generating',
      message: generationMessage,
      sessionId: prepared.sessionId,
      preparationId: prepared.id,
    } satisfies AIStatusSignal);
    context.signals.emit('ai.state.invalidated');
    const task = context.tasks.schedule<AIGenerateResult>({
      category: 'ai-generation',
      label: 'AI 正在生成内容',
      priority: 16,
      timeoutMs: 5 * 60_000,
      estimatedCost: 4,
      run: async (signal, report) => {
        report(0.1);
        const request = await buildGenerateRequest(
          context,
          prepared,
          options.readPromptTemplates(),
          signal,
        );
        let emittedSequence = 0;
        const generateOnce = async (activeRequest: AIGenerateRequest): Promise<AIGenerateResult> => {
          try {
            const stream = await context.capabilities.request<AIGenerateStream>(
              'ai.generate.stream@1',
              activeRequest,
              signal,
            );
            const result = await consumeAIGenerationStream(stream, signal, {
              onDelta: (event) => {
                emittedSequence += 1;
                const current = options.stateBySession.get(prepared.sessionId);
                const text = event.channel === 'answer'
                  ? `${current?.text ?? ''}${event.delta}`
                  : current?.text ?? '';
                const reasoning = event.channel === 'reasoning'
                  ? `${current?.reasoning ?? ''}${event.delta}`
                  : current?.reasoning ?? '';
                options.stateBySession.set(prepared.sessionId, {
                  state: 'generating',
                  message: generationMessage,
                  preparationId: prepared.id,
                  sequence: emittedSequence,
                  text,
                  reasoning,
                });
                context.signals.emit('ai.generation.delta', {
                  preparationId: prepared.id,
                  sessionId: prepared.sessionId,
                  sequence: emittedSequence,
                  delta: event.delta,
                  channel: event.channel,
                } satisfies AIGenerationDeltaSignal);
              },
              report,
            });
            return inferLengthTermination(result, activeRequest);
          } catch (error) {
            if (!isCapabilityUnavailable(error, 'ai.generate.stream@1')) throw error;
            return inferLengthTermination(
              normalizeAIGenerateResult(
                await context.capabilities.request<AIGenerateResult>('ai.generate@1', activeRequest, signal),
              ),
              activeRequest,
            );
          }
        };

        const generateWithToolFallback = async (activeRequest: AIGenerateRequest): Promise<AIGenerateResult> => {
          try {
            return await generateOnce(activeRequest);
          } catch (error) {
            if (!activeRequest.tools?.length || !isToolRequestCompatibilityError(error)) throw error;
            context.diagnostics.warn('当前模型连接不支持本地记忆工具，已回退常规检索', error);
            context.signals.emit('ai.status', {
              state: 'generating',
              message: '当前连接不支持按需记忆工具，已继续使用常规检索',
              sessionId: prepared.sessionId,
              preparationId: prepared.id,
            } satisfies AIStatusSignal);
            return generateOnce({ ...activeRequest, tools: undefined });
          }
        };

        let result = await generateWithToolFallback(request);
        if (result.toolCalls?.length) {
          context.signals.emit('ai.status', {
            state: 'generating',
            message: '正在按需查询已保存的本地记忆',
            sessionId: prepared.sessionId,
            preparationId: prepared.id,
          } satisfies AIStatusSignal);
          const execution = await executeMemorySearchToolCalls(
            context,
            prepared,
            options.readMemoryIndexes(),
            result.toolCalls,
            signal,
          );
          if (execution.executed === 0) {
            throw new Error('模型请求的本地记忆检索未通过当前范围或参数校验；请直接说明现有资料不足。');
          }
          const followUp: AIGenerateRequest = {
            ...request,
            tools: undefined,
            messages: [
              ...request.messages,
              {
                role: 'assistant',
                content: result.text,
                toolCalls: result.toolCalls,
              },
              ...execution.messages,
            ],
          };
          result = {
            ...(await generateOnce(followUp)),
            memorySearchUsed: true,
          };
          if (result.toolCalls?.length) {
            throw new Error('模型重复请求本地工具；已拒绝继续调用，请重新提问或直接使用当前记忆范围。');
          }
        }
        for (let continuation = 0;
          continuation < MAX_AUTOMATIC_CONTINUATIONS && result.finishReason === 'length';
          continuation += 1) {
          const message = '回答达到模型单次输出上限，正在从断点自动续写';
          context.signals.emit('ai.status', {
            state: 'generating',
            message,
            sessionId: prepared.sessionId,
            preparationId: prepared.id,
          } satisfies AIStatusSignal);
          const continued = await generateOnce(continuationRequest(request, result.text));
          result = mergeContinuedGeneration(result, continued);
        }
        return result;
      },
    });
    options.tasks.set(prepared.sessionId, task);
    void task.result.then(
      async (result) => {
        if (options.tasks.get(prepared.sessionId) === task) options.tasks.delete(prepared.sessionId);
        const recorded = await context.commands.dispatch('ai.generation.record', {
          preparationId: prepared.id,
          ...result,
        });
        const completedSession = options.readSessions()[prepared.sessionId];
        prepared.transcriptRevisionAfterAssistant = completedSession?.transcriptRevision;
        prepared.expiresAt = Date.now() + AI_GENERATION_ACTION_TTL_MS;
        options.stateBySession.delete(prepared.sessionId);
        options.actionBySession.set(prepared.sessionId, {
          kind: 'repeat',
          preparationId: prepared.id,
          expiresAt: prepared.expiresAt,
        });
        context.signals.emit('ai.state.invalidated');
        context.signals.emit('ai.status', {
          state: 'complete',
          message: result.finishReason === 'length'
            ? '回答再次达到平台输出上限；已保留全部返回内容，可以继续追问“继续”'
            : recorded.proposalId
            ? '回答完成；检测到明确的节点修改要求，请审查后写回正文'
            : result.memorySearchUsed
            ? '回答完成；已按需查询本地记忆'
            : '回答完成',
          sessionId: prepared.sessionId,
          preparationId: prepared.id,
          ...(recorded.proposalId ? { proposalId: recorded.proposalId } : {}),
        } satisfies AIStatusSignal);
        if (prepared.assistantId && prepared.followupAction !== 'repeat' &&
          options.shouldAutoExtractMemoryCandidates(prepared)) {
          void context.commands.dispatch('ai.memory.candidates.extract', {
            assistantId: prepared.assistantId,
            ...(prepared.userEntryStart !== undefined && prepared.userEntryLength !== undefined
              ? { sourceStart: prepared.userEntryStart, sourceLength: prepared.userEntryLength }
              : {}),
          }).catch((error) => context.diagnostics.warn('自动提炼 AI 记忆候选失败', error));
        }
      },
      (error) => {
        if (options.tasks.get(prepared.sessionId) === task) options.tasks.delete(prepared.sessionId);
        if (isAbortError(error)) {
          options.stateBySession.delete(prepared.sessionId);
          context.signals.emit('ai.state.invalidated');
          return;
        }
        recordGenerationError(context, options.stateBySession, options.actionBySession, prepared, error);
      },
    ).catch((error) => {
      // The network task may succeed while the transcript transaction loses a
      // revision race. Scope that failure to this assistant and keep the other
      // concurrent sessions alive.
      if (isAbortError(error)) return;
      recordGenerationError(context, options.stateBySession, options.actionBySession, prepared, error);
    });
  });
}

export function inferLengthTermination(
  result: AIGenerateResult,
  request: Pick<AIGenerateRequest, 'maxOutputTokens'>,
): AIGenerateResult {
  if (result.finishReason || result.usage?.outputTokens === undefined) return result;
  return result.usage.outputTokens >= Math.floor(request.maxOutputTokens * 0.98)
    ? { ...result, finishReason: 'length' }
    : result;
}

export function continuationRequest(request: AIGenerateRequest, partialAnswer: string): AIGenerateRequest {
  return {
    ...request,
    tools: undefined,
    temperature: Math.min(request.temperature, 0.35),
    maxOutputTokens: Math.min(16_384, Math.max(2_400, request.maxOutputTokens)),
    messages: [
      ...request.messages,
      { role: 'assistant', content: partialAnswer },
      {
        role: 'user',
        content: '上一条最终答案因平台输出长度限制而中断。请只从中断处继续，补齐尚未完成的最终答案；不要重复已经输出的内容，不要展示思考过程。',
      },
    ],
  };
}

function isToolRequestCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s+(?:400|404|422)\b|tool(?:s|_calls?)?.*(?:unsupported|not supported|invalid)|function.*(?:unsupported|not supported|invalid)/iu
    .test(message);
}

export function mergeContinuedGeneration(
  first: AIGenerateResult,
  continuation: AIGenerateResult,
): AIGenerateResult {
  const text = mergeContinuationText(first.text, continuation.text).slice(0, 100_000).trim();
  const reasoning = [first.reasoning, continuation.reasoning].filter(Boolean).join('\n\n')
    .slice(0, MAX_REASONING_DISPLAY_CHARACTERS).trim();
  const inputTokens = addOptional(first.usage?.inputTokens, continuation.usage?.inputTokens);
  const outputTokens = addOptional(first.usage?.outputTokens, continuation.usage?.outputTokens);
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    provider: continuation.provider,
    model: continuation.model,
    ...((inputTokens !== undefined || outputTokens !== undefined)
      ? { usage: { inputTokens, outputTokens } }
      : {}),
    ...(continuation.finishReason ? { finishReason: continuation.finishReason } : {}),
  };
}

function mergeContinuationText(first: string, continuation: string): string {
  const left = first.trimEnd();
  const right = continuation.trimStart();
  const overlapLimit = Math.min(500, left.length, right.length);
  for (let length = overlapLimit; length >= 12; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return left + right.slice(length);
  }
  return `${left}\n${right}`;
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function recordGenerationError(
  context: PluginContext,
  stateBySession: Map<string, GenerationState>,
  actionBySession: Map<string, AIGenerationAction>,
  prepared: PreparedGeneration,
  error: unknown,
): void {
  const previous = stateBySession.get(prepared.sessionId);
  const message = error instanceof Error ? error.message : String(error);
  prepared.expiresAt = Date.now() + AI_GENERATION_ACTION_TTL_MS;
  stateBySession.set(prepared.sessionId, {
    state: 'error',
    message,
    preparationId: prepared.id,
    sequence: previous?.sequence ?? 0,
    text: previous?.text ?? '',
    reasoning: previous?.reasoning ?? '',
  });
  actionBySession.set(prepared.sessionId, {
    kind: 'retry',
    preparationId: prepared.id,
    expiresAt: prepared.expiresAt,
  });
  context.signals.emit('ai.state.invalidated');
  context.signals.emit('ai.status', {
    state: 'error',
    message,
    sessionId: prepared.sessionId,
    preparationId: prepared.id,
  } satisfies AIStatusSignal);
}
