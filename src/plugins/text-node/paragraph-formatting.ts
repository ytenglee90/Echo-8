import type { PluginContext } from '../../core/contracts.ts';
import { PARAGRAPH_FORMAT_FIELDS, type TextDocumentFormat, type TextFormatScope } from '../../protocols/formatting.ts';
import { CHUNK_SIZE, readContentRange, type TextContentRecord } from './content-storage.ts';

const PARAGRAPH_FIELDS = new Set<string>(PARAGRAPH_FORMAT_FIELDS);

/** Reads at most one chunk at a time, including paragraphs crossing editor windows. */
export function enclosingParagraphRange(
  context: PluginContext,
  content: TextContentRecord,
  start: number,
  end: number,
): { start: number; end: number } {
  let paragraphStart = start;
  while (paragraphStart > 0) {
    const from = Math.max(0, paragraphStart - CHUNK_SIZE);
    const before = readContentRange(context, content, from, paragraphStart - from);
    const newline = before.lastIndexOf('\n');
    paragraphStart = newline < 0 ? from : from + newline + 1;
    if (newline >= 0) break;
  }
  // A selection ending immediately after a newline excludes the next paragraph.
  let paragraphEnd = Math.max(start, end - (end > start ? 1 : 0));
  while (paragraphEnd < content.length) {
    const after = readContentRange(context, content, paragraphEnd, CHUNK_SIZE);
    const newline = after.indexOf('\n');
    paragraphEnd += newline < 0 ? after.length : newline + 1;
    if (newline >= 0) break;
  }
  return { start: paragraphStart, end: paragraphEnd };
}

export function formatRangeParts(
  context: PluginContext,
  content: TextContentRecord,
  start: number,
  end: number,
  scope: TextFormatScope,
  patch: Partial<TextDocumentFormat>,
): Array<{ start: number; end: number; scope: TextFormatScope; patch: Partial<TextDocumentFormat> }> {
  const paragraphRange = () => enclosingParagraphRange(context, content, start, end);
  if (scope === 'paragraph') return [{ ...paragraphRange(), scope, patch }];
  const inline = Object.fromEntries(Object.entries(patch).filter(([key]) => !PARAGRAPH_FIELDS.has(key)));
  const paragraph = Object.fromEntries(Object.entries(patch).filter(([key]) => PARAGRAPH_FIELDS.has(key)));
  return [
    ...(Object.keys(inline).length ? [{ start, end, scope, patch: inline }] : []),
    ...(Object.keys(paragraph).length ? [{ ...paragraphRange(), scope: 'paragraph' as const, patch: paragraph }] : []),
  ];
}
