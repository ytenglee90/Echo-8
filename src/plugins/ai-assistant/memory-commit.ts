import {
  createId,
  type EventDeclaration,
  type PatchOperation,
  type PluginContext,
} from '../../core/contracts.ts';
import type {
  AIMemoryIndexDraft,
  AIMemoryIndexRecord,
  AISessionRecord,
} from '../../protocols/ai.ts';
import type {
  ContentCreatePlanRequest,
  ContentDeltaPlanRequest,
  ContentMutationPlan,
  ContentPlacementPlanRequest,
  ContentSummary,
} from '../../protocols/content.ts';
import {
  readCompleteContextSourceText,
  readContextSource,
} from './context-source-reader.ts';
import {
  createMemoryFileStem,
  formatMemoryIndexText,
  memoryIndexTitle,
} from './memory-artifacts.ts';
import { buildMemoryIndexDraft } from './memory-indexing.ts';
import {
  AI_SESSION_NAMESPACE,
  sessionTranscriptSourceId,
} from './transcript-storage.ts';

export const AI_MEMORY_NAMESPACE = 'aiMemoryIndex';

export interface PreparedMemoryCommit {
  id: string;
  sessionId: string;
  expectedSessionRevision: number;
  expectedSourceRevision: number;
  expectedMemory?: { sourceId: string; updatedAt: number };
  expectedTargets: Array<{ id: string; revision: number }>;
  createdTitles: string[];
  index: AIMemoryIndexDraft;
  automatic: boolean;
  archiveNodeId: string;
  indexNodeId: string;
  label: string;
  patches: PatchOperation[];
  events: EventDeclaration[];
}

export async function prepareMemoryCommit(
  context: PluginContext,
  session: AISessionRecord,
  signal: AbortSignal,
  report: (progress: number) => void,
  waitIfPaused: () => Promise<void>,
  automatic = false,
): Promise<PreparedMemoryCommit> {
  const index = await buildMemoryIndexDraft(
    (request, readSignal) => readContextSource(context, request, readSignal),
    sessionTranscriptSourceId(session),
    session.title,
    signal,
    (progress) => report(progress * 0.72),
    waitIfPaused,
  );
  await waitIfPaused();
  return prepareMemoryCommitPlan(context, session, index, signal, report, automatic);
}

