import {
  createId,
  isRecord,
  type PatchOperation,
  type PluginContext,
} from '../../core/contracts.ts';
import {
  DEFAULT_TEXT_DOCUMENT_FORMAT,
  type SetTextDocumentFormatRequest,
  type SetTextRangeFormatRequest,
  type TextAnchor,
  type TextDocumentFormat,
  type TextFormatMark,
  type TextFormatSnapshot,
  type TextFormattingSnapshot,
} from '../../protocols/formatting.ts';
import type { TextContentRecord } from './content-storage.ts';

export const FORMAT_NAMESPACE = 'textFormat';
export const FORMAT_MARK_NAMESPACE = 'textFormatMark';

export const MAX_FORMAT_MARKS_PER_NODE = 10_000;
const FORMAT_FIELDS = new Set<keyof TextDocumentFormat>([
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'color',
  'firstLineIndent',
  'paragraphSpacing',
]);

export interface TextFormatRecord {
  nodeId: string;
  storageVersion?: 1 | 2;
  markIds?: string[];
  revision: number;
  format: TextDocumentFormat;
}

interface FormattingEdit {
  start: number;
  deleteCount: number;
  insertLength: number;
}

interface FormattingInheritance {
  start: number;
  length: number;
  format: Partial<TextDocumentFormat>;
}

export function isSetDocumentFormatRequest(payload: unknown): payload is SetTextDocumentFormatRequest {
  return isRecord(payload) &&
    typeof payload.nodeId === 'string' &&
    Number.isInteger(payload.expectedRevision) &&
    isFormatPatch(payload.patch, true);
}

export function isSetRangeFormatRequest(payload: unknown): payload is SetTextRangeFormatRequest {
  return isRecord(payload) &&
    typeof payload.nodeId === 'string' &&
    Number.isInteger(payload.expectedRevision) &&
    Number.isInteger(payload.expectedContentRevision) &&
    Number.isInteger(payload.start) &&
    Number.isInteger(payload.end) &&
    (payload.scope === 'selection' || payload.scope === 'paragraph') &&
    isFormatPatch(payload.patch);
}

export function readFormatRecord(context: PluginContext, nodeId: string): TextFormatRecord {
  const stored = context.store.readValue<TextFormatRecord>(FORMAT_NAMESPACE, nodeId);
  if (stored) return {
    ...stored,
    storageVersion: 2,
    markIds: Array.isArray(stored.markIds) ? [...stored.markIds] : [],
  };
  return {
    nodeId,
    storageVersion: 2,
    markIds: [],
    revision: 0,
    format: { ...DEFAULT_TEXT_DOCUMENT_FORMAT },
  };
}

export function toFormatSnapshot(record: TextFormatRecord): TextFormatSnapshot {
  return { nodeId: record.nodeId, revision: record.revision, format: { ...record.format } };
}

export function readFormatMarks(context: PluginContext, record: TextFormatRecord): TextFormatMark[] {
  return (record.markIds ?? []).flatMap((id) => {
    const mark = context.store.readValue<TextFormatMark>(FORMAT_MARK_NAMESPACE, id);
    return mark ? [{
      ...mark,
      start: { ...mark.start },
      end: { ...mark.end },
      format: { ...mark.format },
    }] : [];
  });
}

export function toFormattingSnapshot(
  context: PluginContext,
  record: TextFormatRecord,
  content: TextContentRecord,
  rangeStart: number,
  rangeLength: number,
  suppliedMarks?: TextFormatMark[],
): TextFormattingSnapshot {
  const rangeEnd = rangeStart + rangeLength;
  const marks = (suppliedMarks ?? readFormatMarks(context, record)).filter((mark) =>
    rangeLength === 0
      ? mark.start.offset <= rangeStart && mark.end.offset >= rangeStart
      : mark.start.offset < rangeEnd && mark.end.offset > rangeStart);
  return {
    ...toFormatSnapshot(record),
    contentRevision: content.revision,
    rangeStart,
    rangeLength,
    marks,
  };
}

