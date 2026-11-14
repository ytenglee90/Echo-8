import { createId, isRecord, type PluginContext, type TaskHandle } from '../../core/contracts.ts';
import { OPERATION_LOG_STAGE, OPERATION_LOG_STAGE_V2, type OperationStageUpdate, type OperationStageUpdateV2, type OperationStatus } from '../../protocols/operation-log.ts';
import type {
  AIGenerateResult,
  AIGenerateRequest,
  AIGenerateStream,
  AIGenerationDeltaSignal,
  AIMemoryIndexRecord,
  AIPreparedContext,
  AIPromptTemplateCatalog,
  AIProviderCatalog,
  AIStatusSignal,
  AISessionRecord,
} from '../../protocols/ai.ts';
import { assertNotAborted } from '../../services/async-control.ts';
import { parseCanvasControlPlan } from '../../services/canvas-control-validation.ts';
import { canvasContentTarget, needsCanvasCreationPlanning, needsCanvasSearchInterpretation } from '../../services/ai-task-route.ts';
import { aggregateTokenUsage, withTokenUsageEstimates } from '../../services/ai-token-usage.ts';
import { collectFullSourceSummary } from './full-source-summary.ts';
import { stripOperationCommands } from './command-parser.ts';
import { estimateAITokens } from './evidence-boundaries.ts';
import { buildGenerateRequest } from './generation-request.ts';
import { executeMemorySearchToolCalls } from './memory-search-tool.ts';
import { runCanvasAgentLoop } from './canvas-agent-tools.ts';
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
  taskForSession?(sessionId: string): string;
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
      if (event.usage) usage = event.usage;
      finishReason = event.finishReason;
      continue;
    }
    if (event.type === 'tool-call') {
      const existing = toolCalls.get(event.index) ?? { arguments: '' };
      if (toolCalls.size >= 4 && !toolCalls.has(event.index)) throw new Error('单步工具调用超过四项');
      if (existing.arguments.length + (event.argumentsDelta?.length ?? 0) > 128_000) throw new Error('模型工具参数超过长度限制，请缩小任务');
      toolCalls.set(event.index, {
        id: event.id ?? existing.id,
        name: event.name ?? existing.name,
        arguments: `${existing.arguments}${event.argumentsDelta ?? ''}`.slice(0, 128_001),
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
    .flatMap(([, call]) => call.id && call.name && call.arguments.length <= 128_000
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
    if (prepared.review) context.signals.emit(OPERATION_LOG_STAGE, { id: prepared.id, phase: 'ai-context-review', state: 'completed' } satisfies OperationStageUpdate);
    const activityId = createId('ai-answer');
    const logAnswer = (state: OperationStatus) => context.signals.emit(OPERATION_LOG_STAGE, {
      id: activityId, phase: 'ai-answer', state, relatedId: prepared.id,
    } satisfies OperationStageUpdate);
    logAnswer('running');
    prepared.usageTaskId ??= options.taskForSession?.(prepared.sessionId) ?? prepared.sessionId;
    options.tasks.get(prepared.sessionId)?.cancel();
    options.actionBySession.delete(prepared.sessionId);
    const generationMessage = prepared.operation === 'canvas-control' ? '正在规划画布对象操作' : operationCreatesWriteback(prepared.operation)
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
      operationLogRelatedId: prepared.id,
      label: 'AI 正在生成内容',
      priority: 16,
      timeoutMs: 5 * 60_000,
      estimatedCost: 4,
      run: async (signal, report) => {
        report(0.1);
        if (prepared.localMemoryDirective) return { text: '已确认并记入当前对话。', provider: 'local', model: '正式记忆', usage: { inputTokens: 0, outputTokens: 0 } };
        let localTargetUnresolved = false;
        if (prepared.operation === 'canvas-control') {
          const local = await context.capabilities.request<{ handled: boolean; text?: string; unresolvedTarget?: boolean }>('canvasControl.localPlan@1', {
            preparationId: prepared.id, sessionId: prepared.sessionId, prompt: prepared.prompt,
            sourceIds: prepared.sources.filter(source => source.reason === 'explicit-reference').map(source => source.sourceId),
          }, signal).catch(error => { if (isCapabilityUnavailable(error, 'canvasControl.localPlan@1')) return { handled: false }; throw error; });
          if (local.handled && 'text' in local && local.text) {
            if (local.unresolvedTarget) {
              const catalog = await context.capabilities.request<AIProviderCatalog>('ai.provider.catalog@1', undefined, signal)
                .catch(error => { if (isAbortError(error)) throw error; return undefined; });
              const provider = catalog?.options.find(option => option.id === (prepared.providerProfileId ?? catalog.activeId));
              localTargetUnresolved = provider?.configured === true;
            }
            if (!localTargetUnresolved) return { text: local.text, provider: 'local', model: '确定性操作', usage: { inputTokens: 0, outputTokens: 0 } };
          }
        }
        const interpretSearch = prepared.operation === 'canvas-control' && needsCanvasSearchInterpretation(prepared.prompt);
        let request: AIGenerateRequest = interpretSearch ? {
          providerId: prepared.providerProfileId,
          temperature: 0,
          maxOutputTokens: 512,
          messages: [
            { role: 'system', content: '从用户请求提取当前画布本地搜索的关键词和未分组条件。只输出 JSON：{"terms":["关键词"],"ungrouped":true}。关键词最多 8 个，每个最多 48 字。用户明确要求未归类或未分组时 ungrouped 为 true。不要编造节点名、ID 或搜索结果。' },
            { role: 'user', content: prepared.prompt },
          ],
          usageContext: { taskId: prepared.sessionId, sessionId: prepared.sessionId, purpose: 'plan', outputKind: 'plan' },
        } : await buildGenerateRequest(
          context,
          prepared,
          options.readPromptTemplates(),
          signal,
        );
        if (localTargetUnresolved && request.canvasAgentTransport) request.messages.splice(-1, 0, {
          role: 'system', content: '本地规则未能按原词唯一定位对象。请用 query_canvas 试查名称变体、描述或关系，找到真实对象后继续原任务。仅在确实无法区分时询问用户。',
        });
        if (request.usageContext) {
          request.usageContext.taskId = prepared.usageTaskId!;
          if (prepared.followupAction) request.usageContext.purpose = prepared.followupAction;
        }
        const forPurpose = (active: AIGenerateRequest, purpose: NonNullable<AIGenerateRequest['usageContext']>['purpose']): AIGenerateRequest => ({
          ...active, usageContext: { ...active.usageContext!, taskId: prepared.usageTaskId!, sessionId: prepared.sessionId, purpose },
        });
        let emittedSequence = 0;
        const requestUsages: Array<AIGenerateResult['usage']> = [];
        const recordUsage = (completed: AIGenerateResult, activeRequest: AIGenerateRequest) => requestUsages.push(withTokenUsageEstimates(
          completed.usage,
          3 + activeRequest.messages.reduce((total, message) => total + 4 + estimateAITokens(message.content) + (message.toolCalls ? estimateAITokens(JSON.stringify(message.toolCalls)) : 0), 0) + (activeRequest.tools ? estimateAITokens(JSON.stringify(activeRequest.tools)) : 0),
          estimateAITokens(completed.text + (completed.reasoning ?? '') + (completed.toolCalls ? JSON.stringify(completed.toolCalls) : '')),
        ));
        const generateOnce = async (activeRequest: AIGenerateRequest, visible = true): Promise<AIGenerateResult> => {
          const inspectedRequest = { ...activeRequest, inspection: { sessionId: prepared.sessionId, userTurn: prepared.userTurn ?? options.readSessions()[prepared.sessionId]?.turns ?? 1 } };
          const responseId = createId('ai-response');
          const requestedAt = performance.now();
          const logResponse = (state: OperationStatus, elapsedMs?: number, failure?: unknown) => context.signals.emit(OPERATION_LOG_STAGE_V2, {
            id: responseId, phase: 'ai-model-response', state, relatedId: prepared.id, elapsedMs,
            detail: { step: 'model', route: 'model',
              reason: state === 'timed-out' ? 'model-timeout' : state === 'cancelled' ? 'cancelled' : state === 'failed' ? 'model-http-error' : undefined,
              httpStatus: failure instanceof Error ? Number(/\bHTTP\s+(\d{3})\b/iu.exec(failure.message)?.[1]) || undefined : undefined },
          } satisfies OperationStageUpdateV2);
          let received = false;
          const receivedResponse = () => {
            if (received || signal.aborted) return;
            received = true;
            logResponse('completed', performance.now() - requestedAt);
          };
          logResponse('waiting');
          const onAbort = () => { if (!received) logResponse(generationFailure(signal.reason)); };
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            signal.throwIfAborted();
            const stream = await context.capabilities.request<AIGenerateStream>(
              'ai.generate.stream@1',
              inspectedRequest,
              signal,
            );
            const result = await consumeAIGenerationStream(stream, signal, {
              onDelta: (event) => {
                receivedResponse();
                if (!visible || prepared.operation === 'canvas-control' || activeRequest.canvasAgentTransport === 'json') return;
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
              report: visible ? report : () => undefined,
            });
            const completed = inferLengthTermination(result, activeRequest);
            receivedResponse();
            recordUsage(completed, activeRequest);
            return completed;
          } catch (error) {
            try {
              if (!isCapabilityUnavailable(error, 'ai.generate.stream@1')) throw error;
              const completed = inferLengthTermination(normalizeAIGenerateResult(
                await context.capabilities.request<AIGenerateResult>('ai.generate@1', inspectedRequest, signal),
              ), activeRequest);
              receivedResponse();
              recordUsage(completed, activeRequest);
              return completed;
            } catch (reason) {
              if (!received) logResponse(generationFailure(signal.aborted ? signal.reason : reason), performance.now() - requestedAt, reason);
              throw reason;
            }
          } finally {
            signal.removeEventListener('abort', onAbort);
          }
        };

        const generateWithToolFallback = async (activeRequest: AIGenerateRequest): Promise<AIGenerateResult> => {
          try {
            return await generateOnce(activeRequest);
          } catch (error) {
            const rejectedToolRound = activeRequest.canvasAgentTransport === 'native' && activeRequest.messages.some(message => message.role === 'tool') &&
              error instanceof Error && /HTTP\s+422\b/u.test(error.message);
            if (!activeRequest.tools?.length || (!rejectedToolRound && !isToolRequestCompatibilityError(error))) throw error;
            context.diagnostics.warn('当前模型连接不接受原生工具，正在使用兼容方式', error);
            context.signals.emit('ai.status', {
              state: 'generating',
              message: activeRequest.canvasAgentTransport ? '当前连接正在切换画布工具兼容模式' : '当前连接不支持按需记忆工具，已继续使用常规检索',
              sessionId: prepared.sessionId,
              preparationId: prepared.id,
            } satisfies AIStatusSignal);
            if (activeRequest.canvasAgentTransport) {
              activeRequest.canvasAgentTransport = 'json';
              activeRequest.tools = undefined;
              activeRequest.responseSchema = undefined;
              activeRequest.messages = activeRequest.messages.map(message => {
                if (message.role === 'tool') return { role: 'user' as const, content: `画布工具返回（${message.toolCallId}）：\n${message.content}` };
                if (!message.toolCalls?.length) return message;
                return { role: 'assistant' as const, content: [message.content, JSON.stringify({ canvas_tool_calls: message.toolCalls })].filter(Boolean).join('\n') };
              });
              activeRequest.messages.push({ role: 'system', content: '当前连接使用 canvas_tool 结构化信封调用画布工具。请先查询再提交计划。普通聊天仍可直接回答。' });
              return generateOnce(forPurpose(activeRequest, 'compatibility-retry'));
            }
            return generateOnce(forPurpose({ ...activeRequest, tools: undefined }, 'compatibility-retry'));
          }
        };

        if (prepared.fullSummary) {
          request = await collectFullSourceSummary(context, prepared, request, signal,
            stage => generateOnce(forPurpose(stage, 'answer'), false), report);
        }
        let result = await generateWithToolFallback(request);
        if (interpretSearch) {
          let raw: unknown;
          try { raw = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu, '$1')); }
          catch { throw new Error('模型没有返回可用的筛选条件，请试着提供一个关键词。'); }
          if (!isRecord(raw) || !Array.isArray(raw.terms) || typeof raw.ungrouped !== 'boolean') throw new Error('模型没有返回可用的筛选条件，请试着提供一个关键词。');
          const local = await context.capabilities.request<{ text: string }>('canvasControl.searchPlan@1', {
            preparationId: prepared.id, sessionId: prepared.sessionId, prompt: prepared.prompt, terms: raw.terms, ungrouped: raw.ungrouped,
          }, signal);
          return { ...result, text: local.text, reasoning: undefined, usage: aggregateTokenUsage(requestUsages) };
        }
        if (request.canvasAgentTransport) {
          const agent = await runCanvasAgentLoop(context, prepared, request, result,
            active => generateWithToolFallback(active),
            calls => executeMemorySearchToolCalls(context, prepared, options.readMemoryIndexes(), calls, signal), signal);
          result = agent.result;
          if (agent.canvasPlan) {
            prepared.operation = 'canvas-control';
            return { ...result, usage: aggregateTokenUsage(requestUsages) };
          }
        } else if (result.toolCalls?.length) {
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
            ...(await generateOnce(forPurpose(followUp, 'tool-roundtrip'))),
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
          const continued = await generateOnce(forPurpose(continuationRequest(request, result.text), 'continuation'));
          result = mergeContinuedGeneration(result, continued);
        }
        if (prepared.operation === 'canvas-control' && result.finishReason !== 'length') {
          const creationRequested = needsCanvasCreationPlanning(stripOperationCommands(prepared.prompt));
          const contentRequested = Boolean(canvasContentTarget(prepared.prompt) && prepared.sources.some(source => source.reason === 'explicit-reference'));
          const validatePlan = (text: string) => {
            const plan = parseCanvasControlPlan(text);
            if (creationRequested && !plan.actions.some(action => action.type === 'create-node')) {
              throw new Error('当前文字节点能力已启用，但返回计划没有 create-node。请根据本轮要求生成新节点。');
            }
            if (contentRequested && !plan.actions.some(action => action.type === 'update-node')) throw new Error('本轮已定位可写正文目标，请返回 update-node 填入用户要求的内容。');
            context.signals.emit(OPERATION_LOG_STAGE_V2, { id: prepared.id, relatedId: prepared.id, phase: 'canvas-validation', state: 'completed',
              count: plan.actions.length, detail: { step: 'validate', route: 'model', reason: plan.actions.length ? 'model-plan' : 'no-change' } } satisfies OperationStageUpdateV2);
          };
          try { validatePlan(result.text); }
          catch (error) {
            context.signals.emit(OPERATION_LOG_STAGE_V2, { id: prepared.id, relatedId: prepared.id, phase: 'canvas-validation', state: 'failed',
              detail: { step: 'validate', route: 'model', reason: 'invalid-plan' } } satisfies OperationStageUpdateV2);
            if (request.messages.length > 62) throw error;
            context.signals.emit('ai.status', { state: 'generating', message: '正在修正画布操作计划格式', sessionId: prepared.sessionId, preparationId: prepared.id } satisfies AIStatusSignal);
            result = await generateOnce(forPurpose({ ...request, temperature: 0.1, tools: undefined, messages: [
              ...request.messages, { role: 'assistant', content: result.text },
              { role: 'user', content: `计划校验未通过：${error instanceof Error ? error.message : '格式错误'}。${creationRequested ? '按原请求返回创建动作，使用应用确认的能力。' : '请仅修正数据格式。'}保留本次要求与已有对象 ID，不增加权限或无关操作。根对象必须有数字 version 和 actions 数组；保留原计划版本，普通操作可用 1，局部 edit 必须用 2，actions 中每项有 type。只输出完整 JSON，不要输出书籍文件、节点清单、Markdown 说明或代码脚本。` },
            ] }, 'format-correction'));
            if (result.finishReason !== 'length') validatePlan(result.text);
          }
        }
        return { ...result, usage: aggregateTokenUsage(requestUsages) };
      },
    });
    options.tasks.set(prepared.sessionId, task);
    void task.result.then(
      async (result) => {
        let directPlanId: string | undefined;
        if (prepared.operation === 'canvas-control') {
          if (options.tasks.get(prepared.sessionId) !== task) return;
          const offer = await context.commands.dispatch('canvasControl.offer@1', {
            preparationId: prepared.id, sessionId: prepared.sessionId, prompt: prepared.prompt,
            text: result.text, complete: result.finishReason !== 'length',
          });
          result = { ...result, text: offer.message, reasoning: undefined };
          directPlanId = offer.directPlanId;
        }
        if (options.tasks.get(prepared.sessionId) === task) options.tasks.delete(prepared.sessionId);
        const recorded = await context.commands.dispatch('ai.generation.record', {
          preparationId: prepared.id,
          ...result,
        });
        const completedSession = options.readSessions()[prepared.sessionId];
        prepared.transcriptRevisionAfterAssistant = completedSession?.transcriptRevision;
        const directResult = directPlanId ? await context.commands.dispatch('canvasControl.generate@1', { id: directPlanId }) : undefined;
        logAnswer('completed');
        prepared.expiresAt = Date.now() + AI_GENERATION_ACTION_TTL_MS;
        options.stateBySession.delete(prepared.sessionId);
        if (prepared.localMemoryDirective) {
          void context.commands.dispatch('ai.session.save', { sessionId: prepared.sessionId, automatic: true })
            .catch(error => context.diagnostics.warn('建立正式记忆索引失败', error));
        } else {
          options.actionBySession.set(prepared.sessionId, {
            kind: 'repeat',
            preparationId: prepared.id,
            expiresAt: prepared.expiresAt,
          });
        }
        context.signals.emit('ai.state.invalidated');
        context.signals.emit('ai.status', {
          state: 'complete',
          message: directResult?.message ?? (prepared.operation === 'canvas-control' ? result.text.slice(0, 240) : undefined) ?? (result.finishReason === 'length'
            ? '回答再次达到平台输出上限；已保留全部返回内容，可以继续追问“继续”'
            : recorded.proposalId
            ? '回答完成；检测到明确的节点修改要求，请审查后写回正文'
            : result.memorySearchUsed
            ? '回答完成；已按需查询本地记忆'
            : '回答完成'),
          sessionId: prepared.sessionId,
          preparationId: prepared.id,
          ...(recorded.proposalId ? { proposalId: recorded.proposalId } : {}),
        } satisfies AIStatusSignal);
        if (!prepared.localMemoryDirective && prepared.operation !== 'canvas-control' && prepared.contextIntent !== 'conversation' && prepared.assistantId && prepared.followupAction !== 'repeat' &&
          options.shouldAutoExtractMemoryCandidates(prepared)) {
          void context.commands.dispatch('ai.memory.candidates.extract', {
            assistantId: prepared.assistantId,
            usageTaskId: prepared.usageTaskId,
            ...(prepared.userEntryStart !== undefined && prepared.userEntryLength !== undefined
              ? { sourceStart: prepared.userEntryStart, sourceLength: prepared.userEntryLength }
              : {}),
          }).catch((error) => context.diagnostics.warn('自动提炼 AI 记忆候选失败', error));
        }
      },
      (error) => {
        logAnswer(generationFailure(error));
        if (options.tasks.get(prepared.sessionId) === task) options.tasks.delete(prepared.sessionId);
        if (isAbortError(error)) {
          options.stateBySession.delete(prepared.sessionId);
          context.signals.emit('ai.state.invalidated');
          return;
        }
        recordGenerationError(context, options.stateBySession, options.actionBySession, prepared, error);
      },
    ).catch((error) => {
      logAnswer(generationFailure(error));
      // The network task may succeed while the transcript transaction loses a
      // revision race. Scope that failure to this assistant and keep the other
      // concurrent sessions alive.
      const currentTask = options.tasks.get(prepared.sessionId);
      if (currentTask && currentTask !== task) return;
      if (currentTask === task) options.tasks.delete(prepared.sessionId);
      if (isAbortError(error)) return;
      recordGenerationError(context, options.stateBySession, options.actionBySession, prepared, error);
    });
  });
}

function generationFailure(error: unknown): OperationStatus {
  if (error instanceof Error && (error.name === 'TimeoutError' || /(?:\btimed? out\b|超时)/iu.test(error.message))) return 'timed-out';
  return isAbortError(error) ? 'cancelled' : 'failed';
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
  return /(?:tool(?:s|_calls?)?|function(?:s|_call(?:ing)?)?|工具).{0,120}(?:unsupported|not supported|invalid|unknown|unrecognized|not allowed|不支持|无效|未知)|(?:unsupported|not support(?:ed)?|unknown|unrecognized|不支持|无效|未知).{0,120}(?:tool(?:s|_calls?)?|function(?:s|_call(?:ing)?)?|工具)/iu
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
