import { isRecord, type PluginContext, type TaskHandle } from '../../core/contracts.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type {
  FileArtifact,
  FileDirectoryTarget,
  FileOperationStatus,
  FileSaveTarget,
  ProjectSource,
} from '../../protocols/files.ts';
import { safeLocalFilename } from '../../protocols/files.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { DEFAULT_TEXT_DOCUMENT_FORMAT, type TextFormattingSnapshot } from '../../protocols/formatting.ts';
import { writeProjectToWritable } from './codec.ts';
import { createDocx } from './docx.ts';
import { readDocxPlainText } from './docx-import.ts';
import { FileWriteCoordinator } from './file-write-coordinator.ts';

const READ_WINDOW = 256 * 1024;

export interface TextReadResult {
  text: string;
  totalLength: number;
}

export interface TextExportBinding {
  destination: FileSaveTarget;
  /** Present for whole-canvas exports so a title rename can create the new file and retire the old one. */
  directory?: FileDirectoryTarget;
  /** Actual filename in the bound directory; it may include a collision suffix. */
  filename: string;
  format: 'txt' | 'docx';
  revision: number;
  /** Title already written as the first paragraph of the exported document. */
  exportedTitle: string;
  /** Title represented by the native filename, independent from body export state. */
  filenameTitle: string;
  renameRequired: boolean;
  /** Old directory entries whose deletion can be retried after a successful replacement write. */
  obsoleteFilenames?: string[];
}

export interface SaveProjectPayload {
  destination?: FileSaveTarget;
  /** A copy is exported locally without replacing the current cloud/local save target. */
  mode?: 'current' | 'copy';
}

export interface SaveAndOpenPendingPayload {
  destination?: FileSaveTarget;
}

export interface OpenProjectPayload {
  file: Blob & { name?: string };
  /** Native handles are retained so automatic saves can overwrite an opened book. */
  destination?: FileSaveTarget;
  authorizationId?: string;
}

export interface ExportCurrentTextPayload {
  scope: 'current';
  nodeId?: string;
  destination?: FileSaveTarget;
}

export interface ExportCanvasTextPayload {
  scope: 'canvas';
  directory?: FileDirectoryTarget;
}

export type ExportTextPayload = ExportCurrentTextPayload | ExportCanvasTextPayload;

export interface ExportWordPayload {
  scope: 'current';
  nodeId?: string;
  destination?: FileSaveTarget;
}

export interface ImportDocumentsPayload {
  files: Array<Blob & { name?: string }>;
  x: number;
  y: number;
}

export interface ImportedDocumentInput {
  title: string;
  body: string;
  x: number;
  y: number;
}

export interface CommitImportedDocumentsPayload {
  documents: ImportedDocumentInput[];
}

const MAX_IMPORT_FILES = 20;
const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IMPORTED_TEXT_LENGTH = 32 * 1024 * 1024;

