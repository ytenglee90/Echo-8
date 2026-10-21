import type { PluginContext } from '../../core/contracts.ts';
import type {
  AIMemoryIndexRecord,
  AISessionRecord,
  AIStatusSignal,
} from '../../protocols/ai.ts';
import type { AIAssistantInstanceState } from './types.ts';
import {
  isAssistantDraftPreview,
  type AssistantDraftPreview,
} from './command-payloads.ts';
import { internalTranscriptSourceId } from './transcript-storage.ts';

export interface AIEventRuntimeOptions {
  readSessions(): Record<string, AISessionRecord>;
  readMemoryIndexes(): Record<string, AIMemoryIndexRecord>;
  readAssistantInstances(): AIAssistantInstanceState[];
  scheduleConversationAutosave(sessionId: string, reschedule?: boolean): Promise<void>;
  scheduleMemoryRebuild(
    memory: AIMemoryIndexRecord,
    options: { automatic: boolean; delayMs?: number },
  ): unknown;
  scheduleMemoryFileExport(memory: AIMemoryIndexRecord): unknown;
  scheduleOutdatedMemoryRebuilds(): Promise<void>;
  rescheduleConversationAutosaves(): void;
  rememberPreviousFileStem(sourceId: string, stem: string): void;
  rememberComposerDraft(assistantId: string, draft: string): void;
  resetTransientRuntime(): void;
  memoryAutoReindexDelayMs: number;
}

/**
 * Registers reactions to committed AI/content facts.
 * These listeners invalidate derived state or enqueue commands/tasks; they never
 * mutate document state directly.
 */
