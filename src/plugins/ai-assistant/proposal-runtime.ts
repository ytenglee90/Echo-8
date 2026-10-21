import { createId, type PluginContext } from '../../core/contracts.ts';
import type {
  AIPreparedContext,
  AIProposalRecord,
  AISessionRecord,
} from '../../protocols/ai.ts';
import type {
  ContentAppendPlanRequest,
  ContentDeltaPlanRequest,
  ContentMutationPlan,
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
      const suggestedTarget = await resolveProposalTarget(context, prepared);
      const proposalId = suggestedTarget ? createId('ai-proposal') : undefined;
      const proposal: AIProposalRecord | undefined = proposalId && suggestedTarget ? {
        id: proposalId,
        sessionId: session.id,
        operation: prepared.operation,
        text: payload.text,
        provider: payload.provider,
        model: payload.model,
        sourceRefs,
        status: 'pending',
        createdAt: Date.now(),
        suggestedTarget,
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
      const reasoning = payload.reasoning?.trim();
      const citations = collectAIResponseCitations(payload.text, prepared.sources).map((citation) => ({
        ...citation,
        revision: citation.sourceId === transcriptSourceId ? append.revision : citation.revision,
      }));
      const responseDetail: AIResponseDetail | undefined = reasoning || citations.length > 0 ? {
        id: createId('ai-response-detail'),
        sessionId: session.id,
        turn: nextSession.turns,
        ...(reasoning ? { reasoning } : {}),
        ...(citations.length > 0 ? { citations } : {}),
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
          ],
          events: [
            ...(append.events ?? []),
            ...(proposal ? [{
              type: 'ai.proposal.created',
              payload: { proposalId: proposal.id, sessionId: session.id },
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
      const target = payload.target ?? (proposal.suggestedTarget ? {
        mode: 'replace' as const,
        nodeId: proposal.suggestedTarget.nodeId,
        expectedRevision: proposal.suggestedTarget.expectedRevision,
        start: 0,
        end: proposal.suggestedTarget.length,
      } : undefined);
      if (!target) throw new Error('这条回答没有明确的正文写回目标');
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
    expectedRevision: current.source.revision,
    length: current.source.length,
  };
}
