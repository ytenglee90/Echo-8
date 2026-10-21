import type { AppearancePreview } from '../../protocols/appearance.ts';
import type { TextDocumentFormat, TextFormatMark } from '../../protocols/formatting.ts';

export interface PreviewableTextDocument {
  id: string;
  revision: number;
  formatRevision: number;
  format: TextDocumentFormat;
  marks: TextFormatMark[];
}

export function applyTextColorPreview<T extends PreviewableTextDocument>(
  document: T,
  preview?: AppearancePreview,
): T {
  if (preview?.kind !== 'text-color' || !preview.color ||
    !preview.entityIds?.includes(document.id)) return document;
  if (!preview.textRange) {
    return { ...document, format: { ...document.format, color: preview.color } };
  }
  if (preview.textRange.contentRevision !== document.revision ||
    preview.textRange.end <= preview.textRange.start) return document;
  const mark: TextFormatMark = {
    id: `preview:text-color:${document.id}`,
    nodeId: document.id,
    scope: preview.textRange.scope,
    start: { offset: preview.textRange.start, bias: 'after' },
    end: { offset: preview.textRange.end, bias: 'before' },
    format: { color: preview.color },
    revision: document.formatRevision,
  };
  return { ...document, marks: [...document.marks, mark] };
}
