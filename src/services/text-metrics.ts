/** Shared text-domain metrics. This service is intentionally outside the headless microkernel. */
const EAST_ASIAN_WRITING_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NON_EAST_ASIAN_WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;
const WORD_CONNECTOR = /['’._\-\u2010-\u2015\p{Pc}]/u;
const WHITESPACE_GRAPHEME = /^\s+$/u;
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
  : undefined;

export interface GraphemeCounts {
  graphemes: number;
  nonWhitespaceGraphemes: number;
}

/** The product-wide definition of a whitespace-only visible character. */
export function isWhitespaceGrapheme(segment: string): boolean {
  return segment.length > 0 && WHITESPACE_GRAPHEME.test(segment);
}

/** Visits user-visible Unicode characters using the same fallback everywhere. */
export function forEachGrapheme(text: string, visit: (segment: string) => void): void {
  if (!text) return;
  if (GRAPHEME_SEGMENTER) {
    for (const segment of GRAPHEME_SEGMENTER.segment(text)) {
      if (segment.segment.length > 0) visit(segment.segment);
    }
    return;
  }
  for (const character of text) if (character.length > 0) visit(character);
}

export function countGraphemes(text: string): number {
  let count = 0;
  forEachGrapheme(text, () => { count += 1; });
  return count;
}

/** Product-visible “字符数”: Unicode grapheme clusters excluding whitespace. */
export function countNonWhitespaceGraphemes(text: string): number {
  let count = 0;
  forEachGrapheme(text, (segment) => {
    if (!isWhitespaceGrapheme(segment)) count += 1;
  });
  return count;
}

/**
 * Counts graphemes across independently stored chunks without treating a chunk
 * boundary as a character boundary. Call finish after the last chunk.
 */
export class StreamingGraphemeCounter {
  private carry = '';
  private graphemes = 0;
  private nonWhitespaceGraphemes = 0;
  private readonly visit: ((segment: string) => void) | undefined;

  constructor(visit?: (segment: string) => void) {
    this.visit = visit;
  }

  push(chunk: string): void {
    if (!chunk) return;
    if (!GRAPHEME_SEGMENTER) {
      const input = this.carry + chunk;
      const trailingHighSurrogate = input.length > 0 && isHighSurrogate(input.charCodeAt(input.length - 1));
      const ready = trailingHighSurrogate ? input.slice(0, -1) : input;
      this.carry = trailingHighSurrogate ? input.at(-1) ?? '' : '';
      forEachGrapheme(ready, (segment) => this.accept(segment));
      return;
    }
    const segments = [...GRAPHEME_SEGMENTER.segment(this.carry + chunk)];
    this.carry = segments.pop()?.segment ?? '';
    for (const segment of segments) this.accept(segment.segment);
  }

  finish(): GraphemeCounts {
    if (this.carry) {
      forEachGrapheme(this.carry, (segment) => this.accept(segment));
      this.carry = '';
    }
    return this.snapshot();
  }

  snapshot(): GraphemeCounts {
    return {
      graphemes: this.graphemes,
      nonWhitespaceGraphemes: this.nonWhitespaceGraphemes,
    };
  }

  private accept(segment: string): void {
    if (!segment) return;
    this.graphemes += 1;
    if (!isWhitespaceGrapheme(segment)) this.nonWhitespaceGraphemes += 1;
    this.visit?.(segment);
  }
}

/**
 * Product-visible writing units used by the editor's “字数” metric.
 *
 * - Han, Hiragana, Katakana and Hangul graphemes count individually.
 * - A contiguous run of other letters/numbers counts as one word.
 * - Whitespace, punctuation and emoji do not count.
 *
 * This deliberately differs from the product's “字符数”, which counts every
 * non-whitespace grapheme, including punctuation and emoji.
 */
export class WritingUnitCounter {
  private count = 0;
  private insideNonEastAsianWord = false;

  pushGrapheme(segment: string): void {
    if (!segment) return;
    if (EAST_ASIAN_WRITING_CHARACTER.test(segment)) {
      this.count += 1;
      this.insideNonEastAsianWord = false;
      return;
    }
    if (NON_EAST_ASIAN_WORD_CHARACTER.test(segment)) {
      if (!this.insideNonEastAsianWord) this.count += 1;
      this.insideNonEastAsianWord = true;
      return;
    }
    if (this.insideNonEastAsianWord && WORD_CONNECTOR.test(segment)) return;
    this.insideNonEastAsianWord = false;
  }

  get value(): number {
    return this.count;
  }
}

export function countWritingUnits(text: string): number {
  if (!text) return 0;
  const counter = new WritingUnitCounter();
  forEachGrapheme(text, (segment) => counter.pushGrapheme(segment));
  return counter.value;
}

export interface WritingUnitDelta {
  start: number;
  deleteCount: number;
  insert: string;
}

/**
 * Updates a document-wide count by rescanning only the changed lexical run.
 * This keeps typing cost bounded even when the durable document is very large.
 */
export function updateWritingUnitCount(
  currentCount: number,
  previous: string,
  next: string,
  delta: WritingUnitDelta,
): number {
  const previousStart = expandWritingRunLeft(previous, delta.start);
  const previousEnd = expandWritingRunRight(previous, delta.start + delta.deleteCount);
  const nextStart = expandWritingRunLeft(next, delta.start);
  const nextEnd = expandWritingRunRight(next, delta.start + delta.insert.length);
  return Math.max(
    0,
    currentCount - countWritingUnits(previous.slice(previousStart, previousEnd)) +
      countWritingUnits(next.slice(nextStart, nextEnd)),
  );
}

function expandWritingRunLeft(text: string, offset: number): number {
  let cursor = Math.max(0, Math.min(text.length, offset));
  while (cursor > 0) {
    const start = previousCodePointStart(text, cursor);
    if (!isNonEastAsianWordContinuation(text.slice(start, cursor))) break;
    cursor = start;
  }
  return cursor;
}

function expandWritingRunRight(text: string, offset: number): number {
  let cursor = Math.max(0, Math.min(text.length, offset));
  while (cursor < text.length) {
    const end = nextCodePointEnd(text, cursor);
    if (!isNonEastAsianWordContinuation(text.slice(cursor, end))) break;
    cursor = end;
  }
  return cursor;
}

function isNonEastAsianWordContinuation(value: string): boolean {
  return !EAST_ASIAN_WRITING_CHARACTER.test(value) &&
    (NON_EAST_ASIAN_WORD_CHARACTER.test(value) || WORD_CONNECTOR.test(value));
}

function previousCodePointStart(text: string, offset: number): number {
  let start = offset - 1;
  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start -= 1;
  }
  return start;
}

function nextCodePointEnd(text: string, offset: number): number {
  const first = text.charCodeAt(offset);
  return offset + (isHighSurrogate(first) && isLowSurrogate(text.charCodeAt(offset + 1)) ? 2 : 1);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
