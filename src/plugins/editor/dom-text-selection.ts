/**
 * DOM/text coordinate conversion owned by the editor UI.
 *
 * The authoritative document continues to use plain-text offsets. This module
 * is the only place that translates those offsets to the temporary rich DOM
 * projection used by the writing surface.
 */

export interface DOMTextSelection {
  start: number;
  end: number;
  text: string;
}

export interface DOMTextPoint {
  node: Node;
  offset: number;
}

export interface AssistMenuPosition {
  left: number;
  top: number;
}

export function readPlainText(root: HTMLDivElement | null): string {
  if (!root) return '';
  const children = [...root.childNodes];
  if (children.length > 0 && children.every((child) => child.nodeType === Node.ELEMENT_NODE)) {
    // The editor projection owns one top-level block per logical line. `innerText`
    // inserts layout-dependent newlines and differs between Chromium, Firefox and
    // WebKit when a block contains styled spans or a trailing BR. `textContent`
    // follows the authoritative UTF-16 model and keeps the projection deterministic.
    return children.map((child) => child.textContent ?? '').join('\n');
  }
  return root.innerText.replace(/\r\n?/gu, '\n');
}

export function readSelectionRange(root: HTMLDivElement | null): DOMTextSelection | undefined {
  const selection = globalThis.getSelection?.();
  if (!root || !selection || !selection.anchorNode || !selection.focusNode) return undefined;
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return undefined;
  const anchor = domPointToTextOffset(root, selection.anchorNode, selection.anchorOffset);
  const focus = domPointToTextOffset(root, selection.focusNode, selection.focusOffset);
  const start = Math.min(anchor, focus);
  const end = Math.max(anchor, focus);
  return { start, end, text: readPlainText(root).slice(start, end) };
}

export function selectionScreenAnchor(root: HTMLDivElement | null): { x: number; y: number } | undefined {
  const selection = globalThis.getSelection?.();
  if (!root || !selection?.rangeCount || !selection.anchorNode || !root.contains(selection.anchorNode)) return undefined;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(false);
  const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect();
  if (rect && Number.isFinite(rect.left) && Number.isFinite(rect.bottom) && (rect.width > 0 || rect.height > 0)) {
    return { x: rect.left, y: rect.bottom };
  }
  const fallback = root.getBoundingClientRect();
  return { x: fallback.left + 16, y: fallback.top + 24 };
}

export function domPointToTextOffset(root: HTMLDivElement, target: Node, targetOffset: number): number {
  if (target === root) {
    return [...root.childNodes].slice(0, targetOffset)
      .reduce((total, child, index) => total + (child.textContent?.length ?? 0) + (index > 0 ? 1 : 0), 0);
  }
  let offset = 0;
  for (const [index, block] of [...root.childNodes].entries()) {
    if (block === target || block.contains?.(target)) {
      const range = root.ownerDocument.createRange();
      range.selectNodeContents(block);
      range.setEnd(target, targetOffset);
      return offset + range.toString().length;
    }
    offset += (block.textContent?.length ?? 0) + (index < root.childNodes.length - 1 ? 1 : 0);
  }
  return offset;
}

