import { createId, isRecord, type PluginContext, type TaskHandle } from '../../core/contracts.ts';
import { runCreationBatches } from './creation-batches.ts';
import { OPERATION_LOG_STAGE, OPERATION_LOG_STAGE_V2, type OperationStageUpdate, type OperationStageUpdateV2, type OperationStatus } from '../../protocols/operation-log.ts';
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
import { parseCanvasControlPlan } from '../../services/canvas-control-validation.ts';
import { canvasContentTarget, needsCanvasCreationPlanning, naturalCanvasOperation } from '../../services/ai-task-route.ts';
import { aggregateTokenUsage, withTokenUsageEstimates } from '../../services/ai-token-usage.ts';
import { collectFullSourceSummary } from './full-source-summary.ts';
import { stripOperationCommands } from './command-parser.ts';
import { estimateAITokens } from './evidence-boundaries.ts';
import { buildGenerateRequest } from './generation-request.ts';
import { planWorkspaceWithModel } from './workspace-model-planner.ts';
import { buildBoundCanvasWritePlan } from './bound-canvas-write.ts';
import { executeMemorySearchToolCalls } from './memory-search-tool.ts';
import { initialCanvasAgentState, runCanvasAgentLoop } from './canvas-agent-tools.ts';
import { canvasTurnId, rememberTurnAssembly, turnAssembly } from './turn-route.ts';
import { prepareAIContext } from './context-preparation.ts';
import { canvasReceiptReply, readCanvasReceipt } from './canvas-recovery.ts';
import { LOCAL_CANVAS_CONTENT_TARGET, requestsCanvasTextGeneration } from './canvas-execution-policy.ts';
import { compoundGenerateRequest, readCompoundOutput } from './compound-turn.ts';
import { revalidatePreparedSources } from './context-source-reader.ts';
import { operationCreatesWriteback } from './operations.ts';
import { nativeConversation } from './request-evidence.ts';
import { isAbortError, isCanvasRevisionConflict, isCapabilityUnavailable } from './runtime-errors.ts';
import { workspaceReply } from './workspace-reply.ts';
import { bindWorkspaceLanguage } from './workspace-language-runtime.ts';
import type { PreparedGeneration } from './request-runtime.ts';
import type { WorkspacePlanReceipt } from '../../protocols/workspace-actions.ts';
import {
  AI_GENERATION_ACTION_TTL_MS,
  type AIGenerationAction,
  type AIAssistantState,
} from './types.ts';
type GenerationState = AIAssistantState['generationRuntimeBySession'][string];

