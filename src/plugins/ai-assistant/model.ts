import {
  createId,
  isRecord,
  type PatchOperation,
  type PluginDefinition,
  type TaskHandle,
} from '../../core/contracts.ts';
import type {
  AIGenerateResult,
  AIMemoryCandidateRecord,
  AIMemoryIndexRecord,
  AIPromptTemplateCatalog,
  AIPreparedContext,
  AIProposalRecord,
  AISessionRecord,
  AIStatusSignal,
} from '../../protocols/ai.ts';
import type {
  ContentSummary,
} from '../../protocols/content.ts';
import { normalizeFloatingRect, type FloatingPanelRect } from '../../protocols/floating.ts';
import {
  PROJECT_RELATED_DIRECTORY_CAPABILITY,
  type FileDirectoryTarget,
  type PersistenceSnapshot,
} from '../../protocols/files.ts';
import { canReusePersistedFileHandle } from '../../ui/native-file-permission.ts';
import { defineManifest } from '../manifest.ts';
export { estimateAITokens } from './evidence-boundaries.ts';
import { buildMemoryIndexDraft } from './memory-indexing.ts';
import {
  AI_MEMORY_FILE_INDEX_SUFFIX,
  AI_MEMORY_FILE_ORIGINAL_SUFFIX,
  createMemoryFileStem,
} from './memory-artifacts.ts';
import {
  AI_MEMORY_NAMESPACE,
  prepareMemoryCommit,
  type PreparedMemoryCommit,
} from './memory-commit.ts';
import {
  removeMemoryFileIfPresent,
  writeMemorySourceToDirectory,
  type PreparedMemoryFileImport,
} from './memory-file-io.ts';
import { registerAIGenerationRuntime } from './generation-runtime.ts';
import { registerAIEventRuntime } from './event-runtime.ts';
import { isAbortError } from './runtime-errors.ts';
import {
  normalizePromptTemplateCatalog,
} from './prompt-template-files.ts';
import { registerPromptTemplateRuntime } from './prompt-template-runtime.ts';
import {
  registerAIRequestRuntime,
  requirePreparedContext,
  type PreparedGeneration,
} from './request-runtime.ts';
import {
  AI_MEMORY_CANDIDATE_NAMESPACE,
  registerAIMemoryCandidateRuntime,
} from './memory-candidate-runtime.ts';
import {
  AI_PROPOSAL_NAMESPACE,
  AI_RESPONSE_NAMESPACE,
  registerAIProposalRuntime,
} from './proposal-runtime.ts';
import {
  normalizeAIComposerHeight,
  type AIAssistantInstanceState,
  type AIAssistantState,
  type AIAssistantView,
  type AIResponseDetail,
} from './types.ts';
import {
  AI_UI_NAMESPACE,
  DEFAULT_AI_RECT,
  buildAssistantWorkspacePatches,
  createAssistantInstance,
  createAssistantSession,
  readAssistantInstancesFromWorkspace,
  selectPrimaryAssistant,
  type AssistantSessionSettings,
} from './assistant-workspace.ts';
import {
  AI_SESSION_NAMESPACE,
  AI_TRANSCRIPT_NAMESPACE,
  sessionTranscriptSourceId,
  type AITranscriptChunkRecord,
} from './transcript-storage.ts';
import {
  readContextSource as readSource,
  readContextSourceRevision as readSourceRevision,
} from './context-source-reader.ts';
import { registerAIQueryRuntime } from './query-runtime.ts';
import { registerAIMemoryManagementRuntime } from './memory-management-runtime.ts';
import { PERSONAL_AI_MEMORY_DIRECTORY_KEY } from './memory-protocol.ts';
import { registerAIAssistantUI } from './ui-runtime.ts';
import {
  isAssistantIdPayload,
  isAssistantInstanceState,
  isAssistantAutoMemoryCandidatesPayload,
  isAssistantContextModePayload,
  isAssistantMemoriesPayload,
  isAssistantRectCommandPayload,
  isAssistantResourcePayload,
  isAssistantViewCommandPayload,
  isAssistantWebSearchPayload,
  isCommitMemoryRequest,
  isComposerHeightPayload,
  isContinueMemoryPayload,
  isFileDirectoryTarget,
  isFloatingRect,
  isSaveSessionPayload,
  isSessionIdPayload,
  readAssistantView,
  type AssistantIdPayload,
  type AssistantAutoMemoryCandidatesPayload,
  type AssistantContextModePayload,
  type AssistantMemoriesPayload,
  type AssistantRectPayload,
  type AssistantResourcePayload,
  type AssistantViewPayload,
  type AssistantWebSearchPayload,
  type CommitMemoryRebuildPayload,
  type ComposerHeightPayload,
  type ContinueMemoryPayload,
  type MemoryCandidateCommitPayload,
  type PreparePayload,
  type SaveSessionPayload,
  type SessionIdPayload,
} from './command-payloads.ts';

export { AI_SESSION_NAMESPACE, AI_TRANSCRIPT_NAMESPACE } from './transcript-storage.ts';
export { AI_PROPOSAL_NAMESPACE, AI_RESPONSE_NAMESPACE } from './proposal-runtime.ts';
export { AI_UI_NAMESPACE } from './assistant-workspace.ts';
export { AI_MEMORY_NAMESPACE } from './memory-commit.ts';
export { AI_MEMORY_CANDIDATE_NAMESPACE } from './memory-candidate-runtime.ts';

