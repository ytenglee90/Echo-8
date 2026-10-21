import type {
  CommandOutcome,
  PluginContext,
  TaskHandle,
} from '../../core/contracts.ts';
import type {
  AIMemoryIndexRecord,
  AISessionRecord,
  AIStatusSignal,
} from '../../protocols/ai.ts';
import type {
  ContentCreatePlanRequest,
  ContentDeltaPlanRequest,
  ContentMutationPlan,
  ContentPlacementPlanRequest,
  ContentRenamePlan,
  ContentRenamePlanRequest,
  ContentSummary,
} from '../../protocols/content.ts';
import type { FileDirectoryTarget } from '../../protocols/files.ts';
import type { EntityDeletePlan } from '../../protocols/selection.ts';
import {
  createMemoryFileStem,
  formatMemoryIndexText,
  memoryIndexTitle,
  normalizeMemoryField,
} from './memory-artifacts.ts';
import { AI_MEMORY_NAMESPACE } from './memory-commit.ts';
import {
  prepareMemoryFileImport,
  type PreparedMemoryFileImport,
} from './memory-file-io.ts';
import { isAbortError } from './runtime-errors.ts';
import { PERSONAL_AI_MEMORY_DIRECTORY_KEY } from './memory-protocol.ts';
import { AI_SESSION_NAMESPACE } from './transcript-storage.ts';
import {
  isCommitMemoryFileImportPayload,
  isCommitMemoryRebuildPayload,
  isImportMemoryFilesPayload,
  isLinkMemoryDirectoryPayload,
  isMemoryIdPayload,
  isRenameMemoryPayload,
  isSetMemoryEnabledPayload,
  isSetMemoryScopePayload,
  type CommitMemoryFileImportPayload,
  type CommitMemoryRebuildPayload,
  type ImportMemoryFilesPayload,
  type LinkMemoryDirectoryPayload,
  type MemoryIdPayload,
  type RenameMemoryPayload,
  type SetMemoryEnabledPayload,
  type SetMemoryScopePayload,
} from './command-payloads.ts';

export interface MemoryManagementRuntime {
  context: PluginContext;
  readMemoryIndexes: () => Record<string, AIMemoryIndexRecord>;
  readSessions: () => Record<string, AISessionRecord>;
  setMemoryDirectory: (directory: FileDirectoryTarget) => void;
  scheduleMemoryFileExport: (
    memory: AIMemoryIndexRecord,
    previousStem?: string,
  ) => TaskHandle<void> | undefined;
  invalidateState: () => void;
  memoryFileImportTasks: Map<string, TaskHandle<PreparedMemoryFileImport>>;
  memoryFileImportPreparations: Map<string, PreparedMemoryFileImport>;
  pendingMemoryDeletion: { sourceId?: string };
  publishPendingMemoryDeletion: () => void;
  scheduleMemoryRebuild: (
    memory: AIMemoryIndexRecord,
    options: { automatic: boolean; delayMs?: number },
  ) => TaskHandle<CommitMemoryRebuildPayload>;
}