export interface AIGenerationRuntimeOptions {
  archiveSession?(sessionId: string, signal: AbortSignal, report: (progress: number) => void, waitIfPaused: () => Promise<void>): Promise<void>;
  planPersonalTurn?(prompt: string, sessionId: string): import('./personal-preferences.ts').PersonalTurn | undefined | Promise<import('./personal-preferences.ts').PersonalTurn | undefined>;
  observeAppliedPreference?(prompt: string, sessionId: string, preparationId: string, reviewId: string): Promise<void>;
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
    if (reasoning.trim()) throw new Error('模型只返回了思考过程，没有返回最终答案；本轮未完成，请重试或切换模型');
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

function normalizeAIGenerateResult(result: AIGenerateResult): AIGenerateResult {
  const text = result.text.trim();
  if (!text && !result.toolCalls?.length) {
    if (result.reasoning?.trim()) {
      throw new Error('模型只返回了思考过程，没有返回最终答案；本轮未完成，请重试或切换模型');
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
    const initialPreparation = options.preparations.get(message.payload.preparationId);
    if (!initialPreparation) return;
    let prepared = initialPreparation;
    if (prepared.review) context.signals.emit(OPERATION_LOG_STAGE, { id: prepared.id, phase: 'ai-context-review', state: 'completed' } satisfies OperationStageUpdate);
    const activityId = createId('ai-answer');
    const logAnswer = (state: OperationStatus, outputCharacters?: number) => context.signals.emit(OPERATION_LOG_STAGE_V2, {
      id: activityId, phase: 'ai-answer', state, relatedId: prepared.id,
      detail: { step: 'done', task: prepared.operation === 'canvas-control' ? 'semantic-plan' : 'conversation', sourceCount: prepared.sources.length, outputCharacters },
    } satisfies OperationStageUpdateV2);
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
    const requestUsages: Array<AIGenerateResult['usage']> = [];
    let replayedCanvasReceipt = false;
    let recoveredDirectPlanId: string | undefined;
    const rebuild = async (signal: AbortSignal, stale: boolean) => {
      const session = options.readSessions()[prepared.sessionId];
      if (!session || !prepared.replayRequest) throw new Error('原请求已失效，请重新发送任务');
      const fresh = await prepareAIContext(context, session, options.readMemoryIndexes(), prepared.replayRequest, signal, () => undefined,
        undefined, undefined, undefined, undefined, await options.planPersonalTurn?.(prepared.prompt, session.id), prepared.selectionAtSend);
      if (fresh.review) throw new Error(fresh.review.message);
      const refreshed: PreparedGeneration = {
        ...fresh,
        id: prepared.id,
        replayRequest: prepared.replayRequest,
        selectionAtSend: prepared.selectionAtSend,
        usageTaskId: prepared.usageTaskId,
        transcriptRevisionAfterUser: prepared.transcriptRevisionAfterUser,
        followupAction: prepared.followupAction,
        appliedItemsMessage: prepared.followupAction === 'repeat' ? undefined : prepared.appliedItemsMessage,
        userEntryStart: prepared.userEntryStart,
        userEntryLength: prepared.userEntryLength,
        userTurn: prepared.userTurn,
      };
      const priorAssembly = turnAssembly(prepared);
      const freshAssembly = turnAssembly(fresh);
      rememberTurnAssembly(refreshed, { ...freshAssembly, ownerId: fresh.id, refreshed: stale,
        ...(priorAssembly.workspacePlanId ? { workspacePlanId: priorAssembly.workspacePlanId,
          route: { ...freshAssembly.route, workspaceSteps: priorAssembly.route.workspaceSteps } } : {}),
      });
      prepared = refreshed;
      options.preparations.set(prepared.id, prepared);
    };
    const runWithRecovery = async (signal: AbortSignal, runTurn: () => Promise<AIGenerateResult>) => {
      if (prepared.followupAction === 'retry' && prepared.operation === 'canvas-control') {
        const retryAssembly = turnAssembly(prepared);
        const workspaceSteps = retryAssembly.route.workspaceSteps;
        if (workspaceSteps) {
          let receipt = await context.queries.ask<WorkspacePlanReceipt | undefined>('workspace.plan.receipt@1', { id: retryAssembly.workspacePlanId ?? canvasTurnId(prepared) });
          signal.throwIfAborted();
          if (receipt?.status === 'waiting' && retryAssembly.workspacePlanId) receipt = await context.commands.dispatch('workspace.plan.resume@1', { id: receipt.id, apply: [] });
          if (receipt) {
            replayedCanvasReceipt = true;
            const text = await workspaceReply(context, workspaceSteps, receipt, signal);
            return { text, provider: 'local', model: '本地工作区动作', usage: { inputTokens: 0, outputTokens: 0 } };
          }
          if (retryAssembly.workspacePlanId) return { text: '原执行回执已失效，不能自动重复操作。请先核对当前界面，再重新发送要求。',
            provider: 'local', model: '执行回执', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        const receipt = await readCanvasReceipt(context, prepared.sessionId, signal, { preparationId: canvasTurnId(prepared) });
        if (receipt || prepared.appliedItemsMessage) {
          replayedCanvasReceipt = true;
          recoveredDirectPlanId = receipt?.directPlanId;
          return { text: receipt ? canvasReceiptReply(receipt) : prepared.appliedItemsMessage!,
            provider: 'local', model: '画布回执', usage: { inputTokens: 0, outputTokens: 0 } };
        }
      }
      const batchedCreation = (turnAssembly(prepared).localInstructions?.length ?? 0) > 80;
      if (!batchedCreation && prepared.replayRequest && (prepared.followupAction === 'retry' && !turnAssembly(prepared).route.applyItems ||
        prepared.followupAction === 'repeat' && prepared.operation === 'canvas-control')) await rebuild(signal, false);
      try {
        return await runTurn();
      } catch (error) {
        if (batchedCreation || !prepared.replayRequest || signal.aborted || turnAssembly(prepared).compoundTargets || !isCanvasRevisionConflict(error)) throw error;
        context.signals.emit('ai.status', { state: 'generating', message: '画布对象已变化，正在重新定位并核对正文',
          sessionId: prepared.sessionId, preparationId: prepared.id } satisfies AIStatusSignal);
        await rebuild(signal, true);
        return runTurn();
      }
    };
    const task = context.tasks.schedule<AIGenerateResult>({
      category: 'ai-generation',
      operationLogRelatedId: prepared.id,
      label: 'AI 正在生成内容',
      priority: 16,
      timeoutMs: 5 * 60_000,
      estimatedCost: 4,
      run: (signal, report, control) => runWithRecovery(signal, async () => {
        report(0.1);
        if (prepared.localMemoryDirective) return { text: '已确认并记入当前对话。', provider: 'local', model: '正式记忆', usage: { inputTokens: 0, outputTokens: 0 } };
        const assembly = turnAssembly(prepared);
        const { route } = assembly;
        const parseWithModel = () => planWorkspaceWithModel(context, prepared, signal, plan => {
          assembly.workspacePlanId = plan.id;
          assembly.route = { ...assembly.route, workspaceSteps: plan.steps };
        });
        if (assembly.personalTurn?.update) {
          signal.throwIfAborted();
          await context.commands.dispatch('ai.personal.update@1', assembly.personalTurn.update);
        }
        if (route.revisePending) {
          signal.throwIfAborted();
          const result = await context.commands.dispatch('canvasControl.revisePending@1', { sessionId: prepared.sessionId, change: route.revisePending });
          return { text: result.message, provider: 'local', model: '画布预览', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        if (assembly.localReply) return { text: assembly.localReply, provider: 'local', model: '画布回执', usage: { inputTokens: 0, outputTokens: 0 } };
        if (route.archiveSession) {
          if (!options.archiveSession) throw new Error('当前对话存档功能尚未启用。');
          await options.archiveSession(prepared.sessionId, signal, report, control.waitIfPaused);
          return { text: '当前对话原文与索引已保存到本地存档。', provider: 'local', model: '对话存档', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        const clarification = assembly.clarify ?? route.clarification;
        if (clarification) {
          if (!route.clarification && assembly.fallbackToModel) {
            const result = await parseWithModel();
            assembly.localReply = result.text; return result;
          }
          return { text: clarification, provider: 'local', model: '任务澄清', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        if (route.workspaceSteps) {
          signal.throwIfAborted();
          const { revision } = await context.queries.ask<{ revision: number }>('system.document.revision');
          const steps = await bindWorkspaceLanguage(context, route.workspaceSteps, prepared.selectionAtSend, signal);
          signal.throwIfAborted();
          const lastZoom = steps.findLast(step => ['viewport.set', 'viewport.focusEntity', 'viewport.scale'].includes(step.action) &&
            (step.arguments?.zoom !== undefined || step.action === 'viewport.scale'))?.arguments?.zoom;
          const receipt = await context.commands.dispatch('workspace.plan.run@1', {
            version: 1, id: canvasTurnId(prepared), steps, constraints: { documentRevision: revision },
            ...(typeof lastZoom === 'number' ? { verify: [{ action: 'viewport.read', field: ['zoom'], equals: lastZoom }] } : {}),
          });
          assembly.localReply = await workspaceReply(context, route.workspaceSteps, receipt, signal);
          return { text: assembly.localReply, provider: 'local', model: '本地工作区动作', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        if (route.native) {
          signal.throwIfAborted();
          const result = await context.commands.dispatch('canvasControl.native@1', {
            preparationId: canvasTurnId(prepared), sessionId: prepared.sessionId, prompt: assembly.personalTurn?.instruction ?? prepared.prompt,
            selectedIds: assembly.nativeSelection, sourceIds: assembly.localSourceIds,
          });
          return { text: result.message, provider: 'local', model: '确定性操作', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        if (route.applyItems) {
          signal.throwIfAborted();
          await context.commands.dispatch('canvasControl.applyItems@2', { sessionId: prepared.sessionId, items: route.applyItems });
          prepared.appliedItemsMessage = `已应用第 ${route.applyItems.join('、')} 项，可一次撤销。核对结果见画布控制。`;
          return { text: prepared.appliedItemsMessage,
            provider: 'local', model: '选择应用', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        if (assembly.fixedPlan) {
          const sources = prepared.sources.filter(source => source.reason === 'explicit-reference');
          await revalidatePreparedSources(context, sources, { signal });
          if (!await initialCanvasAgentState(context, prepared, signal)) throw new Error('请启用画布控制以核对字段写入目标');
          const plan = await context.capabilities.request<{ text: string }>('canvasControl.agentPlan@1', {
            preparationId: canvasTurnId(prepared), sessionId: prepared.sessionId, prompt: prepared.prompt, plan: assembly.fixedPlan,
          }, signal);
          return { text: plan.text, provider: 'local', model: route.fieldTask?.kind === 'change' ? '字段写入' : '历史原文恢复',
            usage: { inputTokens: 0, outputTokens: 0 } };
        }
        if (route.category === 'operation' && !assembly.compoundTargets && !route.semanticFallback) {
          const instructions = assembly.localInstructions ?? (assembly.workspaceLocalPrompt ? [assembly.workspaceLocalPrompt] : undefined);
          if (prepared.selectionAtSend && /选中|选区/u.test(instructions?.join(' ') ?? prepared.prompt)) {
            const current = await context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal);
            if (current.ids.length !== prepared.selectionAtSend.length || current.ids.some((id, index) => id !== prepared.selectionAtSend?.[index])) {
              throw new Error('发送后的选区已变化，请重新发送以确认目标。');
            }
          }
          if (instructions && instructions.length > 80 && instructions.every(text => naturalCanvasOperation(text)?.kind === 'create')) {
            assembly.localReply = await runCreationBatches(context, { preparationId: canvasTurnId(prepared), sessionId: prepared.sessionId,
              prompt: prepared.prompt }, instructions, signal, (completed, total, batches) => {
              report(0.1 + 0.8 * completed / total);
              const runtime = options.stateBySession.get(prepared.sessionId);
              if (runtime) options.stateBySession.set(prepared.sessionId, { ...runtime, batchProgress: { completed, total, batches } });
              context.signals.emit('ai.status', { state: 'generating', sessionId: prepared.sessionId, preparationId: prepared.id,
                message: `分 ${batches} 批新建，已创建 ${completed}/${total} 个节点；可取消剩余批次，已提交批次可逐批撤销。` } satisfies AIStatusSignal);
            });
            return { text: assembly.localReply, provider: 'local', model: '分批新建', usage: { inputTokens: 0, outputTokens: 0 } };
          }
          const capability = instructions && instructions.length > 80 ? 'canvasControl.localCreationPlan@1' : instructions ? 'canvasControl.localPlan@2' : 'canvasControl.localPlan@1';
          const local = await context.capabilities.request<{ handled: boolean; text?: string; unresolvedTarget?: boolean }>(capability, {
            preparationId: canvasTurnId(prepared), sessionId: prepared.sessionId, prompt: prepared.prompt,
            sourceIds: assembly.localSourceIds ?? prepared.sources.filter(source => source.reason === 'explicit-reference').map(source => source.sourceId),
            ...(instructions ? { instructions, expectedSelectionCount: assembly.expectedSelectionCount } : {}),
          }, signal).catch(error => { if (isCapabilityUnavailable(error, capability)) return { handled: false }; throw error; });
          if (local.handled && 'text' in local && local.text) {
            return { text: local.text, provider: 'local', model: '确定性操作', usage: { inputTokens: 0, outputTokens: 0 } };
          }
          if (instructions) throw new Error('本地画布操作能力不可用，请启用 AI 画布控制插件。');
        }
        if (prepared.operation === 'canvas-control' && !requestsCanvasTextGeneration(route) && !prepared.writebackTarget) {
          const result = await parseWithModel();
          assembly.localReply = result.text; return result;
        }
        const interpretSearch = route.interpretedSearch;
        let request: AIGenerateRequest = assembly.compoundTargets && route.compound ?
          compoundGenerateRequest(prepared, route.compound.requests, assembly.compoundTargets) : interpretSearch ? {
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
        if (prepared.operation === 'canvas-control' && !assembly.boundCanvasWrite && !assembly.compoundTargets) {
          assembly.localReply = LOCAL_CANVAS_CONTENT_TARGET;
          return { text: assembly.localReply, provider: 'local', model: '本地操作澄清', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        if (route.draft) {
          const draft = assembly.canvasDraftBound ? prepared.sources.filter(source => source.reason === 'recent-conversation' && source.complete === true)
            .flatMap(source => nativeConversation(source.text, prepared.prompt, true, true, true))
            .findLast(message => message.role === 'assistant')?.content : undefined;
          if (assembly.boundCanvasWrite?.kind !== 'write' || !draft?.trim()) {
            assembly.localReply = '没有找到可原样写入的完整草稿。请贴出要写入的正文，或指定上一段草稿。';
            return { text: assembly.localReply, provider: 'local', model: '本地操作澄清', usage: { inputTokens: 0, outputTokens: 0 } };
          }
          await revalidatePreparedSources(context, prepared.sources, { signal,
            allowUnchangedRangeRevisionAdvanceFor: new Set(prepared.sources.filter(source => source.kind === 'conversation').map(source => source.sourceId)),
          });
          const plan = buildBoundCanvasWritePlan(assembly.boundCanvasWrite, JSON.stringify({ text: draft }));
          return { text: JSON.stringify(plan), provider: 'local', model: '原文写入', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        if (request.usageContext) {
          request.usageContext.taskId = prepared.usageTaskId!;
          if (prepared.followupAction) request.usageContext.purpose = prepared.followupAction;
        }
        const forPurpose = (active: AIGenerateRequest, purpose: NonNullable<AIGenerateRequest['usageContext']>['purpose']): AIGenerateRequest => ({
          ...active, usageContext: { ...active.usageContext!, taskId: prepared.usageTaskId!, sessionId: prepared.sessionId, purpose },
        });
        let emittedSequence = 0;
        const recordUsage = (completed: AIGenerateResult, activeRequest: AIGenerateRequest) => requestUsages.push(withTokenUsageEstimates(
          completed.usage,
          3 + activeRequest.messages.reduce((total, message) => total + 4 + estimateAITokens(message.content) + (message.toolCalls ? estimateAITokens(JSON.stringify(message.toolCalls)) : 0), 0) + (activeRequest.tools ? estimateAITokens(JSON.stringify(activeRequest.tools)) : 0),
          estimateAITokens(completed.text + (completed.reasoning ?? '') + (completed.toolCalls ? JSON.stringify(completed.toolCalls) : '')),
        ));
        const generateOnce = async (activeRequest: AIGenerateRequest, visible = true): Promise<AIGenerateResult> => {
          if (prepared.operation === 'canvas-control' && ((!assembly.boundCanvasWrite && !assembly.compoundTargets) || activeRequest.canvasAgentTransport || activeRequest.tools?.length)) {
            throw new Error('画布操作只允许本地执行；云端仅可生成已绑定范围的正文。');
          }
          const inspectedRequest = { ...activeRequest, inspection: { sessionId: prepared.sessionId, userTurn: prepared.userTurn ?? options.readSessions()[prepared.sessionId]?.turns ?? 1 } };
          const responseId = createId('ai-response');
          const requestedAt = performance.now();
          const logResponse = (state: OperationStatus, elapsedMs?: number, failure?: unknown) => context.signals.emit(OPERATION_LOG_STAGE_V2, {
            id: responseId, phase: 'ai-model-response', state, relatedId: prepared.id, elapsedMs,
            detail: { step: 'model', route: 'model', task: assembly.boundCanvasWrite || assembly.compoundTargets ? 'body-generation' : 'conversation', sourceCount: prepared.sources.length,
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
        let result = assembly.compoundTargets ? await generateOnce(request, false) : await generateWithToolFallback(request);
        if (assembly.compoundTargets) {
          if (result.finishReason === 'length' || result.toolCalls?.length) throw new Error('正文结果未完整生成，组合计划尚未应用。');
          const texts = readCompoundOutput(result.text, assembly.compoundTargets.length);
          await revalidatePreparedSources(context, prepared.sources, { signal, allowUnchangedRangeRevisionAdvanceFor: new Set(prepared.sources
            .filter(source => source.kind === 'conversation').map(source => source.sourceId)) });
          const completed = await context.capabilities.request<{ text: string }>('canvasControl.completeCompound@1', {
            preparationId: canvasTurnId(prepared), sessionId: prepared.sessionId, prompt: prepared.prompt, texts,
          }, signal);
          return { ...result, text: completed.text, reasoning: undefined, usage: aggregateTokenUsage(requestUsages) };
        }
        if (assembly.boundCanvasWrite) {
          if (result.finishReason === 'length') throw new Error('卡片正文超过单次输出上限，请缩短要求后重试');
          if (result.toolCalls?.length) throw new Error('模型没有返回符合本轮写入范围的正文，请重试');
          const plan = buildBoundCanvasWritePlan(assembly.boundCanvasWrite, result.text);
          try {
            await revalidatePreparedSources(context, prepared.sources, {
              signal, allowUnchangedRangeRevisionAdvanceFor: new Set(prepared.sources
                .filter(source => source.kind === 'conversation').map(source => source.sourceId)),
            });
          } catch (error) {
            signal.throwIfAborted();
            throw new Error('写入前核对资料失败，请重新准备本轮资料后重试。', { cause: error });
          }
          return { ...result, text: JSON.stringify(plan), reasoning: undefined, usage: aggregateTokenUsage(requestUsages) };
        }
        if (interpretSearch) {
          let raw: unknown;
          try { raw = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu, '$1')); }
          catch { throw new Error('模型没有返回可用的筛选条件，请试着提供一个关键词。'); }
          if (!isRecord(raw) || !Array.isArray(raw.terms) || typeof raw.ungrouped !== 'boolean') throw new Error('模型没有返回可用的筛选条件，请试着提供一个关键词。');
          const local = await context.capabilities.request<{ text: string }>('canvasControl.searchPlan@1', {
            preparationId: canvasTurnId(prepared), sessionId: prepared.sessionId, prompt: prepared.prompt, terms: raw.terms, ungrouped: raw.ungrouped,
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
          if (assembly.destinationId || assembly.fields || assembly.restructure) throw new Error('本轮还没有生成可验证的正文计划，请缩小处理范围。');
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
        if (assembly.conversationDraft && result.finishReason !== 'length') {
          const { firstSentence, maxCharacters } = assembly.conversationDraft;
          const joinDraft = (text: string) => {
            const body = text.trim();
            if (!firstSentence || body.startsWith(firstSentence)) return body;
            return firstSentence + body;
          };
          let text = joinDraft(result.text);
          if (maxCharacters !== undefined && Array.from(text).length > maxCharacters) {
            const correction: AIGenerateRequest = { ...request, messages: [...request.messages.slice(0, -1), {
              role: 'system', content: `请直接给出精简正文，最终长度上限 ${maxCharacters} 字符。${firstSentence ? `应用另行拼接长度 ${Array.from(firstSentence).length} 字符的首句，请为它留出空间。` : ''}`,
            }, request.messages.at(-1)!] };
            result = await generateOnce(forPurpose(correction, 'format-correction'));
            text = joinDraft(result.text);
            if (Array.from(text).length > maxCharacters) throw new Error('生成的草稿仍超过本轮字数上限，请减少保留内容或调整篇幅。');
          }
          result = { ...result, text };
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
      }),
    });
    options.tasks.set(prepared.sessionId, task);
    void task.result.then(
      async (result) => {
        if (options.tasks.get(prepared.sessionId) !== task) { logAnswer('cancelled'); return; }
        let directPlanId = recoveredDirectPlanId;
        const assembly = turnAssembly(prepared);
        if (prepared.operation === 'canvas-control' && !replayedCanvasReceipt && !assembly.localReply && !assembly.clarify && !assembly.route.archiveSession && !assembly.route.clarification && !assembly.route.applyItems && !assembly.route.native) {
          if (options.tasks.get(prepared.sessionId) !== task) { logAnswer('cancelled'); return; }
          const offer = await context.commands.dispatch('canvasControl.offer@1', {
            preparationId: canvasTurnId(prepared), sessionId: prepared.sessionId, prompt: prepared.prompt,
            text: result.text, complete: result.finishReason !== 'length',
          });
          result = { ...result, text: offer.message + (assembly.route.compound?.deferred ? '\n其余步骤已暂缓，可以之后再发送。' : ''), reasoning: undefined };
          directPlanId = offer.directPlanId;
        }
        if (options.tasks.get(prepared.sessionId) !== task) { logAnswer('cancelled'); return; }
        const recorded = await context.commands.dispatch('ai.generation.record', {
          preparationId: prepared.id,
          ...result,
        });
        if (options.tasks.get(prepared.sessionId) !== task) { logAnswer('cancelled'); return; }
        options.tasks.delete(prepared.sessionId);
        const completedSession = options.readSessions()[prepared.sessionId];
        prepared.transcriptRevisionAfterAssistant = completedSession?.transcriptRevision;
        const directResult = directPlanId ? await context.commands.dispatch('canvasControl.generate@1', { id: directPlanId }) : undefined;
        if (directPlanId && !replayedCanvasReceipt) {
          void options.observeAppliedPreference?.(prepared.prompt, prepared.sessionId, canvasTurnId(prepared), directPlanId)
            .catch(error => context.diagnostics.warn('记录偏好候选失败', error));
        }
        logAnswer('completed', result.text.length);
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
        if (options.tasks.get(prepared.sessionId) !== task) { logAnswer('cancelled'); return; }
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
      // The network task may succeed while the transcript transaction loses a
      // revision race. Scope that failure to this assistant and keep the other
      // concurrent sessions alive.
      const currentTask = options.tasks.get(prepared.sessionId);
      if (currentTask && currentTask !== task) return;
      if (!currentTask && options.preparations.get(prepared.id) !== prepared) { logAnswer('cancelled'); return; }
      logAnswer(generationFailure(error));
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
