import {
  createId,
  type EventDeclaration,
  type PatchOperation,
  type PluginContext,
} from '../../core/contracts.ts';
import type { AIMemoryIndexRecord, AISessionRecord } from '../../protocols/ai.ts';
import type { ContentCreatePlanRequest, ContentMutationPlan } from '../../protocols/content.ts';
import type { FileDirectoryTarget, FileReadWriteTarget } from '../../protocols/files.ts';
import {
  readContextSource,
  readContextSourceRevision,
} from './context-source-reader.ts';
import {
  AI_MEMORY_FILE_INDEX_SUFFIX,
  AI_MEMORY_FILE_ORIGINAL_SUFFIX,
  countTranscriptTurns,
  formatMemoryIndexText,
  memoryIndexTitle,
  pairMemoryFiles,
  parseImportedMemoryIndex,
  parseImportedMemoryTitle,
} from './memory-artifacts.ts';
import { AI_MEMORY_NAMESPACE } from './memory-commit.ts';
import {
  AI_SESSION_NAMESPACE,
  AI_TRANSCRIPT_NAMESPACE,
  chunkImportedTranscript,
} from './transcript-storage.ts';

const AI_MEMORY_IMPORT_FILE_LIMIT = 64 * 1024 * 1024;
const AI_MEMORY_FILE_WRITE_CHUNK = 256 * 1024;

export interface PreparedMemoryFileImport {
  id: string;
  count: number;
  patches: PatchOperation[];
  events: EventDeclaration[];
}

export async function writeMemorySourceToDirectory(
  context: PluginContext,
  directory: FileDirectoryTarget,
  filename: string,
  sourceId: string,
  signal: AbortSignal,
  report: (progress: number) => void,
  waitIfPaused: () => Promise<void>,
): Promise<void> {
  const metadata = await readContextSource(context, { sourceId, start: 0, length: 0 }, signal);
  const length = metadata.source?.length ?? 0;
  const revision = metadata.source?.revision;
  if (revision === undefined) throw new Error('本地记忆来源已经不存在');
  const target = await directory.getFileHandle(filename, { create: true });
  const writable = await target.createWritable();
  let closed = false;
  try {
    if (length === 0) await writable.write(new Blob([''], { type: 'text/plain;charset=utf-8' }));
    for (let start = 0; start < length; start += AI_MEMORY_FILE_WRITE_CHUNK) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await waitIfPaused();
      const part = await readContextSource(context, {
        sourceId,
        start,
        length: Math.min(AI_MEMORY_FILE_WRITE_CHUNK, length - start),
      }, signal);
      if (part.source?.revision !== revision) {
        throw new Error('写入本地记忆时原文发生变化，将在下次保存时重试');
      }
      await writable.write(new Blob([part.text ?? ''], { type: 'text/plain;charset=utf-8' }));
      report(Math.min(1, (start + (part.text?.length ?? 0)) / Math.max(1, length)));
    }
    if (await readContextSourceRevision(context, sourceId) !== revision) {
      throw new Error('写入本地记忆时原文发生变化，将在下次保存时重试');
    }
    await writable.close();
    closed = true;
    report(1);
  } catch (error) {
    if (!closed) await writable.abort?.().catch(() => undefined);
    throw error;
  }
}