export function planFormattingEdits(
  context: PluginContext,
  nodeId: string,
  edits: FormattingEdit[],
  inheritance?: FormattingInheritance,
): { patches: PatchOperation[]; revision?: number } {
  const record = readFormatRecord(context, nodeId);
  const originalMarks = readFormatMarks(context, record);
  if ((originalMarks.length === 0 || edits.length === 0) && !inheritance) return { patches: [] };
  let marks = originalMarks;
  for (const edit of edits) {
    marks = marks.flatMap((mark) => {
      const start = transformAnchor(mark.start, edit);
      const end = transformAnchor(mark.end, edit);
      if (start.offset >= end.offset) return [];
      if (start.offset === mark.start.offset && end.offset === mark.end.offset) return [mark];
      return [{ ...mark, start, end, revision: mark.revision + 1 }];
    });
  }
  if (inheritance && inheritance.length > 0) {
    const start = inheritance.start;
    const end = start + inheritance.length;
    const normalizedFormat = validateFormatPatch(inheritance.format);
    const inheritedFormat = Object.fromEntries(
      Object.entries(normalizedFormat).filter(([key, value]) =>
        record.format[key as keyof TextDocumentFormat] !== value),
    ) as Partial<TextDocumentFormat>;
    if (Object.keys(inheritedFormat).length > 0) {
      const existingIndex = marks.findIndex((mark) =>
        mark.scope === 'selection' && mark.start.offset === start && mark.end.offset === end);
      if (existingIndex >= 0) {
        const existing = marks[existingIndex];
        marks = marks.map((mark, index) => index === existingIndex ? {
          ...existing,
          format: { ...existing.format, ...inheritedFormat },
          revision: existing.revision + 1,
        } : mark);
      } else {
        if (marks.length >= MAX_FORMAT_MARKS_PER_NODE) {
          throw new Error(`单个节点最多保留 ${MAX_FORMAT_MARKS_PER_NODE} 个格式区间`);
        }
        marks = [...marks, {
          id: createId('format-mark'),
          nodeId,
          scope: 'selection',
          start: { offset: start, bias: 'after' },
          end: { offset: end, bias: 'before' },
          format: inheritedFormat,
          revision: 1,
        }];
      }
    }
  }
  const originalById = new Map(originalMarks.map((mark) => [mark.id, mark]));
  const nextById = new Map(marks.map((mark) => [mark.id, mark]));
  const patches: PatchOperation[] = [];
  let changed = false;
  for (const mark of originalMarks) {
    const next = nextById.get(mark.id);
    if (!next) {
      changed = true;
      patches.push({ op: 'delete', domain: 'document', namespace: FORMAT_MARK_NAMESPACE, key: mark.id });
      continue;
    }
    if (next !== mark || next.start.offset !== mark.start.offset || next.end.offset !== mark.end.offset) {
      changed = true;
      patches.push({ op: 'set', domain: 'document', namespace: FORMAT_MARK_NAMESPACE, key: mark.id, value: next });
    }
  }
  for (const mark of marks) {
    if (originalById.has(mark.id)) continue;
    changed = true;
    patches.push({ op: 'set', domain: 'document', namespace: FORMAT_MARK_NAMESPACE, key: mark.id, value: mark });
  }
  if (!changed) return { patches: [] };
  const revision = record.revision + 1;
  patches.push({
    op: 'set',
    domain: 'document',
    namespace: FORMAT_NAMESPACE,
    key: nodeId,
    value: { ...record, storageVersion: 2, markIds: marks.map((mark) => mark.id), revision } satisfies TextFormatRecord,
  });
  return { patches, revision };
}

export function planFormattingMove(
  context: PluginContext,
  nodeId: string,
  start: number,
  end: number,
  target: number,
): { patches: PatchOperation[]; revision?: number } {
  const record = readFormatRecord(context, nodeId);
  const originalMarks = readFormatMarks(context, record);
  if (originalMarks.length === 0) return { patches: [] };
  const marks = originalMarks.flatMap((mark) => moveFormatMark(mark, start, end, target));
  if (marks.length > MAX_FORMAT_MARKS_PER_NODE) {
    throw new Error(`移动文字后格式区间将超过 ${MAX_FORMAT_MARKS_PER_NODE} 个`);
  }
  const originalById = new Map(originalMarks.map((mark) => [mark.id, mark]));
  const nextById = new Map(marks.map((mark) => [mark.id, mark]));
  const patches: PatchOperation[] = [];
  for (const mark of originalMarks) {
    const next = nextById.get(mark.id);
    if (!next) {
      patches.push({ op: 'delete', domain: 'document', namespace: FORMAT_MARK_NAMESPACE, key: mark.id });
    } else if (!sameFormatMark(mark, next)) {
      patches.push({ op: 'set', domain: 'document', namespace: FORMAT_MARK_NAMESPACE, key: mark.id, value: next });
    }
  }
  for (const mark of marks) {
    if (originalById.has(mark.id)) continue;
    patches.push({ op: 'set', domain: 'document', namespace: FORMAT_MARK_NAMESPACE, key: mark.id, value: mark });
  }
  if (patches.length === 0) return { patches: [] };
  const revision = record.revision + 1;
  patches.push({
    op: 'set',
    domain: 'document',
    namespace: FORMAT_NAMESPACE,
    key: nodeId,
    value: { ...record, storageVersion: 2, markIds: marks.map((mark) => mark.id), revision } satisfies TextFormatRecord,
  });
  return { patches, revision };
}