export function scheduleOperation(
  context: PluginContext,
  operation: FileOperationStatus['operation'],
  message: string,
  run: (signal: AbortSignal) => Promise<string>,
  capture: (task: TaskHandle<unknown>) => void,
): { taskId: string } {
  context.signals.emit('file.status', { operation, state: 'running', message, progress: 0 } satisfies FileOperationStatus);
  const task = context.tasks.schedule<string>({
    category: `file-${operation}`,
    label: message,
    priority: operation === 'project-open' || operation === 'recovery' ? 80 : 55,
    timeoutMs: 5 * 60_000,
    estimatedCost: operation === 'text-export' || operation === 'word-export' ? 2 : 8,
    run: async (signal) => run(signal),
  });
  capture(task);
  void task.result.then(
    (readyMessage) => context.signals.emit('file.status', {
      operation,
      state: 'ready',
      message: readyMessage,
      progress: 1,
    } satisfies FileOperationStatus),
    (error) => {
      if (isAbortError(error)) return;
      context.signals.emit('file.status', {
        operation,
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies FileOperationStatus);
    },
  );
  return { taskId: task.id };
}

export function emitProgress(
  context: PluginContext,
  operation: FileOperationStatus['operation'],
  message: string,
  progress: number,
): void {
  context.signals.emit('file.status', { operation, state: 'running', message, progress } satisfies FileOperationStatus);
}

export async function exportCurrentText(
  context: PluginContext,
  signal: AbortSignal,
  report: (progress: number) => void,
  requestedNodeId?: string,
): Promise<{ artifact: FileArtifact; node: ContentSummary }> {
  const summaries = await context.capabilities.request<ContentSummary[]>('content.summaries@1', undefined, signal);
  const node = await resolveCurrentNode(context, summaries, requestedNodeId);
  if (!node) throw new Error('当前没有可以导出的文本节点');
  let processed = 0;
  const artifact = await buildTextArtifact(context, node, `${safeLocalFilename(node.title)}.txt`, signal, (amount) => {
    processed += amount;
    report(Math.min(1, processed / Math.max(1, node.length)));
  });
  return { artifact, node };
}

export async function exportCanvasTextFiles(
  context: PluginContext,
  directory: FileDirectoryTarget | undefined,
  signal: AbortSignal,
  report: (progress: number) => void,
  fileWrites: FileWriteCoordinator,
  existingBindings: ReadonlyMap<string, TextExportBinding>,
): Promise<{ count: number; totalBytes: number; bindings: Map<string, TextExportBinding> }> {
  const summaries = await context.capabilities.request<ContentSummary[]>('content.summaries@1', undefined, signal);
  const nodes = [...summaries]
    .sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id));
  if (nodes.length === 0) throw new Error('画布上没有可以导出的文本节点');
  const total = nodes.reduce((sum, node) => sum + Math.max(1, node.length), 0);
  const reservedNames = new Set<string>();
  const reusable = new Map<string, TextExportBinding>();
  if (directory) {
    for (const [nodeId, binding] of existingBindings) {
      if (binding.format !== 'txt' || !binding.directory || !await sameDirectory(binding.directory, directory)) continue;
      reusable.set(nodeId, binding);
      reservedNames.add(binding.filename.toLocaleLowerCase('zh-CN'));
    }
  }
  const bindings = new Map<string, TextExportBinding>();
  let processed = 0;
  let totalBytes = 0;
  for (const node of nodes) {
    assertNotAborted(signal);
    const previous = reusable.get(node.id);
    if (previous) reservedNames.delete(previous.filename.toLocaleLowerCase('zh-CN'));
    const output = directory
      ? previous && node.title === previous.filenameTitle
        ? { filename: previous.filename, destination: previous.destination }
        : await reserveTextFile(directory, node.title, reservedNames)
      : { filename: uniqueTextFilename(node.title, reservedNames), destination: undefined };
    reservedNames.add(output.filename.toLocaleLowerCase('zh-CN'));
    const artifact = await buildTextArtifact(context, node, output.filename, signal, (amount) => {
      processed += amount;
      report(Math.min(1, processed / total));
    });
    await deliverArtifact(context, artifact, output.destination, signal, fileWrites);
    if (directory && output.destination) {
      const obsolete = new Set(previous?.obsoleteFilenames ?? []);
      if (previous && previous.filename !== output.filename) obsolete.add(previous.filename);
      for (const filename of [...obsolete]) {
        if (await removeDirectoryEntry(directory, filename)) obsolete.delete(filename);
      }
      bindings.set(node.id, {
        destination: output.destination,
        directory,
        filename: output.filename,
        format: 'txt',
        revision: node.revision,
        exportedTitle: node.title,
        filenameTitle: node.title,
        renameRequired: obsolete.size > 0,
        ...(obsolete.size > 0 ? { obsoleteFilenames: [...obsolete] } : {}),
      });
    }
    totalBytes += artifact.blob.size;
    await nextTaskTurn();
  }
  report(1);
  return { count: nodes.length, totalBytes, bindings };
}

export async function sameDirectory(left: FileDirectoryTarget, right: FileDirectoryTarget): Promise<boolean> {
  if (left === right) return true;
  try {
    if (left.isSameEntry) return await left.isSameEntry(right);
    if (right.isSameEntry) return await right.isSameEntry(left);
  } catch {
    return false;
  }
  return false;
}

