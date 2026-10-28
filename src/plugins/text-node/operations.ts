import { isRecord, type PluginContext } from '../../core/contracts.ts';
import { StreamingGraphemeCounter, WritingUnitCounter } from '../../services/text-metrics.ts';
import type {
  AIContextSearchContribution,
  AIContextSearchRequest,
  AIContextSource,
} from '../../protocols/ai.ts';
import type {
  ContentMovePlan,
  ContentNodePresentation,
  ContentNodeResizeLimits,
  ContentPlacement,
  NodePosition,
} from '../../protocols/content.ts';
import type { ApplyContentDeltaRequest, MoveContentRangeRequest } from '../../protocols/editor.ts';
import {
  MAX_ANNOTATION_BODY_LENGTH,
  MAX_ANNOTATION_CLIPBOARD_BODY,
  MAX_ANNOTATION_CLIPBOARD_ITEMS,
  type AnnotationClipboardItem,
} from '../../protocols/annotations.ts';
import type {
  AppearanceEntityRef,
  AppearanceUpdatePlan,
  AppearanceUpdateRequest,
} from '../../protocols/appearance.ts';
import type { TextFormatMark } from '../../protocols/formatting.ts';
import type { ContentSearchRequest, SearchHit } from '../../protocols/search.ts';
import { GRID_NODE_HEIGHT, GRID_NODE_WIDTH } from './grid-layout.ts';
import {
  contentChunkLengths,
  isVersionTwoContent,
  readContentChunk,
  readRangeWithReader,
  type TextContentRecord,
} from './content-storage.ts';
import {
  FORMAT_NAMESPACE,
  isFormatPatch,
  readFormatRecord,
  type TextFormatRecord,
} from './formatting-storage.ts';

export const NODE_NAMESPACE = 'textNode';
export const CONTENT_NAMESPACE = 'textContent';
export const DEFAULT_NODE_TITLE_COLORS = ['#202124', '#374151'] as const;

export function defaultNodeTitleColor(index: number): string {
  return DEFAULT_NODE_TITLE_COLORS[Math.abs(Math.trunc(index)) % DEFAULT_NODE_TITLE_COLORS.length];
}
export const DEFAULT_NODE_WIDTH = GRID_NODE_WIDTH;
export const DEFAULT_NODE_HEIGHT = GRID_NODE_HEIGHT;
export const MIN_NODE_WIDTH = 220;
export const MAX_NODE_WIDTH = 1600;
export const MIN_NODE_HEIGHT = 120;
export const MAX_NODE_HEIGHT = 1200;
export const DEFAULT_TEXT_BOX_WIDTH = 240;
export const DEFAULT_TEXT_BOX_HEIGHT = 64;
export const MIN_TEXT_BOX_WIDTH = 120;
export const MIN_TEXT_BOX_HEIGHT = 48;
export const NODE_HEADER_HEIGHT = 42;
export const NODE_PREVIEW_HORIZONTAL_PADDING = 32;
export const NODE_PREVIEW_VERTICAL_PADDING = 34;
export const NODE_PREVIEW_LINE_HEIGHT = 21;
export const NODE_PREVIEW_MIN_GLYPH_WIDTH = 3;
export const MIN_NODE_PREVIEW_LENGTH = 256;
export const MAX_NODE_PREVIEW_LENGTH = 32 * 1024;

