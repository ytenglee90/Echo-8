import type {
  AIContextSource,
  AIProposalRecord,
  AIProposalTarget,
} from '../../protocols/ai.ts';

export type AIWritebackMode = 'replace' | 'append';

/**
 * Resolves the current revision immediately before the parent dispatches the
 * formal accept command. The command handler still performs the authoritative
 * stale-revision validation.
 */
export function resolveAIWritebackTarget(
  proposal: AIProposalRecord,
  sources: readonly AIContextSource[],
  mode: AIWritebackMode,
  nodeId: string,
): AIProposalTarget | undefined {
  const source = sources.find((item) => item.sourceId === nodeId) ??
    (proposal.suggestedTarget?.nodeId === nodeId ? {
      sourceId: proposal.suggestedTarget.nodeId,
      revision: proposal.suggestedTarget.expectedRevision,
      length: proposal.suggestedTarget.length,
    } : undefined);
  if (!source) return undefined;
  return mode === 'append'
    ? { mode: 'append', nodeId: source.sourceId, expectedRevision: source.revision }
    : {
        mode: 'replace',
        nodeId: source.sourceId,
        expectedRevision: source.revision,
        start: 0,
        end: source.length,
      };
}
