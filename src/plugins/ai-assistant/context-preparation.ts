import { createId, type PluginContext } from '../../core/contracts.ts';
import type {
  AIContextSearchContribution,
  AIContextIntent,
  AIContextSource,
  AIProviderCatalog,
  AIMemoryIndexRecord,
  AIProposalRecord,
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
import { isAbortError, isCapabilityUnavailable } from './runtime-errors.ts';
import type { SemanticRetrievalResult } from '../../protocols/retrieval.ts';
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
import { canvasCommandText, canvasControlPurpose, naturalCanvasOperation, needsCanvasSearchInterpretation } from '../../services/ai-task-route.ts';
import { readParagraphTarget } from './paragraph-target.ts';
import { operationCreatesWriteback } from './operations.ts';
import { bindNaturalWriteback, naturalWritebackIntent, readBoundWriteback, writebackTaskInstructions } from './natural-writeback.ts';
import { naturalMemoryDirective } from './memory-suggestion.ts';
import { bindNaturalSourceScope, naturalResultDestination } from './natural-source-scope.ts';
import { planFullSourceSummary } from './full-source-summary.ts';

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
  previousProposal?: AIProposalRecord,
  preparationId = createId('ai-context'),
): Promise<AIPreparedContext> {
  const localMemoryDirective = naturalMemoryDirective(payload.prompt);
  if (localMemoryDirective) {
    const createdAt = Date.now();
    report(1);
    return {
      id: preparationId, sessionId: session.id, assistantId: payload.assistantId, prompt: payload.prompt,
      operation: 'general', contextMode: 'explicit-only', sources: [], totalCharacters: payload.prompt.length, estimatedTokens: 0,
      createdAt, expiresAt: createdAt + 10 * 60_000, localMemoryDirective,
      review: { reason: 'memory-state-change', message: '确认后将这条变更记入当前对话的正式记忆。' },
    };
  }
  const contentTarget = payload.operation === 'canvas-control' && naturalCanvasOperation(payload.prompt)?.kind === 'content';
  const contentBinding = contentTarget ? await context.capabilities.request<{ ids: string[]; needsChoice: boolean }>('canvasControl.bindContent@1', {
    preparationId, sessionId: session.id, prompt: payload.prompt,
    sourceIds: payload.references?.filter(reference => payload.prompt.includes(reference.token)).map(reference => reference.sourceId),
  }, signal) : undefined;
  if (payload.operation === 'canvas-control' && (!contentTarget || contentBinding?.needsChoice) && (naturalCanvasOperation(payload.prompt) || needsCanvasSearchInterpretation(payload.prompt)) && !payload.references?.length && !parseExplicitReferences(payload.prompt).length) {
    const createdAt = Date.now();
    report(1);
    return { id: preparationId, sessionId: session.id, assistantId: payload.assistantId, prompt: payload.prompt,
      operation: 'canvas-control', providerProfileId: payload.providerProfileId, contextMode: 'explicit-only', sources: [], totalCharacters: payload.prompt.length,
      estimatedTokens: 0, createdAt, expiresAt: createdAt + 10 * 60_000 };
  }
  const resolvedBudget = budgetOverride
    ? { budget: budgetOverride, modelContextWindowTokens: undefined }
    : await resolveAIContextBudget(context, payload.providerProfileId, signal);
  const budget = resolvedBudget.budget;
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
    ...(contentBinding?.ids ?? []),
  ])];
  const destination = naturalResultDestination(canvasCommandText(stripOperationCommands(payload.prompt)), payload.operation);
  const command = destination.input;
  const editIntent = operationCreatesWriteback(payload.operation) ? naturalWritebackIntent(command.trim()) : undefined;
  const conversationalFollowup = editIntent?.kind === 'followup' && (!previousProposal?.suggestedTarget?.range || previousProposal.status === 'dismissed');
  const naturalEdit = conversationalFollowup ? undefined : editIntent;
  const externalCatalog = await readContextCatalog(context);
  const naturalScope = explicit.length || naturalEdit ? undefined : await bindNaturalSourceScope(context, command, payload.operation, externalCatalog, signal);
  explicit.push(...(naturalScope?.ids ?? []));
  const fullSummary = payload.operation === 'summarize' && explicit.length > 0 && (naturalScope?.group || /全文|完整总结|逐段汇总/u.test(command))
    ? planFullSourceSummary(explicit, externalCatalog, budget)
    : undefined;
  const paragraph = /(?:改写|修改|重写|润色)[\s\S]{0,30}?第\s*(\d+)\s*段/u.exec(command) ?? /第\s*(\d+)\s*段[\s\S]{0,30}?(?:改写|修改|重写|润色)/u.exec(command);
  const continuation = /续写|接着写|继续写|从末尾/u.test(command);
  const boundedEdit = (naturalEdit || (explicit.length === 1 && (paragraph || continuation) && operationCreatesWriteback(payload.operation))) &&
    !selectedMemorySet.size && !/历史|上次|之前|结合|参考|查找/u.test(command);
  const contextMode = payload.operation === 'canvas-control' || boundedEdit || fullSummary || conversationalFollowup || (naturalScope?.ids.length && !/历史|之前|记忆/u.test(command))
    ? 'explicit-only' : payload.contextMode ?? 'automatic';
  const contextIntent: AIContextIntent = classifyAIContextIntent(payload.prompt, payload.operation, {
    hasExplicitSource: explicit.length > 0,
    hasSelectedMemory: selectedMemorySet.size > 0,
  });
  const permitsAutomaticRetrieval = contextMode === 'automatic' && contextIntent !== 'conversation';
  const scopedMemoryIndexes = selectedMemorySet.size > 0
    ? Object.fromEntries(Object.entries(memoryIndexes).filter(([sourceId]) => selectedMemorySet.has(sourceId)))
    : permitsAutomaticRetrieval ? memoryIndexes : {};
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
  let writebackTarget: AIPreparedContext['writebackTarget'];
  let remainingCharacters = Math.max(0, budget.characterLimit - payload.prompt.length);
  let remainingTokens = Math.max(0, budget.tokenLimit - estimateAITokens(payload.prompt));
  const add = (source: AIPreparedSource) => {
    const existingIndex = sources.findIndex(item => item.sourceId === source.sourceId && item.revision === source.revision &&
      item.start <= source.start + source.text.length && source.start <= item.start + item.text.length);
    if (existingIndex >= 0) {
      const previous = sources[existingIndex]!;
      const overlapStart = Math.max(previous.start, source.start);
      const overlapEnd = Math.min(previous.start + previous.text.length, source.start + source.text.length);
      if (previous.text.slice(overlapStart - previous.start, overlapEnd - previous.start) !==
        source.text.slice(overlapStart - source.start, overlapEnd - source.start)) return false;
      const first = previous.start <= source.start ? previous : source;
      const last = previous.start + previous.text.length >= source.start + source.text.length ? previous : source;
      const text = first.text + last.text.slice(Math.max(0, first.start + first.text.length - last.start));
      const addedCharacters = text.length - previous.text.length;
      const estimatedTokens = estimateAITokens(text);
      const addedTokens = estimatedTokens - (previous.estimatedTokens ?? estimateAITokens(previous.text));
      if (addedCharacters > remainingCharacters || addedTokens > remainingTokens) return false;
      sources[existingIndex] = { ...previous, start: first.start, length: text.length, text, estimatedTokens,
        complete: previous.complete !== false && source.complete !== false, boundary: 'range' };
      remainingCharacters -= addedCharacters;
      remainingTokens -= addedTokens;
      return true;
    }
    if (remainingCharacters <= 0 || remainingTokens <= 0) return false;
    const estimatedTokens = estimateAITokens(source.text);
    if (!source.text || source.text.length > remainingCharacters || estimatedTokens > remainingTokens) return false;
    sources.push({ ...source, length: source.text.length, estimatedTokens });
    remainingCharacters -= source.text.length;
    remainingTokens -= estimatedTokens;
    return true;
  };

  if (naturalEdit) {
    writebackTarget = await bindNaturalWriteback(context, naturalEdit, catalog, explicit, previousProposal, signal);
    const source = catalog.find(item => item.sourceId === writebackTarget?.nodeId);
    if (!source || !writebackTarget) throw new Error('没有找到可改写的正文。');
    const block = await readBoundWriteback(context, source, writebackTarget, remainingCharacters, remainingTokens, signal);
    const evidence = { ...source, ...block, reason: 'explicit-reference' as const, boundary: 'range' as const, complete: true };
    if (block.length === 0 && writebackTarget.mode === 'append') sources.push(evidence);
    else if (!add(evidence)) throw new Error('目标正文超过本轮预算。');
  }
  const previousDraft = naturalEdit?.kind === 'followup' && previousProposal?.status === 'pending' ? previousProposal.text : undefined;
  const taskInstructions = naturalEdit ? writebackTaskInstructions(payload.prompt, naturalEdit.kind === 'followup' ? previousProposal?.taskInstructions : []) : undefined;
  const carriedInstructions = taskInstructions?.filter(instruction => !payload.prompt.includes(instruction)).join('\n') ?? '';
  remainingCharacters -= carriedInstructions.length;
  remainingTokens -= estimateAITokens(carriedInstructions);
  if (remainingCharacters < 0 || remainingTokens < 0) throw new Error('任务约束和目标正文合计超出本轮预算，请缩小目标范围。');
  if (previousDraft && (previousDraft.length > remainingCharacters || estimateAITokens(previousDraft) > remainingTokens)) {
    throw new Error('上一版草稿超过本轮预算，请先应用草稿，再选中要继续调整的段落。');
  }
  for (const reference of naturalEdit || fullSummary ? [] : explicit) {
    const source = catalog.find((candidate) => candidate.sourceId === reference ||
      candidate.title.toLocaleLowerCase('zh-CN') === reference.toLocaleLowerCase('zh-CN'));
    if (!source) throw new Error(`没有找到 @ 引用：“${reference}”`);
    if (explicit.length === 1 && paragraph && (operationCreatesWriteback(payload.operation) || payload.operation === 'canvas-control')) {
      const target = await readParagraphTarget(context, source, Number(paragraph[1]), signal);
      if (!add({ ...source, start: target.contextStart, length: target.text.length, text: target.text, reason: 'explicit-reference', boundary: 'range', complete: true })) throw new Error('目标段落超过本轮正文预算，请缩小修改范围');
      writebackTarget = { nodeId: source.sourceId, expectedRevision: source.revision, start: target.start, end: target.end, mode: 'replace' };
      continue;
    }
    const purpose = canvasControlPurpose(payload.prompt);
    const omitBody = purpose === 'move' || (purpose === 'appearance' && !/设计|方案|主题|根据|协调|参考|推荐|想法/u.test(canvasCommandText(payload.prompt)));
    if (payload.operation === 'canvas-control' && (omitBody || source.length === 0)) {
      sources.push({ ...source, start: 0, length: 0, text: '', reason: 'explicit-reference', complete: true });
      continue;
    }
    if (continuation && explicit.length === 1) writebackTarget = { nodeId: source.sourceId, expectedRevision: source.revision, start: source.length, end: source.length, mode: 'append' };
    const readBlock = continuation ? readTailEvidenceBlock : readHeadEvidenceBlock;
    const block = await readBlock(
      context,
      source,
      Math.min(3_500, remainingCharacters, naturalScope ? Math.floor(budget.characterLimit / explicit.length) : Infinity),
      Math.min(remainingTokens, naturalScope ? Math.floor(budget.tokenLimit / explicit.length) : Infinity),
      signal,
    );
    if (block.text) add({ ...source, ...block, reason: 'explicit-reference' });
    else if (naturalScope?.ids.length) sources.push({ ...source, start: 0, length: 0, text: '', reason: 'explicit-reference', complete: source.length === 0 });
  }
  report(0.25);

  const transcriptMeta = catalog.find((source) => source.sourceId === transcriptSourceId);
  if (transcriptMeta?.length && !naturalEdit && !fullSummary) {
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
  let retrievalDetails: SemanticRetrievalResult | undefined;
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
        const query = { terms, query: stripOperationCommands(payload.prompt), maxResults: 12,
          ...(selectedMemorySet.size ? { sourceIds: [...selectedMemorySet].slice(0, 100) } : {}) };
        try {
          retrievalDetails = await context.capabilities.request<SemanticRetrievalResult>('context.semanticSearch@3', {
            ...query, lexicalHits: new Set(contributions.flatMap(part => part.hits.map(hit => hit.source.sourceId))).size,
          }, signal);
          semantic = retrievalDetails.contributions;
        } catch (error) {
          if (!isCapabilityUnavailable(error, 'context.semanticSearch@3')) throw error;
          semantic = await context.capabilities.requestAll<AIContextSearchContribution>('context.localSemanticSearch@1', query, signal);
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        context.diagnostics.warn('语义检索暂不可用，继续使用关键词结果', error);
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
  const totalCharacters = payload.prompt.length + (previousDraft?.length ?? 0) + carriedInstructions.length + sources.reduce((total, source) => total + source.text.length, 0);
  const estimatedTokens = estimateAITokens(payload.prompt) + estimateAITokens(previousDraft ?? '') + estimateAITokens(carriedInstructions) +
    sources.reduce((total, source) => total + (source.estimatedTokens ?? estimateAITokens(source.text)), 0);
  const unresolvedConflictCount = memoryConflicts.filter((conflict) => conflict.resolution === 'unresolved').length;
  const changesMemoryState = /(^|[\s，。！？、；：,.!?;:])@(确认|修改|废弃|分支)(?=\s|$|[，。！？、；：,.!?;:])/u
    .test(payload.prompt);
  const review = fullSummary
    ? { reason: 'full-source-summary' as const, message: `将分批读取 ${fullSummary.sources.length} 个来源的全文（${fullSummary.characters.toLocaleString()} 字符）。确认后发送至当前模型。` }
    : unresolvedConflictCount > 0
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
    id: preparationId,
    ...(taskInstructions?.length ? { taskInstructions } : {}),
    ...(retrievalDetails ? { retrievalDetails: { ...retrievalDetails, contributions: [] } } : {}),
    sessionId: session.id,
    ...(payload.assistantId ? { assistantId: payload.assistantId } : {}),
    prompt: payload.prompt,
    operation: payload.operation,
    ...(writebackTarget && !destination.title ? { writebackTarget } : {}),
    ...(destination.title ? { outputNodeTitle: destination.title } : {}),
    ...(fullSummary ? { fullSummary } : {}),
    ...(previousDraft && previousProposal ? { previousWritebackProposalId: previousProposal.id, previousWritebackDraft: previousDraft } : {}),
    ...(payload.providerProfileId ? { providerProfileId: payload.providerProfileId } : {}),
    ...(payload.webSearchEnabled ? { webSearchEnabled: true } : {}),
    ...(payload.promptTemplateId ? { promptTemplateId: payload.promptTemplateId } : {}),
    ...(selectedMemorySourceIds.length > 0 ? { selectedMemorySourceIds } : {}),
    ...(contextMode === 'explicit-only' ? { contextMode } : {}),
    contextIntent,
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