export function validateDocumentFormat(format: TextDocumentFormat): TextDocumentFormat {
  if (!/^#[0-9a-f]{6}$/iu.test(format.color)) throw new Error('正文颜色必须是六位十六进制颜色');
  return {
    fontSize: clampNumber(format.fontSize, 10, 48, '字号'),
    fontWeight: clampNumber(format.fontWeight, 300, 900, '字重'),
    lineHeight: clampNumber(format.lineHeight, 1.1, 3, '行距'),
    letterSpacing: clampNumber(format.letterSpacing, -1, 6, '字距'),
    color: format.color.toLowerCase(),
    firstLineIndent: clampNumber(format.firstLineIndent, 0, 4, '首行缩进'),
    paragraphSpacing: clampNumber(format.paragraphSpacing, 0, 3, '段后间距'),
  };
}

export function isFormatPatch(patch: unknown, allowEmpty = false): patch is Partial<TextDocumentFormat> {
  if (!isRecord(patch) || (!allowEmpty && Object.keys(patch).length === 0)) return false;
  return Object.entries(patch).every(
    ([key, value]) => FORMAT_FIELDS.has(key as keyof TextDocumentFormat) &&
      (key === 'color' ? typeof value === 'string' : typeof value === 'number' && Number.isFinite(value)),
  );
}

function moveFormatMark(
  mark: TextFormatMark,
  moveStart: number,
  moveEnd: number,
  target: number,
): TextFormatMark[] {
  const cuts = [mark.start.offset, mark.end.offset, moveStart, moveEnd, target]
    .filter((offset) => offset >= mark.start.offset && offset <= mark.end.offset)
    .sort((left, right) => left - right)
    .filter((offset, index, values) => index === 0 || offset !== values[index - 1]);
  const pieces = cuts.slice(0, -1).flatMap((pieceStart, index) => {
    const pieceEnd = cuts[index + 1];
    if (pieceEnd <= pieceStart) return [];
    const shift = moveOffsetShift(pieceStart, pieceEnd, moveStart, moveEnd, target);
    return [{
      start: {
        offset: pieceStart + shift,
        bias: pieceStart === mark.start.offset ? mark.start.bias : 'after',
      } satisfies TextAnchor,
      end: {
        offset: pieceEnd + shift,
        bias: pieceEnd === mark.end.offset ? mark.end.bias : 'before',
      } satisfies TextAnchor,
    }];
  }).sort((left, right) => left.start.offset - right.start.offset);
  const merged = pieces.reduce<Array<{ start: TextAnchor; end: TextAnchor }>>((result, piece) => {
    const previous = result.at(-1);
    if (previous && previous.end.offset >= piece.start.offset) {
      previous.end = piece.end.offset >= previous.end.offset ? piece.end : previous.end;
      return result;
    }
    result.push({ start: { ...piece.start }, end: { ...piece.end } });
    return result;
  }, []);
  return merged.map((range, index) => ({
    ...mark,
    id: index === 0 ? mark.id : createId('format-mark'),
    start: range.start,
    end: range.end,
    revision: mark.revision + 1,
  }));
}

function moveOffsetShift(
  start: number,
  end: number,
  moveStart: number,
  moveEnd: number,
  target: number,
): number {
  const length = moveEnd - moveStart;
  if (target < moveStart) {
    if (start >= moveStart && end <= moveEnd) return target - moveStart;
    if (start >= target && end <= moveStart) return length;
    return 0;
  }
  if (start >= moveStart && end <= moveEnd) return target - moveEnd;
  if (start >= moveEnd && end <= target) return -length;
  return 0;
}

function sameFormatMark(left: TextFormatMark, right: TextFormatMark): boolean {
  return left.id === right.id && left.scope === right.scope &&
    left.start.offset === right.start.offset && left.start.bias === right.start.bias &&
    left.end.offset === right.end.offset && left.end.bias === right.end.bias &&
    JSON.stringify(left.format) === JSON.stringify(right.format);
}

function transformAnchor(anchor: TextAnchor, edit: FormattingEdit): TextAnchor {
  const end = edit.start + edit.deleteCount;
  if (edit.deleteCount === 0) {
    if (anchor.offset < edit.start || (anchor.offset === edit.start && anchor.bias === 'before')) {
      return { ...anchor };
    }
    return { ...anchor, offset: anchor.offset + edit.insertLength };
  }
  if (anchor.offset < edit.start) return { ...anchor };
  if (anchor.offset > end) {
    return { ...anchor, offset: anchor.offset - edit.deleteCount + edit.insertLength };
  }
  return {
    ...anchor,
    offset: anchor.bias === 'after' ? edit.start + edit.insertLength : edit.start,
  };
}

export function validateFormatPatch(patch: Partial<TextDocumentFormat>): Partial<TextDocumentFormat> {
  if (!isFormatPatch(patch)) throw new Error('正文格式补丁不正确');
  const validated = validateDocumentFormat({ ...DEFAULT_TEXT_DOCUMENT_FORMAT, ...patch });
  return Object.fromEntries(
    Object.keys(patch).map((key) => [key, validated[key as keyof TextDocumentFormat]]),
  ) as Partial<TextDocumentFormat>;
}

function clampNumber(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label}超出允许范围`);
  }
  return value;
}