export async function removeDirectoryEntry(directory: FileDirectoryTarget, filename: string): Promise<boolean> {
  if (!directory.removeEntry) return false;
  try {
    await directory.removeEntry(filename);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return true;
    return false;
  }
}

export async function buildTextArtifact(
  context: PluginContext,
  node: ContentSummary,
  filename: string,
  signal: AbortSignal,
  onRead: (amount: number) => void,
): Promise<FileArtifact> {
  const parts: BlobPart[] = ['\uFEFF'];
  parts.push(`${node.title}\n\n`);
  for (let start = 0; start < node.length; start += READ_WINDOW) {
    assertNotAborted(signal);
    const result = await context.capabilities.request<TextReadResult>('content.read@1', {
      nodeId: node.id,
      start,
      length: Math.min(READ_WINDOW, node.length - start),
    }, signal);
    parts.push(result.text);
    onRead(result.text.length);
    await nextTaskTurn();
  }
  if (node.length === 0) onRead(1);
  return { filename, mimeType: 'text/plain;charset=utf-8', blob: new Blob(parts, { type: 'text/plain;charset=utf-8' }) };
}

export async function resolveCurrentNode(
  context: PluginContext,
  summaries: ContentSummary[],
  requestedNodeId?: string,
): Promise<ContentSummary | undefined> {
  let id = requestedNodeId;
  if (!id) {
    try {
      id = await context.capabilities.request<string | undefined>('editor.activeNode@1');
    } catch {
      // The editor is optional.
    }
  }
  if (!id) {
    try {
      const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
      if (selection.ids.length === 1) id = selection.ids[0];
    } catch {
      // Selection is optional when an editor is active.
    }
  }
  if (!id) throw new Error('请先聚焦一个编辑器，或只选择一个文本节点');
  const node = summaries.find((summary) => summary.id === id);
  if (!node) throw new Error('当前对象不是可导出的文本节点');
  return node;
}

export async function exportWord(
  context: PluginContext,
  signal: AbortSignal,
  report: (progress: number) => void,
  requestedNodeId?: string,
): Promise<{ artifact: FileArtifact; node: ContentSummary }> {
  const summaries = await context.capabilities.request<ContentSummary[]>('content.summaries@1', undefined, signal);
  const node = await resolveCurrentNode(context, summaries, requestedNodeId);
  if (!node) throw new Error('当前没有可以导出的文本节点');
  const parts: BlobPart[] = [];
  let processed = 0;
  for (let start = 0; start < node.length; start += READ_WINDOW) {
    assertNotAborted(signal);
    const result = await context.capabilities.request<TextReadResult>('content.read@1', {
      nodeId: node.id,
      start,
      length: Math.min(READ_WINDOW, node.length - start),
    }, signal);
    parts.push(result.text);
    processed += result.text.length;
    report(node.length === 0 ? 0.8 : Math.min(0.8, processed / node.length * 0.8));
    await nextTaskTurn();
  }
  let format = { ...DEFAULT_TEXT_DOCUMENT_FORMAT };
  try {
    const snapshot = await context.capabilities.request<TextFormattingSnapshot>(
      'content.formatting@2',
      { nodeId: node.id, start: 0, length: 0 },
      signal,
    );
    format = snapshot.format;
  } catch {
    // Formatting is an optional capability; readable text still exports safely.
  }
  const blob = await createDocx(node.title, parts, format);
  assertNotAborted(signal);
  report(1);
  return { node, artifact: {
    filename: `${safeLocalFilename(node.title)}.docx`,
    mimeType: blob.type,
    blob,
  } };
}

export async function deliverArtifact(
  context: PluginContext,
  artifact: FileArtifact,
  destination: FileSaveTarget | undefined,
  signal: AbortSignal,
  fileWrites: FileWriteCoordinator,
  renameTo?: string,
): Promise<boolean> {
  if (!destination) {
    context.signals.emit('file.artifact.ready', artifact);
    return false;
  }
  return fileWrites.run(destination, signal, async () => {
    assertNotAborted(signal);
    const renamed = renameTo
      ? await renameDestinationDirect(destination, renameTo, signal)
      : true;
    const writable = await destination.createWritable();
    try {
      assertNotAborted(signal);
      await writable.write(artifact.blob);
      assertNotAborted(signal);
      await writable.close();
      return renamed;
    } catch (error) {
      await writable.abort?.().catch(() => undefined);
      throw error;
    }
  });
}

