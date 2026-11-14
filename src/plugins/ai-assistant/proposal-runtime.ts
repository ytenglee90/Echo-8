import { createId, type PluginContext } from '../../core/contracts.ts';
import { OPERATION_LOG_STAGE, type OperationStageUpdate } from '../../protocols/operation-log.ts';
import type {
  AIPreparedContext,
  AIProposalRecord,
  AISessionRecord,
} from '../../protocols/ai.ts';
import type {
  ContentAppendPlanRequest,
  ContentDeltaPlanRequest,
  ContentMutationPlan,
  ContentCreatePlanRequest,
} from '../../protocols/content.ts';
import {
  isAcceptProposalPayload,
  isGenerationRecordPayload,
  isProposalIdPayload,
  type AcceptProposalPayload,
  type ProposalIdPayload,
} from './command-payloads.ts';
import {
  readContextSource,
  revalidateSourceRefs,
} from './context-source-reader.ts';
import { operationCreatesWriteback } from './operations.ts';
import {
  AI_SESSION_NAMESPACE,
  formatAITranscriptEntry,
  planTranscriptAppend,
  sessionTranscriptSourceId,
} from './transcript-storage.ts';
import { collectAIResponseCitations } from './transcript-presentation.ts';
import type { PreparedGeneration } from './request-runtime.ts';
import type { AIResponseDetail } from './types.ts';
import { normalizeTokenUsage } from '../../services/ai-token-usage.ts';

export const AI_PROPOSAL_NAMESPACE = 'aiProposals';
export const AI_RESPONSE_NAMESPACE = 'aiResponseDetails';

export interface AIProposalRuntimeOptions {
  readSessions(): Record<string, AISessionRecord>;
  readProposals(): Record<string, AIProposalRecord>;
  requirePreparation(id: string): PreparedGeneration;
}

