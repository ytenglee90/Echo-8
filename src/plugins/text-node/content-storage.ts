import { createId, type PatchOperation, type PluginContext } from '../../core/contracts.ts';
import type { SearchHit } from '../../protocols/search.ts';

export const CONTENT_CHUNK_NAMESPACE = 'textContentChunk';
export const CHUNK_SIZE = 64 * 1024;
export const MAX_DOCUMENT_LENGTH = 32 * 1024 * 1024;

export interface TextContentRecord {
  id: string;
  storageVersion?: 1 | 2;
  chunkIds?: string[];
  chunkLengths?: number[];
  /** Version-one compatibility only. Migrated through content.migrateStorage. */
  chunks?: string[];
  length: number;
  revision: number;
}

export interface TextContentChunkRecord {
  id: string;
  contentId: string;
  text: string;
}

export function chunkText(text: string): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) {
    chunks.push(text.slice(offset, offset + CHUNK_SIZE));
  }
  return chunks;
}

export function createContentStorage(contentId: string, text: string, revision: number) {
  return createContentStorageFromChunks(contentId, chunkText(text), revision);
}

export function createContentStorageFromChunks(contentId: string, sourceChunks: string[], revision: number): {
  content: TextContentRecord;
  chunkPatches: PatchOperation[];
} {
  const normalized: string[] = [];
  for (const source of sourceChunks.length > 0 ? sourceChunks : ['']) {
    if (source.length <= CHUNK_SIZE) normalized.push(source);
    else normalized.push(...chunkText(source));
  }
  if (normalized.length === 0) normalized.push('');
  const chunkIds: string[] = [];
  const chunkLengths: number[] = [];
  const chunkPatches: PatchOperation[] = [];
  for (const text of normalized) {
    const id = createId('content-chunk');
    chunkIds.push(id);
    chunkLengths.push(text.length);
    chunkPatches.push({
      op: 'set',
      domain: 'document',
      namespace: CONTENT_CHUNK_NAMESPACE,
      key: id,
      value: { id, contentId, text } satisfies TextContentChunkRecord,
    });
  }
  return {
    content: {
      id: contentId,
      storageVersion: 2,
      chunkIds,
      chunkLengths,
      length: chunkLengths.reduce((total, length) => total + length, 0),
      revision,
    },
    chunkPatches,
  };
}

export function isVersionTwoContent(content: TextContentRecord): boolean {
  return content.storageVersion === 2 && Array.isArray(content.chunkIds) &&
    Array.isArray(content.chunkLengths) && content.chunkIds.length === content.chunkLengths.length &&
    content.chunkIds.length > 0;
}

export function contentChunkIds(content: TextContentRecord): string[] {
  return isVersionTwoContent(content) ? content.chunkIds! : [];
}

export function contentChunkLengths(content: TextContentRecord): number[] {
  if (isVersionTwoContent(content)) return content.chunkLengths!;
  return (content.chunks ?? ['']).map((chunk) => chunk.length);
}

export function readContentChunk(context: PluginContext, content: TextContentRecord, index: number): string {
  if (!isVersionTwoContent(content)) return (content.chunks ?? [''])[index] ?? '';
  const id = content.chunkIds![index];
  if (!id) return '';
  const chunk = context.store.readValue<TextContentChunkRecord>(CONTENT_CHUNK_NAMESPACE, id);
  if (!chunk || chunk.contentId !== content.id || typeof chunk.text !== 'string') {
    throw new Error(`正文分块缺失或损坏：${content.id}.${index}`);
  }
  if (chunk.text.length !== content.chunkLengths![index]) {
    throw new Error(`正文分块长度校验失败：${content.id}.${index}`);
  }
  return chunk.text;
}

export function readAllContentChunks(context: PluginContext, content: TextContentRecord): string[] {
  return contentChunkLengths(content).map((_length, index) => readContentChunk(context, content, index));
}

export function readContentRange(
  context: PluginContext,
  content: TextContentRecord,
  requestedStart: number,
  requestedLength: number,
): string {
  const start = Math.max(0, Math.min(content.length, requestedStart));
  let remaining = Math.max(0, Math.min(requestedLength, content.length - start));
  if (remaining === 0) return '';
  const lengths = contentChunkLengths(content);
  const point = locateOffsetByLengths(lengths, start);
  let result = '';
  for (let index = point.index; index < lengths.length && remaining > 0; index += 1) {
    const chunk = readContentChunk(context, content, index);
    const localStart = index === point.index ? point.offset : 0;
    const part = chunk.slice(localStart, localStart + remaining);
    result += part;
    remaining -= part.length;
  }
  return result;
}

