import type { WritingActivityKind } from '../../protocols/editor.ts';

export interface TextDelta {
  start: number;
  deleteCount: number;
  deletedText: string;
  insert: string;
}

export interface TextRangeMove {
  start: number;
  end: number;
  target: number;
}

export interface PlannedTextRangeMove {
  next: string;
  cursor: number;
  delta: TextDelta;
  move: TextRangeMove;
}

/** Plans a same-document move. Target uses the offsets before removing the source range. */
export function planTextRangeMove(
  text: string,
  start: number,
  end: number,
  target: number,
): PlannedTextRangeMove | undefined {
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(target) ||
    start < 0 || end <= start || end > text.length || target < 0 || target > text.length ||
    target >= start && target <= end) return undefined;
  const moved = text.slice(start, end);
  const length = end - start;
  const destination = target < start ? target : target - length;
  const withoutSource = `${text.slice(0, start)}${text.slice(end)}`;
  const next = `${withoutSource.slice(0, destination)}${moved}${withoutSource.slice(destination)}`;
  return {
    next,
    cursor: destination + length,
    delta: calculateTextDelta(text, next),
    move: { start, end, target },
  };
}

/** Finds the smallest contiguous replacement that changes previous into next. */
export function calculateTextDelta(previous: string, next: string): TextDelta {
  let start = 0;
  const commonLimit = Math.min(previous.length, next.length);
  while (start < commonLimit && previous[start] === next[start]) start += 1;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  return {
    start,
    deleteCount: previousEnd - start,
    deletedText: previous.slice(start, previousEnd),
    insert: next.slice(start, nextEnd),
  };
}

/**
 * Repositions an edit captured from a stale editor buffer onto the latest
 * authoritative text. This is used when undo/redo changes the document between
 * the browser input event and the durable content command.
 */
export function rebaseTextDelta(
  previous: string,
  authoritative: string,
  delta: TextDelta,
): TextDelta {
  if (previous === authoritative) return delta;
  const authorityDelta = calculateTextDelta(previous, authoritative);
  const start = mapTextOffset(delta.start, authorityDelta);
  const end = mapTextOffset(delta.start + delta.deleteCount, authorityDelta);
  const normalizedStart = Math.min(start, end);
  const normalizedEnd = Math.max(start, end);
  return {
    start: normalizedStart,
    deleteCount: normalizedEnd - normalizedStart,
    deletedText: authoritative.slice(normalizedStart, normalizedEnd),
    insert: delta.insert,
  };
}

/** Maps an offset through the one contiguous replacement produced by calculateTextDelta. */
export function mapTextOffset(offset: number, change: TextDelta): number {
  const oldEnd = change.start + change.deleteCount;
  if (offset < change.start) return offset;
  if (offset > oldEnd || (offset === oldEnd && change.deleteCount > 0)) {
    return offset + change.insert.length - change.deleteCount;
  }
  if (change.deleteCount === 0) return change.start + change.insert.length;
  return change.start + Math.min(offset - change.start, change.insert.length);
}

export function classifyWritingInput(inputType: string, delta: TextDelta): WritingActivityKind {
  if (/paste|drop/iu.test(inputType)) return 'paste';
  if (inputType.startsWith('delete')) return 'delete';
  return delta.deleteCount > 0 && delta.insert.length > 0 ? 'replace' : 'insert';
}
