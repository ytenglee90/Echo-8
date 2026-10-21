import type { PluginContext } from '../../core/contracts.ts';
import type {
  AIContextSearchContribution,
  AIMemoryCatalogSnapshot,
  AIMemoryClaimRecord,
  AIMemoryConflict,
  AIMemoryIndexRecord,
  AIMemoryRetrievalReport,
} from '../../protocols/ai.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import { stripOperationCommands } from './command-parser.ts';
import { expandMemoryClaimRelations } from './memory-claim-graph.ts';
import { MEMORY_STOP_TERMS, memoryTermOccurrences } from './memory-terms.ts';

const MEMORY_RETRIEVAL_BATCH_SIZE = 10;
const MAX_MEMORY_INDEX_CANDIDATES = 50;

export interface MemoryMatch {
  index: AIMemoryIndexRecord;
  score: number;
  anchorStarts: number[];
  coveredBranches: number[];
}

interface MemoryMatchSet {
  matches: MemoryMatch[];
  report: Omit<AIMemoryRetrievalReport,
    'usableCandidates' | 'evidenceMemories' | 'deferredMemories' | 'contextBudgetExhausted'>;
}

export function matchConversationMemories(
  prompt: string,
  memoryIndexes: Record<string, AIMemoryIndexRecord>,
  forcedSourceIds: ReadonlySet<string> = new Set(),
): MemoryMatchSet {
  const cleanPrompt = stripOperationCommands(prompt)
    .replace(/@\[[^\]]+\](?:\([^)]+\))?/gu, ' ')
    .replace(/@(node:[a-z0-9:-]+)/giu, ' ');
  const branches = memoryQueryBranches(cleanPrompt);
  const relationshipExpansion = expandMemoryClaimRelations(branches, Object.values(memoryIndexes));
  const exhaustiveRequested = /(?:全部|所有|完整|全面|综合|彻底|逐一|无遗漏|尽可能全|every|all|complete)/iu.test(cleanPrompt);
  const emptyReport = {
    mode: 'batched-index-coverage' as const,
    batchSize: MEMORY_RETRIEVAL_BATCH_SIZE,
    batchesScanned: 0,
    candidateLimit: MAX_MEMORY_INDEX_CANDIDATES,
    candidatesMatched: 0,
    queryBranches: branches.length,
    coveredBranches: 0,
    exhaustiveRequested,
    relationshipSources: relationshipExpansion.relatedSources,
    relationshipEvidence: relationshipExpansion.evidenceCount,
  };
  if (branches.length === 0 && forcedSourceIds.size === 0) return { matches: [], report: emptyReport };
  const candidates: MemoryMatch[] = Object.values(memoryIndexes)
    .filter((index) => index.enabled !== false)
    .flatMap((index) => {
      const forced = forcedSourceIds.has(index.sourceId);
      const keywords = new Set(index.keywords);
      const summary = index.summary.toLocaleLowerCase('zh-CN');
      const relationship = relationshipExpansion.matches.get(index.sourceId);
      let score = 0;
      const coveredBranches: number[] = [];
      const anchorStarts: number[] = [];
      const addAnchor = (start: number) => {
        if (anchorStarts.length < 4 && anchorStarts.every((existing) => Math.abs(existing - start) > 320)) {
          anchorStarts.push(start);
        }
      };
      for (let branchIndex = 0; branchIndex < branches.length; branchIndex += 1) {
        let branchScore = 0;
        const formalClaim = strongestFormalClaimMatch(index, branches[branchIndex]);
        if (formalClaim) {
          // Directives are user-confirmed facts, so a matching directive is a
          // stronger retrieval signal than an automatically generated summary.
          branchScore += 12 + formalClaim.matchedTerms.length * 3;
          addAnchor(formalClaim.claim.start);
        }
        const relationshipEvidence = relationship?.evidence.filter((item) => item.branchIndex === branchIndex) ?? [];
        if (relationshipEvidence.length > 0) {
          // The connection itself is only a retrieval hint. The reader below
          // still obtains the complete original source around this exact claim.
          branchScore += Math.min(10, relationshipEvidence.reduce((total, item) =>
            total + relationScore(item.kind), 0));
          for (const relation of relationshipEvidence) addAnchor(relation.start);
        }
        for (const term of branches[branchIndex]) {
          const anchors = index.anchors.filter((item) => item.term === term);
          if (keywords.has(term)) branchScore += 5;
          else if (summary.includes(term)) branchScore += 1;
          for (const anchor of anchors) {
            addAnchor(anchor.start);
          }
        }
        if (branchScore > 0) {
          coveredBranches.push(branchIndex);
          score += branchScore + 2;
        }
      }
      if (index.scope && cleanPrompt.toLocaleLowerCase('zh-CN').includes(index.scope.toLocaleLowerCase('zh-CN'))) {
        score += 8;
      }
      return score > 0 || forced
        ? [{ index, score: score + (forced ? 100 : 0), anchorStarts, coveredBranches }]
        : [];
    }).sort((left, right) => right.score - left.score || right.index.createdAt - left.index.createdAt);

  const selected = new Map<string, MemoryMatch>();
  const covered = new Set<number>();
  const candidatePool = candidates.slice(0, MAX_MEMORY_INDEX_CANDIDATES);
  let batchesScanned = 0;
  for (let offset = 0; offset < candidatePool.length; offset += MEMORY_RETRIEVAL_BATCH_SIZE) {
    const batch = candidatePool.slice(offset, offset + MEMORY_RETRIEVAL_BATCH_SIZE);
    batchesScanned += 1;
    for (let branchIndex = 0; branchIndex < branches.length; branchIndex += 1) {
      if (covered.has(branchIndex)) continue;
      const best = batch.find((candidate) => candidate.coveredBranches.includes(branchIndex));
      if (best) selected.set(best.index.sourceId, best);
    }
    for (const candidate of batch) selected.set(candidate.index.sourceId, candidate);
    for (const candidate of selected.values()) {
      for (const branchIndex of candidate.coveredBranches) covered.add(branchIndex);
    }
    if (!exhaustiveRequested && covered.size >= branches.length) break;
  }
  const matches = [...selected.values()].sort((left, right) =>
    right.coveredBranches.length - left.coveredBranches.length ||
    right.score - left.score || right.index.createdAt - left.index.createdAt);
  return {
    matches,
    report: {
      ...emptyReport,
      batchesScanned,
      candidatesMatched: candidates.length,
      coveredBranches: covered.size,
    },
  };
}

