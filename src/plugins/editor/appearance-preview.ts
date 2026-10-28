import { appearancePreviewTarget, type AppearancePreview } from '../../protocols/appearance.ts';
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
  const target = appearancePreviewTarget(preview, 'text-color');
  if (!target?.color || !target.entityIds.includes(document.id)) return document;
  const textRange = preview?.textRange;
  if (!textRange) {
    return { ...document, format: { ...document.format, color: target.color } };
  }
  if (textRange.contentRevision !== document.revision ||
    textRange.end <= textRange.start) return document;
  const mark: TextFormatMark = {
    id: `preview:text-color:${document.id}`,
    nodeId: document.id,
    scope: textRange.scope,
    start: { offset: textRange.start, bias: 'after' },
    end: { offset: textRange.end, bias: 'before' },
    format: { color: target.color },
    revision: document.formatRevision,
  };
  return { ...document, marks: [...document.marks, mark] };
}