export interface TextNodeRecord {
  id: string;
  contentId: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  presentation?: ContentNodePresentation;
  cardSize?: { width: number; height: number };
  textBoxSize?: { width: number; height: number };
  titleColor: string;
  automaticContext?: boolean;
  placement?: ContentPlacement;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateNodePayload {
  title?: string;
  body?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  automaticContext?: boolean;
  placement?: ContentPlacement;
  history?: boolean;
}

export interface MoveNodePayload {
  id: string;
  x: number;
  y: number;
}

export interface MoveManyPayload {
  positions: NodePosition[];
}

export interface ResizeNodePayload {
  id: string;
  width: number;
  height: number;
  expectedRevision?: number;
}

export interface ResetNodeSizePayload {
  id: string;
}

export interface RenameNodePayload {
  id: string;
  title: string;
}

export function nodePresentation(node: TextNodeRecord): ContentNodePresentation {
  return node.presentation === 'text-box' ? 'text-box' : 'card';
}

export function nodeResizeLimits(
  presentation: ContentNodePresentation,
): ContentNodeResizeLimits {
  return presentation === 'text-box'
    ? {
        minWidth: MIN_TEXT_BOX_WIDTH,
        maxWidth: MAX_NODE_WIDTH,
        minHeight: MIN_TEXT_BOX_HEIGHT,
        maxHeight: MAX_NODE_HEIGHT,
      }
    : {
        minWidth: MIN_NODE_WIDTH,
        maxWidth: MAX_NODE_WIDTH,
        minHeight: MIN_NODE_HEIGHT,
        maxHeight: MAX_NODE_HEIGHT,
      };
}

export function defaultNodeSize(
  presentation: ContentNodePresentation,
): { width: number; height: number } {
  return presentation === 'text-box'
    ? { width: DEFAULT_TEXT_BOX_WIDTH, height: DEFAULT_TEXT_BOX_HEIGHT }
    : { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
}

export function rememberedNodeSize(
  node: TextNodeRecord,
  presentation: ContentNodePresentation,
): { width: number; height: number } {
  const remembered = presentation === 'text-box' ? node.textBoxSize : node.cardSize;
  const fallback = nodePresentation(node) === presentation
    ? { width: node.width, height: node.height ?? defaultNodeSize(presentation).height }
    : defaultNodeSize(presentation);
  const size = remembered ?? fallback;
  const limits = nodeResizeLimits(presentation);
  return {
    width: clampNodeSize(size.width, limits.minWidth, limits.maxWidth),
    height: clampNodeSize(size.height, limits.minHeight, limits.maxHeight),
  };
}

export function withRememberedNodeSize(
  node: TextNodeRecord,
  widthInput: number,
  heightInput: number,
): TextNodeRecord {
  const presentation = nodePresentation(node);
  const limits = nodeResizeLimits(presentation);
  const width = clampNodeSize(widthInput, limits.minWidth, limits.maxWidth);
  const height = clampNodeSize(heightInput, limits.minHeight, limits.maxHeight);
  return {
    ...node,
    width,
    height,
    ...(presentation === 'text-box'
      ? { textBoxSize: { width, height } }
      : { cardSize: { width, height } }),
  };
}

export interface SerializedTextNodes {
  nodes: Array<{
    node: TextNodeRecord;
    content: { id: string; chunks: string[]; length: number; revision: number };
    format?: TextFormatRecord;
    marks?: TextFormatMark[];
  }>;
  plainTextPreview: string;
}

export function validateAppearanceUpdate(input: AppearanceUpdateRequest): void {
  if (!/^#[0-9a-f]{6}$/iu.test(input.color)) throw new Error('颜色必须是六位十六进制颜色');
  if (!Array.isArray(input.entities) || input.entities.length === 0) throw new Error('没有可修改的颜色对象');
  if (new Set(input.entities.map((entity) => entity.id)).size !== input.entities.length) {
    throw new Error('颜色对象不能重复');
  }
  for (const entity of input.entities) {
    if (!entity || typeof entity.id !== 'string' || !Number.isInteger(entity.revision) ||
      !/^#[0-9a-f]{6}$/iu.test(entity.expectedColor)) {
      throw new Error('颜色对象版本不正确');
    }
  }
}

export function isCanvasTextNode(node: TextNodeRecord): boolean {
  return node.placement !== 'system';
}

export function buildTitleColorPlan(
  context: PluginContext,
  color: string,
  entities: AppearanceEntityRef[],
): AppearanceUpdatePlan {
  const nodes = entities.map((entity) => {
    const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, entity.id);
    if (!node) throw new Error(`文本节点已经不存在：${entity.id}`);
    if (node.revision !== entity.revision || node.titleColor !== entity.expectedColor) {
      throw new Error(`节点“${node.title}”已经变化，请重新选择颜色`);
    }
    return node;
  });
  const changed = nodes.filter((node) => node.titleColor !== color);
  if (changed.length === 0) return { patches: [], changed: 0 };
  const updatedAt = Date.now();
  return {
    changed: changed.length,
    patches: changed.map((node) => ({
      op: 'set',
      domain: 'document',
      namespace: NODE_NAMESPACE,
      key: node.id,
      value: { ...node, titleColor: color.toLowerCase(), revision: node.revision + 1, updatedAt },
      schemaOwner: 'text-node',
    })),
    events: [{ type: 'node.appearance.changed', payload: { ids: changed.map((node) => node.id), kind: 'node-title' } }],
  };
}

export function buildTextColorPlan(
  context: PluginContext,
  color: string,
  entities: AppearanceEntityRef[],
): AppearanceUpdatePlan {
  const formats = entities.map((entity) => {
    const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, entity.id);
    if (!node) throw new Error(`文本节点已经不存在：${entity.id}`);
    const format = readFormatRecord(context, node.id);
    if (format.revision !== entity.revision || format.format.color !== entity.expectedColor) {
      throw new Error(`节点“${node.title}”的格式已经变化，请重新选择颜色`);
    }
    return format;
  });
  const changed = formats.filter((format) => format.format.color !== color);
  if (changed.length === 0) return { patches: [], changed: 0 };
  return {
    changed: changed.length,
    patches: changed.map((format) => ({
      op: 'set',
      domain: 'document',
      namespace: FORMAT_NAMESPACE,
      key: format.nodeId,
      value: {
        ...format,
        revision: format.revision + 1,
        format: { ...format.format, color: color.toLowerCase() },
      },
      schemaOwner: 'text-node',
    })),
    events: [{ type: 'content.format.changed', payload: { nodeIds: changed.map((format) => format.nodeId) } }],
  };
}

export function toContextSource(node: TextNodeRecord, content: TextContentRecord): AIContextSource {
  return {
    sourceId: node.id,
    provider: 'text-node',
    kind: 'text',
    title: node.title,
    revision: content.revision,
    length: content.length,
    ...(node.automaticContext === false ? { automaticRetrieval: false } : {}),
  };
}

export async function searchContextNodes(
  nodes: Record<string, TextNodeRecord>,
  readContent: (node: TextNodeRecord) => TextContentRecord | undefined,
  readChunk: (content: TextContentRecord, index: number) => string,
  input: AIContextSearchRequest,
  signal?: AbortSignal,
): Promise<AIContextSearchContribution> {
  if (!input || !Array.isArray(input.terms) || !Number.isInteger(input.maxResults) ||
    input.maxResults < 1 || input.maxResults > 50) {
    throw new Error('context.search request is invalid');
  }
  const terms = [...new Set(input.terms
    .map((term) => term.trim().toLocaleLowerCase('zh-CN'))
    .filter((term) => term.length > 0 && term.length <= 48))]
    .slice(0, 8);
  if (terms.length === 0) return { provider: 'text-node', hits: [], scanned: 0 };
  const hits: AIContextSearchContribution['hits'] = [];
  let scanned = 0;
  let scannedChunks = 0;
  for (const node of Object.values(nodes)) {
    assertNotAborted(signal);
    if (node.automaticContext === false) continue;
    const content = readContent(node);
    if (!content) continue;
    scanned += 1;
    const title = node.title.toLocaleLowerCase('zh-CN');
    let score = terms.reduce((total, term) => total + (title.includes(term) ? 8 : 0), 0);
    let firstStart = -1;
    let offset = 0;
    const lengths = contentChunkLengths(content);
    for (let chunkIndex = 0; chunkIndex < lengths.length; chunkIndex += 1) {
      assertNotAborted(signal);
      const chunk = readChunk(content, chunkIndex);
      const searchable = chunk.toLocaleLowerCase('zh-CN');
      for (const term of terms) {
        let cursor = 0;
        let matches = 0;
        while (matches < 4) {
          const index = searchable.indexOf(term, cursor);
          if (index < 0) break;
          if (firstStart < 0) firstStart = offset + index;
          score += 1;
          matches += 1;
          cursor = index + Math.max(1, term.length);
        }
      }
      offset += chunk.length;
      scannedChunks += 1;
      if (scannedChunks % 8 === 0) await yieldToMainThread();
    }
    if (score <= 0) continue;
    const previewStart = Math.max(0, (firstStart < 0 ? 0 : firstStart) - 90);
    const preview = readRangeWithReader(
      contentChunkLengths(content),
      (index) => readChunk(content, index),
      previewStart,
      360,
    ).replace(/\s+/gu, ' ').trim();
    hits.push({
      source: toContextSource(node, content),
      start: previewStart,
      length: Math.min(360, Math.max(0, content.length - previewStart)),
      preview,
      score,
    });
    hits.sort((left, right) => right.score - left.score || left.source.title.localeCompare(right.source.title, 'zh-CN'));
    if (hits.length > input.maxResults) hits.length = input.maxResults;
  }
  return { provider: 'text-node', hits, scanned };
}

export function isMovePayload(payload: unknown): payload is MoveNodePayload {
  return (
    isRecord(payload) &&
    typeof payload.id === 'string' &&
    Number.isFinite(payload.x) &&
    Number.isFinite(payload.y)
  );
}

export function buildMovePlan(
  context: PluginContext,
  positions: NodePosition[],
  portable = false,
): ContentMovePlan {
  const updatedAt = Date.now();
  const normalized = positions.map((position) => ({ ...position }));
  const patches = normalized.map((position) => {
    const node = context.store.readValue<TextNodeRecord>(NODE_NAMESPACE, position.id);
    if (!node) throw new Error(`Text node not found: ${position.id}`);
    return {
      op: 'set' as const,
      domain: 'document' as const,
      namespace: NODE_NAMESPACE,
      key: node.id,
      value: {
        ...node,
        x: position.x,
        y: position.y,
        revision: node.revision + 1,
        updatedAt,
      },
      ...(portable ? { schemaOwner: 'text-node' } : {}),
    };
  });
  return {
    positions: normalized,
    patches,
    events: [{ type: 'nodes.moved', payload: { positions: normalized } }],
  };
}

export function isMoveManyPayload(payload: unknown): payload is MoveManyPayload {
  return (
    isRecord(payload) &&
    Array.isArray(payload.positions) &&
    payload.positions.length > 0 &&
    payload.positions.every(
      (position) =>
        isRecord(position) &&
        typeof position.id === 'string' &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y),
    )
  );
}