export function planContentDelta(
  context: PluginContext,
  content: TextContentRecord,
  start: number,
  deleteCount: number,
  insert: string,
): { content: TextContentRecord; chunkPatches: PatchOperation[] } {
  if (!isVersionTwoContent(content)) {
    const chunks = applyDeltaToChunks(content.chunks ?? [''], start, deleteCount, insert);
    return createContentStorageFromChunks(content.id, chunks, content.revision + 1);
  }
  return planVersionTwoDelta(content, start, deleteCount, insert, (candidate, index) =>
    readContentChunk(context, candidate, index));
}

export function planContentReplacements(
  context: PluginContext,
  content: TextContentRecord,
  hits: SearchHit[],
  replacement: string,
): { content: TextContentRecord; chunkPatches: PatchOperation[] } {
  const projectedLength = hits.reduce(
    (length, hit) => length - hit.length + replacement.length,
    content.length,
  );
  if (projectedLength > MAX_DOCUMENT_LENGTH) throw new Error('替换结果超过单节点 3200 万字符上限');
  if (!isVersionTwoContent(content)) {
    let chunks = content.chunks ?? [''];
    for (const hit of [...hits].sort((left, right) => right.start - left.start)) {
      chunks = applyDeltaToChunks(chunks, hit.start, hit.length, replacement);
    }
    return createContentStorageFromChunks(content.id, chunks, content.revision + 1);
  }

  const originalIds = new Set(content.chunkIds!);
  const staged = new Map<string, TextContentChunkRecord>();
  let working = content;
  const readChunk = (candidate: TextContentRecord, index: number) => {
    const id = candidate.chunkIds![index];
    const pending = staged.get(id);
    return pending?.text ?? readContentChunk(context, candidate, index);
  };
  for (const hit of [...hits].sort((left, right) => right.start - left.start)) {
    const mutation = planVersionTwoDelta(working, hit.start, hit.length, replacement, readChunk);
    for (const patch of mutation.chunkPatches) {
      if (patch.op === 'set') staged.set(patch.key, patch.value as TextContentChunkRecord);
    }
    working = mutation.content;
  }
  const finalIds = new Set(working.chunkIds!);
  const chunkPatches: PatchOperation[] = [];
  for (const id of originalIds) {
    if (!finalIds.has(id)) chunkPatches.push({
      op: 'delete', domain: 'document', namespace: CONTENT_CHUNK_NAMESPACE, key: id,
    });
  }
  for (const id of finalIds) {
    if (originalIds.has(id)) continue;
    const record = staged.get(id);
    if (!record) throw new Error(`替换计划缺少新正文分块：${id}`);
    chunkPatches.push({
      op: 'set', domain: 'document', namespace: CONTENT_CHUNK_NAMESPACE, key: id, value: record,
    });
  }
  return {
    content: { ...working, length: projectedLength, revision: content.revision + 1 },
    chunkPatches,
  };
}

export function planContentMove(
  context: PluginContext,
  content: TextContentRecord,
  start: number,
  end: number,
  target: number,
): { content: TextContentRecord; chunkPatches: PatchOperation[]; destination: number } {
  const length = end - start;
  const movedText = readContentRange(context, content, start, length);
  const destination = target < start ? target : target - length;
  if (!isVersionTwoContent(content)) {
    const withoutSource = applyDeltaToChunks(content.chunks ?? [''], start, length, '');
    const chunks = applyDeltaToChunks(withoutSource, destination, 0, movedText);
    const replacement = createContentStorageFromChunks(content.id, chunks, content.revision + 1);
    return { ...replacement, destination };
  }

  const originalIds = new Set(content.chunkIds!);
  const staged = new Map<string, TextContentChunkRecord>();
  const readChunk = (candidate: TextContentRecord, index: number) => {
    const id = candidate.chunkIds![index];
    const pending = staged.get(id);
    return pending?.text ?? readContentChunk(context, candidate, index);
  };
  const apply = (
    candidate: TextContentRecord,
    deltaStart: number,
    deleteCount: number,
    insert: string,
  ) => {
    const mutation = planVersionTwoDelta(candidate, deltaStart, deleteCount, insert, readChunk);
    for (const patch of mutation.chunkPatches) {
      if (patch.op === 'set') staged.set(patch.key, patch.value as TextContentChunkRecord);
    }
    return mutation.content;
  };
  const withoutSource = apply(content, start, length, '');
  const working = apply(withoutSource, destination, 0, movedText);
  const finalIds = new Set(working.chunkIds!);
  const chunkPatches: PatchOperation[] = [];
  for (const id of originalIds) {
    if (!finalIds.has(id)) chunkPatches.push({
      op: 'delete', domain: 'document', namespace: CONTENT_CHUNK_NAMESPACE, key: id,
    });
  }
  for (const id of finalIds) {
    if (originalIds.has(id)) continue;
    const record = staged.get(id);
    if (!record) throw new Error(`移动计划缺少新正文分块：${id}`);
    chunkPatches.push({
      op: 'set', domain: 'document', namespace: CONTENT_CHUNK_NAMESPACE, key: id, value: record,
    });
  }
  return {
    content: { ...working, revision: content.revision + 1 },
    chunkPatches,
    destination,
  };
}