async function prepareMemoryCommitPlan(
  context: PluginContext,
  session: AISessionRecord,
  index: AIMemoryIndexDraft,
  signal: AbortSignal,
  report: (progress: number) => void,
  automatic: boolean,
): Promise<PreparedMemoryCommit> {
  const transcriptSourceId = sessionTranscriptSourceId(session);
  const currentIndexes = Object.values(
    context.store.readNamespace<Record<string, AIMemoryIndexRecord>>(AI_MEMORY_NAMESPACE),
  );
  const existingMemory = currentIndexes.find((item) => item.sessionId === session.id);
  const memoryNodeIds = currentIndexes.flatMap((item) =>
    [item.sourceId, item.indexNodeId].filter(Boolean) as string[]);
  const summaries = memoryNodeIds.length > 0
    ? await context.capabilities.request<ContentSummary[]>('content.summariesById@1', {
        nodeIds: memoryNodeIds,
      }, signal)
    : [];
  const summariesById = new Map(summaries.map((summary) => [summary.id, summary]));
  const existingArchive = existingMemory ? summariesById.get(existingMemory.sourceId) : undefined;
  const existingIndex = existingMemory?.indexNodeId
    ? summariesById.get(existingMemory.indexNodeId)
    : undefined;
  const reuseArchive = Boolean(existingArchive);
  const reuseIndex = Boolean(existingIndex);
  report(0.76);

  const transcriptText = await readCompleteContextSourceText(
    context,
    transcriptSourceId,
    signal,
    index.sourceRevision,
    (progress) => report(0.76 + progress * 0.14),
  );
  const archiveTitle = existingMemory?.title ?? `${session.title} · 对话原文`.slice(0, 120);
  const reservedTitles: string[] = [];
  const archive: ContentMutationPlan = reuseArchive && existingArchive!.id === transcriptSourceId
    ? {
        nodeId: existingArchive!.id,
        revision: existingArchive!.revision,
        length: existingArchive!.length,
        resolvedTitle: existingArchive!.title,
        patches: [],
        events: [],
      }
    : reuseArchive
      ? await context.capabilities.request<ContentMutationPlan>(
          'content.deltaPlan@1',
          {
            nodeId: existingArchive!.id,
            start: 0,
            deleteCount: existingArchive!.length,
            insert: transcriptText,
            expectedRevision: existingArchive!.revision,
          } satisfies ContentDeltaPlanRequest,
          signal,
        )
      : await context.capabilities.request<ContentMutationPlan>(
          'content.createPlan@1',
          {
            title: archiveTitle,
            body: transcriptText,
            placement: 'system',
            automaticContext: false,
            reservedTitles,
          } satisfies ContentCreatePlanRequest,
          signal,
        );
  const archivePlacement = reuseArchive
    ? await context.capabilities.request<ContentMutationPlan>(
        'content.placementPlan@1',
        { nodeId: archive.nodeId, placement: 'system' } satisfies ContentPlacementPlanRequest,
        signal,
      )
    : undefined;
  if (!reuseArchive && archive.resolvedTitle) reservedTitles.push(archive.resolvedTitle);
  const resolvedArchiveTitle = existingMemory?.title ?? archive.resolvedTitle ?? existingArchive?.title ?? archiveTitle;
  const archiveIndexDraft: AIMemoryIndexDraft = {
    ...index,
    sourceRevision: archive.revision,
    sourceLength: archive.length,
  };
  const savedAt = Date.now();
  const indexTitle = memoryIndexTitle(resolvedArchiveTitle);
  const indexText = formatMemoryIndexText(archiveIndexDraft, {
    archiveNodeId: archive.nodeId,
    archiveTitle: resolvedArchiveTitle,
    savedAt,
  });
  const indexPlan = reuseIndex
    ? await context.capabilities.request<ContentMutationPlan>(
        'content.deltaPlan@1',
        {
          nodeId: existingIndex!.id,
          start: 0,
          deleteCount: existingIndex!.length,
          insert: indexText,
          expectedRevision: existingIndex!.revision,
        } satisfies ContentDeltaPlanRequest,
        signal,
      )
    : await context.capabilities.request<ContentMutationPlan>(
        'content.createPlan@1',
        {
          title: indexTitle,
          body: indexText,
          placement: 'system',
          automaticContext: false,
          reservedTitles,
        } satisfies ContentCreatePlanRequest,
        signal,
      );
  const indexPlacement = reuseIndex
    ? await context.capabilities.request<ContentMutationPlan>(
        'content.placementPlan@1',
        { nodeId: indexPlan.nodeId, placement: 'system' } satisfies ContentPlacementPlanRequest,
        signal,
      )
    : undefined;
  report(0.96);

  const memoryIndex: AIMemoryIndexRecord = {
    ...archiveIndexDraft,
    schemaVersion: 2,
    sessionId: session.id,
    sourceId: archive.nodeId,
    title: resolvedArchiveTitle,
    indexNodeId: indexPlan.nodeId,
    hubNodeId: undefined,
    connectionIds: undefined,
    enabled: existingMemory?.enabled ?? true,
    scope: existingMemory?.scope,
    localFileStem: existingMemory?.localFileStem ?? createMemoryFileStem(resolvedArchiveTitle, archive.nodeId),
    sourceRevision: archive.revision,
    sourceLength: archive.length,
    createdAt: existingMemory?.createdAt ?? savedAt,
    updatedAt: savedAt,
  };
  const nextSession: AISessionRecord = {
    ...session,
    revision: session.revision + 1,
    updatedAt: savedAt,
    savedAt,
    savedTranscriptRevision: index.sourceRevision,
  };
  const patches: PatchOperation[] = [
    ...archive.patches,
    ...(archivePlacement?.patches ?? []),
    ...indexPlan.patches,
    ...(indexPlacement?.patches ?? []),
    ...(existingMemory && existingMemory.sourceId !== archive.nodeId
      ? [{
          op: 'delete' as const,
          domain: 'document' as const,
          namespace: AI_MEMORY_NAMESPACE,
          key: existingMemory.sourceId,
        }]
      : []),
    { op: 'set', domain: 'document', namespace: AI_SESSION_NAMESPACE, key: session.id, value: nextSession },
    { op: 'set', domain: 'document', namespace: AI_MEMORY_NAMESPACE, key: archive.nodeId, value: memoryIndex },
  ];
  const events: EventDeclaration[] = [
    ...(archive.events ?? []),
    ...(archivePlacement?.events ?? []),
    ...(indexPlan.events ?? []),
    ...(indexPlacement?.events ?? []),
    { type: 'ai.session.saved', payload: {
      sessionId: session.id,
      sourceId: transcriptSourceId,
      archiveNodeId: archive.nodeId,
      indexNodeId: indexPlan.nodeId,
      automatic,
    } },
  ];
  report(1);
  return {
    id: createId('ai-memory-preparation'),
    sessionId: session.id,
    expectedSessionRevision: session.revision,
    expectedSourceRevision: index.sourceRevision,
    expectedMemory: existingMemory
      ? { sourceId: existingMemory.sourceId, updatedAt: existingMemory.updatedAt ?? 0 }
      : undefined,
    expectedTargets: [existingArchive, existingIndex]
      .filter((target): target is ContentSummary => Boolean(target))
      .map((target) => ({ id: target.id, revision: target.revision })),
    createdTitles: [
      ...(!reuseArchive && archive.resolvedTitle ? [archive.resolvedTitle] : []),
      ...(!reuseIndex && indexPlan.resolvedTitle ? [indexPlan.resolvedTitle] : []),
    ],
    index,
    automatic,
    archiveNodeId: archive.nodeId,
    indexNodeId: indexPlan.nodeId,
    label: existingMemory ? '更新 AI 对话原文与索引' : '保存 AI 对话原文与索引',
    patches,
    events,
  };
}
