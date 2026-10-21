import type { TextAssistDecoration } from '../../protocols/text-assist.ts';
import {
  DEFAULT_TEXT_DOCUMENT_FORMAT,
  type TextDocumentFormat,
  type TextFormatMark,
} from '../../protocols/formatting.ts';

/**
 * Rebuilds the visible content-editable projection from authoritative text,
 * format marks, and derived text-assistance decorations. No generated DOM is
 * persisted or used as document state.
 */
export function writeFormattedText(
  root: HTMLDivElement,
  text: string,
  documentFormat: TextDocumentFormat,
  marks: TextFormatMark[],
  windowStart: number,
  decorations: TextAssistDecoration[] = [],
): void {
  const fragment = root.ownerDocument.createDocumentFragment();
  let lineStart = windowStart;
  for (const line of text.split('\n')) {
    const block = root.ownerDocument.createElement('div');
    const lineEnd = lineStart + line.length;
    const applicable = marks.filter((mark) => mark.scope === 'paragraph'
      ? mark.start.offset <= lineStart && mark.end.offset >= lineEnd
      : mark.start.offset < lineEnd && mark.end.offset > lineStart);
    const lineDecorations = decorations.filter((decoration) =>
      decoration.start < lineEnd && decoration.end > lineStart);
    const paragraphFormat = applicable
      .filter((mark) => mark.scope === 'paragraph')
      .reduce((resolved, mark) => ({ ...resolved, ...mark.format }), {} as Partial<TextDocumentFormat>);
    Object.assign(block.style, toTextStyle(paragraphFormat, true));
    if (!line) {
      block.appendChild(root.ownerDocument.createElement('br'));
    } else {
      const boundaries = new Set([0, line.length]);
      for (const mark of applicable) {
        boundaries.add(Math.max(0, Math.min(line.length, mark.start.offset - lineStart)));
        boundaries.add(Math.max(0, Math.min(line.length, mark.end.offset - lineStart)));
      }
      for (const decoration of lineDecorations) {
        boundaries.add(Math.max(0, Math.min(line.length, decoration.start - lineStart)));
        boundaries.add(Math.max(0, Math.min(line.length, decoration.end - lineStart)));
      }
      const sorted = [...boundaries].sort((left, right) => left - right);
      for (let index = 0; index < sorted.length - 1; index += 1) {
        const start = sorted[index];
        const end = sorted[index + 1];
        if (start === end) continue;
        const globalStart = lineStart + start;
        const resolved = applicable
          .filter((mark) => mark.start.offset <= globalStart && mark.end.offset >= lineStart + end)
          .reduce((value, mark) => ({ ...value, ...mark.format }), {} as Partial<TextDocumentFormat>);
        const span = root.ownerDocument.createElement('span');
        span.textContent = line.slice(start, end);
        Object.assign(span.style, toTextStyle(resolved, false));
        const activeDecorations = lineDecorations.filter((decoration) =>
          decoration.start <= globalStart && decoration.end >= lineStart + end);
        const correction = activeDecorations.find((decoration) => decoration.kind === 'correction');
        const reference = activeDecorations.find((decoration) => decoration.kind === 'node-reference');
        if (correction) {
          span.classList.add('text-assist-correction');
          span.dataset.textAssistId = correction.id;
          span.title = correction.message;
        } else if (reference) {
          span.classList.add('text-assist-reference');
          span.dataset.textAssistId = reference.id;
          span.title = `跳转到文字节点“${reference.title}”`;
        }
        block.appendChild(span);
      }
    }
    fragment.append(block);
    lineStart = lineEnd + 1;
  }
  root.replaceChildren(fragment);
  root.style.setProperty('--editor-font-size', `${documentFormat.fontSize}px`);
  root.style.setProperty('--editor-font-weight', String(documentFormat.fontWeight));
  root.style.setProperty('--editor-line-height', String(documentFormat.lineHeight));
  root.style.setProperty('--editor-letter-spacing', `${documentFormat.letterSpacing}px`);
  root.style.setProperty('--editor-text-color', editorDocumentTextColor(documentFormat.color));
  root.style.setProperty('--editor-first-indent', `${documentFormat.firstLineIndent}em`);
  root.style.setProperty('--editor-paragraph-spacing', `${documentFormat.paragraphSpacing}em`);
}

/** Keeps ordinary unformatted writing readable on user-selected paper colors. */
export function editorDocumentTextColor(color: string): string {
  return color.trim().toLowerCase() === DEFAULT_TEXT_DOCUMENT_FORMAT.color
    ? 'var(--editor-paper-ink)'
    : color;
}

function toTextStyle(format: Partial<TextDocumentFormat>, paragraph: boolean): Partial<CSSStyleDeclaration> {
  const style: Record<string, string> = {};
  if (format.fontSize !== undefined) style.fontSize = `${format.fontSize}px`;
  if (format.fontWeight !== undefined) style.fontWeight = String(format.fontWeight);
  if (format.lineHeight !== undefined) style.lineHeight = String(format.lineHeight);
  if (format.letterSpacing !== undefined) style.letterSpacing = `${format.letterSpacing}px`;
  if (format.color !== undefined) style.color = format.color;
  if (paragraph && format.firstLineIndent !== undefined) style.textIndent = `${format.firstLineIndent}em`;
  if (paragraph && format.paragraphSpacing !== undefined) style.marginBottom = `${format.paragraphSpacing}em`;
  return style as Partial<CSSStyleDeclaration>;
}