export function registerAIEventRuntime(
  context: PluginContext,
  options: AIEventRuntimeOptions,
): void {
  const invalidateState = () => context.signals.emit('ai.state.invalidated');
  const invalidateCatalog = () => context.signals.emit('ai.catalog.invalidated');

  context.events.subscribe<{ proposalId: string; sessionId: string }>('ai.proposal.created', (message) => {
    context.signals.emit('ai.status', {
      state: 'complete',
      message: 'AI 提案已经记录',
      sessionId: message.payload.sessionId,
      proposalId: message.payload.proposalId,
    } satisfies AIStatusSignal);
  });
  context.events.subscribe<{ assistant?: AIAssistantInstanceState }>('ai.session.initialized', (message) => {
    invalidateState();
    if (!message.payload.assistant) return;
    void context.commands.dispatch('ai.assistant.attach', message.payload.assistant).catch((error) => {
      context.diagnostics.error('挂载 AI 助手窗口失败', error);
    });
  });
  context.events.subscribe<{ assistantId: string }>('ai.assistant.focused', (message) => {
    invalidateState();
    context.signals.emit('ai.assistant.focus.requested', { assistantId: message.payload.assistantId });
  });
  context.events.subscribe<{ assistantId?: string; sessionId: string }>('ai.assistant.deleted', (message) => {
    invalidateState();
    void context.commands.dispatch('ai.assistant.removeDeletedWindow', {
      sessionId: message.payload.sessionId,
    }).catch((error) => context.diagnostics.error('清理已删除的 AI 助手窗口失败', error));
  });
  context.events.subscribe<{ sessionId: string; archiveNodeId?: string }>('ai.session.saved', (message) => {
    invalidateState();
    // A first save creates a new memory record. The memory center keeps its
    // catalog separately from general assistant state, so invalidate it here
    // as well; otherwise the record exists but the UI still appears unsaved
    // until a later unrelated action refreshes the catalog.
    context.signals.emit('ai.memory.invalidated');
    if (message.payload.archiveNodeId) {
      const memory = options.readMemoryIndexes()[message.payload.archiveNodeId];
      if (memory) options.scheduleMemoryFileExport(memory);
      for (const assistant of options.readAssistantInstances()
        .filter((item) => item.sessionId === message.payload.sessionId)) {
        const sourceIds = [...new Set([
          message.payload.archiveNodeId,
          ...(assistant.memorySourceIds ?? []),
        ])];
        void context.commands.dispatch('ai.assistant.setMemories', {
          assistantId: assistant.id,
          sourceIds,
        }).catch((error) => context.diagnostics.warn('关联当前 AI 记忆失败', error));
      }
    }
    void options.scheduleConversationAutosave(message.payload.sessionId).catch((error) => {
      context.diagnostics.warn('继续安排 AI 对话自动保存失败', error);
    });
  });
  context.events.subscribe<{ sessionId: string }>('ai.transcript.changed', (message) => {
    invalidateState();
    context.signals.emit('ai.transcript.invalidated', {
      nodeId: internalTranscriptSourceId(message.payload.sessionId),
    });
    void options.scheduleConversationAutosave(message.payload.sessionId).catch((error) => {
      context.diagnostics.warn('安排 AI 对话自动保存失败', error);
    });
  });
  context.signals.subscribe<{ intervalMs: number }>(
    'system.persistence.autosaveInterval.changed',
    options.rescheduleConversationAutosaves,
  );
  context.signals.subscribe<AssistantDraftPreview>('ai.composer.draft.preview', (message) => {
    if (!isAssistantDraftPreview(message.payload)) return;
    options.rememberComposerDraft(message.payload.assistantId, message.payload.draft);
  });
  context.events.subscribe('ai.generation.requested', invalidateState);
  context.events.subscribe('ai.proposal.created', invalidateState);
  context.events.subscribe('ai.proposal.accepted', invalidateState);
  context.events.subscribe('ai.proposal.dismissed', invalidateState);
  context.events.subscribe('ai.memory.candidates.updated', invalidateState);
  context.events.subscribe<{
    sourceId?: string;
    action?: string;
    rebuilt?: boolean;
    previousFileStem?: string;
  }>('ai.memory.updated', (message) => {
    context.signals.emit('ai.memory.invalidated');
    const sourceId = message.payload.sourceId;
    const memory = sourceId ? options.readMemoryIndexes()[sourceId] : undefined;
    if (!memory) return;
    if (message.payload.action === 'rename') {
      if (message.payload.previousFileStem) {
        options.rememberPreviousFileStem(memory.sourceId, message.payload.previousFileStem);
      }
      options.scheduleMemoryRebuild(memory, { automatic: true });
    } else if (message.payload.rebuilt) {
      options.scheduleMemoryFileExport(memory);
    }
  });
  context.events.subscribe<{ nodeId?: string; revision?: number }>('content.changed', (message) => {
    context.signals.emit('ai.transcript.invalidated', { nodeId: message.payload.nodeId });
    const nodeId = message.payload.nodeId;
    if (nodeId && Object.values(options.readMemoryIndexes()).some((memory) =>
      memory.sourceId === nodeId || memory.indexNodeId === nodeId || memory.hubNodeId === nodeId)) {
      context.signals.emit('ai.memory.invalidated');
    }
    const changedMemory = nodeId ? options.readMemoryIndexes()[nodeId] : undefined;
    if (changedMemory && changedMemory.enabled !== false &&
      message.payload.revision !== changedMemory.sourceRevision) {
      options.scheduleMemoryRebuild(changedMemory, {
        automatic: true,
        delayMs: options.memoryAutoReindexDelayMs,
      });
    }
  });
  context.events.subscribe('node.created', invalidateCatalog);
  context.events.subscribe('node.renamed', invalidateCatalog);
  context.events.subscribe('nodes.deleted', invalidateCatalog);
  context.events.subscribe('history.changed', () => {
    invalidateState();
    invalidateCatalog();
    context.signals.emit('ai.transcript.invalidated', {});
    context.signals.emit('ai.memory.invalidated');
  });
  context.events.subscribe('document.replaced', () => {
    options.resetTransientRuntime();
    invalidateState();
    invalidateCatalog();
    context.signals.emit('ai.transcript.invalidated', {});
    context.signals.emit('ai.memory.invalidated');
    void options.scheduleOutdatedMemoryRebuilds().catch((error) => {
      context.diagnostics.warn('打开画布后检查记忆索引失败', error);
    });
    for (const session of Object.values(options.readSessions())) {
      void options.scheduleConversationAutosave(session.id).catch((error) => {
        context.diagnostics.warn('打开画布后恢复 AI 对话自动保存失败', error);
      });
    }
  });
}
