import type {
  TextDocumentFormat,
  TextFormatMark,
} from '../../protocols/formatting.ts';

export type FormatTarget = 'document' | 'selection' | 'paragraph';

export interface EditorSelectionRange {
  start: number;
  end: number;
}

export interface EditorFormattingDocument {
  length: number;
  body: string;
  windowStart: number;
  format: TextDocumentFormat;
  marks: TextFormatMark[];
}

export function inferFormatTarget(
  document: EditorFormattingDocument,
  selection?: EditorSelectionRange,
): FormatTarget {
  if (document.length === 0) return 'document';
  if (selection && selection.start === 0 && selection.end === document.length) return 'document';
  if (selection && selection.end > selection.start) return 'selection';
  return 'document';
}

export function resolveActiveFormat(
  document: EditorFormattingDocument,
  selection?: EditorSelectionRange,
): TextDocumentFormat {
  const target = inferFormatTarget(document, selection);
  if (target === 'document') return { ...document.format };
  const range = resolveFormatRange(document, target, selection);
  if (!range) return { ...document.format };
  const caret = selection?.start ?? range.start;
  return document.marks.reduce((resolved, mark) => {
    const coversSelection = target === 'selection' &&
      mark.start.offset <= range.start && mark.end.offset >= range.end;
    const coversCaret = target === 'paragraph' &&
      mark.start.offset <= caret && mark.end.offset >= caret;
    const coversParagraph = target === 'paragraph' && mark.scope === 'paragraph' &&
      mark.start.offset < range.end && mark.end.offset > range.start;
    return coversSelection || coversCaret || coversParagraph ? { ...resolved, ...mark.format } : resolved;
  }, { ...document.format });
}

export function resolveFormatAtOffset(
  documentFormat: TextDocumentFormat,
  marks: TextFormatMark[],
  offset: number,
): TextDocumentFormat {
  const point = Math.max(0, offset);
  const direct = marks.filter((mark) => mark.start.offset <= point && mark.end.offset > point);
  const applicable = direct.length > 0
    ? direct
    : marks.filter((mark) => point > 0 && mark.start.offset < point && mark.end.offset >= point);
  return applicable.reduce(
    (resolved, mark) => ({ ...resolved, ...mark.format }),
    { ...documentFormat },
  );
}

export function resolveFormatRange(
  document: EditorFormattingDocument,
  target: Exclude<FormatTarget, 'document'>,
  selection?: EditorSelectionRange,
): { start: number; end: number } | undefined {
  if (!selection) return undefined;
  if (target === 'selection') {
    return selection.end > selection.start
      ? { start: selection.start, end: selection.end }
      : undefined;
  }
  const localStart = Math.max(0, Math.min(document.body.length, selection.start - document.windowStart));
  const localEnd = Math.max(localStart, Math.min(document.body.length, selection.end - document.windowStart));
  const start = document.body.lastIndexOf('\n', Math.max(0, localStart - 1)) + 1;
  const endProbe = Math.max(localStart, localEnd - (localEnd > localStart ? 1 : 0));
  const nextBreak = document.body.indexOf('\n', endProbe);
  const end = nextBreak < 0 ? document.body.length : nextBreak + 1;
  return end > start
    ? { start: document.windowStart + start, end: document.windowStart + end }
    : undefined;
}

export function resolveFormatBrushRange(
  document: Pick<EditorFormattingDocument, 'length' | 'body' | 'windowStart'>,
  selection: EditorSelectionRange,
): { start: number; end: number } | undefined {
  const start = Math.max(0, Math.min(document.length, Math.min(selection.start, selection.end)));
  const end = Math.max(start, Math.min(document.length, Math.max(selection.start, selection.end)));
  if (end > start) return { start, end };
  if (document.body.length === 0) return undefined;
  let local = Math.max(0, Math.min(document.body.length - 1, start - document.windowStart));
  const currentCode = document.body.charCodeAt(local);
  const previousCode = local > 0 ? document.body.charCodeAt(local - 1) : 0;
  if (currentCode >= 0xdc00 && currentCode <= 0xdfff && previousCode >= 0xd800 && previousCode <= 0xdbff) {
    local -= 1;
  }
  if (typeof Intl.Segmenter === 'function') {
    for (const segment of new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(document.body)) {
      if (local < segment.index || local >= segment.index + segment.segment.length) continue;
      return {
        start: document.windowStart + segment.index,
        end: document.windowStart + segment.index + segment.segment.length,
      };
    }
  }
  const length = String.fromCodePoint(document.body.codePointAt(local)!).length;
  return { start: document.windowStart + local, end: document.windowStart + local + length };
}