function relationScore(kind: 'same-scope' | 'same-subject' | 'same-value'): number {
  if (kind === 'same-subject') return 7;
  if (kind === 'same-value') return 6;
  return 5;
}

function strongestFormalClaimMatch(
  index: AIMemoryIndexRecord,
  branchTerms: string[],
): { claim: AIMemoryClaimRecord; matchedTerms: string[] } | undefined {
  let strongest: { claim: AIMemoryClaimRecord; matchedTerms: string[] } | undefined;
  for (const claim of index.claims ?? []) {
    // The AI candidate pipeline is deliberately excluded even if an imported
    // legacy index happens to contain a candidate-shaped record.
    if (claim.authority !== 'user-explicit' || claim.status === 'candidate') continue;
    const searchable = [
      claim.subject,
      claim.value,
      claim.previousValue,
      claim.scope ?? index.scope,
    ].filter((value): value is string => Boolean(value)).join(' ');
    const claimTerms = new Set(memoryTermOccurrences(searchable).map((item) => item.term));
    const matchedTerms = branchTerms.filter((term) => claimTerms.has(term));
    if (matchedTerms.length === 0) continue;
    if (!strongest || matchedTerms.length > strongest.matchedTerms.length ||
      (matchedTerms.length === strongest.matchedTerms.length && claim.kind === 'modify' && strongest.claim.kind !== 'modify')) {
      strongest = { claim, matchedTerms };
    }
  }
  return strongest;
}

export function memoryQueryBranches(prompt: string): string[][] {
  const rawBranches = prompt.split(/(?:[，。、；！？\n]|以及|并且|同时|结合|还有|或者|\band\b)/giu);
  const branches = rawBranches.map((branch) => [...new Set(
    memoryTermOccurrences(branch).map((occurrence) => occurrence.term),
  )].filter((term) => !MEMORY_STOP_TERMS.has(term)).slice(0, 16)).filter((branch) => branch.length > 0);
  if (branches.length > 0) return branches.slice(0, 12);
  const fallback = [...new Set(memoryTermOccurrences(prompt).map((occurrence) => occurrence.term))]
    .filter((term) => !MEMORY_STOP_TERMS.has(term)).slice(0, 48);
  return fallback.length > 0 ? [fallback] : [];
}