export async function writeProjectDestination(
  source: ProjectSource,
  destination: FileSaveTarget,
  signal: AbortSignal,
  report: (progress: number) => void,
  fileWrites: FileWriteCoordinator,
): Promise<number> {
  return fileWrites.run(destination, signal, async () => {
    assertNotAborted(signal);
    const writable = await destination.createWritable();
    try {
      const bytes = await writeProjectToWritable(source, writable, signal, report);
      assertNotAborted(signal);
      await writable.close();
      return bytes;
    } catch (error) {
      await writable.abort?.().catch(() => undefined);
      throw error;
    }
  });
}

export async function renameDestination(
  destination: FileSaveTarget,
  filename: string,
  signal: AbortSignal,
  fileWrites: FileWriteCoordinator,
): Promise<boolean> {
  return fileWrites.run(destination, signal, () => renameDestinationDirect(destination, filename, signal));
}

export async function renameDestinationDirect(
  destination: FileSaveTarget,
  filename: string,
  signal: AbortSignal,
): Promise<boolean> {
  assertNotAborted(signal);
  if (!destination.move) return false;
  try {
    await destination.move(filename);
    assertNotAborted(signal);
    return true;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return false;
  }
}

export function exportFilename(title: string, format: TextExportBinding['format']): string {
  return `${safeLocalFilename(title)}.${format}`;
}