export function registerAIProposalRuntime(
  context: PluginContext,
  options: AIProposalRuntimeOptions,
): void {
  for (const [event, state] of [
    ['ai.proposal.created', 'pending'], ['ai.proposal.accepted', 'applied'], ['ai.proposal.dismissed', 'dismissed'],
  ] as const) {
    context.events.subscribe<{ proposalId: string; preparationId?: string }>(event, ({ payload }) =>
      context.signals.emit(OPERATION_LOG_STAGE, {
        id: payload.proposalId, phase: 'ai-writeback', state, relatedId: payload.preparationId,
      } satisfies OperationStageUpdate));
  }
  context.commands.register({
    type: 'ai.generation.record',
    validate: isGenerationRecordPayload,
    handle: async (payload) => {
      const prepared = options.requirePreparation(payload.preparationId);
      const session = options.readSessions()[prepared.sessionId];
      if (!session || !prepared.transcriptRevisionAfterUser) throw new Error('AI 对话状态已经变化');
      const transcriptSourceId = sessionTranscriptSourceId(session);
      const append = await planTranscriptAppend(
        context,
        session,
        formatAITranscriptEntry('助手', payload.text, prepared.operation, Date.now()),
        prepared.transcriptRevisionAfterUser,
      );
      const sourceRefs = prepared.sources.map(({ sourceId, title, revision, start, length, reason }) => ({
        sourceId,
        title,
        revision: sourceId === transcriptSourceId ? append.revision : revision,
        start,
        length,
        reason,
      }));
      for (const { sourceId, title, revision, length } of prepared.fullSummary?.sources ?? []) {
        sourceRefs.push({ sourceId, title, revision, start: 0, length, reason: 'explicit-reference' });
      }
      const suggestedTarget = !prepared.outputNodeTitle && payload.finishReason !== 'length' ? await resolveProposalTarget(context, prepared) : undefined;
      const outputNodeTitle = payload.finishReason !== 'length' ? prepared.outputNodeTitle : undefined;
      const proposalId = suggestedTarget || outputNodeTitle ? createId('ai-proposal') : undefined;
      const proposal: AIProposalRecord | undefined = proposalId ? {
        id: proposalId,
        sessionId: session.id,
        operation: prepared.operation,
        text: payload.text,
        provider: payload.provider,
        model: payload.model,
        sourceRefs,
        ...(prepared.taskInstructions?.length ? { taskInstructions: prepared.taskInstructions } : {}),
        status: 'pending',
        createdAt: Date.now(),
        suggestedTarget,
        ...(outputNodeTitle ? { outputNodeTitle } : {}),
      } : undefined;
      const nextSession: AISessionRecord = {
        ...session,
        transcriptRevision: append.revision,
        transcriptLength: append.length,
        transcriptEntries: append.entries,
        revision: session.revision + 1,
        turns: session.turns + 1,
        updatedAt: Date.now(),
      };
      const previous = prepared.previousWritebackProposalId ? options.readProposals()[prepared.previousWritebackProposalId] : undefined;
      const replacePending = proposal && previous?.status === 'pending' && previous.sessionId === session.id;
      const reasoning = payload.reasoning?.trim();
      const citations = collectAIResponseCitations(payload.text, prepared.sources).map((citation) => ({
        ...citation,
        revision: citation.sourceId === transcriptSourceId ? append.revision : citation.revision,
      }));
      const usage = normalizeTokenUsage(payload.usage);
      const retrieval = prepared.retrievalDetails && { mode: prepared.retrievalDetails.mode, attempted: prepared.retrievalDetails.attempted,
        matched: prepared.retrievalDetails.matched, warnings: prepared.retrievalDetails.warnings };
      const responseDetail: AIResponseDetail | undefined = reasoning || citations.length > 0 || usage || retrieval ? {
        id: createId('ai-response-detail'),
        sessionId: session.id,
        turn: nextSession.turns,
        ...(reasoning ? { reasoning } : {}),
        ...(citations.length > 0 ? { citations } : {}),
        ...(usage ? { usage } : {}),
        ...(retrieval ? { retrieval } : {}),
        createdAt: Date.now(),
      } : undefined;
      return {
        result: { proposalId },
        transaction: {
          label: proposal ? '记录 AI 助手消息与正文修改建议' : '记录 AI 助手消息',
          patches: [
            ...append.patches,
            { op: 'set', domain: 'document', namespace: AI_SESSION_NAMESPACE, key: session.id, value: nextSession },
            ...(responseDetail ? [{
              op: 'set' as const,
              domain: 'document' as const,
              namespace: AI_RESPONSE_NAMESPACE,
              key: responseDetail.id,
              value: responseDetail,
            }] : []),
            ...(proposal ? [{
              op: 'set' as const,
              domain: 'document' as const,
              namespace: AI_PROPOSAL_NAMESPACE,
              key: proposal.id,
              value: proposal,
            }] : []),
            ...(replacePending ? [{ op: 'set' as const, domain: 'document' as const, namespace: AI_PROPOSAL_NAMESPACE, key: previous.id, value: { ...previous, status: 'dismissed' as const } }] : []),
          ],
          events: [
            ...(append.events ?? []),
            ...(proposal ? [{
              type: 'ai.proposal.created',
              payload: { proposalId: proposal.id, sessionId: session.id, preparationId: prepared.id },
            }] : []),
          ],
        },
      };
    },
  });
  context.commands.register<AcceptProposalPayload, { nodeId: string }>({
    type: 'ai.proposal.accept',
    validate: isAcceptProposalPayload,
    handle: async (payload) => {
      const proposal = options.readProposals()[payload.proposalId];
      if (!proposal || proposal.status !== 'pending') throw new Error('AI 提案已经不存在或处理完毕');
      await revalidateSourceRefs(context, proposal.sourceRefs);
      if (proposal.outputNodeTitle) {
        if (payload.target) throw new Error('这个结果已指定保存为新节点。');
        const plan = await context.capabilities.request<ContentMutationPlan>('content.createPlan@1', {
          title: proposal.outputNodeTitle, body: proposal.text,
        } satisfies ContentCreatePlanRequest);
        return { result: { nodeId: plan.nodeId }, transaction: {
          label: '将 AI 结果保存为新节点',
          patches: [...plan.patches, { op: 'set', domain: 'document', namespace: AI_PROPOSAL_NAMESPACE, key: proposal.id,
            value: { ...proposal, status: 'accepted', acceptedNodeId: plan.nodeId, acceptedRevision: plan.revision } }],
          events: [...(plan.events ?? []), { type: 'ai.proposal.accepted', payload: { proposalId: proposal.id, nodeId: plan.nodeId } }],
        } };
      }
      const target = payload.target ?? (proposal.suggestedTarget ? {
        mode: proposal.suggestedTarget.mode ?? 'replace' as const,
        nodeId: proposal.suggestedTarget.nodeId,
        expectedRevision: proposal.suggestedTarget.expectedRevision,
        start: proposal.suggestedTarget.range?.start ?? 0,
        end: proposal.suggestedTarget.range?.end ?? proposal.suggestedTarget.length,
      } : undefined);
      if (!target) throw new Error('这条回答没有明确的正文写回目标');
      const bound = proposal.suggestedTarget;
      if (bound?.range && (target.nodeId !== bound.nodeId || target.expectedRevision !== bound.expectedRevision || target.mode !== bound.mode ||
        (target.mode === 'replace' && (target.start !== bound.range.start || target.end !== bound.range.end)))) throw new Error('此提案绑定了原来的正文范围，请重新生成后再修改其他位置');
      const plan = target.mode === 'append'
        ? await context.capabilities.request<ContentMutationPlan>(
            'content.appendPlan@1',
            {
              nodeId: target.nodeId,
              text: proposal.text,
              expectedRevision: target.expectedRevision,
            } satisfies ContentAppendPlanRequest,
          )
        : await context.capabilities.request<ContentMutationPlan>(
            'content.deltaPlan@1',
            {
              nodeId: target.nodeId,
              start: target.start,
              deleteCount: target.end - target.start,
              insert: proposal.text,
              expectedRevision: target.expectedRevision,
            } satisfies ContentDeltaPlanRequest,
          );
      const accepted: AIProposalRecord = {
        ...proposal,
        status: 'accepted',
        acceptedNodeId: plan.nodeId,
        acceptedRevision: plan.revision,
        acceptedTarget: target,
      };
      return {
        result: { nodeId: plan.nodeId },
        transaction: {
          label: target.mode === 'append' ? '接受 AI 提案并追加到节点' : '接受 AI 提案并替换节点正文',
          patches: [
            ...plan.patches,
            { op: 'set', domain: 'document', namespace: AI_PROPOSAL_NAMESPACE, key: proposal.id, value: accepted },
          ],
          events: [
            ...(plan.events ?? []),
            { type: 'ai.proposal.accepted', payload: { proposalId: proposal.id, nodeId: plan.nodeId } },
          ],
        },
      };
    },
  });
  context.commands.register<ProposalIdPayload>({
    type: 'ai.proposal.dismiss',
    validate: isProposalIdPayload,
    handle: (payload) => {
      const proposal = options.readProposals()[payload.proposalId];
      if (!proposal || proposal.status !== 'pending') throw new Error('AI 提案已经不存在或处理完毕');
      return {
        transaction: {
          label: '放弃 AI 提案',
          patches: [{
            op: 'set',
            domain: 'document',
            namespace: AI_PROPOSAL_NAMESPACE,
            key: proposal.id,
            value: { ...proposal, status: 'dismissed' },
          }],
          events: [{ type: 'ai.proposal.dismissed', payload: { proposalId: proposal.id } }],
        },
      };
    },
  });
}

export async function resolveProposalTarget(
  context: PluginContext,
  prepared: AIPreparedContext,
): Promise<NonNullable<AIProposalRecord['suggestedTarget']> | undefined> {
  if (!operationCreatesWriteback(prepared.operation)) return undefined;
  const explicitSources = prepared.sources.filter((source) =>
    source.reason === 'explicit-reference' && source.provider === 'text-node' && source.kind === 'text');
  if (explicitSources.length !== 1) return undefined;
  const selected = explicitSources[0];
  const current = await readContextSource(context, {
    sourceId: selected.sourceId,
    start: 0,
    length: 0,
  });
  if (!current.source || current.source.provider !== 'text-node' || current.source.kind !== 'text') {
    return undefined;
  }
  return {
    nodeId: current.source.sourceId,
    title: current.source.title,
    expectedRevision: selected.revision,
    length: current.source.length,
    ...(prepared.writebackTarget?.nodeId === selected.sourceId ? { range: { start: prepared.writebackTarget.start, end: prepared.writebackTarget.end }, mode: prepared.writebackTarget.mode } : {}),
  };
}
