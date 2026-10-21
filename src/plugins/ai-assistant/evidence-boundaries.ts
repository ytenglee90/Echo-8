import type { AIPreparedSource } from '../../protocols/ai.ts';

export interface EvidenceBlock {
  start: number;
  length: number;
  text: string;
  boundary: NonNullable<AIPreparedSource['boundary']>;
  complete: boolean;
}

export interface TextRange {
  start: number;
  end: number;
}

export function enclosingCodeBlock(text: string, anchor: number): TextRange | undefined {
  for (const match of text.matchAll(/```[^\r\n]*\r?\n?[\s\S]*?```/gu)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start <= anchor && anchor < end) return { start, end };
  }
  return undefined;
}

export function enclosingMarkdownTable(text: string, anchor: number): TextRange | undefined {
  const paragraph = enclosingParagraph(text, anchor);
  if (!paragraph) return undefined;
  const lines = text.slice(paragraph.start, paragraph.end)
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2 || !lines.every(isMarkdownTableLine) || !lines.some(isMarkdownTableDivider)) {
    return undefined;
  }
  return paragraph;
}

export function enclosingMarkdownList(text: string, anchor: number): TextRange | undefined {
  const paragraph = enclosingParagraph(text, anchor);
  if (!paragraph) return undefined;
  const lines = text.slice(paragraph.start, paragraph.end).split(/\r?\n/u);
  const marker = /^\s{0,3}(?:[-+*]|\d+[.)])\s+\S/u;
  if (!lines.some((line) => marker.test(line))) return undefined;
  if (!lines.every((line) => !line.trim() || marker.test(line) || /^\s{2,}\S/u.test(line))) return undefined;
  return paragraph;
}

export function enclosingChatTurn(text: string, anchor: number): TextRange | undefined {
  const starts = [...text.matchAll(/^\[(?:用户|助手|系统)(?:\s*·[^\]\r\n]+)?\][ \t]*$/gmu)]
    .map((match) => match.index ?? 0);
  return enclosingRange(starts, text.length, anchor);
}

/**
 * Keeps a matched user question and its assistant answer together. Retrieval
 * may still fall back to a single turn when the exchange does not fit the
 * active context budget.
 */
export function enclosingChatExchange(text: string, anchor: number): TextRange | undefined {
  const markers = [...text.matchAll(/^\[(用户|助手|系统)(?:\s*·[^\]\r\n]+)?\][ \t]*$/gmu)]
    .map((match) => ({ start: match.index ?? 0, role: match[1] }));
  if (markers.length === 0) return undefined;
  let activeIndex = 0;
  for (let index = 0; index < markers.length; index += 1) {
    if (markers[index]!.start > anchor) break;
    activeIndex = index;
  }
  const active = markers[activeIndex]!;
  const userIndex = active.role === '用户'
    ? activeIndex
    : active.role === '助手' && markers[activeIndex - 1]?.role === '用户'
      ? activeIndex - 1
      : -1;
  if (userIndex < 0 || markers[userIndex + 1]?.role !== '助手') return undefined;
  return {
    start: markers[userIndex]!.start,
    end: markers[userIndex + 2]?.start ?? text.length,
  };
}

export function enclosingParagraph(text: string, anchor: number): TextRange | undefined {
  const starts = [0, ...[...text.matchAll(/\r?\n[ \t]*\r?\n/gu)]
    .map((match) => (match.index ?? 0) + match[0].length)];
  return enclosingRange(starts, text.length, anchor);
}

export function enclosingSentence(text: string, anchor: number): TextRange | undefined {
  const starts = [0, ...[...text.matchAll(/(?:[。！？!?；;][”’」』】）)]*[ \t]*|\r?\n)/gu)]
    .map((match) => (match.index ?? 0) + match[0].length)];
  return enclosingRange(starts, text.length, anchor);
}

export function evidenceFromLocalRange(
  probeStart: number,
  probeText: string,
  rawRange: TextRange,
  boundary: EvidenceBlock['boundary'],
  complete: boolean,
): EvidenceBlock {
  const range = trimLocalRange(probeText, rawRange, probeText.length);
  const text = probeText.slice(range.start, range.end);
  return {
    start: probeStart + range.start,
    length: text.length,
    text,
    boundary,
    complete,
  };
}

export function rangeFitsBudget(
  text: string,
  range: TextRange,
  maxLength: number,
  maxTokens: number,
): boolean {
  return Math.max(0, range.end - range.start) <= maxLength &&
    estimateAITokens(text.slice(range.start, range.end)) <= maxTokens;
}