export async function reserveTextFile(
  directory: FileDirectoryTarget,
  title: string,
  reservedNames: Set<string>,
): Promise<{ filename: string; destination: FileSaveTarget }> {
  for (let index = 1; index <= 10_000; index += 1) {
    const filename = textFilenameCandidate(title, index);
    const key = filename.toLocaleLowerCase('zh-CN');
    if (reservedNames.has(key)) continue;
    try {
      await directory.getFileHandle(filename);
      continue;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    const destination = await directory.getFileHandle(filename, { create: true });
    reservedNames.add(key);
    return { filename, destination };
  }
  throw new Error(`无法为“${title || '未命名节点'}”生成不重复的 TXT 文件名`);
}

export function uniqueTextFilename(title: string, reservedNames: Set<string>): string {
  for (let index = 1; index <= 10_000; index += 1) {
    const filename = textFilenameCandidate(title, index);
    const key = filename.toLocaleLowerCase('zh-CN');
    if (reservedNames.has(key)) continue;
    reservedNames.add(key);
    return filename;
  }
  throw new Error(`无法为“${title || '未命名节点'}”生成不重复的 TXT 文件名`);
}

export function textFilenameCandidate(title: string, index: number): string {
  const suffix = index === 1 ? '' : ` (${index})`;
  const safeTitle = safeLocalFilename(title).replace(/\.txt$/iu, '') || '未命名节点';
  return `${safeTitle.slice(0, Math.max(1, 116 - suffix.length))}${suffix}.txt`;
}

export async function parseImportedDocument(
  file: Blob & { name?: string },
  signal: AbortSignal,
): Promise<{ title: string; body: string }> {
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('单个导入文件不能超过 64 MB');
  const name = file.name ?? '未命名文件.txt';
  const extension = name.toLocaleLowerCase().split('.').at(-1);
  let text: string;
  if (extension === 'txt' || file.type.startsWith('text/plain')) {
    text = await readTextFile(file, signal);
  } else if (extension === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    text = await readDocxPlainText(file, signal, MAX_IMPORTED_TEXT_LENGTH);
  } else if (extension === 'doc') {
    throw new Error('旧版 .doc 文件不能安全解析，请先在 Word 中另存为 .docx');
  } else {
    throw new Error(`不支持的文件格式：${name}`);
  }
  if (text.length > MAX_IMPORTED_TEXT_LENGTH) throw new Error('导入正文不能超过 3200 万 UTF-16 字符');
  return splitImportedDocument(text, name);
}

export async function readTextFile(file: Blob, signal: AbortSignal): Promise<string> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  const parts: string[] = [];
  let length = 0;
  try {
    while (true) {
      assertNotAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      length += text.length;
      if (length > MAX_IMPORTED_TEXT_LENGTH) throw new Error('导入正文不能超过 3200 万 UTF-16 字符');
      parts.push(text);
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock();
  }
}

export function splitImportedDocument(text: string, filename: string): { title: string; body: string } {
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const paragraphBreak = /\n[\t ]*\n/u.exec(normalized);
  let titlePart: string;
  let body: string;
  if (paragraphBreak?.index !== undefined) {
    titlePart = normalized.slice(0, paragraphBreak.index);
    body = normalized.slice(paragraphBreak.index + paragraphBreak[0].length);
  } else {
    const lineBreak = normalized.indexOf('\n');
    titlePart = lineBreak >= 0 ? normalized.slice(0, lineBreak) : normalized;
    body = lineBreak >= 0 ? normalized.slice(lineBreak + 1) : '';
  }
  const fallback = filename.replace(/\.(?:txt|docx?|word)$/iu, '').trim() || '导入文本';
  const title = titlePart.replace(/\s+/gu, ' ').trim().slice(0, 240) || fallback;
  return { title, body: body.replace(/^\n+/u, '') };
}

export function isImportDocumentsPayload(payload: unknown): payload is ImportDocumentsPayload {
  return isRecord(payload) &&
    Array.isArray(payload.files) &&
    payload.files.length > 0 &&
    payload.files.length <= MAX_IMPORT_FILES &&
    payload.files.every((file) => isBlobLike(file) && isSupportedDocumentFile(file)) &&
    Number.isFinite(payload.x) &&
    Number.isFinite(payload.y);
}

export function isCommitImportedDocumentsPayload(payload: unknown): payload is CommitImportedDocumentsPayload {
  return isRecord(payload) &&
    Array.isArray(payload.documents) &&
    payload.documents.length > 0 &&
    payload.documents.length <= MAX_IMPORT_FILES &&
    payload.documents.every((document) =>
      isRecord(document) &&
      typeof document.title === 'string' &&
      typeof document.body === 'string' &&
      document.body.length <= MAX_IMPORTED_TEXT_LENGTH &&
      Number.isFinite(document.x) &&
      Number.isFinite(document.y));
}

export function isExportTextPayload(payload: unknown): payload is ExportTextPayload {
  if (!isRecord(payload)) return false;
  if (payload.scope === 'current') {
    return payload.directory === undefined &&
      (payload.nodeId === undefined || typeof payload.nodeId === 'string') &&
      (payload.destination === undefined || isFileSaveTarget(payload.destination));
  }
  return payload.scope === 'canvas' &&
    payload.nodeId === undefined &&
    payload.destination === undefined &&
    (payload.directory === undefined || isFileDirectoryTarget(payload.directory));
}

export function isExportWordPayload(payload: unknown): payload is ExportWordPayload {
  return isRecord(payload) &&
    payload.scope === 'current' &&
    (payload.nodeId === undefined || typeof payload.nodeId === 'string') &&
    (payload.destination === undefined || isFileSaveTarget(payload.destination));
}

export function isFileSaveTarget(value: unknown): value is FileSaveTarget {
  return typeof value === 'object' && value !== null &&
    typeof (value as FileSaveTarget).name === 'string' &&
    typeof (value as FileSaveTarget).createWritable === 'function';
}

export function isFileDirectoryTarget(value: unknown): value is FileDirectoryTarget {
  return typeof value === 'object' && value !== null &&
    typeof (value as FileDirectoryTarget).name === 'string' &&
    typeof (value as FileDirectoryTarget).getFileHandle === 'function';
}

export function isSupportedDocumentFile(file: Blob & { name?: string }): boolean {
  const name = file.name?.toLocaleLowerCase() ?? '';
  return name.endsWith('.txt') || name.endsWith('.docx') || name.endsWith('.doc') ||
    file.type.startsWith('text/plain') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

export function isBlobLike(value: unknown): value is Blob & { name?: string } {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

export function dateStamp(): string {
  const date = new Date();
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Task cancelled', 'AbortError');
}

export function nextTaskTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