const MEMORY_AUTO_REINDEX_DELAY_MS = 900;
export function createAIAssistantPlugin(
  panel?: unknown,
  toolbar?: unknown,
  memoryDeleteDialog?: unknown,
): PluginDefinition {
  const preparations = new Map<string, PreparedGeneration>();
  const preparationTasks = new Map<string, TaskHandle<AIPreparedContext>>();
  const generationTasks = new Map<string, TaskHandle<AIGenerateResult>>();
  const memoryTasks = new Map<string, TaskHandle<PreparedMemoryCommit>>();
  const memoryCommitPreparations = new Map<string, PreparedMemoryCommit>();
  const autoSaveDelayTasks = new Map<string, TaskHandle<void>>();
  const memoryRebuildTasks = new Map<string, TaskHandle<CommitMemoryRebuildPayload>>();
  const memoryFileTasks = new Map<string, TaskHandle<void>>();
  const previousMemoryFileStems = new Map<string, Set<string>>();
  const memoryFileImportTasks = new Map<string, TaskHandle<PreparedMemoryFileImport>>();
  const memoryFileImportPreparations = new Map<string, PreparedMemoryFileImport>();
  const memoryCandidateTasks = new Map<string, TaskHandle<MemoryCandidateCommitPayload>>();
  const generationRuntimeBySession = new Map<
    string,
    AIAssistantState['generationRuntimeBySession'][string]
  >();
  const generationActionBySession = new Map<string, AIAssistantState['generationActionBySession'][string]>();
  const lastPrepareRequestBySession = new Map<string, PreparePayload>();
  let memoryDirectory: FileDirectoryTarget | undefined;
  let memoryFileError: string | undefined;
  let releaseMemoryDirectoryLease: (() => void) | undefined;
  let lifecycleGeneration = 0;

  return {
    manifest: defineManifest('ai-assistant', 'AI 助手', {
      namespaces: [
        AI_SESSION_NAMESPACE,
        AI_TRANSCRIPT_NAMESPACE,
        AI_PROPOSAL_NAMESPACE,
        AI_RESPONSE_NAMESPACE,
        AI_MEMORY_NAMESPACE,
        AI_MEMORY_CANDIDATE_NAMESPACE,
        AI_UI_NAMESPACE,
      ],
      namespaceDomains: {
        [AI_SESSION_NAMESPACE]: 'document',
        [AI_TRANSCRIPT_NAMESPACE]: 'document',
        [AI_PROPOSAL_NAMESPACE]: 'document',
        [AI_RESPONSE_NAMESPACE]: 'document',
        [AI_MEMORY_NAMESPACE]: 'document',
        [AI_MEMORY_CANDIDATE_NAMESPACE]: 'document',
        [AI_UI_NAMESPACE]: 'workspace',
      },
      requiresCapabilities: [
        'content.createPlan@1',
        'content.clonePlan@1',
        'content.appendPlan@1',
        'content.deltaPlan@1',
        'content.placementPlan@1',
        'content.renamePlan@1',
        'content.summaries@1',
        'content.summariesById@1',
        'context.catalog@1',
        'context.read@1',
        'entity.deletePlan@1',
      ],
      optionalCapabilities: [
        'context.search@1',
        'context.search@2',
        'context.search@3',
        'context.semanticSearch@1',
        PROJECT_RELATED_DIRECTORY_CAPABILITY,
        'ai.generate@1',
        'ai.generate.stream@1',
        'ai.provider.info@1',
        'ai.provider.catalog@1',
        'ai.promptPolicy@1',
      ],
      commands: [
        'ai.open',
        'ai.assistant.openNew',
        'ai.assistant.attach',
        'ai.assistant.focus',
        'ai.assistant.openSession',
        'ai.assistant.activate',
        'ai.assistant.delete',
        'ai.assistant.deleteSession',
        'ai.assistant.removeDeletedWindow',
        'ai.assistant.setProvider',
        'ai.assistant.setWebSearch',
        'ai.assistant.setAutoMemoryCandidates',
        'ai.assistant.setContextMode',
        'ai.assistant.setPromptTemplate',
        'ai.assistant.setMemories',
        'ai.assistant.continueMemory',
        'ai.openProviderSettings',
        'ai.close',
        'ai.setView',
        'ai.setPanelRect',
        'ai.setComposerHeight',
        'ai.promptTemplate.save',
        'ai.promptTemplate.remove',
        'ai.promptTemplate.activate',
        'ai.promptTemplate.restorePersonal',
        'ai.promptTemplate.export',
        'ai.promptTemplate.import',
        'ai.session.save',
        'ai.session.memory.commit',
        'ai.context.prepare',
        'ai.context.discard',
        'ai.generation.start',
        'ai.generation.retry',
        'ai.generation.cancel',
        'ai.generation.record',
        'ai.proposal.accept',
        'ai.proposal.dismiss',
        'ai.memory.setEnabled',
        'ai.memory.setScope',
        'ai.memory.rename',
        'ai.memory.linkDirectory',
        'ai.memory.importFiles',
        'ai.memory.importFiles.commit',
        'ai.memory.delete.request',
        'ai.memory.delete.cancel',
        'ai.memory.delete.confirm',
        'ai.memory.delete',
        'ai.memory.rebuild',
        'ai.memory.rebuild.commit',
        'ai.memory.candidates.extract',
        'ai.memory.candidates.commit',
        'ai.memory.candidate.accept',
        'ai.memory.candidate.dismiss',
      ],
      dispatches: [
        'ai.open', 'ai.assistant.openNew', 'ai.assistant.attach', 'ai.assistant.removeDeletedWindow', 'ai.openProviderSettings',
        'ai.context.prepare',
        'aiProvider.profile.activate', 'ai.promptTemplate.restorePersonal', 'system.preferences.set',
        'ai.memory.importFiles.commit',
        'editor.open',
      ],
      events: [
        'ai.session.initialized',
        'ai.assistant.focused',
        'ai.assistant.deleted',
        'ai.transcript.changed',
        'ai.session.saved',
        'ai.generation.requested',
        'ai.proposal.created',
        'ai.proposal.accepted',
        'ai.proposal.dismissed',
        'ai.memory.updated',
        'ai.memory.candidates.updated',
        'content.changed',
        'node.created',
        'node.renamed',
        'nodes.deleted',
        'history.changed',
        'document.replaced',
        'ai.prompt.configuration.changed',
      ],
      queries: [
        'ai.state', 'ai.catalog', 'ai.transcript', 'ai.pendingPreparation',
        'ai.memoryIndexes', 'ai.memoryCatalog', 'ai.memory.deleteConfirmation', 'ai.promptTemplates',
      ],
      asks: [
        'ai.state',
        'ai.catalog',
        'ai.transcript',
        'ai.pendingPreparation',
        'ai.memoryIndexes',
        'ai.memoryCatalog',
        'ai.memory.deleteConfirmation',
        'ai.promptTemplates',
        'system.persistence',
        'system.preferences.get',
      ],
      signals: [
        'ai.status',
        'ai.context.ready',
        'ai.generation.delta',
        'ai.panel.preview',
        'ai.composer.resize.preview',
        'ai.composer.draft.preview',
        'ai.state.invalidated',
        'ai.catalog.invalidated',
        'system.persistence.autosaveInterval.changed',
        'ai.transcript.invalidated',
        'ai.memory.invalidated',
        'ai.provider.changed',
        'ai.assistant.focus.requested',
        'ai.memory.deleteConfirmation.changed',
        'content.reference.drop-zone',
        'content.reference.drag.preview',
        'content.reference.drop',
      ],
      ui: ['ai.open-button', 'ai.panel', 'ai.memory.deleteConfirm'],
      actions: ['ai.open-action', 'ai.open-new-assistant-action', 'ai.open-provider-settings-action', 'ai.save-session-action'],
      shortcuts: [
        'ai.open-shortcut',
        'ai.open-new-assistant-shortcut',
        'ai.open-provider-settings-shortcut',
        'ai.close-shortcut',
        'ai.save-session-shortcut',
      ],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.top.contribute',
        'ui.overlay.contribute',
        'ui.modal.contribute',
        'ui.action.register',
        'ui.shortcut.register',
        'content.context.read',
        'tasks.schedule',
        'preferences.manage',
      ],
    }),

    start(context) {
      const generation = ++lifecycleGeneration;
      // A memory save plans content-node titles and then commits those plans.
      // Keep that planning/commit window exclusive so concurrent sessions do
      // not both reserve the same title against the same document snapshot.
      let memoryCommitQueue: Promise<void> = Promise.resolve();
      let activeAssistantId: string | undefined;
      const pendingMemoryDeletion: { sourceId?: string } = {};
      const composerDrafts = new Map<string, string>();
      const lastMemoryUseBySession = new Map<string, AIAssistantState['lastMemoryUseBySession'][string]>();
      preparations.clear();
      preparationTasks.clear();
      generationTasks.clear();
      memoryTasks.clear();
      memoryCommitPreparations.clear();
      autoSaveDelayTasks.clear();
      for (const task of memoryRebuildTasks.values()) task.cancel();
      memoryRebuildTasks.clear();
      for (const task of memoryFileTasks.values()) task.cancel();
      for (const task of memoryFileImportTasks.values()) task.cancel();
      for (const task of memoryCandidateTasks.values()) task.cancel();
      memoryFileTasks.clear();
      previousMemoryFileStems.clear();
      memoryFileImportTasks.clear();
      memoryFileImportPreparations.clear();
      memoryCandidateTasks.clear();
      generationRuntimeBySession.clear();
      generationActionBySession.clear();
      lastPrepareRequestBySession.clear();
      memoryFileError = undefined;
      const readSessions = () => context.store.readNamespace<Record<string, AISessionRecord>>(AI_SESSION_NAMESPACE);
      const readProposals = () => context.store.readNamespace<Record<string, AIProposalRecord>>(AI_PROPOSAL_NAMESPACE);
      const readResponseDetails = () => context.store.readNamespace<Record<string, AIResponseDetail>>(AI_RESPONSE_NAMESPACE);
      const readMemoryIndexes = () =>
        context.store.readNamespace<Record<string, AIMemoryIndexRecord>>(AI_MEMORY_NAMESPACE);
      const readPendingMemoryDeletion = () => {
        const memory = pendingMemoryDeletion.sourceId
          ? readMemoryIndexes()[pendingMemoryDeletion.sourceId]
          : undefined;
        return memory ? { sourceId: memory.sourceId, title: memory.title } : undefined;
      };
      const publishPendingMemoryDeletion = () => {
        context.signals.emit('ai.memory.deleteConfirmation.changed', readPendingMemoryDeletion());
      };
      const readMemoryCandidates = () => context.store.readNamespace<Record<string, AIMemoryCandidateRecord>>(
        AI_MEMORY_CANDIDATE_NAMESPACE,
      );
      const readPromptTemplates = (): AIPromptTemplateCatalog => normalizePromptTemplateCatalog(
        context.store.readValue(AI_UI_NAMESPACE, 'promptTemplates'),
        context.store.readValue(AI_UI_NAMESPACE, 'activePromptTemplateId'),
      );
      context.queries.register<undefined, { sourceId: string; title: string } | undefined>({
        type: 'ai.memory.deleteConfirmation',
        handle: readPendingMemoryDeletion,
      });
      const invalidateState = () => context.signals.emit('ai.state.invalidated');
      const scheduleConversationAutosave = async (sessionId: string, reschedule = false) => {
        const session = readSessions()[sessionId];
        const transcriptRevision = session?.transcriptSourceId
          ? await readSourceRevision(context, session.transcriptSourceId).catch(() => -1)
          : Math.max(0, session?.transcriptRevision ?? 0);
        if (!session || session.turns === 0 || session.savedTranscriptRevision === transcriptRevision) return;
        const existingDelay = autoSaveDelayTasks.get(sessionId);
        if (existingDelay && !reschedule) return;
        existingDelay?.cancel();
        const persistence = await context.queries.ask<PersistenceSnapshot>('system.persistence');
        const task = context.tasks.schedule<void>({
          category: 'ai-conversation-autosave-delay',
          label: '等待自动保存 AI 对话',
          delayMs: persistence.autosaveIntervalMs,
          noticeAfterMs: 60_000,
          priority: 1,
          estimatedCost: 1,
          run: async () => undefined,
        });
        autoSaveDelayTasks.set(sessionId, task);
        void task.result.then(
          () => context.commands.dispatch('ai.session.save', { sessionId, automatic: true }),
          (error) => {
            if (!isAbortError(error)) context.diagnostics.warn('AI 对话自动保存计时失败', error);
          },
        ).catch((error) => {
          if (!isAbortError(error)) context.diagnostics.warn('AI 对话自动保存失败', error);
        }).finally(() => {
          if (autoSaveDelayTasks.get(sessionId) === task) autoSaveDelayTasks.delete(sessionId);
        });
      };
      const scheduleMemoryRebuild = (
        memory: AIMemoryIndexRecord,
        options: { automatic: boolean; delayMs?: number },
      ) => {
        memoryRebuildTasks.get(memory.sourceId)?.cancel();
        if (!options.automatic) {
          context.signals.emit('ai.status', {
            state: 'indexing', message: `正在重建“${memory.title}”的索引`,
          } satisfies AIStatusSignal);
        }
        const task = context.tasks.schedule<CommitMemoryRebuildPayload>({
          category: 'ai-memory-index',
          label: `正在重建记忆索引：${memory.title}`,
          delayMs: options.delayMs ?? 0,
          priority: options.automatic ? 1 : 12,
          timeoutMs: 3 * 60_000,
          estimatedCost: 5,
          run: async (signal, report, control) => ({
            sourceId: memory.sourceId,
            expectedSourceRevision: (await readSource(context, {
              sourceId: memory.sourceId, start: 0, length: 0,
            })).source?.revision ?? -1,
            index: await buildMemoryIndexDraft(
              (request, readSignal) => readSource(context, request, readSignal),
              memory.sourceId,
              memory.title,
              signal,
              report,
              control.waitIfPaused,
            ),
          }),
        });
        memoryRebuildTasks.set(memory.sourceId, task);
        void task.result.then(
          async (result) => {
            await context.commands.dispatch('ai.memory.rebuild.commit', result);
            if (!options.automatic) {
              context.signals.emit('ai.status', {
                state: 'complete', message: '记忆索引已经重建',
              } satisfies AIStatusSignal);
            }
          },
          (error) => {
            if (isAbortError(error)) return;
            context.signals.emit('ai.status', {
              state: 'error', message: error instanceof Error ? error.message : String(error),
            } satisfies AIStatusSignal);
          },
        ).finally(() => {
          if (memoryRebuildTasks.get(memory.sourceId) === task) memoryRebuildTasks.delete(memory.sourceId);
        });
        return task;
      };
      const scheduleOutdatedMemoryRebuilds = async () => {
        const sourceIds = Object.values(readMemoryIndexes()).map((memory) => memory.sourceId);
        const summaries = sourceIds.length > 0
          ? await context.capabilities.request<ContentSummary[]>('content.summariesById@1', {
              nodeIds: sourceIds,
            })
          : [];
        const byId = new Map(summaries.map((summary) => [summary.id, summary]));
        let order = 0;
        for (const memory of Object.values(readMemoryIndexes())) {
          const source = byId.get(memory.sourceId);
          if (!source || source.revision === memory.sourceRevision || memory.enabled === false) continue;
          scheduleMemoryRebuild(memory, {
            automatic: true,
            delayMs: MEMORY_AUTO_REINDEX_DELAY_MS + Math.min(order, 40) * 120,
          });
          order += 1;
        }
      };
      const scheduleMemoryFileExport = (memory: AIMemoryIndexRecord, previousStemInput?: string) => {
        const directory = memoryDirectory;
        if (!directory || !memory.indexNodeId) return undefined;
        memoryFileTasks.get(memory.sourceId)?.cancel();
        memoryFileError = undefined;
        const task = context.tasks.schedule<void>({
          category: 'ai-memory-file-export',
          label: `正在覆盖本地记忆文件：${memory.title}`,
          priority: 2,
          timeoutMs: 5 * 60_000,
          noticeAfterMs: 1_500,
          estimatedCost: Math.max(1, Math.ceil(memory.sourceLength / (1024 * 1024))),
          run: async (signal, report, control) => {
            const stem = memory.localFileStem ?? createMemoryFileStem(memory.title, memory.sourceId);
            await writeMemorySourceToDirectory(
              context,
              directory,
              `${stem}${AI_MEMORY_FILE_ORIGINAL_SUFFIX}`,
              memory.sourceId,
              signal,
              (progress) => report(progress * 0.78),
              control.waitIfPaused,
            );
            await writeMemorySourceToDirectory(
              context,
              directory,
              `${stem}${AI_MEMORY_FILE_INDEX_SUFFIX}`,
              memory.indexNodeId!,
              signal,
              (progress) => report(0.78 + progress * 0.22),
              control.waitIfPaused,
            );
            const previousStems = new Set(previousMemoryFileStems.get(memory.sourceId) ?? []);
            if (previousStemInput) previousStems.add(previousStemInput);
            if (directory.removeEntry) {
              for (const previousStem of previousStems) {
                if (previousStem === stem) continue;
                await removeMemoryFileIfPresent(directory, `${previousStem}${AI_MEMORY_FILE_ORIGINAL_SUFFIX}`);
                await removeMemoryFileIfPresent(directory, `${previousStem}${AI_MEMORY_FILE_INDEX_SUFFIX}`);
              }
            }
          },
        });
        memoryFileTasks.set(memory.sourceId, task);
        invalidateState();
        void task.result.then(
          () => {
            memoryFileError = undefined;
            previousMemoryFileStems.delete(memory.sourceId);
          },
          (reason) => {
            if (isAbortError(reason)) return;
            memoryFileError = reason instanceof Error ? reason.message : String(reason);
            context.diagnostics.warn('写入本地 AI 记忆 TXT 失败', reason);
          },
        ).finally(() => {
          if (memoryFileTasks.get(memory.sourceId) === task) memoryFileTasks.delete(memory.sourceId);
          invalidateState();
        });
        return task;
      };
      const readAssistantInstances = (): AIAssistantInstanceState[] => {
        const sessions = readSessions();
        const sessionSettings = context.store.readValue<Record<string, AssistantSessionSettings>>(
          AI_UI_NAMESPACE,
          'sessionSettings',
        ) ?? {};
        return readAssistantInstancesFromWorkspace({
          sessions,
          sessionSettings,
          storedAssistants: context.store.readValue<unknown>(AI_UI_NAMESPACE, 'assistants'),
          legacyOpen: context.store.readValue<boolean>(AI_UI_NAMESPACE, 'open') ?? false,
          legacySessionId: context.store.readValue<string>(AI_UI_NAMESPACE, 'activeSessionId'),
          legacyPanelRect: context.store.readValue(AI_UI_NAMESPACE, 'panelRect'),
          legacyComposerHeight: context.store.readValue(AI_UI_NAMESPACE, 'composerHeight'),
          legacyView: context.store.readValue(AI_UI_NAMESPACE, 'view'),
        });
      };
      const assistantWorkspacePatches = (assistants: AIAssistantInstanceState[]): PatchOperation[] => {
        const sessions = readSessions();
        const previousSettings = context.store.readValue<Record<string, AssistantSessionSettings>>(
          AI_UI_NAMESPACE,
          'sessionSettings',
        ) ?? {};
        return buildAssistantWorkspacePatches(assistants, activeAssistantId, sessions, previousSettings);
      };
      const assistantWorkspaceTransaction = (label: string, assistants: AIAssistantInstanceState[]) => ({
        transaction: { label, history: false, patches: assistantWorkspacePatches(assistants) },
      });
      const readState = (): AIAssistantState => {
        const assistants = readAssistantInstances();
        const visible = assistants.filter((assistant) => assistant.minimized !== true);
        const primary = selectPrimaryAssistant(assistants, activeAssistantId);
        const rect = primary?.rect ?? normalizeFloatingRect(
          context.store.readValue(AI_UI_NAMESPACE, 'panelRect'),
          DEFAULT_AI_RECT,
        );
        return {
          open: visible.length > 0,
          rect,
          composerHeight: primary?.composerHeight ?? normalizeAIComposerHeight(
            context.store.readValue(AI_UI_NAMESPACE, 'composerHeight'), rect.height,
          ),
          view: primary?.view ?? readAssistantView(context.store.readValue(AI_UI_NAMESPACE, 'view')),
          activeSessionId: primary?.sessionId ?? context.store.readValue<string>(AI_UI_NAMESPACE, 'activeSessionId'),
          assistants,
          sessions: Object.values(readSessions()).sort((left, right) => right.updatedAt - left.updatedAt),
          memoryCandidates: Object.values(readMemoryCandidates())
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, 80),
          proposals: Object.values(readProposals()).sort((left, right) => right.createdAt - left.createdAt).slice(0, 24),
          responseDetails: Object.values(readResponseDetails()).sort((left, right) => left.createdAt - right.createdAt).slice(-200),
          lastMemoryUseBySession: Object.fromEntries(lastMemoryUseBySession),
          memoryFiles: {
            linked: Boolean(memoryDirectory),
            ...(memoryDirectory ? { directoryName: memoryDirectory.name } : {}),
            writingSourceIds: [...memoryFileTasks.keys()],
            ...(memoryFileError ? { lastError: memoryFileError } : {}),
          },
          generationRuntimeBySession: Object.fromEntries(generationRuntimeBySession),
          generationActionBySession: Object.fromEntries(generationActionBySession),
        };
      };
      const createSession = (ordinal: number) => {
          const now = Date.now();
          return createAssistantSession(ordinal, createId('ai-session'), now);
      };
      const createAssistant = (
        sessionId: string,
        view?: AIAssistantView,
        offset = 0,
        inheritLayout = true,
      ): AIAssistantInstanceState => {
        const settings = context.store.readValue<Record<string, AssistantSessionSettings>>(
          AI_UI_NAMESPACE,
          'sessionSettings',
        )?.[sessionId];
        return createAssistantInstance({
          id: createId('ai-assistant'),
          sessionId,
          view,
          legacyView: context.store.readValue(AI_UI_NAMESPACE, 'view'),
          offset,
          inheritLayout,
          panelRect: context.store.readValue(AI_UI_NAMESPACE, 'panelRect'),
          composerHeight: context.store.readValue(AI_UI_NAMESPACE, 'composerHeight'),
          settings,
          createdAt: Date.now(),
        });
      };
      const openAssistant = async (view?: AIAssistantView) => {
          const assistants = readAssistantInstances();
          if (assistants.length > 0) {
            const target = assistants.find((assistant) => assistant.id === activeAssistantId) ?? assistants[0];
            activeAssistantId = target.id;
            const next = assistants.map((assistant) => assistant.id === target.id
              ? { ...assistant, minimized: false, ...(view ? { view } : {}) }
              : assistant);
            return assistantWorkspaceTransaction(
              view === 'provider' ? '打开 AI 模型与连接' : '打开 AI 助手',
              next,
            );
          }
          const sessions = Object.values(readSessions());
          const requested = context.store.readValue<string>(AI_UI_NAMESPACE, 'activeSessionId');
          const active = sessions.find((session) => session.id === requested) ??
            sessions.sort((left, right) => right.updatedAt - left.updatedAt)[0];
          const session = active ?? createSession(sessions.length + 1);
          const assistant = createAssistant(session.id, view);
          if (active) {
            return assistantWorkspaceTransaction(
              view === 'provider' ? '打开 AI 模型与连接' : '打开 AI 助手',
              [assistant],
            );
          }
          return {
            transaction: {
              label: '初始化并打开 AI 助手',
              history: false,
              patches: [
                { op: 'set' as const, domain: 'document' as const, namespace: AI_SESSION_NAMESPACE, key: session.id, value: session },
              ],
              events: [
                { type: 'ai.session.initialized', payload: { id: session.id, assistant } },
              ],
            },
          };
      };

      context.commands.register({
        type: 'ai.open',
        handle: async () => {
          const result = await openAssistant();
          const assistants = readAssistantInstances();
          activeAssistantId = assistants.find((item) => item.id === activeAssistantId)?.id ?? assistants[0]?.id;
          context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return result;
        },
      });
      context.commands.register({
        type: 'ai.assistant.openNew',
        handle: () => {
          const assistants = readAssistantInstances();
          const sessions = Object.values(readSessions());
          const session = createSession(sessions.length + 1);
          const assistant = createAssistant(session.id, 'chat', assistants.length, false);
          activeAssistantId = assistant.id;
          context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return {
            result: { assistantId: assistant.id, sessionId: session.id },
            transaction: {
              label: '新开独立 AI 助手',
              history: false,
              patches: [
                { op: 'set' as const, domain: 'document' as const, namespace: AI_SESSION_NAMESPACE, key: session.id, value: session },
              ],
              events: [{ type: 'ai.session.initialized', payload: { id: session.id, assistant } }],
            },
          };
        },
      });
      context.commands.register<AIAssistantInstanceState>({
        type: 'ai.assistant.attach',
        validate: isAssistantInstanceState,
        handle: (assistant) => {
          if (!readSessions()[assistant.sessionId]) throw new Error('AI 对话已经不存在');
          const assistants = readAssistantInstances();
          if (assistants.some((candidate) => candidate.id === assistant.id)) return { result: { unchanged: true } };
          activeAssistantId = assistant.id;
          context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return assistantWorkspaceTransaction('挂载独立 AI 助手窗口', [...assistants, assistant]);
        },
      });
      context.commands.register<AssistantIdPayload>({
        type: 'ai.assistant.focus',
        validate: (payload): payload is AssistantIdPayload =>
          isRecord(payload) && typeof payload.assistantId === 'string' && payload.assistantId.length > 0,
        handle: (payload) => {
          const assistants = readAssistantInstances();
          if (!payload.assistantId || !assistants.some((item) => item.id === payload.assistantId)) {
            throw new Error('AI 助手窗口已经关闭');
          }
          activeAssistantId = payload.assistantId;
          context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return {
            result: { focused: true },
            transaction: {
              label: '恢复并聚焦 AI 助手',
              history: false,
              patches: assistantWorkspacePatches(assistants.map((assistant) =>
                assistant.id === payload.assistantId ? { ...assistant, minimized: false } : assistant)),
              events: [{ type: 'ai.assistant.focused', payload: { assistantId: payload.assistantId } }],
            },
          };
        },
      });
      context.commands.register<SessionIdPayload>({
        type: 'ai.assistant.openSession',
        validate: isSessionIdPayload,
        handle: (payload) => {
          const session = readSessions()[payload.sessionId];
          if (!session) throw new Error('AI 对话已经不存在');
          const assistants = readAssistantInstances();
          const opened = assistants.find((assistant) => assistant.sessionId === payload.sessionId);
          if (opened) {
            activeAssistantId = opened.id;
            context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
            return {
              result: { assistantId: opened.id, reopened: false },
              transaction: {
                label: '恢复已有 AI 对话窗口',
                history: false,
                patches: assistantWorkspacePatches(assistants.map((assistant) =>
                  assistant.id === opened.id ? { ...assistant, minimized: false } : assistant)),
                events: [{ type: 'ai.assistant.focused', payload: { assistantId: opened.id } }],
              },
            };
          }
          const assistant = createAssistant(payload.sessionId, 'chat', assistants.length, false);
          activeAssistantId = assistant.id;
          context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return {
            result: { assistantId: assistant.id, reopened: true },
            transaction: {
              ...assistantWorkspaceTransaction('重新打开 AI 对话', [...assistants, assistant]).transaction,
              events: [{ type: 'ai.assistant.focused', payload: { assistantId: assistant.id } }],
            },
          };
        },
      });
      const setAssistantResource = (
        label: string,
        payload: AssistantResourcePayload,
        key: 'providerProfileId' | 'promptTemplateId',
      ) => {
        const assistants = readAssistantInstances();
        if (!assistants.some((assistant) => assistant.id === payload.assistantId)) {
          throw new Error('AI 助手窗口已经关闭');
        }
        return assistantWorkspaceTransaction(label, assistants.map((assistant) =>
          assistant.id === payload.assistantId
            ? { ...assistant, [key]: payload.resourceId || undefined }
            : assistant));
      };
      context.commands.register<AssistantResourcePayload>({
        type: 'ai.assistant.setProvider',
        validate: isAssistantResourcePayload,
        handle: (payload) => setAssistantResource('切换当前 AI 助手的模型', payload, 'providerProfileId'),
      });
      context.commands.register<AssistantWebSearchPayload>({
        type: 'ai.assistant.setWebSearch',
        validate: isAssistantWebSearchPayload,
        handle: (payload) => {
          const assistants = readAssistantInstances();
          if (!assistants.some((assistant) => assistant.id === payload.assistantId)) {
            throw new Error('AI 助手窗口已经关闭');
          }
          return assistantWorkspaceTransaction('切换当前 AI 助手联网', assistants.map((assistant) =>
            assistant.id === payload.assistantId
              ? { ...assistant, webSearchEnabled: payload.enabled || undefined }
              : assistant));
        },
      });
      context.commands.register<AssistantContextModePayload>({
        type: 'ai.assistant.setContextMode',
        validate: isAssistantContextModePayload,
        handle: (payload) => {
          const assistants = readAssistantInstances();
          if (!assistants.some((assistant) => assistant.id === payload.assistantId)) {
            throw new Error('AI 助手窗口已经关闭');
          }
          return assistantWorkspaceTransaction(
            payload.mode === 'explicit-only' ? '限制当前 AI 助手上下文来源' : '恢复当前 AI 助手自动检索',
            assistants.map((assistant) => assistant.id === payload.assistantId
              ? { ...assistant, contextMode: payload.mode === 'explicit-only' ? payload.mode : undefined }
              : assistant),
          );
        },
      });
      context.commands.register<AssistantAutoMemoryCandidatesPayload>({
        type: 'ai.assistant.setAutoMemoryCandidates',
        validate: isAssistantAutoMemoryCandidatesPayload,
        handle: (payload) => {
          const assistants = readAssistantInstances();
          if (!assistants.some((assistant) => assistant.id === payload.assistantId)) {
            throw new Error('AI 助手窗口已经关闭');
          }
          return assistantWorkspaceTransaction(
            payload.enabled ? '开启 AI 自动提炼记忆候选' : '关闭 AI 自动提炼记忆候选',
            assistants.map((assistant) => assistant.id === payload.assistantId
              ? { ...assistant, autoMemoryCandidates: payload.enabled || undefined }
              : assistant),
          );
        },
      });
      context.commands.register<AssistantResourcePayload>({
        type: 'ai.assistant.setPromptTemplate',
        validate: isAssistantResourcePayload,
        handle: (payload) => setAssistantResource('切换当前 AI 助手的 Prompt 模板', payload, 'promptTemplateId'),
      });
      context.commands.register<AssistantMemoriesPayload>({
        type: 'ai.assistant.setMemories',
        validate: isAssistantMemoriesPayload,
        handle: (payload) => {
          const assistants = readAssistantInstances();
          if (!assistants.some((assistant) => assistant.id === payload.assistantId)) {
            throw new Error('AI 助手窗口已经关闭');
          }
          const memoryIndexes = readMemoryIndexes();
          const sourceIds = [...new Set(payload.sourceIds)];
          const missing = sourceIds.find((sourceId) => !memoryIndexes[sourceId]);
          if (missing) throw new Error('选择的记忆已经不存在，请刷新记忆中心');
          const unavailable = sourceIds.find((sourceId) => memoryIndexes[sourceId]?.enabled === false);
          if (unavailable) throw new Error('已暂停的记忆不能用于当前助手');
          return assistantWorkspaceTransaction('设置当前 AI 助手使用的记忆', assistants.map((assistant) =>
            assistant.id === payload.assistantId
              ? { ...assistant, memorySourceIds: sourceIds.length > 0 ? sourceIds : undefined }
              : assistant));
        },
      });
      context.commands.register<ContinueMemoryPayload>({
        type: 'ai.assistant.continueMemory',
        validate: isContinueMemoryPayload,
        handle: (payload) => {
          const memory = readMemoryIndexes()[payload.sourceId];
          if (!memory || memory.enabled === false) throw new Error('这份记忆当前不可用');
          const sessions = readSessions();
          if (!sessions[memory.sessionId]) {
            const current = readAssistantInstances().find((assistant) => assistant.id === payload.assistantId);
            if (!current) throw new Error('AI 助手窗口已经关闭');
            const now = Date.now();
            const restoredSession: AISessionRecord = {
              id: memory.sessionId,
              title: memory.title,
              transcriptSourceId: memory.sourceId,
              transcriptRevision: memory.sourceRevision,
              transcriptLength: memory.sourceLength,
              transcriptEntries: 0,
              revision: 1,
              turns: memory.sourceLength > 0 ? 1 : 0,
              createdAt: memory.createdAt,
              updatedAt: now,
              savedAt: memory.updatedAt ?? memory.createdAt,
              savedTranscriptRevision: memory.sourceRevision,
            };
            const assistant = {
              ...createAssistant(restoredSession.id, 'chat', readAssistantInstances().length, false),
              memorySourceIds: [memory.sourceId],
            };
            activeAssistantId = assistant.id;
            context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
            return {
              result: { assistantId: assistant.id, reused: false, restored: true },
              transaction: {
                label: '从原文记忆恢复 AI 对话',
                history: false,
                patches: [{
                  op: 'set' as const,
                  domain: 'document' as const,
                  namespace: AI_SESSION_NAMESPACE,
                  key: restoredSession.id,
                  value: restoredSession,
                }],
                events: [{
                  type: 'ai.session.initialized',
                  payload: { id: restoredSession.id, assistant, restoredFromMemory: memory.sourceId },
                }],
              },
            };
          }
          const assistants = readAssistantInstances();
          const alreadyOpen = assistants.find((assistant) => assistant.sessionId === memory.sessionId);
          if (alreadyOpen) {
            activeAssistantId = alreadyOpen.id;
            context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
            return {
              result: { assistantId: alreadyOpen.id, reused: true },
              transaction: {
                label: '继续已有 AI 记忆',
                history: false,
                patches: assistantWorkspacePatches(assistants.map((assistant) =>
                  assistant.id === alreadyOpen.id
                    ? { ...assistant, minimized: false, view: 'chat' as const, memorySourceIds: [memory.sourceId] }
                    : assistant)),
                events: [{ type: 'ai.assistant.focused', payload: { assistantId: alreadyOpen.id } }],
              },
            };
          }
          const current = assistants.find((assistant) => assistant.id === payload.assistantId);
          if (!current) throw new Error('AI 助手窗口已经关闭');
          const currentSession = sessions[current.sessionId];
          const currentAlreadyArchived = Object.values(readMemoryIndexes()).some((item) =>
            item.sessionId === current.sessionId);
          const keepCurrent = Boolean(currentSession?.turns && !currentAlreadyArchived);
          const continued = keepCurrent
            ? {
                ...createAssistant(memory.sessionId, 'chat', assistants.length, false),
                memorySourceIds: [memory.sourceId],
              }
            : {
                ...current,
                sessionId: memory.sessionId,
                view: 'chat' as const,
                minimized: false,
                draft: '',
                memorySourceIds: [memory.sourceId],
              };
          const next = keepCurrent
            ? [...assistants, continued]
            : assistants.map((assistant) => assistant.id === current.id ? continued : assistant);
          activeAssistantId = continued.id;
          context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return {
            result: { assistantId: continued.id, reused: false },
            transaction: {
              label: '继续选中的 AI 记忆',
              history: false,
              patches: assistantWorkspacePatches(next),
              events: [{ type: 'ai.assistant.focused', payload: { assistantId: continued.id } }],
            },
          };
        },
      });
      context.commands.register<AssistantIdPayload>({
        type: 'ai.assistant.activate',
        validate: (payload): payload is AssistantIdPayload =>
          isRecord(payload) && typeof payload.assistantId === 'string' && payload.assistantId.length > 0,
        handle: (payload) => {
          if (!readAssistantInstances().some((item) => item.id === payload.assistantId)) return { result: false };
          activeAssistantId = payload.assistantId;
          context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return { result: true };
        },
      });
      context.commands.register({
        type: 'ai.openProviderSettings',
        handle: async () => {
          const result = await openAssistant('provider');
          const assistants = readAssistantInstances();
          activeAssistantId = assistants.find((item) => item.id === activeAssistantId)?.id ?? assistants[0]?.id;
          context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return result;
        },
      });
      context.commands.register<AssistantIdPayload | undefined>({
        type: 'ai.close',
        validate: isAssistantIdPayload,
        handle: (payload) => {
          const assistants = readAssistantInstances();
          const targetId = payload?.assistantId ??
            assistants.find((assistant) => assistant.id === activeAssistantId)?.id ??
            assistants.at(-1)?.id;
          const next = targetId ? assistants.map((assistant) => assistant.id === targetId
            ? { ...assistant, minimized: true, draft: composerDrafts.get(assistant.id) ?? assistant.draft }
            : assistant) : assistants;
          const visible = next.filter((assistant) => assistant.minimized !== true);
          activeAssistantId = visible.at(-1)?.id;
          if (visible.length === 0) context.ui.deactivateSurface('overlay.floating', 'ai.panel');
          else context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return assistantWorkspaceTransaction('最小化 AI 助手', next);
        },
      });
      context.commands.register<SessionIdPayload>({
        type: 'ai.assistant.removeDeletedWindow',
        validate: isSessionIdPayload,
        handle: (payload) => {
          const next = readAssistantInstances().filter((assistant) => assistant.sessionId !== payload.sessionId);
          const visible = next.filter((assistant) => assistant.minimized !== true);
          activeAssistantId = visible.at(-1)?.id;
          if (visible.length === 0) context.ui.deactivateSurface('overlay.floating', 'ai.panel');
          else context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
          return assistantWorkspaceTransaction('清理已删除的 AI 助手窗口', next);
        },
      });
      const deleteSession = (sessionId: string, assistantId?: string) => {
          const session = readSessions()[sessionId];
          if (!session) return { result: { deleted: false } };
          generationTasks.get(sessionId)?.cancel();
          preparationTasks.get(sessionId)?.cancel();
          memoryTasks.get(sessionId)?.cancel();
          memoryCandidateTasks.get(sessionId)?.cancel();
          autoSaveDelayTasks.get(sessionId)?.cancel();
          generationTasks.delete(sessionId);
          preparationTasks.delete(sessionId);
          memoryTasks.delete(sessionId);
          memoryCandidateTasks.delete(sessionId);
          autoSaveDelayTasks.delete(sessionId);
          generationRuntimeBySession.delete(sessionId);
          generationActionBySession.delete(sessionId);
          lastPrepareRequestBySession.delete(sessionId);
          for (const [id, prepared] of preparations) {
            if (prepared.sessionId === sessionId) preparations.delete(id);
          }
          const transcriptChunks = context.store.readNamespace<Record<string, AITranscriptChunkRecord>>(AI_TRANSCRIPT_NAMESPACE);
          const proposals = readProposals();
          const responseDetails = readResponseDetails();
          const memoryCandidates = readMemoryCandidates();
          return {
            result: { deleted: true },
            transaction: {
              label: '删除独立 AI 助手及其当前对话',
              patches: [
                { op: 'delete' as const, domain: 'document' as const, namespace: AI_SESSION_NAMESPACE, key: sessionId },
                ...Object.entries(transcriptChunks).filter(([, chunk]) => chunk.sessionId === sessionId).map(([key]) => ({
                  op: 'delete' as const,
                  domain: 'document' as const,
                  namespace: AI_TRANSCRIPT_NAMESPACE,
                  key,
                })),
                ...Object.entries(proposals).filter(([, proposal]) => proposal.sessionId === sessionId).map(([key]) => ({
                  op: 'delete' as const,
                  domain: 'document' as const,
                  namespace: AI_PROPOSAL_NAMESPACE,
                  key,
                })),
                ...Object.entries(responseDetails).filter(([, detail]) => detail.sessionId === sessionId).map(([key]) => ({
                  op: 'delete' as const,
                  domain: 'document' as const,
                  namespace: AI_RESPONSE_NAMESPACE,
                  key,
                })),
                ...Object.entries(memoryCandidates).filter(([, candidate]) => candidate.sessionId === sessionId).map(([key]) => ({
                  op: 'delete' as const,
                  domain: 'document' as const,
                  namespace: AI_MEMORY_CANDIDATE_NAMESPACE,
                  key,
                })),
              ],
              events: [{ type: 'ai.assistant.deleted', payload: { assistantId, sessionId } }],
            },
          };
      };
      context.commands.register<AssistantIdPayload>({
        type: 'ai.assistant.delete',
        validate: (payload): payload is AssistantIdPayload =>
          isRecord(payload) && typeof payload.assistantId === 'string' && payload.assistantId.length > 0,
        handle: (payload) => {
          const assistants = readAssistantInstances();
          const removed = assistants.find((assistant) => assistant.id === payload.assistantId);
          if (!removed) return { result: { deleted: false } };
          return deleteSession(removed.sessionId, removed.id);
        },
      });
      context.commands.register<SessionIdPayload>({
        type: 'ai.assistant.deleteSession',
        validate: isSessionIdPayload,
        handle: (payload) => {
          const assistant = readAssistantInstances().find((item) => item.sessionId === payload.sessionId);
          return deleteSession(payload.sessionId, assistant?.id);
        },
      });
      context.commands.register<AIAssistantView | AssistantViewPayload>({
        type: 'ai.setView',
        validate: isAssistantViewCommandPayload,
        handle: (payload) => {
          const view = typeof payload === 'string' ? payload : payload.view;
          const assistantId = typeof payload === 'string' ? undefined : payload.assistantId;
          const assistants = readAssistantInstances();
          return assistantWorkspaceTransaction('切换 AI 助手视图', assistants.map((assistant, index) =>
            assistant.id === assistantId || (!assistantId && index === 0) ? { ...assistant, view } : assistant));
        },
      });
      context.commands.register<FloatingPanelRect | AssistantRectPayload>({
        type: 'ai.setPanelRect',
        validate: isAssistantRectCommandPayload,
        handle: (payload) => {
          const rectPayload = isFloatingRect(payload) ? payload : payload.rect;
          const assistantId = isFloatingRect(payload) ? undefined : payload.assistantId;
          return assistantWorkspaceTransaction('调整 AI 助手窗口', readAssistantInstances().map((assistant, index) =>
            assistant.id === assistantId || (!assistantId && index === 0)
              ? { ...assistant, rect: normalizeFloatingRect(rectPayload, DEFAULT_AI_RECT) }
              : assistant));
        },
      });
      context.commands.register<ComposerHeightPayload>({
        type: 'ai.setComposerHeight',
        validate: isComposerHeightPayload,
        handle: (payload) => {
          return assistantWorkspaceTransaction('调整 AI 输入框高度', readAssistantInstances().map((assistant, index) =>
            assistant.id === payload.assistantId || (!payload.assistantId && index === 0)
              ? { ...assistant, composerHeight: normalizeAIComposerHeight(payload.height, assistant.rect.height) }
              : assistant));
        },
      });
      const promptTemplateRuntime = registerPromptTemplateRuntime(context, readPromptTemplates);
      context.commands.register<SaveSessionPayload | undefined, { taskId: string }>({
        type: 'ai.session.save',
        validate: isSaveSessionPayload,
        handle: (payload = {}) => {
          const sessionId = payload.sessionId ?? context.store.readValue<string>(AI_UI_NAMESPACE, 'activeSessionId');
          const session = sessionId ? readSessions()[sessionId] : undefined;
          if (!session) throw new Error('AI 对话已经不存在');
          if (session.turns === 0) throw new Error('当前对话还没有可以保存的内容');
          const transcriptRevision = session.transcriptSourceId
            ? undefined
            : Math.max(0, session.transcriptRevision ?? 0);
          if (payload.automatic && session.savedTranscriptRevision === transcriptRevision) {
            return { result: { taskId: 'already-saved' } };
          }
          const activeMemoryTask = memoryTasks.get(session.id);
          if (payload.automatic && activeMemoryTask) return { result: { taskId: activeMemoryTask.id } };
          if (!payload.automatic) {
            autoSaveDelayTasks.get(session.id)?.cancel();
            autoSaveDelayTasks.delete(session.id);
          }
          activeMemoryTask?.cancel();
          if (!payload.automatic) {
            context.signals.emit('ai.status', {
              state: 'indexing',
              message: '正在保存对话并建立关键索引',
              sessionId: session.id,
            } satisfies AIStatusSignal);
          }
          const previousMemoryCommit = memoryCommitQueue;
          let releaseMemoryCommit!: () => void;
          memoryCommitQueue = new Promise<void>((resolve) => {
            releaseMemoryCommit = resolve;
          });
          const task = context.tasks.schedule<PreparedMemoryCommit>({
            category: 'ai-memory-index',
            label: '正在建立对话关键索引',
            priority: 12,
            timeoutMs: 3 * 60_000,
            estimatedCost: 5,
            run: async (signal, report, control) => {
              await previousMemoryCommit;
              signal.throwIfAborted();
              return prepareMemoryCommit(
                context,
                session,
                signal,
                report,
                control.waitIfPaused,
                payload.automatic,
              );
            },
          });
          memoryTasks.set(session.id, task);
          void task.result.then(
            async (prepared) => {
              memoryCommitPreparations.set(prepared.id, prepared);
              await context.commands.dispatch('ai.session.memory.commit', { preparationId: prepared.id });
              if (!payload.automatic) {
                context.signals.emit('ai.status', {
                  state: 'complete',
                  message: `对话原文与索引已保存，索引包含 ${prepared.index.keywords.length} 个词`,
                  sessionId: session.id,
                } satisfies AIStatusSignal);
              }
            },
          ).catch((error) => {
            if (isAbortError(error)) return;
            if (!payload.automatic) {
                context.signals.emit('ai.status', {
                  state: 'error',
                  message: error instanceof Error ? error.message : String(error),
                  sessionId: session.id,
                } satisfies AIStatusSignal);
              }
          }).finally(() => {
            if (memoryTasks.get(session.id) === task) memoryTasks.delete(session.id);
            releaseMemoryCommit();
          });
          return { result: { taskId: task.id } };
        },
      });
      context.commands.register({
        type: 'ai.session.memory.commit',
        validate: isCommitMemoryRequest,
        handle: async (payload) => {
          const prepared = memoryCommitPreparations.get(payload.preparationId);
          memoryCommitPreparations.delete(payload.preparationId);
          if (!prepared) throw new Error('对话保存准备已经失效，请重新保存');
          const session = readSessions()[prepared.sessionId];
          if (!session) throw new Error('AI 对话已经不存在');
          if (session.revision !== prepared.expectedSessionRevision) {
            throw new Error('准备保存期间对话状态发生变化，请重新保存');
          }
          const transcriptSourceId = sessionTranscriptSourceId(session);
          const currentRevision = await readSourceRevision(context, transcriptSourceId);
          if (currentRevision !== prepared.expectedSourceRevision) {
            throw new Error('建立索引期间对话内容发生变化，请重新保存');
          }
          const existingMemory = Object.values(readMemoryIndexes())
            .find((item) => item.sessionId === session.id);
          if (prepared.expectedMemory) {
            if (existingMemory?.sourceId !== prepared.expectedMemory.sourceId ||
              (existingMemory.updatedAt ?? 0) !== prepared.expectedMemory.updatedAt) {
              throw new Error('准备保存期间记忆记录发生变化，请重新保存');
            }
          } else if (existingMemory) {
            throw new Error('准备保存期间已经建立了另一份记忆，请重新保存');
          }
          const targets = prepared.expectedTargets.length > 0
            ? await context.capabilities.request<ContentSummary[]>('content.summariesById@1', {
                nodeIds: prepared.expectedTargets.map((target) => target.id),
              })
            : [];
          const byId = new Map(targets.map((target) => [target.id, target]));
          for (const expected of prepared.expectedTargets) {
            if (byId.get(expected.id)?.revision !== expected.revision) {
              throw new Error('准备保存期间原文或索引节点发生变化，请重新保存');
            }
          }
          if (prepared.createdTitles.length > 0) {
            const occupied = new Set(
              (await context.capabilities.request<ContentSummary[]>('content.summaries@1'))
                .map((summary) => summary.title.trim().toLocaleLowerCase('zh-CN')),
            );
            if (prepared.createdTitles.some((title) => occupied.has(title.trim().toLocaleLowerCase('zh-CN')))) {
              throw new Error('准备保存期间节点标题发生冲突，请重新保存');
            }
          }
          return {
            result: { archiveNodeId: prepared.archiveNodeId, indexNodeId: prepared.indexNodeId },
            transaction: {
              label: prepared.label,
              patches: prepared.patches,
              events: prepared.events,
              ...(prepared.automatic
                ? { mergeKey: `ai-conversation-autosave:${prepared.sessionId}`, mergeWindowMs: 30 * 60_000 }
                : {}),
            },
          };
        },
      });
      registerAIRequestRuntime(context, {
        preparations,
        preparationTasks,
        generationTasks,
        generationStateBySession: generationRuntimeBySession,
        generationActionBySession,
        lastPrepareRequestBySession,
        lastMemoryUseBySession,
        readSessions,
        readMemoryIndexes,
        readAssistantInstances,
      });
      registerAIMemoryCandidateRuntime(context, {
        tasks: memoryCandidateTasks,
        readSessions,
        readCandidates: readMemoryCandidates,
        readMemoryIndexes,
        readAssistantInstances,
      });
      registerAIProposalRuntime(context, {
        readSessions,
        readProposals,
        requirePreparation: (id) => requirePreparedContext(preparations, id),
      });
      registerAIMemoryManagementRuntime({
        context,
        readMemoryIndexes,
        readSessions,
        setMemoryDirectory: (directory) => {
          releaseMemoryDirectoryLease?.();
          memoryDirectory = directory;
          memoryFileError = undefined;
          releaseMemoryDirectoryLease = context.resources.track('file', () => {
            if (memoryDirectory === directory) memoryDirectory = undefined;
          });
        },
        scheduleMemoryFileExport,
        invalidateState,
        memoryFileImportTasks,
        memoryFileImportPreparations,
        pendingMemoryDeletion,
        publishPendingMemoryDeletion,
        scheduleMemoryRebuild,
      });

      registerAIQueryRuntime(context, {
        preparations,
        readState,
        readPromptTemplates,
        readMemoryIndexes,
        readSessions,
      });

      registerAIGenerationRuntime(context, {
        preparations,
        tasks: generationTasks,
        stateBySession: generationRuntimeBySession,
        actionBySession: generationActionBySession,
        readPromptTemplates,
        readMemoryIndexes,
        readSessions,
        shouldAutoExtractMemoryCandidates: (prepared) => readAssistantInstances().some((assistant) =>
          assistant.id === prepared.assistantId && assistant.autoMemoryCandidates === true),
      });
      registerAIEventRuntime(context, {
        readSessions,
        readMemoryIndexes,
        readAssistantInstances,
        scheduleConversationAutosave,
        scheduleMemoryRebuild,
        scheduleMemoryFileExport,
        scheduleOutdatedMemoryRebuilds,
        rescheduleConversationAutosaves: () => {
          for (const sessionId of autoSaveDelayTasks.keys()) {
            void scheduleConversationAutosave(sessionId, true).catch((error) => {
              context.diagnostics.warn('更新 AI 对话自动保存时间失败', error);
            });
          }
        },
        rememberPreviousFileStem: (sourceId, stem) => {
          const stems = previousMemoryFileStems.get(sourceId) ?? new Set<string>();
          stems.add(stem);
          previousMemoryFileStems.set(sourceId, stems);
        },
        rememberComposerDraft: (assistantId, draft) => composerDrafts.set(assistantId, draft),
        resetTransientRuntime: () => {
          for (const task of preparationTasks.values()) task.cancel();
          for (const task of generationTasks.values()) task.cancel();
          for (const task of memoryTasks.values()) task.cancel();
          for (const task of autoSaveDelayTasks.values()) task.cancel();
          for (const task of memoryRebuildTasks.values()) task.cancel();
          for (const task of memoryFileTasks.values()) task.cancel();
          for (const task of memoryFileImportTasks.values()) task.cancel();
          preparationTasks.clear();
          generationTasks.clear();
          memoryTasks.clear();
          memoryCommitPreparations.clear();
          autoSaveDelayTasks.clear();
          memoryRebuildTasks.clear();
          memoryFileTasks.clear();
          previousMemoryFileStems.clear();
          memoryFileImportTasks.clear();
          memoryFileImportPreparations.clear();
          for (const task of memoryCandidateTasks.values()) task.cancel();
          memoryCandidateTasks.clear();
          generationRuntimeBySession.clear();
          generationActionBySession.clear();
          lastPrepareRequestBySession.clear();
          preparations.clear();
        },
        memoryAutoReindexDelayMs: MEMORY_AUTO_REINDEX_DELAY_MS,
      });
      registerAIAssistantUI(context, panel, toolbar, memoryDeleteDialog);
      const restoredAssistants = readAssistantInstances();
      if (restoredAssistants.length > 0) {
        activeAssistantId = restoredAssistants.at(-1)?.id;
        context.ui.activateSurface('overlay.floating', 'ai.panel', 'ai.close');
      }
      promptTemplateRuntime.restorePersonal();
      void context.queries.ask<unknown>('system.preferences.get', { key: PERSONAL_AI_MEMORY_DIRECTORY_KEY })
        .then(async (value) => {
          if (generation !== lifecycleGeneration) return;
          if (!isFileDirectoryTarget(value)) return;
          if (!await canReusePersistedFileHandle(value)) return;
          if (generation !== lifecycleGeneration) return;
          releaseMemoryDirectoryLease?.();
          memoryDirectory = value;
          memoryFileError = undefined;
          releaseMemoryDirectoryLease = context.resources.track('file', () => {
            if (memoryDirectory === value) memoryDirectory = undefined;
          });
          invalidateState();
        })
        .catch((error) => context.diagnostics.warn('读取本机 AI 记忆文件夹授权失败', error));
      void scheduleOutdatedMemoryRebuilds().catch((error) => {
        context.diagnostics.warn('启动时检查记忆索引失败', error);
      });
      for (const session of Object.values(readSessions())) {
        void scheduleConversationAutosave(session.id).catch((error) => {
          context.diagnostics.warn('恢复 AI 对话自动保存失败', error);
        });
      }
    },

    stop(context) {
      lifecycleGeneration += 1;
      releaseMemoryDirectoryLease?.();
      releaseMemoryDirectoryLease = undefined;
      memoryDirectory = undefined;
      memoryFileError = undefined;
      context.ui.deactivateSurface('overlay.modal', 'ai.memory.deleteConfirm');
      for (const task of preparationTasks.values()) task.cancel();
      for (const task of generationTasks.values()) task.cancel();
      for (const task of memoryTasks.values()) task.cancel();
      for (const task of autoSaveDelayTasks.values()) task.cancel();
      for (const task of memoryRebuildTasks.values()) task.cancel();
      for (const task of memoryFileTasks.values()) task.cancel();
      for (const task of memoryFileImportTasks.values()) task.cancel();
      for (const task of memoryCandidateTasks.values()) task.cancel();
      preparationTasks.clear();
      generationTasks.clear();
      memoryTasks.clear();
      memoryCommitPreparations.clear();
      autoSaveDelayTasks.clear();
      memoryRebuildTasks.clear();
      memoryFileTasks.clear();
      memoryFileImportTasks.clear();
      memoryFileImportPreparations.clear();
      memoryCandidateTasks.clear();
      generationRuntimeBySession.clear();
      generationActionBySession.clear();
      lastPrepareRequestBySession.clear();
      preparations.clear();
    },
  };
}