export function isResizePayload(payload: unknown): payload is ResizeNodePayload {
  return (
    isRecord(payload) &&
    typeof payload.id === 'string' &&
    Number.isFinite(payload.width) &&
    Number.isFinite(payload.height) &&
    (payload.expectedRevision === undefined || Number.isInteger(payload.expectedRevision))
  );
}

export function nodeHeight(node: TextNodeRecord): number {
  const presentation = nodePresentation(node);
  const limits = nodeResizeLimits(presentation);
  return Number.isFinite(node.height)
    ? clampNodeSize(node.height!, limits.minHeight, limits.maxHeight)
    : defaultNodeSize(presentation).height;
}

export function nodePreviewLength(node: TextNodeRecord): number {
  const contentWidth = Math.max(1, node.width - NODE_PREVIEW_HORIZONTAL_PADDING);
  const contentHeight = Math.max(
    1,
    nodeHeight(node) - NODE_HEADER_HEIGHT - NODE_PREVIEW_VERTICAL_PADDING,
  );
  const visibleLines = Math.ceil(contentHeight / NODE_PREVIEW_LINE_HEIGHT) + 1;
  const charactersPerLine = Math.ceil(contentWidth / NODE_PREVIEW_MIN_GLYPH_WIDTH) + 2;
  return Math.min(
    MAX_NODE_PREVIEW_LENGTH,
    Math.max(MIN_NODE_PREVIEW_LENGTH, visibleLines * charactersPerLine),
  );
}

