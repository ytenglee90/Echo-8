import {
  PARAGRAPH_FORMAT_FIELDS,
  type TextDocumentFormat,
  type TextFormatMark,
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
  if (document.length === 0 && document.marks.length === 0) return 'document';
  if (selection && selection.end > selection.start) return 'selection';
  return selection ? 'paragraph' : 'document';
}

export function resolveActiveFormat(
  document: EditorFormattingDocument,
  selection?: EditorSelectionRange,
): TextDocumentFormat {
  if (!selection) return { ...document.format };
  const range = resolveFormatRange(document, 'paragraph', { start: selection.start, end: selection.start })!;
  const point = selection.start;
  // Prefer the character under the caret, except at the end of a paragraph.
  // Never inherit the previous paragraph merely because its mark ends here.
  const local = point - document.windowStart;
  const probe = point > range.start && (local === document.body.length || document.body[local] === '\n')
    ? point - 1 : point;
  const resolved = resolveFormatAtOffset(document.format, document.marks, probe, false);
  for (const mark of document.marks) {
    if (mark.start.offset < range.end && mark.end.offset > range.start ||
      mark.scope === 'paragraph' && mark.start.offset === point && mark.end.offset === point) {
      for (const key of PARAGRAPH_FORMAT_FIELDS) {
        if (mark.format[key] !== undefined) resolved[key] = mark.format[key];
      }
    }
  }
  return resolved;
}

export { PARAGRAPH_FORMAT_FIELDS };

/** Index only the mounted window once, then resolve ranges by binary search. */
function paragraphRangeResolver(document: EditorFormattingDocument) {
  const starts = [0];
  for (let at = document.body.indexOf('\n'); at >= 0; at = document.body.indexOf('\n', at + 1)) starts.push(at + 1);
  const nextLine = (offset: number) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return (selection: EditorSelectionRange) => {
    const start = Math.max(0, Math.min(document.body.length, selection.start - document.windowStart));
    const end = Math.max(start, Math.min(document.body.length, selection.end - document.windowStart));
    const last = Math.max(start, end - (end > start ? 1 : 0));
    return {
      start: document.windowStart + starts[nextLine(start) - 1],
      end: document.windowStart + (starts[nextLine(last)] ?? document.body.length),
    };
  };
}

/** A priority sweep avoids rescanning each character or each overlapping mark. */
export function resolveMixedFormatFields(
  document: EditorFormattingDocument,
  selection?: EditorSelectionRange,
): Array<keyof TextDocumentFormat> {
  if (!selection || selection.end <= selection.start) return [];
  const mixed: Array<keyof TextDocumentFormat> = [];
  const paragraphRange = paragraphRangeResolver(document);
  for (const key of Object.keys(document.format) as Array<keyof TextDocumentFormat>) {
    const paragraph = PARAGRAPH_FORMAT_FIELDS.some((field) => field === key);
    const range = paragraph ? paragraphRange(selection) : selection;
    const events: Array<{ offset: number; index: number; add: boolean }> = [];
    document.marks.forEach((mark, index) => {
      if (mark.format[key] === undefined) return;
      if (mark.end.offset <= range.start || mark.start.offset >= range.end) return;
      const bounds = paragraph ? paragraphRange({
        start: mark.start.offset, end: mark.end.offset,
      }) : { start: mark.start.offset, end: mark.end.offset };
      const start = Math.max(range.start, bounds.start);
      const end = Math.min(range.end, bounds.end);
      if (start < end) events.push({ offset: start, index, add: true }, { offset: end, index, add: false });
    });
    events.sort((a, b) => a.offset - b.offset);
    const active = new Set<number>();
    const heap: number[] = [];
    const push = (index: number) => {
      heap.push(index);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (heap[parent] >= heap[child]) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
    };
    const value = () => {
      while (heap.length && !active.has(heap[0])) {
        const tail = heap.pop()!;
        if (!heap.length) break;
        heap[0] = tail;
        let parent = 0;
        for (;;) {
          const left = parent * 2 + 1;
          const right = left + 1;
          const child = right < heap.length && heap[right] > heap[left] ? right : left;
          if (child >= heap.length || heap[parent] >= heap[child]) break;
          [heap[parent], heap[child]] = [heap[child], heap[parent]];
          parent = child;
        }
      }
      return heap.length ? document.marks[heap[0]].format[key]! : document.format[key];
    };
    let offset = range.start;
    let first: string | number | undefined;
    let index = 0;
    while (offset < range.end) {
      while (index < events.length && events[index].offset <= offset) {
        const event = events[index++];
        if (event.add) { active.add(event.index); push(event.index); }
        else active.delete(event.index);
      }
      const current = value();
      if (first !== undefined && first !== current) { mixed.push(key); break; }
      first = current;
      offset = index < events.length ? events[index].offset : range.end;
    }
  }
  return mixed;
}

export function resolveFormatAtOffset(
  documentFormat: TextDocumentFormat,
  marks: TextFormatMark[],
  offset: number,
  includePrevious = true,
): TextDocumentFormat {
  const point = Math.max(0, offset);
  const direct = marks.filter((mark) => mark.start.offset <= point && (mark.end.offset > point ||
    mark.scope === 'paragraph' && mark.start.offset === point && mark.end.offset === point));
  const applicable = direct.length > 0 || !includePrevious
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
  const start = localStart === 0 ? 0 : document.body.lastIndexOf('\n', localStart - 1) + 1;
  const endProbe = Math.max(localStart, localEnd - (localEnd > localStart ? 1 : 0));
  const nextBreak = document.body.indexOf('\n', endProbe);
  const end = nextBreak < 0 ? document.body.length : nextBreak + 1;
  return { start: document.windowStart + start, end: document.windowStart + end };
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
