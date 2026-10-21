import { createId, type PluginContext } from '../../core/contracts.ts';
import type {
  AIContextSearchContribution,
  AIContextIntent,
  AIContextSource,
  AIProviderCatalog,
  AIMemoryIndexRecord,
  AIPreparedContext,
  AIPreparedSource,
  AISessionRecord,
} from '../../protocols/ai.ts';
import { stripOperationCommands } from './command-parser.ts';
import { classifyAIContextIntent } from './context-intent.ts';
import type { PreparePayload } from './command-payloads.ts';
import {
  readContextCatalog,
  readContextSource,
  readHeadEvidenceBlock,
  readNaturalEvidenceBlock,
  readTailEvidenceBlock,
} from './context-source-reader.ts';
import { estimateAITokens } from './evidence-boundaries.ts';
import { MEMORY_SOURCE_WINDOW } from './memory-indexing.ts';
import { isAbortError } from './runtime-errors.ts';
import {
  detectMemoryConflicts,
  matchConversationMemories,
  mergeContextSearchContributions,
  orderMemoryMatches,
  staleEvidenceStillMatches,
  type MemoryMatch,
} from './memory-retrieval.ts';
import { extractTerms } from './memory-terms.ts';
import { sessionTranscriptSourceId } from './transcript-storage.ts';

export interface AIContextBudget {
  characterLimit: number;
  tokenLimit: number;
  transcriptWindow: number;
  minimumMemoryWindow: number;
}

export const DEFAULT_AI_CONTEXT_BUDGET: Readonly<AIContextBudget> = Object.freeze({
  characterLimit: 12_000,
  tokenLimit: 6_000,
  transcriptWindow: 4_000,
  minimumMemoryWindow: 480,
});