export function clampNodeSize(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

export function isDeltaPayload(payload: unknown): payload is ApplyContentDeltaRequest {
  return (
    isRecord(payload) &&
    typeof payload.nodeId === 'string' &&
    Number.isInteger(payload.start) &&
    Number.isInteger(payload.deleteCount) &&
    typeof payload.insert === 'string' &&
    (payload.expectedRevision === undefined || Number.isInteger(payload.expectedRevision)) &&
    (payload.typingSessionId === undefined || typeof payload.typingSessionId === 'string') &&
    (payload.inheritFormat === undefined || isFormatPatch(payload.inheritFormat)) &&
    (payload.annotationCopies === undefined || isAnnotationClipboardItems(payload.annotationCopies, payload.insert.length))
  );
}

export function isAnnotationClipboardItems(value: unknown, insertionLength: number): value is AnnotationClipboardItem[] {
  if (!Array.isArray(value) || value.length > MAX_ANNOTATION_CLIPBOARD_ITEMS) return false;
  let bodyLength = 0;
  for (const item of value) {
    if (!isRecord(item) || !Number.isInteger(item.relativeOffset) ||
      (item.relativeOffset as number) < 0 || (item.relativeOffset as number) > insertionLength ||
      typeof item.body !== 'string' || item.body.length > MAX_ANNOTATION_BODY_LENGTH) return false;
    bodyLength += item.body.length;
    if (bodyLength > MAX_ANNOTATION_CLIPBOARD_BODY) return false;
  }
  return true;
}

export function isMoveRangePayload(payload: unknown): payload is MoveContentRangeRequest {
  return isRecord(payload) && typeof payload.nodeId === 'string' &&
    Number.isInteger(payload.start) && Number.isInteger(payload.end) && Number.isInteger(payload.target) &&
    (payload.expectedRevision === undefined || Number.isInteger(payload.expectedRevision));
}

export function isSerializedTextNodes(payload: unknown): payload is SerializedTextNodes {
  return (
    isRecord(payload) &&
    typeof payload.plainTextPreview === 'string' &&
    Array.isArray(payload.nodes) &&
    payload.nodes.every(
      (entry) =>
        isRecord(entry) &&
        isRecord(entry.node) &&
        typeof entry.node.id === 'string' &&
        typeof entry.node.contentId === 'string' &&
        isRecord(entry.content) &&
        typeof entry.content.id === 'string' &&
        Array.isArray(entry.content.chunks) &&
        entry.content.chunks.every((chunk) => typeof chunk === 'string') &&
        (entry.format === undefined ||
          (isRecord(entry.format) &&
            typeof entry.format.nodeId === 'string' &&
            Number.isInteger(entry.format.revision) &&
            isRecord(entry.format.format))) &&
        (entry.marks === undefined ||
          (Array.isArray(entry.marks) && entry.marks.every((mark) =>
            isRecord(mark) &&
            typeof mark.id === 'string' &&
            typeof mark.nodeId === 'string' &&
            (mark.scope === 'selection' || mark.scope === 'paragraph') &&
            isRecord(mark.start) && Number.isInteger(mark.start.offset) &&
            (mark.start.bias === 'before' || mark.start.bias === 'after') &&
            isRecord(mark.end) && Number.isInteger(mark.end.offset) &&
            (mark.end.bias === 'before' || mark.end.bias === 'after') &&
            isFormatPatch(mark.format)))),
    )
  );
}

export function validateSearchRequest(input: ContentSearchRequest): void {
  if (!input || typeof input.query !== 'string' || input.query.length === 0 || input.query.length > 512) {
    throw new Error('查找内容长度必须在1到512个字符之间');
  }
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 5000) {
    throw new Error('查找结果上限必须在1到5000之间');
  }
  if (input.nodeIds && (!Array.isArray(input.nodeIds) || input.nodeIds.some((id) => typeof id !== 'string'))) {
    throw new Error('查找节点范围不正确');
  }
}