export async function prepareMemoryFileImport(
  context: PluginContext,
  sources: FileReadWriteTarget[],
  existingMemories: Record<string, AIMemoryIndexRecord>,
  signal: AbortSignal,
  report: (progress: number) => void,
  waitIfPaused: () => Promise<void>,
): Promise<PreparedMemoryFileImport> {
  const pairs = pairMemoryFiles(sources);
  if (pairs.length === 0) {
    throw new Error(`请选择名称分别以“${AI_MEMORY_FILE_ORIGINAL_SUFFIX}”和“${AI_MEMORY_FILE_INDEX_SUFFIX}”结尾的一对 TXT 文件`);
  }
  const existingStems = new Set(
    Object.values(existingMemories).map((memory) => memory.localFileStem).filter(Boolean),
  );
  const duplicate = pairs.find((pair) => existingStems.has(pair.stem));
  if (duplicate) throw new Error(`记忆“${duplicate.stem}”已经关联，未重复导入`);
  const patches: PatchOperation[] = [];
  const events: EventDeclaration[] = [];
  const reservedTitles: string[] = Object.values(existingMemories).map((memory) => memory.title);
  for (const [pairIndex, pair] of pairs.entries()) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    await waitIfPaused();
    const originalFile = await pair.original.getFile();
    const indexFile = await pair.index.getFile();
    if (originalFile.size > AI_MEMORY_IMPORT_FILE_LIMIT || indexFile.size > AI_MEMORY_IMPORT_FILE_LIMIT) {
      throw new Error('单个 AI 记忆 TXT 不能超过 64 MB');
    }
    const [originalText, savedIndexText] = await Promise.all([originalFile.text(), indexFile.text()]);
    const importedTitle = parseImportedMemoryTitle(savedIndexText, pair.stem);
    const archive = await context.capabilities.request<ContentMutationPlan>(
      'content.createPlan@1',
      {
        title: importedTitle,
        body: originalText,
        placement: 'system',
        automaticContext: false,
        reservedTitles,
      } satisfies ContentCreatePlanRequest,
      signal,
    );
    if (archive.resolvedTitle) reservedTitles.push(archive.resolvedTitle);
    const title = archive.resolvedTitle ?? importedTitle;
    const createdAt = Date.now() + pairIndex;
    const draft = parseImportedMemoryIndex(savedIndexText, originalText, archive.revision, createdAt);
    const indexText = formatMemoryIndexText(draft, {
      archiveNodeId: archive.nodeId,
      archiveTitle: title,
      savedAt: createdAt,
    });
    const indexPlan = await context.capabilities.request<ContentMutationPlan>(
      'content.createPlan@1',
      {
        title: memoryIndexTitle(title),
        body: indexText,
        placement: 'system',
        automaticContext: false,
        reservedTitles,
      } satisfies ContentCreatePlanRequest,
      signal,
    );
    if (indexPlan.resolvedTitle) reservedTitles.push(indexPlan.resolvedTitle);
    const sessionId = createId('ai-session');
    const chunks = chunkImportedTranscript(sessionId, originalText);
    const transcriptRevision = 1;
    const session: AISessionRecord = {
      id: sessionId,
      title,
      transcriptRevision,
      transcriptLength: originalText.length,
      transcriptEntries: chunks.length,
      revision: 1,
      turns: countTranscriptTurns(originalText),
      createdAt,
      updatedAt: createdAt,
      savedAt: createdAt,
      savedTranscriptRevision: transcriptRevision,
    };
    const memory: AIMemoryIndexRecord = {
      ...draft,
      schemaVersion: 2,
      sessionId,
      sourceId: archive.nodeId,
      title,
      indexNodeId: indexPlan.nodeId,
      enabled: true,
      localFileStem: pair.stem,
      sourceRevision: archive.revision,
      sourceLength: archive.length,
      createdAt,
      updatedAt: createdAt,
    };
    patches.push(
      ...archive.patches,
      ...indexPlan.patches,
      { op: 'set', domain: 'document', namespace: AI_SESSION_NAMESPACE, key: session.id, value: session },
      ...chunks.map(({ key, chunk }) => ({
        op: 'set' as const,
        domain: 'document' as const,
        namespace: AI_TRANSCRIPT_NAMESPACE,
        key,
        value: chunk,
      })),
      { op: 'set', domain: 'document', namespace: AI_MEMORY_NAMESPACE, key: memory.sourceId, value: memory },
    );
    events.push(
      ...(archive.events ?? []),
      ...(indexPlan.events ?? []),
      { type: 'ai.memory.updated', payload: { sourceId: memory.sourceId, imported: true } },
    );
    report((pairIndex + 1) / pairs.length);
  }
  return {
    id: createId('ai-memory-file-import'),
    count: pairs.length,
    patches,
    events,
  };
}

export async function removeMemoryFileIfPresent(
  directory: FileDirectoryTarget,
  filename: string,
): Promise<void> {
  try {
    await directory.removeEntry?.(filename);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return;
    throw error;
  }
}
