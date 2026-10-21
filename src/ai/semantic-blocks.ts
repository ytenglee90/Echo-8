export interface SemanticTextBlock {
  start: number;
  text: string;
}

export const SEMANTIC_BLOCK_LENGTH = 1_200;
export const MAX_SEMANTIC_BLOCKS_PER_SOURCE = 128;
export const FULL_SEMANTIC_COVERAGE_LENGTH =
  SEMANTIC_BLOCK_LENGTH * MAX_SEMANTIC_BLOCKS_PER_SOURCE;

/** Splits one bounded source buffer at paragraph/sentence boundaries without losing absolute offsets. */
export function partitionSemanticText(
  text: string,
  absoluteStart = 0,
  maximumLength = SEMANTIC_BLOCK_LENGTH,
): SemanticTextBlock[] {
  const blocks: SemanticTextBlock[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const hardEnd = Math.min(text.length, cursor + maximumLength);
    const end = hardEnd < text.length
      ? preferredBoundary(text, cursor, hardEnd, maximumLength)
      : text.length;
    const safeEnd = avoidSplitSurrogate(text, Math.max(cursor + 1, end));
    const raw = text.slice(cursor, safeEnd);
    const leading = raw.search(/\S/u);
    if (leading >= 0) {
      const trimmedEnd = raw.trimEnd().length;
      blocks.push({
        start: absoluteStart + cursor + leading,
        text: raw.slice(leading, trimmedEnd),
      });
    }
    cursor = safeEnd;
  }
  return blocks;
}

/** Chooses a complete paragraph around a stratified anchor, or a bounded centre slice for a huge paragraph. */
export function semanticBlockAround(
  probe: string,
  probeStart: number,
  absoluteAnchor: number,
  maximumLength = SEMANTIC_BLOCK_LENGTH,
): SemanticTextBlock | undefined {
  if (!probe.length) return undefined;
  const localAnchor = clamp(absoluteAnchor - probeStart, 0, Math.max(0, probe.length - 1));
  const before = lastParagraphBoundary(probe, localAnchor);
  const after = nextParagraphBoundary(probe, localAnchor);
  const paragraphStart = before < 0 ? 0 : before;
  const paragraphEnd = after < 0 ? probe.length : after;
  let start = paragraphStart;
  let end = paragraphEnd;
  if (end - start > maximumLength) {
    start = clamp(
      localAnchor - Math.floor(maximumLength / 2),
      paragraphStart,
      Math.max(paragraphStart, paragraphEnd - maximumLength),
    );
    end = Math.min(paragraphEnd, start + maximumLength);
  }
  end = avoidSplitSurrogate(probe, Math.max(start + 1, end));
  const raw = probe.slice(start, end);
  const leading = raw.search(/\S/u);
  if (leading < 0) return undefined;
  const trimmedEnd = raw.trimEnd().length;
  return { start: probeStart + start + leading, text: raw.slice(leading, trimmedEnd) };
}

export function stratifiedSemanticAnchors(length: number): number[] {
  if (length <= 0) return [0];
  return Array.from({ length: MAX_SEMANTIC_BLOCKS_PER_SOURCE }, (_, index) =>
    Math.round(index * Math.max(0, length - 1) / (MAX_SEMANTIC_BLOCKS_PER_SOURCE - 1)));
}

function preferredBoundary(text: string, start: number, hardEnd: number, maximumLength: number): number {
  const minimum = start + Math.floor(maximumLength * 0.4);
  for (const token of ['\r\n\r\n', '\n\n', '\r\n', '\n']) {
    const boundary = text.lastIndexOf(token, hardEnd);
    if (boundary >= minimum) return boundary + token.length;
  }
  for (let index = hardEnd - 1; index >= minimum; index -= 1) {
    if ('。！？!?；;'.includes(text[index])) return index + 1;
  }
  return hardEnd;
}

function lastParagraphBoundary(text: string, anchor: number): number {
  const windowsBoundary = text.lastIndexOf('\r\n\r\n', anchor);
  const unixBoundary = text.lastIndexOf('\n\n', anchor);
  return Math.max(windowsBoundary < 0 ? -1 : windowsBoundary + 4, unixBoundary < 0 ? -1 : unixBoundary + 2);
}

function nextParagraphBoundary(text: string, anchor: number): number {
  const windowsBoundary = text.indexOf('\r\n\r\n', anchor);
  const unixBoundary = text.indexOf('\n\n', anchor);
  if (windowsBoundary < 0) return unixBoundary;
  if (unixBoundary < 0) return windowsBoundary;
  return Math.min(windowsBoundary, unixBoundary);
}

function avoidSplitSurrogate(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? end - 1
    : end;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