export function textOffsetFromClientPoint(
  root: HTMLDivElement,
  x: number,
  y: number,
): number | undefined {
  const document = root.ownerDocument as Document & {
    caretPositionFromPoint?: (clientX: number, clientY: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
  };
  const position = document.caretPositionFromPoint?.(x, y);
  if (position && root.contains(position.offsetNode)) {
    return domPointToTextOffset(root, position.offsetNode, position.offset);
  }
  const range = document.caretRangeFromPoint?.(x, y);
  if (range && root.contains(range.startContainer)) {
    return domPointToTextOffset(root, range.startContainer, range.startOffset);
  }
  return undefined;
}

export function restoreSelectionRange(
  root: HTMLDivElement,
  start: number,
  end: number,
  collapsedBias: 'before' | 'after' = 'before',
): Range | undefined {
  const selection = globalThis.getSelection?.();
  if (!selection) return undefined;
  const bias = start === end ? collapsedBias : 'before';
  const startPoint = textOffsetToDomPoint(root, start, bias);
  const endPoint = textOffsetToDomPoint(root, end, bias);
  if (!startPoint || !endPoint) return undefined;
  const range = root.ownerDocument.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

export function textOffsetToDomPoint(
  root: HTMLDivElement,
  requestedOffset: number,
  bias: 'before' | 'after' = 'before',
): DOMTextPoint | undefined {
  let offset = Math.max(0, requestedOffset);
  const blocks = [...root.childNodes];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const length = block.textContent?.length ?? 0;
    if (offset <= length) {
      const walker = root.ownerDocument.createTreeWalker(block, 4);
      let remaining = offset;
      let textNode = walker.nextNode();
      while (textNode) {
        const textLength = textNode.textContent?.length ?? 0;
        if (remaining < textLength || (remaining === textLength && bias === 'before')) {
          return { node: textNode, offset: remaining };
        }
        if (remaining === textLength) {
          const nextTextNode = walker.nextNode();
          if (nextTextNode) return { node: nextTextNode, offset: 0 };
          return { node: block, offset: block.childNodes.length };
        }
        remaining -= textLength;
        textNode = walker.nextNode();
      }
      return { node: block, offset: 0 };
    }
    offset -= length;
    if (index < blocks.length - 1) {
      if (offset === 0) return { node: block, offset: block.childNodes.length };
      offset -= 1;
    }
  }
  const last = blocks.at(-1);
  return last ? { node: last, offset: last.childNodes.length } : { node: root, offset: 0 };
}

export function caretAssistPosition(
  root: HTMLDivElement | null,
  shell: HTMLDivElement | null,
  localOffset?: number,
): AssistMenuPosition {
  if (!root || !shell) return { left: 12, top: 12 };
  const selection = globalThis.getSelection?.();
  const shellRect = shell.getBoundingClientRect();
  const fallback = root.getBoundingClientRect();
  const range = selection?.rangeCount && selection.anchorNode && root.contains(selection.anchorNode)
    ? selection.getRangeAt(0).cloneRange()
    : undefined;
  const requestedOffset = localOffset === undefined
    ? undefined
    : Math.max(0, Math.min(localOffset, readPlainText(root).length));
  const rect = usableCaretRect(range) ??
    (requestedOffset === undefined ? undefined : caretRectFromTextOffset(root, requestedOffset)) ??
    fallback;
  return clampAssistPosition(rect.left - shellRect.left, rect.bottom - shellRect.top + 6, shell);
}

export function pointerAssistPosition(
  clientX: number,
  clientY: number,
  shell: HTMLDivElement | null,
): AssistMenuPosition {
  if (!shell) return { left: 12, top: 12 };
  const rect = shell.getBoundingClientRect();
  return clampAssistPosition(clientX - rect.left, clientY - rect.top + 8, shell);
}

function clampAssistPosition(left: number, top: number, shell: HTMLDivElement): AssistMenuPosition {
  const width = Math.min(260, Math.max(220, shell.clientWidth - 24));
  const resolvedLeft = Math.max(8, Math.min(left, shell.clientWidth - width - 8));
  const resolvedTop = top + 220 > shell.clientHeight
    ? Math.max(8, top - 236)
    : Math.max(8, top);
  return { left: resolvedLeft, top: resolvedTop };
}

interface CaretGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  height: number;
}

function usableCaretRect(range: Range | undefined): CaretGeometry | undefined {
  if (!range) return undefined;
  const rects = range.getClientRects();
  const rect = rects.item(rects.length - 1) ?? range.getBoundingClientRect();
  return isUsableCaretGeometry(rect) ? rect : undefined;
}

function caretRectFromTextOffset(root: HTMLDivElement, offset: number): CaretGeometry | undefined {
  const point = textOffsetToDomPoint(root, offset);
  if (!point) return undefined;
  const range = root.ownerDocument.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  const direct = usableCaretRect(range);
  if (direct) return direct;

  const text = readPlainText(root);
  const beforeEndsLine = offset > 0 && text[offset - 1] === '\n';
  const neighbours = beforeEndsLine
    ? [[offset, offset + 1, 'start'], [offset - 1, offset, 'end']] as const
    : [[offset - 1, offset, 'end'], [offset, offset + 1, 'start']] as const;
  for (const [start, end, edge] of neighbours) {
    if (start < 0 || end > text.length || start === end) continue;
    const startPoint = textOffsetToDomPoint(root, start);
    const endPoint = textOffsetToDomPoint(root, end);
    if (!startPoint || !endPoint) continue;
    const neighbour = root.ownerDocument.createRange();
    neighbour.setStart(startPoint.node, startPoint.offset);
    neighbour.setEnd(endPoint.node, endPoint.offset);
    const rects = neighbour.getClientRects();
    const measured = edge === 'start' ? rects.item(0) : rects.item(rects.length - 1);
    if (!measured || !isUsableCaretGeometry(measured)) continue;
    const x = edge === 'start' ? measured.left : measured.right;
    return {
      left: x,
      right: x,
      top: measured.top,
      bottom: measured.bottom,
      height: measured.height,
    };
  }
  return undefined;
}

function isUsableCaretGeometry(rect: CaretGeometry): boolean {
  return Number.isFinite(rect.left) && Number.isFinite(rect.bottom) &&
    rect.height > 0 && rect.bottom > rect.top;
}