export function estimateAITokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let compactRun = 0;
  const flushRun = () => {
    if (compactRun > 0) tokens += Math.ceil(compactRun / 4);
    compactRun = 0;
  };
  for (const character of text) {
    if (/\s/u.test(character)) {
      flushRun();
    } else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(character)) {
      flushRun();
      tokens += 1;
    } else if (/[\p{L}\p{N}_]/u.test(character)) {
      compactRun += character.length;
    } else {
      flushRun();
      tokens += 0.5;
    }
  }
  flushRun();
  return Math.max(1, Math.ceil(tokens));
}

export function fitRangeEndToTokenBudget(
  text: string,
  start: number,
  end: number,
  maxTokens: number,
): number {
  if (maxTokens <= 0 || end <= start) return start;
  if (estimateAITokens(text.slice(start, end)) <= maxTokens) return end;
  let low = start;
  let high = end;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateAITokens(text.slice(start, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return avoidSplitSurrogateAtEnd(text, start, low);
}

export function fitRangeStartToTokenBudget(
  text: string,
  start: number,
  end: number,
  maxTokens: number,
): number {
  if (maxTokens <= 0 || end <= start) return end;
  if (estimateAITokens(text.slice(start, end)) <= maxTokens) return start;
  let low = start;
  let high = end;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateAITokens(text.slice(middle, end)) <= maxTokens) high = middle;
    else low = middle + 1;
  }
  return avoidSplitSurrogateAtStart(text, low, end);
}

export function lastBoundaryWithinBudget(text: string, limit: number, maxTokens: number): number {
  let selected = -1;
  for (const boundary of naturalBoundaries(text)) {
    if (boundary > limit) break;
    if (boundary > 0 && estimateAITokens(text.slice(0, boundary)) <= maxTokens) selected = boundary;
  }
  return selected;
}

export function tailBoundaryCandidates(text: string, start: number): number[] {
  return naturalBoundaries(text).filter((boundary) => boundary >= start && boundary < text.length);
}

export function firstChatTurnAtOrAfter(text: string, start: number): number | undefined {
  return [...text.matchAll(/^\[(?:用户|助手|系统)(?:\s*·[^\]\r\n]+)?\][ \t]*$/gmu)]
    .map((match) => match.index ?? 0)
    .find((position) => position >= start);
}

export function emptyEvidenceBlock(): EvidenceBlock {
  return { start: 0, length: 0, text: '', boundary: 'range', complete: true };
}

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && (trimmed.match(/\|/gu)?.length ?? 0) >= 2;
}

function isMarkdownTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
}

function enclosingRange(starts: number[], textLength: number, anchor: number): TextRange | undefined {
  const ordered = [...new Set(starts.filter((value) => value >= 0 && value <= textLength))]
    .sort((left, right) => left - right);
  if (ordered.length === 0) return undefined;
  let start = ordered[0];
  for (const value of ordered) {
    if (value > anchor) break;
    start = value;
  }
  const end = ordered.find((value) => value > anchor) ?? textLength;
  return trimLocalRange('', { start, end }, textLength);
}

function trimLocalRange(text: string, range: TextRange, limit: number): TextRange {
  let start = Math.max(0, Math.min(limit, range.start));
  let end = Math.max(start, Math.min(limit, range.end));
  if (text) {
    while (start < end && /[\r\n \t]/u.test(text[start])) start += 1;
    while (end > start && /[\r\n \t]/u.test(text[end - 1])) end -= 1;
  }
  return { start, end };
}

function avoidSplitSurrogateAtEnd(text: string, start: number, end: number): number {
  return end > start && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) ? end - 1 : end;
}

function avoidSplitSurrogateAtStart(text: string, start: number, end: number): number {
  return start < end && start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]) ? start + 1 : start;
}

function naturalBoundaries(text: string): number[] {
  return [...new Set([
    ...[...text.matchAll(/(?:[。！？!?；;][”’」』】）)]*[ \t]*|\r?\n)/gu)]
      .map((match) => (match.index ?? 0) + match[0].length),
    ...[...text.matchAll(/^\[(?:用户|助手|系统)(?:\s*·[^\]\r\n]+)?\][ \t]*$/gmu)]
      .map((match) => match.index ?? 0),
  ])].sort((left, right) => left - right);
}
