const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })
  : undefined;

/** Keeps the visible beginning and marks the first omitted title characters at the end. */
export function endEllipsis(value: string, maximumGraphemes: number): string {
  const maximum = Math.max(3, Math.floor(maximumGraphemes));
  const graphemes = splitGraphemes(value);
  if (graphemes.length <= maximum) return value;
  return `${graphemes.slice(0, maximum - 1).join('')}…`;
}

export function nodeTitleLimit(width: number, height: number, compact: boolean): number {
  if (!compact) return Math.max(8, Math.floor((width - 116) / 12));
  const columns = Math.max(4, Math.floor((width - 36) / 28));
  const rows = Math.max(1, Math.floor((height - 36) / 32));
  return Math.max(10, columns * Math.min(rows, 4));
}

function splitGraphemes(value: string): string[] {
  return graphemeSegmenter
    ? [...graphemeSegmenter.segment(value)].map((item) => item.segment)
    : Array.from(value);
}