export async function searchChunks(
  node: TextNodeRecord,
  content: TextContentRecord,
  readChunk: (index: number) => string,
  request: ContentSearchRequest,
  limit: number,
  signal?: AbortSignal,
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const hits: SearchHit[] = [];
  const expression = new RegExp(escapeRegExp(request.query), request.matchCase ? 'gu' : 'giu');
  const carrySize = request.query.length + 1;
  let carry = '';
  let offset = 0;
  const lengths = contentChunkLengths(content);
  let nextChunk = lengths.length > 0 ? readChunk(0) : '';
  for (let index = 0; index < lengths.length; index += 1) {
    assertNotAborted(signal);
    const chunk = nextChunk;
    nextChunk = index + 1 < lengths.length ? readChunk(index + 1) : '';
    const nextLead = nextChunk.slice(0, 2);
    const window = carry + chunk + nextLead;
    const base = offset - carry.length;
    expression.lastIndex = 0;
    for (const match of window.matchAll(expression)) {
      const localStart = match.index;
      const localEnd = localStart + match[0].length;
      const start = base + localStart;
      const end = start + match[0].length;
      if (end <= offset || end > offset + chunk.length) continue;
      if (request.wholeWord && !hasWordBoundaries(window, localStart, localEnd, request.query)) continue;
      hits.push({
        nodeId: node.id,
        title: node.title,
        start,
        length: match[0].length,
        matchedText: match[0],
        preview: window.slice(Math.max(0, localStart - 36), Math.min(window.length, localEnd + 36)),
        revision: content.revision,
      });
      if (hits.length >= limit) return { hits, truncated: true };
    }
    carry = (carry + chunk).slice(-carrySize);
    offset += chunk.length;
    if (index % 8 === 7) await yieldToMainThread();
  }
  return { hits, truncated: false };
}