export async function prepareAIContext(
  context: PluginContext,
  session: AISessionRecord,
  memoryIndexes: Record<string, AIMemoryIndexRecord>,
  payload: PreparePayload,
  signal: AbortSignal,
  report: (progress: number) => void,
  budgetOverride?: Readonly<AIContextBudget>,
): Promise<AIPreparedContext> {
  const resolvedBudget = budgetOverride
    ? { budget: budgetOverride, modelContextWindowTokens: undefined }
    : await resolveAIContextBudget(context, payload.providerProfileId, signal);
  const budget = resolvedBudget.budget;
  const contextMode = payload.contextMode ?? 'automatic';
  const selectedMemorySourceIds = [...new Set(payload.memorySourceIds ?? [])];
  const selectedMemorySet = new Set(selectedMemorySourceIds);
  const memoryArtifactOwner = new Map<string, string>();
  for (const memory of Object.values(memoryIndexes)) {
    memoryArtifactOwner.set(memory.sourceId, memory.sourceId);
    if (memory.indexNodeId) memoryArtifactOwner.set(memory.indexNodeId, memory.sourceId);
    if (memory.hubNodeId) memoryArtifactOwner.set(memory.hubNodeId, memory.sourceId);
  }
  const boundReferences = (payload.references ?? []).filter((reference) => payload.prompt.includes(reference.token));
  let unboundPrompt = payload.prompt;
  for (const reference of boundReferences) unboundPrompt = unboundPrompt.replaceAll(reference.token, ' ');
  const explicit = [...new Set([
    ...boundReferences.map((reference) => reference.sourceId),
    ...parseExplicitReferences(unboundPrompt),
  ])];
  const contextIntent: AIContextIntent = classifyAIContextIntent(payload.prompt, payload.operation, {
    hasExplicitSource: explicit.length > 0,
    hasSelectedMemory: selectedMemorySet.size > 0,
  });
  const permitsAutomaticRetrieval = contextMode === 'automatic' && contextIntent !== 'conversation';
  const scopedMemoryIndexes = selectedMemorySet.size > 0
    ? Object.fromEntries(Object.entries(memoryIndexes).filter(([sourceId]) => selectedMemorySet.has(sourceId)))
    : permitsAutomaticRetrieval ? memoryIndexes : {};
  const externalCatalog = await readContextCatalog(context);
  const transcriptSourceId = sessionTranscriptSourceId(session);
  const transcriptMetadata = await readContextSource(
    context,
    { sourceId: transcriptSourceId, start: 0, length: 0 },
    signal,
  );
  const baseCatalog = externalCatalog.some((source) => source.sourceId === transcriptSourceId) ||
    !transcriptMetadata.source
    ? externalCatalog
    : [...externalCatalog, transcriptMetadata.source];
  const memorySources = (await Promise.all(Object.values(scopedMemoryIndexes).map(async (memory) => {
    try {
      return (await readContextSource(
        context,
        { sourceId: memory.sourceId, start: 0, length: 0 },
        signal,
      )).source;
    } catch {
      return undefined;
    }
  }))).filter((source): source is AIContextSource => Boolean(source));
  const catalog = [...new Map([...baseCatalog, ...memorySources]
    .map((source) => [source.sourceId, source])).values()];
  report(0.15);
  const sources: AIPreparedSource[] = [];
  let remainingCharacters = Math.max(0, budget.characterLimit - payload.prompt.length);
  let remainingTokens = Math.max(0, budget.tokenLimit - estimateAITokens(payload.prompt));
  const add = (source: AIPreparedSource) => {
    if (remainingCharacters <= 0 || remainingTokens <= 0 || sources.some((item) =>
      item.sourceId === source.sourceId && Math.abs(item.start - source.start) < 160)) return false;
    const estimatedTokens = estimateAITokens(source.text);
    if (!source.text || source.text.length > remainingCharacters || estimatedTokens > remainingTokens) return false;
    sources.push({ ...source, length: source.text.length, estimatedTokens });
    remainingCharacters -= source.text.length;
    remainingTokens -= estimatedTokens;
    return true;
  };

  for (const reference of explicit) {
    const source = catalog.find((candidate) => candidate.sourceId === reference ||
      candidate.title.toLocaleLowerCase('zh-CN') === reference.toLocaleLowerCase('zh-CN'));
    if (!source) throw new Error(`没有找到 @ 引用：“${reference}”`);
    const block = await readHeadEvidenceBlock(
      context,
      source,
      Math.min(3_500, remainingCharacters),
      remainingTokens,
      signal,
    );
    if (block.text) add({ ...source, ...block, reason: 'explicit-reference' });
  }
  report(0.25);

  const transcriptMeta = catalog.find((source) => source.sourceId === transcriptSourceId);
  if (transcriptMeta?.length) {
    const block = await readTailEvidenceBlock(
      context,
      transcriptMeta,
      Math.min(budget.transcriptWindow, remainingCharacters),
      remainingTokens,
      signal,
    );
    if (block.text) add({ ...transcriptMeta, ...block, reason: 'recent-conversation' });
  }

  const memoryMatchSet = matchConversationMemories(payload.prompt, scopedMemoryIndexes, selectedMemorySet);
  const memoryMatches = memoryMatchSet.matches;
  const memoryIssues: NonNullable<AIPreparedContext['memoryIssues']> = [];
  const usableMemoryMatches: MemoryMatch[] = [];
  const staleMemoryMatches: MemoryMatch[] = [];
  for (const match of memoryMatches) {
    const source = catalog.find((candidate) => candidate.sourceId === match.index.sourceId);
    const reason = !source
      ? 'source-missing'
      : match.index.schemaVersion === 2 && source.revision !== match.index.sourceRevision
        ? 'source-revision-changed'
        : undefined;
    if (!reason) {
      usableMemoryMatches.push(match);
      continue;
    }
    memoryIssues.push({
      sourceId: match.index.sourceId,
      title: match.index.title,
      reason,
      ...(reason === 'source-revision-changed' ? { recovery: 'rebuild-pending' as const } : {}),
    });
    if (reason === 'source-revision-changed' && source) staleMemoryMatches.push(match);
  }
  const memoryConflicts = detectMemoryConflicts(
    usableMemoryMatches.map((match) => match.index),
    payload.prompt,
  );
  const evidenceMatches = orderMemoryMatches(
    [...usableMemoryMatches, ...staleMemoryMatches],
    new Set<number>(),
  );
  const evidenceCoveredBranches = new Set<number>();
  let incompleteBlocksSkipped = 0;
  const staleCandidatesRecovered = new Set<string>();
  for (let anchorPass = 0; anchorPass < 2; anchorPass += 1) {
    const ordered = orderMemoryMatches(evidenceMatches, evidenceCoveredBranches);
    for (const match of ordered) {
      if (remainingCharacters < 80 || remainingTokens < 24) break;
      const source = catalog.find((candidate) => candidate.sourceId === match.index.sourceId);
      if (!source) continue;
      const explicitlySelected = selectedMemorySet.has(match.index.sourceId);
      const selectedWithoutLexicalAnchor = explicitlySelected && match.anchorStarts.length === 0;
      const anchorStarts = match.anchorStarts.length > 0
        ? match.anchorStarts
        : [explicitlySelected ? Math.max(0, source.length - 1) : 0];
      const anchorStart = anchorStarts[anchorPass];
      if (anchorStart === undefined) continue;
      const maxLength = Math.min(
        selectedWithoutLexicalAnchor && selectedMemorySet.size === 1
          ? budget.transcriptWindow
          : MEMORY_SOURCE_WINDOW,
        remainingCharacters,
      );
      const block = selectedWithoutLexicalAnchor
        ? await readTailEvidenceBlock(context, source, maxLength, remainingTokens, signal)
        : await readNaturalEvidenceBlock(
            context,
            source,
            anchorStart,
            maxLength,
            remainingTokens,
            signal,
          );
      if (!block.text) continue;
      if (!block.complete) {
        incompleteBlocksSkipped += 1;
        continue;
      }
      const stale = source.revision !== match.index.sourceRevision;
      if (stale && !explicitlySelected && !staleEvidenceStillMatches(block.text, match, payload.prompt)) continue;
      const added = add({
        ...source,
        ...block,
        reason: 'conversation-memory',
        ...(stale ? { staleIndexRevision: match.index.sourceRevision } : {}),
      });
      if (!added) continue;
      for (const branchIndex of match.coveredBranches) evidenceCoveredBranches.add(branchIndex);
      if (stale) {
        staleCandidatesRecovered.add(match.index.sourceId);
        const issue = memoryIssues.find((item) =>
          item.sourceId === match.index.sourceId && item.reason === 'source-revision-changed');
        if (issue) issue.recovery = 'current-source-verified';
      }
    }
  }
  report(0.5);

  const terms = extractTerms(payload.prompt);
  if (permitsAutomaticRetrieval && remainingCharacters > 0 && remainingTokens > 0 && terms.length > 0) {
    try {
      let contributions: AIContextSearchContribution[] = [];
      try {
        contributions = await context.capabilities.requestAll<AIContextSearchContribution>(
          'context.search@3',
          { terms, query: stripOperationCommands(payload.prompt), maxResults: 12 },
          signal,
        );
      } catch (error) {
        if (isAbortError(error)) throw error;
        context.diagnostics.warn('混合检索暂不可用，回退到旧版索引', error);
      }
      if (contributions.length === 0) {
        try {
          contributions = await context.capabilities.requestAll<AIContextSearchContribution>(
            'context.search@2',
            { terms, query: stripOperationCommands(payload.prompt), maxResults: 12 },
            signal,
          );
        } catch (error) {
          if (isAbortError(error)) throw error;
          context.diagnostics.warn('索引检索暂不可用，回退到内容提供者检索', error);
        }
      }
      if (contributions.length === 0) {
        contributions = await context.capabilities.requestAll<AIContextSearchContribution>(
          'context.search@1',
          { terms, maxResults: 12 },
          signal,
        );
      }
      let semantic: AIContextSearchContribution[] = [];
      try {
        semantic = await context.capabilities.requestAll<AIContextSearchContribution>(
          'context.semanticSearch@1',
          { terms, query: stripOperationCommands(payload.prompt), maxResults: 12 },
          signal,
        );
      } catch (error) {
        if (isAbortError(error)) throw error;
        context.diagnostics.warn('远程语义检索暂不可用，继续使用本地 BM25 结果', error);
      }
      const hits = mergeContextSearchContributions([...contributions, ...semantic]);
      for (const hit of hits) {
        const memoryOwner = memoryArtifactOwner.get(hit.source.sourceId);
        if (selectedMemorySet.size > 0 && memoryOwner && !selectedMemorySet.has(memoryOwner)) continue;
        if (sources.some((source) => source.sourceId === hit.source.sourceId) ||
          remainingCharacters <= 0 || remainingTokens <= 0) continue;
        const block = await readNaturalEvidenceBlock(
          context,
          hit.source,
          hit.start,
          Math.min(1_500, remainingCharacters),
          remainingTokens,
          signal,
        );
        if (block.text && block.complete) add({ ...hit.source, ...block, reason: 'keyword-match' });
        else if (block.text) incompleteBlocksSkipped += 1;
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      context.diagnostics.warn('可选的 AI 关键词检索不可用', error);
    }
  }
  report(1);
  const createdAt = Date.now();
  const evidenceMemoryIds = new Set(sources
    .filter((source) => source.reason === 'conversation-memory' || selectedMemorySet.has(source.sourceId))
    .map((source) => source.sourceId));
  const deferredMemories = Math.max(0, evidenceMatches.length - evidenceMemoryIds.size);
  const totalCharacters = payload.prompt.length + sources.reduce((total, source) => total + source.text.length, 0);
  const estimatedTokens = estimateAITokens(payload.prompt) +
    sources.reduce((total, source) => total + (source.estimatedTokens ?? estimateAITokens(source.text)), 0);
  const unresolvedConflictCount = memoryConflicts.filter((conflict) => conflict.resolution === 'unresolved').length;
  const changesMemoryState = /(^|[\s，。！？、；：,.!?;:])@(确认|修改|废弃|分支)(?=\s|$|[，。！？、；：,.!?;:])/u
    .test(payload.prompt);
  const review = unresolvedConflictCount > 0
    ? {
        reason: 'unresolved-memory-conflict' as const,
        message: `发现 ${unresolvedConflictCount} 项尚未解决的历史信息冲突，请确认后继续`,
      }
    : changesMemoryState
      ? {
          reason: 'memory-state-change' as const,
          message: '本次要求会确认或改变历史信息状态，请确认后继续',
        }
      : undefined;
  return {
    id: createId('ai-context'),
    sessionId: session.id,
    ...(payload.assistantId ? { assistantId: payload.assistantId } : {}),
    prompt: payload.prompt,
    operation: payload.operation,
    ...(payload.providerProfileId ? { providerProfileId: payload.providerProfileId } : {}),
    ...(payload.webSearchEnabled ? { webSearchEnabled: true } : {}),
    ...(payload.promptTemplateId ? { promptTemplateId: payload.promptTemplateId } : {}),
    ...(selectedMemorySourceIds.length > 0 ? { selectedMemorySourceIds } : {}),
    ...(contextMode === 'explicit-only' ? { contextMode } : {}),
    ...(contextIntent === 'conversation' ? { contextIntent } : {}),
    createdAt,
    expiresAt: createdAt + 10 * 60_000,
    totalCharacters,
    estimatedTokens,
    contextBudget: {
      ...(resolvedBudget.modelContextWindowTokens
        ? { modelContextWindowTokens: resolvedBudget.modelContextWindowTokens }
        : {}),
      evidenceTokenLimit: budget.tokenLimit,
      evidenceCharacterLimit: budget.characterLimit,
    },
    sources,
    memoryConflicts,
    memoryIssues,
    ...(review ? { review } : {}),
    memoryRetrieval: {
      ...memoryMatchSet.report,
      usableCandidates: evidenceMatches.length,
      evidenceMemories: evidenceMemoryIds.size,
      deferredMemories,
      contextBudgetExhausted: deferredMemories > 0 &&
        (remainingCharacters < budget.minimumMemoryWindow || remainingTokens < 160),
      evidenceCoveredBranches: evidenceCoveredBranches.size,
      incompleteBlocksSkipped,
      staleCandidates: staleMemoryMatches.length,
      staleCandidatesRecovered: staleCandidatesRecovered.size,
    },
  };
}

export function deriveAIContextBudget(contextWindowTokens?: number): Readonly<AIContextBudget> {
  if (!Number.isInteger(contextWindowTokens) || (contextWindowTokens ?? 0) < 4_000) {
    return DEFAULT_AI_CONTEXT_BUDGET;
  }
  const tokenLimit = clamp(Math.floor(contextWindowTokens! * 0.375), 1_500, 36_000);
  const characterLimit = tokenLimit * 2;
  return Object.freeze({
    tokenLimit,
    characterLimit,
    transcriptWindow: clamp(Math.floor(characterLimit / 3), 1_600, 12_000),
    minimumMemoryWindow: clamp(Math.floor(characterLimit * 0.04), 240, 1_200),
  });
}

async function resolveAIContextBudget(
  context: PluginContext,
  profileId: string | undefined,
  signal: AbortSignal,
): Promise<{ budget: Readonly<AIContextBudget>; modelContextWindowTokens?: number }> {
  try {
    const catalog = await context.capabilities.request<AIProviderCatalog>(
      'ai.provider.catalog@1',
      undefined,
      signal,
    );
    const option = catalog.options.find((candidate) => candidate.id === profileId) ??
      catalog.options.find((candidate) => candidate.id === catalog.activeId) ?? catalog.options[0];
    return {
      budget: deriveAIContextBudget(option?.contextWindowTokens),
      modelContextWindowTokens: option?.contextWindowTokens,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { budget: DEFAULT_AI_CONTEXT_BUDGET };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function parseExplicitReferences(prompt: string): string[] {
  const linkedPattern = /@\[[^\]\r\n]{1,120}\]\((node:[a-z0-9:-]+)\)/giu;
  const linkedIds = [...prompt.matchAll(linkedPattern)].map((match) => match[1]);
  const withoutLinkedReferences = prompt.replace(linkedPattern, ' ');
  const bracketed = [...withoutLinkedReferences.matchAll(/@\[([^\]\r\n]{1,120})\]/gu)]
    .map((match) => match[1].trim());
  const ids = [...withoutLinkedReferences.matchAll(/@(node:[a-z0-9:-]+)/giu)].map((match) => match[1]);
  return [...new Set([...linkedIds, ...bracketed, ...ids])];
}