export function orderMemoryMatches(matches: MemoryMatch[], covered: Set<number>): MemoryMatch[] {
  return [...matches].sort((left, right) => {
    const leftNewCoverage = left.coveredBranches.filter((branch) => !covered.has(branch)).length;
    const rightNewCoverage = right.coveredBranches.filter((branch) => !covered.has(branch)).length;
    return rightNewCoverage - leftNewCoverage ||
      memoryAuthorityScore(right.index) - memoryAuthorityScore(left.index) ||
      right.coveredBranches.length - left.coveredBranches.length ||
      right.score - left.score ||
      right.index.createdAt - left.index.createdAt;
  });
}

export function staleEvidenceStillMatches(text: string, match: MemoryMatch, prompt: string): boolean {
  const evidenceTerms = new Set(memoryTermOccurrences(text).map((item) => item.term));
  const queryTerms = memoryQueryBranches(prompt).flat();
  if (queryTerms.some((term) => evidenceTerms.has(term))) return true;
  return match.index.anchors.some((anchor) => evidenceTerms.has(anchor.term));
}

export function mergeContextSearchContributions(
  contributions: AIContextSearchContribution[],
): AIContextSearchContribution['hits'] {
  const merged = new Map<string, {
    hit: AIContextSearchContribution['hits'][number];
    rankScore: number;
    methods: Set<string>;
  }>();
  for (const contribution of contributions) {
    const ordered = [...contribution.hits].sort((left, right) => right.score - left.score);
    ordered.forEach((hit, rank) => {
      const key = hit.source.sourceId;
      const existing = merged.get(key);
      const rankScore = 1 / (60 + rank + 1);
      if (!existing) {
        merged.set(key, {
          hit,
          rankScore,
          methods: new Set([hit.retrievalMethod ?? contribution.provider]),
        });
        return;
      }
      existing.rankScore += rankScore;
      existing.methods.add(hit.retrievalMethod ?? contribution.provider);
      if (hit.score > existing.hit.score) existing.hit = hit;
    });
  }
  return [...merged.values()]
    .map(({ hit, rankScore, methods }) => ({
      ...hit,
      score: rankScore * 1_000 + Math.log1p(Math.max(0, hit.score)),
      retrievalMethod: methods.size > 1 ? 'hybrid' as const : hit.retrievalMethod,
    }))
    .sort((left, right) => right.score - left.score || left.source.title.localeCompare(right.source.title, 'zh-CN'));
}