export function readRange(chunks: string[], start: number, length: number): string {
  if (length <= 0) return '';
  let cursor = 0;
  let remaining = length;
  let result = '';
  for (const chunk of chunks) {
    const end = cursor + chunk.length;
    if (end <= start) {
      cursor = end;
      continue;
    }
    const localStart = Math.max(0, start - cursor);
    const part = chunk.slice(localStart, localStart + remaining);
    result += part;
    remaining -= part.length;
    if (remaining <= 0) break;
    cursor = end;
  }
  return result;
}

export function readRangeWithReader(
  lengths: number[],
  readChunk: (index: number) => string,
  start: number,
  length: number,
): string {
  if (length <= 0) return '';
  const point = locateOffsetByLengths(lengths, start);
  let remaining = length;
  let result = '';
  for (let index = point.index; index < lengths.length && remaining > 0; index += 1) {
    const chunk = readChunk(index);
    const localStart = index === point.index ? point.offset : 0;
    const part = chunk.slice(localStart, localStart + remaining);
    result += part;
    remaining -= part.length;
  }
  return result;
}

export function locateOffsetByLengths(lengths: number[], offset: number): { index: number; offset: number } {
  let cursor = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const end = cursor + lengths[index];
    if (offset <= end || index === lengths.length - 1) {
      return { index, offset: Math.max(0, offset - cursor) };
    }
    cursor = end;
  }
  return { index: 0, offset: 0 };
}

function planVersionTwoDelta(
  content: TextContentRecord,
  start: number,
  deleteCount: number,
  insert: string,
  readChunk: (content: TextContentRecord, index: number) => string,
): { content: TextContentRecord; chunkPatches: PatchOperation[] } {
  const chunkIds = content.chunkIds!;
  const lengths = content.chunkLengths!;
  const startPoint = locateOffsetByLengths(lengths, start);
  const endPoint = locateOffsetByLengths(lengths, start + deleteCount);
  const startChunk = readChunk(content, startPoint.index);
  const endChunk = endPoint.index === startPoint.index ? startChunk : readChunk(content, endPoint.index);
  const bridge = startChunk.slice(0, startPoint.offset) + insert + endChunk.slice(endPoint.offset);
  const replacement = createContentStorageFromChunks(content.id, chunkText(bridge), content.revision + 1);
  const removedIds = chunkIds.slice(startPoint.index, endPoint.index + 1);
  const nextChunkIds = [
    ...chunkIds.slice(0, startPoint.index),
    ...replacement.content.chunkIds!,
    ...chunkIds.slice(endPoint.index + 1),
  ];
  const nextChunkLengths = [
    ...lengths.slice(0, startPoint.index),
    ...replacement.content.chunkLengths!,
    ...lengths.slice(endPoint.index + 1),
  ];
  return {
    content: {
      id: content.id,
      storageVersion: 2,
      chunkIds: nextChunkIds,
      chunkLengths: nextChunkLengths,
      length: content.length - deleteCount + insert.length,
      revision: content.revision + 1,
    },
    chunkPatches: [
      ...removedIds.map((id): PatchOperation => ({
        op: 'delete', domain: 'document', namespace: CONTENT_CHUNK_NAMESPACE, key: id,
      })),
      ...replacement.chunkPatches,
    ],
  };
}

function applyDeltaToChunks(
  chunks: string[],
  start: number,
  deleteCount: number,
  insert: string,
): string[] {
  const startPoint = locateOffset(chunks, start);
  const endPoint = locateOffset(chunks, start + deleteCount);
  const before = chunks.slice(0, startPoint.index);
  const after = chunks.slice(endPoint.index + 1);
  const bridge =
    chunks[startPoint.index].slice(0, startPoint.offset) +
    insert +
    chunks[endPoint.index].slice(endPoint.offset);
  return [...before, ...chunkText(bridge), ...after];
}

function locateOffset(chunks: string[], offset: number): { index: number; offset: number } {
  return locateOffsetByLengths(chunks.map((chunk) => chunk.length), offset);
}