export function registerAIMemoryManagementRuntime({
  context,
  readMemoryIndexes,
  readSessions,
  setMemoryDirectory,
  scheduleMemoryFileExport,
  invalidateState,
  memoryFileImportTasks,
  memoryFileImportPreparations,
  pendingMemoryDeletion,
  publishPendingMemoryDeletion,
  scheduleMemoryRebuild,
}: MemoryManagementRuntime): void {
      context.commands.register<SetMemoryEnabledPayload>({
        type: 'ai.memory.setEnabled',
        validate: isSetMemoryEnabledPayload,
        handle: (payload) => {
          const memory = readMemoryIndexes()[payload.sourceId];
          if (!memory) throw new Error('记忆已经不存在');
          if ((memory.enabled !== false) === payload.enabled) return { result: { unchanged: true } };
          return {
            transaction: {
              label: payload.enabled ? '启用 AI 记忆' : '暂停 AI 记忆',
              patches: [{
                op: 'set', domain: 'document', namespace: AI_MEMORY_NAMESPACE, key: memory.sourceId,
                value: { ...memory, enabled: payload.enabled, updatedAt: Date.now() },
              }],
              events: [{ type: 'ai.memory.updated', payload: { sourceId: memory.sourceId, enabled: payload.enabled } }],
            },
          };
        },
      });
      context.commands.register<SetMemoryScopePayload>({
        type: 'ai.memory.setScope',
        validate: isSetMemoryScopePayload,
        handle: (payload) => {
          const memory = readMemoryIndexes()[payload.sourceId];
          if (!memory) throw new Error('记忆已经不存在');
          const scope = normalizeMemoryField(payload.scope, 80);
          return {
            transaction: {
              label: '修改 AI 记忆适用范围',
              patches: [{
                op: 'set', domain: 'document', namespace: AI_MEMORY_NAMESPACE, key: memory.sourceId,
                value: { ...memory, scope: scope || undefined, updatedAt: Date.now() },
              }],
              events: [{ type: 'ai.memory.updated', payload: { sourceId: memory.sourceId, scope } }],
            },
          };
        },
      });
      context.commands.register<RenameMemoryPayload>({
        type: 'ai.memory.rename',
        validate: isRenameMemoryPayload,
        handle: async (payload) => {
          const memory = readMemoryIndexes()[payload.sourceId];
          if (!memory) throw new Error('记忆已经不存在');
          const title = payload.title.trim();
          if (!title) throw new Error('记忆标题不能为空');
          const duplicate = Object.values(readMemoryIndexes()).some((item) =>
            item.sourceId !== memory.sourceId && item.title.trim().toLocaleLowerCase('zh-CN') === title.toLocaleLowerCase('zh-CN'));
          if (duplicate) throw new Error(`记忆标题“${title}”已经存在，请换一个名称`);
          if (title === memory.title) return { result: { unchanged: true } };
          const session = readSessions()[memory.sessionId];
          const targetIds = [memory.sourceId, memory.indexNodeId].filter(Boolean) as string[];
          const summaries = await context.capabilities.request<ContentSummary[]>('content.summariesById@1', {
            nodeIds: targetIds,
          });
          const byId = new Map(summaries.map((summary) => [summary.id, summary]));
          const sourceSummary = byId.get(memory.sourceId);
          if (!sourceSummary) throw new Error('记忆原文已经不存在，无法改名');
          const sourceRename = await context.capabilities.request<ContentRenamePlan>('content.renamePlan@1', {
            nodeId: memory.sourceId,
            title,
            expectedNodeRevision: sourceSummary.nodeRevision,
          } satisfies ContentRenamePlanRequest);
          const indexRename = memory.indexNodeId
            ? await context.capabilities.request<ContentRenamePlan>('content.renamePlan@1', {
                nodeId: memory.indexNodeId,
                title: memoryIndexTitle(title),
                expectedNodeRevision: byId.get(memory.indexNodeId)?.nodeRevision,
                reservedTitles: [sourceRename.resolvedTitle],
              } satisfies ContentRenamePlanRequest)
            : undefined;
          const updatedAt = Date.now();
          const previousFileStem = memory.localFileStem ?? createMemoryFileStem(memory.title, memory.sourceId);
          const localFileStem = createMemoryFileStem(sourceRename.resolvedTitle, memory.sourceId);
          return {
            result: { title: sourceRename.resolvedTitle },
            transaction: {
              label: '修改 AI 记忆标题',
              patches: [
                ...sourceRename.patches,
                ...(indexRename?.patches ?? []),
                {
                  op: 'set', domain: 'document', namespace: AI_MEMORY_NAMESPACE, key: memory.sourceId,
                  value: { ...memory, title: sourceRename.resolvedTitle, localFileStem, updatedAt },
                },
                ...(session ? [{
                  op: 'set' as const, domain: 'document' as const, namespace: AI_SESSION_NAMESPACE, key: session.id,
                  value: { ...session, title: sourceRename.resolvedTitle, revision: session.revision + 1, updatedAt },
                }] : []),
              ],
              events: [
                ...(sourceRename.events ?? []),
                ...(indexRename?.events ?? []),
                {
                  type: 'ai.memory.updated',
                  payload: { sourceId: memory.sourceId, action: 'rename', previousFileStem, localFileStem },
                },
              ],
            },
          };
        },
      });
      context.commands.register<LinkMemoryDirectoryPayload, { linked: true; count: number }>({
        type: 'ai.memory.linkDirectory',
        validate: isLinkMemoryDirectoryPayload,
        handle: (payload) => {
          setMemoryDirectory(payload.directory);
          context.commands.defer('system.preferences.set', {
            key: PERSONAL_AI_MEMORY_DIRECTORY_KEY,
            value: payload.directory,
          });
          const memories = Object.values(readMemoryIndexes());
          for (const memory of memories) scheduleMemoryFileExport(memory);
          invalidateState();
          return { result: { linked: true, count: memories.length } };
        },
      });
      context.commands.register<ImportMemoryFilesPayload, { taskId: string }>({
        type: 'ai.memory.importFiles',
        validate: isImportMemoryFilesPayload,
        handle: (payload) => {
          const task = context.tasks.schedule<PreparedMemoryFileImport>({
            category: 'ai-memory-file-import',
            label: '正在重新关联本地 AI 记忆',
            priority: 8,
            timeoutMs: 5 * 60_000,
            noticeAfterMs: 800,
            estimatedCost: Math.max(1, payload.sources.length),
            run: (signal, report, control) => prepareMemoryFileImport(
              context,
              payload.sources,
              readMemoryIndexes(),
              signal,
              report,
              control.waitIfPaused,
            ),
          });
          memoryFileImportTasks.set(task.id, task);
          void task.result.then(
            async (prepared) => {
              memoryFileImportPreparations.set(prepared.id, prepared);
              await context.commands.dispatch('ai.memory.importFiles.commit', {
                preparationId: prepared.id,
              });
              context.signals.emit('ai.status', {
                state: 'complete',
                message: `已经重新关联 ${prepared.count} 份本地记忆`,
              } satisfies AIStatusSignal);
            },
            (reason) => {
              if (isAbortError(reason)) return;
              context.signals.emit('ai.status', {
                state: 'error',
                message: reason instanceof Error ? reason.message : String(reason),
              } satisfies AIStatusSignal);
            },
          ).finally(() => memoryFileImportTasks.delete(task.id));
          return { result: { taskId: task.id } };
        },
      });
      context.commands.register<CommitMemoryFileImportPayload, { imported: number }>({
        type: 'ai.memory.importFiles.commit',
        validate: isCommitMemoryFileImportPayload,
        handle: (payload) => {
          const prepared = memoryFileImportPreparations.get(payload.preparationId);
          if (!prepared) throw new Error('本地记忆重新关联准备已经失效');
          memoryFileImportPreparations.delete(payload.preparationId);
          return {
            result: { imported: prepared.count },
            transaction: {
              label: `重新关联 ${prepared.count} 份本地 AI 记忆`,
              patches: prepared.patches,
              events: prepared.events,
            },
          };
        },
      });
      const deleteMemory = async (payload: MemoryIdPayload): Promise<CommandOutcome<{ deleted: boolean }>> => {
        const memory = readMemoryIndexes()[payload.sourceId];
        if (!memory) return { result: { deleted: false } };
        const ids = [memory.sourceId, memory.indexNodeId].filter(Boolean) as string[];
        const plans = await context.capabilities.requestAll<EntityDeletePlan>('entity.deletePlan@1', { ids });
        const session = readSessions()[memory.sessionId];
        const sessionPatch = session ? [{
          op: 'set' as const,
          domain: 'document' as const,
          namespace: AI_SESSION_NAMESPACE,
          key: session.id,
          value: {
            ...session,
            savedAt: undefined,
            // Do not recreate the deleted memory until this conversation changes again.
            savedTranscriptRevision: session.transcriptRevision,
            revision: session.revision + 1,
            updatedAt: Date.now(),
          },
        }] : [];
        return {
          result: { deleted: true },
          transaction: {
            label: `删除 AI 记忆“${memory.title}”`,
            patches: [
              ...plans.flatMap((plan) => plan.patches),
              { op: 'delete', domain: 'document', namespace: AI_MEMORY_NAMESPACE, key: memory.sourceId },
              ...sessionPatch,
            ],
            events: [
              ...plans.flatMap((plan) => plan.events ?? []),
              { type: 'ai.memory.updated', payload: { sourceId: memory.sourceId, deleted: true } },
            ],
          },
        };
      };
      context.commands.register<MemoryIdPayload, { opened: boolean }>({
        type: 'ai.memory.delete.request',
        validate: isMemoryIdPayload,
        handle: (payload) => {
          if (!readMemoryIndexes()[payload.sourceId]) return { result: { opened: false } };
          pendingMemoryDeletion.sourceId = payload.sourceId;
          context.ui.activateSurface('overlay.modal', 'ai.memory.deleteConfirm', 'ai.memory.delete.cancel');
          publishPendingMemoryDeletion();
          return { result: { opened: true } };
        },
      });
      context.commands.register<undefined, { cancelled: boolean }>({
        type: 'ai.memory.delete.cancel',
        handle: () => {
          if (!pendingMemoryDeletion.sourceId) return { result: { cancelled: false } };
          pendingMemoryDeletion.sourceId = undefined;
          context.ui.deactivateSurface('overlay.modal', 'ai.memory.deleteConfirm');
          publishPendingMemoryDeletion();
          return { result: { cancelled: true } };
        },
      });
      context.commands.register<MemoryIdPayload, { deleted: boolean }>({
        type: 'ai.memory.delete.confirm',
        validate: isMemoryIdPayload,
        handle: async (payload) => {
          if (pendingMemoryDeletion.sourceId !== payload.sourceId) {
            throw new Error('删除确认已经失效，请重新选择记忆');
          }
          const result = await deleteMemory(payload);
          pendingMemoryDeletion.sourceId = undefined;
          context.ui.deactivateSurface('overlay.modal', 'ai.memory.deleteConfirm');
          publishPendingMemoryDeletion();
          return result;
        },
      });
      context.commands.register<MemoryIdPayload, { deleted: boolean }>({
        type: 'ai.memory.delete',
        validate: isMemoryIdPayload,
        handle: async (payload) => {
          const result = await deleteMemory(payload);
          if (pendingMemoryDeletion.sourceId === payload.sourceId) {
            pendingMemoryDeletion.sourceId = undefined;
            context.ui.deactivateSurface('overlay.modal', 'ai.memory.deleteConfirm');
            publishPendingMemoryDeletion();
          }
          return result;
        },
      });
      context.commands.register<MemoryIdPayload, { taskId: string }>({
        type: 'ai.memory.rebuild',
        validate: isMemoryIdPayload,
        handle: (payload) => {
          const memory = readMemoryIndexes()[payload.sourceId];
          if (!memory) throw new Error('记忆已经不存在');
          const task = scheduleMemoryRebuild(memory, { automatic: false });
          return { result: { taskId: task.id } };
        },
      });
      context.commands.register<CommitMemoryRebuildPayload>({
        type: 'ai.memory.rebuild.commit',
        validate: isCommitMemoryRebuildPayload,
        handle: async (payload) => {
          const memory = readMemoryIndexes()[payload.sourceId];
          if (!memory) throw new Error('记忆已经不存在');
          const summaries = await context.capabilities.request<ContentSummary[]>('content.summariesById@1', {
            nodeIds: [memory.sourceId, memory.indexNodeId].filter(Boolean),
          });
          const byId = new Map(summaries.map((summary) => [summary.id, summary]));
          const source = byId.get(memory.sourceId);
          if (!source) throw new Error('原文记忆节点已经不存在');
          if (source.revision !== payload.expectedSourceRevision || payload.index.sourceRevision !== source.revision) {
            throw new Error('重建索引期间原文发生变化，请重新执行');
          }
          const existingIndex = memory.indexNodeId ? byId.get(memory.indexNodeId) : undefined;
          const reservedTitles: string[] = [];
          const indexText = formatMemoryIndexText(payload.index, {
            archiveNodeId: memory.sourceId,
            archiveTitle: memory.title,
            savedAt: memory.createdAt,
          });
          const indexPlan = existingIndex
            ? await context.capabilities.request<ContentMutationPlan>(
                'content.deltaPlan@1',
                {
                  nodeId: existingIndex.id,
                  expectedRevision: existingIndex.revision,
                  start: 0,
                  deleteCount: existingIndex.length,
                  insert: indexText,
                } satisfies ContentDeltaPlanRequest,
              )
            : await context.capabilities.request<ContentMutationPlan>(
                'content.createPlan@1',
                {
                  title: memoryIndexTitle(memory.title),
                  body: indexText,
                  placement: 'system',
                  automaticContext: false,
                  reservedTitles,
                } satisfies ContentCreatePlanRequest,
              );
          const indexNodeId = existingIndex?.id ?? indexPlan.nodeId;
          const sourcePlacement = await context.capabilities.request<ContentMutationPlan>(
            'content.placementPlan@1',
            { nodeId: memory.sourceId, placement: 'system' } satisfies ContentPlacementPlanRequest,
          );
          const indexPlacement = existingIndex
            ? await context.capabilities.request<ContentMutationPlan>(
                'content.placementPlan@1',
                { nodeId: indexNodeId, placement: 'system' } satisfies ContentPlacementPlanRequest,
              )
            : undefined;
          const next: AIMemoryIndexRecord = {
            ...memory,
            ...payload.index,
            sourceId: memory.sourceId,
            sessionId: memory.sessionId,
            title: memory.title,
            indexNodeId,
            hubNodeId: undefined,
            connectionIds: undefined,
            createdAt: memory.createdAt,
            updatedAt: Date.now(),
          };
          return {
            transaction: {
              label: '重建 AI 记忆索引',
              patches: [
                ...indexPlan.patches,
                ...sourcePlacement.patches,
                ...(indexPlacement?.patches ?? []),
                { op: 'set', domain: 'document', namespace: AI_MEMORY_NAMESPACE, key: memory.sourceId, value: next },
              ],
              events: [
                ...(indexPlan.events ?? []),
                ...(sourcePlacement.events ?? []),
                ...(indexPlacement?.events ?? []),
                { type: 'ai.memory.updated', payload: { sourceId: memory.sourceId, rebuilt: true } },
              ],
            },
          };
        },
      });

}