export function contentStatisticsSignature(content: TextContentRecord): string {
  if (isVersionTwoContent(content)) {
    return `${content.revision}:${content.length}:${content.chunkIds!.join('|')}`;
  }
  return `${content.revision}:${content.length}:legacy:${(content.chunks ?? []).join('\u0000')}`;
}

export async function countContentChunks(
  context: PluginContext,
  content: TextContentRecord,
  signal?: AbortSignal,
): Promise<{
  graphemes: number;
  nonWhitespaceGraphemes: number;
  writingUnits: number;
  words: number;
  lines: number;
}> {
  let words = 0;
  let newlines = 0;
  let wordCarry = '';
  const writingUnitCounter = new WritingUnitCounter();
  const graphemeCounter = new StreamingGraphemeCounter((segment) => writingUnitCounter.pushGrapheme(segment));
  const wordSegmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
    : undefined;
  const lengths = contentChunkLengths(content);
  for (let index = 0; index < lengths.length; index += 1) {
    assertNotAborted(signal);
    const chunk = readContentChunk(context, content, index);
    newlines += countNewlines(chunk);
    graphemeCounter.push(chunk);
    if (wordSegmenter) {
      const segments = [...wordSegmenter.segment(wordCarry + chunk)];
      const held = index < lengths.length - 1 ? segments.pop()?.segment ?? '' : '';
      words += segments.filter((segment) => segment.isWordLike).length;
      wordCarry = held;
    } else {
      words += (chunk.match(/[\p{L}\p{N}_]+/gu) ?? []).length;
    }
    if (index % 8 === 7) await yieldToMainThread();
  }
  const graphemeCounts = graphemeCounter.finish();
  return {
    ...graphemeCounts,
    writingUnits: writingUnitCounter.value,
    words,
    lines: content.length === 0 ? 0 : newlines + 1,
  };
}

export function hasWordBoundaries(window: string, start: number, end: number, query: string): boolean {
  const first = query[0];
  const last = query.at(-1) ?? '';
  const before = start > 0 ? [...window.slice(0, start)].at(-1) ?? '' : '';
  const after = [...window.slice(end)].at(0) ?? '';
  return (!isWordCharacter(first) || !isWordCharacter(before)) &&
    (!isWordCharacter(last) || !isWordCharacter(after));
}

export function isWordCharacter(value: string): boolean {
  return value.length > 0 && /[\p{L}\p{N}_]/u.test(value);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countNewlines(value: string): number {
  let count = 0;
  for (let index = value.indexOf('\n'); index >= 0; index = value.indexOf('\n', index + 1)) count += 1;
  return count;
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Task aborted', 'AbortError');
}

export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
