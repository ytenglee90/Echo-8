import {
  isRecord,
  type PluginContext,
} from '../../core/contracts.ts';
import type {
  AIMemoryCatalogSnapshot,
  AIMemoryIndexRecord,
  AIPromptTemplateCatalog,
  AIPreparedContext,
  AISessionRecord,
} from '../../protocols/ai.ts';
import { buildMemoryCatalog } from './memory-retrieval.ts';
import {
  readContextCatalog,
  readContextSource,
  readContextSourceLength,
  readContextSourceRevision,
} from './context-source-reader.ts';
import {
  sessionTranscriptSourceId,
} from './transcript-storage.ts';
import type { PreparedGeneration } from './request-runtime.ts';
import type {
  AIAssistantState,
  AICatalogSnapshot,
  AITranscriptSnapshot,
} from './types.ts';

export interface AIQueryRuntimeOptions {
  preparations: Map<string, PreparedGeneration>;
  readState(): AIAssistantState;
  readPromptTemplates(): AIPromptTemplateCatalog;
  readMemoryIndexes(): Record<string, AIMemoryIndexRecord>;
  readSessions(): Record<string, AISessionRecord>;
}

/** Registers the read-only public surface of the AI assistant plugin. */
export function registerAIQueryRuntime(
  context: PluginContext,
  options: AIQueryRuntimeOptions,
): void {
  const {
    preparations,
    readState,
    readPromptTemplates,
    readMemoryIndexes,
    readSessions,
  } = options;

  context.queries.register({ type: 'ai.state', handle: readState });
  context.queries.register<undefined, AIPromptTemplateCatalog>({
    type: 'ai.promptTemplates',
    handle: readPromptTemplates,
  });
  context.queries.register<undefined, AIMemoryIndexRecord[]>({
    type: 'ai.memoryIndexes',
    handle: () => Object.values(readMemoryIndexes()).sort((left, right) => right.createdAt - left.createdAt),
  });
  context.queries.register<undefined, AIMemoryCatalogSnapshot>({
    type: 'ai.memoryCatalog',
    handle: () => buildMemoryCatalog(context, readMemoryIndexes()),
  });
  context.queries.register<undefined, AICatalogSnapshot>({
    type: 'ai.catalog',
    handle: async () => ({ sources: await readContextCatalog(context) }),
  });
  context.queries.register<{ sessionId: string }, AITranscriptSnapshot>({
    type: 'ai.transcript',
    validate: (payload): payload is { sessionId: string } =>
      isRecord(payload) && typeof payload.sessionId === 'string',
    handle: async (payload) => {
      const session = readSessions()[payload.sessionId];
      if (!session) throw new Error('AI 对话已经不存在');
      const sourceId = sessionTranscriptSourceId(session);
      const revision = await readContextSourceRevision(context, sourceId);
      const length = await readContextSourceLength(context, sourceId);
      const result = await readContextSource(context, {
        sourceId,
        start: Math.max(0, length - 64 * 1024),
        length: 64 * 1024,
      });
      return {
        sessionId: session.id,
        nodeId: sourceId,
        revision,
        text: result.text ?? '',
        totalLength: result.source?.length ?? 0,
      };
    },
  });
  context.queries.register<{ sessionId: string }, AIPreparedContext | undefined>({
    type: 'ai.pendingPreparation',
    validate: (payload): payload is { sessionId: string } =>
      isRecord(payload) && typeof payload.sessionId === 'string',
    handle: (payload) => [...preparations.values()]
      .filter((prepared) => prepared.sessionId === payload.sessionId &&
        prepared.transcriptRevisionAfterUser === undefined && prepared.expiresAt >= Date.now())
      .sort((left, right) => right.createdAt - left.createdAt)[0],
  });
}