export function detectMemoryConflicts(
  indexes: AIMemoryIndexRecord[],
  prompt: string,
): AIMemoryConflict[] {
  const promptTerms = new Set(memoryTermOccurrences(prompt).map((item) => item.term));
  const grouped = new Map<string, Array<{
    index: AIMemoryIndexRecord;
    claim: AIMemoryClaimRecord;
    insertionOrder: number;
  }>>();
  let insertionOrder = 0;
  for (const index of indexes) {
    for (const claim of index.claims ?? []) {
      const effectiveScope = claim.scope ?? index.scope;
      const searchable = `${claim.subject} ${claim.value ?? ''} ${claim.previousValue ?? ''} ${effectiveScope ?? ''}`;
      const relevant = promptTerms.size === 0 ||
        memoryTermOccurrences(searchable).some((item) => promptTerms.has(item.term));
      if (!relevant) continue;
      const key = `${normalizeConflictScope(effectiveScope)}::${normalizeConflictKey(claim.subject)}`;
      const group = grouped.get(key) ?? [];
      group.push({ index, claim, insertionOrder });
      insertionOrder += 1;
      grouped.set(key, group);
    }
  }

  const conflicts: AIMemoryConflict[] = [];
  for (const [key, records] of grouped) {
    const ordered = [...records].sort((left, right) =>
      (left.index.createdAt - right.index.createdAt) ||
      ((left.claim.sequence ?? left.claim.start) - (right.claim.sequence ?? right.claim.start)) ||
      (left.insertionOrder - right.insertionOrder));
    const values = [...new Set(records.flatMap(({ claim }) => [claim.value, claim.previousValue])
      .filter((value): value is string => Boolean(value)).map(normalizeConflictValue))];
    if (values.length < 2) continue;
    const activeValues = new Map<string, string>();
    let hasResolutionDirective = false;
    for (const { claim } of ordered) {
      const value = claim.value ? normalizeConflictValue(claim.value) : '';
      if (claim.kind === 'deprecate' || claim.status === 'deprecated') {
        hasResolutionDirective = true;
        if (value) activeValues.delete(value);
        else activeValues.clear();
        continue;
      }
      if (claim.kind === 'modify') {
        hasResolutionDirective = true;
        if (claim.previousValue) activeValues.delete(normalizeConflictValue(claim.previousValue));
      }
      if (value) activeValues.set(value, claim.value!);
    }
    const currentValues = [...activeValues.keys()];
    const resolved = currentValues.length <= 1 && hasResolutionDirective;
    conflicts.push({
      key,
      subject: ordered[0].claim.subject,
      scope: ordered[0].claim.scope ?? ordered[0].index.scope,
      resolution: resolved ? 'resolved-by-explicit-modification' : 'unresolved',
      currentValue: resolved && currentValues[0] ? activeValues.get(currentValues[0]) : undefined,
      evidence: ordered.flatMap(({ index, claim }) => claim.value ? [{
        claimId: claim.id,
        sourceId: index.sourceId,
        title: index.title,
        value: claim.value,
        status: claim.status,
        start: claim.start,
        length: claim.length,
        createdAt: index.createdAt,
        effectiveStatus: claim.kind === 'deprecate' || claim.status === 'deprecated'
          ? 'deprecated' as const
          : activeValues.has(normalizeConflictValue(claim.value))
            ? currentValues.length > 1 ? 'competing' as const : 'current' as const
            : 'superseded' as const,
      }] : []),
    });
  }
  return conflicts.sort((left, right) =>
    Number(left.resolution === 'resolved-by-explicit-modification') -
    Number(right.resolution === 'resolved-by-explicit-modification'));
}

export async function buildMemoryCatalog(
  context: PluginContext,
  indexes: Record<string, AIMemoryIndexRecord>,
): Promise<AIMemoryCatalogSnapshot> {
  const nodeIds = Object.values(indexes)
    .flatMap((memory) => [memory.sourceId, memory.indexNodeId].filter(Boolean) as string[]);
  const summaries = nodeIds.length > 0
    ? await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds })
    : [];
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const entries = Object.values(indexes)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((memory) => {
      const source = byId.get(memory.sourceId);
      const indexNodeId = memory.indexNodeId;
      const status = !source
          ? 'source-missing' as const
          : memory.schemaVersion === 2 && source.revision !== memory.sourceRevision
            ? 'source-revision-changed' as const
            : memory.schemaVersion === 2 && !indexNodeId
              ? 'index-node-missing' as const
              : memory.schemaVersion === 2 && indexNodeId !== undefined && !byId.has(indexNodeId)
                ? 'index-node-missing' as const
                : memory.enabled === false ? 'paused' as const : 'ready' as const;
      return { memory, status };
    });
  return {
    entries,
    conflicts: detectMemoryConflicts(entries
      .filter((entry) => entry.status === 'ready')
      .map((entry) => entry.memory), ''),
    counts: {
      total: entries.length,
      ready: entries.filter((entry) => entry.status === 'ready').length,
      paused: entries.filter((entry) => entry.status === 'paused').length,
      attention: entries.filter((entry) => !['ready', 'paused'].includes(entry.status)).length,
    },
  };
}

function memoryAuthorityScore(index: AIMemoryIndexRecord): number {
  return (index.claims ?? []).reduce((score, claim) => {
    if (claim.status === 'deprecated' || claim.kind === 'deprecate') return score;
    if (claim.kind === 'modify') return score + 5;
    if (claim.kind === 'confirm') return score + 4;
    if (claim.kind === 'branch') return score + 3;
    return score + 1;
  }, 0);
}

function normalizeConflictKey(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeConflictScope(scope: string | undefined): string {
  if (!scope?.trim()) return '默认';
  const dimensions = scope
    .split(/[，,；;]+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.{1,40}?)[=:：]\s*(.{1,80})$/u);
      if (!match) return normalizeConflictKey(part);
      return `${normalizeConflictKey(match[1])}=${normalizeConflictKey(match[2])}`;
    })
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  return dimensions.join(';') || '默认';
}

function normalizeConflictValue(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim();
}
