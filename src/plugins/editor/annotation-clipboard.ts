import { isRecord } from '../../core/contracts.ts';
import {
  MAX_ANNOTATION_CLIPBOARD_BODY,
  MAX_ANNOTATION_CLIPBOARD_ITEMS,
  MAX_ANNOTATION_BODY_LENGTH,
  type AnnotationClipboardItem,
  type AnnotationRecord,
} from '../../protocols/annotations.ts';

interface AnnotationClipboardPayload {
  version: 1;
  text: string;
  items: AnnotationClipboardItem[];
}

let recentClipboard: { text: string; encoded: string; expiresAt: number } | undefined;

export function collectAnnotationClipboardItems(
  records: AnnotationRecord[],
  nodeId: string,
  start: number,
  end: number,
): AnnotationClipboardItem[] {
  if (end <= start) return [];
  const items: AnnotationClipboardItem[] = [];
  let bodyLength = 0;
  for (const record of records) {
    if (record.target.kind !== 'text-range' || record.target.targetId !== nodeId ||
      record.target.offset <= start || record.target.offset > end) continue;
    if (items.length >= MAX_ANNOTATION_CLIPBOARD_ITEMS ||
      bodyLength + record.body.length > MAX_ANNOTATION_CLIPBOARD_BODY) break;
    bodyLength += record.body.length;
    items.push({ relativeOffset: record.target.offset - start, body: record.body });
  }
  return items;
}

export function rebaseEditorAnnotationRecords(
  records: AnnotationRecord[],
  nodeId: string,
  start: number,
  deleteCount: number,
  insertLength: number,
): AnnotationRecord[] {
  const end = start + deleteCount;
  const delta = insertLength - deleteCount;
  return records.flatMap((record) => {
    if (record.target.kind !== 'text-range' || record.target.targetId !== nodeId) return [record];
    if (deleteCount > 0 && record.target.offset > start && record.target.offset <= end) return [];
    if (record.target.offset <= start) return [record];
    return [{ ...record, target: { ...record.target, offset: record.target.offset + delta } }];
  });
}

export function moveEditorAnnotationRecords(
  records: AnnotationRecord[],
  nodeId: string,
  start: number,
  end: number,
  target: number,
): AnnotationRecord[] {
  return records.map((record) => {
    if (record.target.kind !== 'text-range' || record.target.targetId !== nodeId) return record;
    const offset = moveAnchorOffset(record.target.offset, start, end, target);
    return offset === record.target.offset ? record : {
      ...record,
      target: { ...record.target, offset },
    };
  });
}

export function encodeAnnotationClipboard(text: string, items: AnnotationClipboardItem[]): string | undefined {
  if (items.length === 0) return undefined;
  return JSON.stringify({ version: 1, text, items } satisfies AnnotationClipboardPayload);
}

export function rememberAnnotationClipboard(text: string, encoded: string | undefined): void {
  recentClipboard = encoded
    ? { text, encoded, expiresAt: Date.now() + 120_000 }
    : undefined;
}

export function readRememberedAnnotationClipboard(text: string): string {
  if (!recentClipboard || recentClipboard.expiresAt < Date.now() || recentClipboard.text !== text) return '';
  return recentClipboard.encoded;
}

export function decodeAnnotationClipboard(raw: string, pastedText: string): AnnotationClipboardItem[] {
  if (!raw || raw.length > MAX_ANNOTATION_CLIPBOARD_BODY * 2) return [];
  try {
    const payload: unknown = JSON.parse(raw);
    if (!isRecord(payload) || payload.version !== 1 ||
      typeof payload.text !== 'string' || normalizeNewlines(payload.text) !== pastedText ||
      !Array.isArray(payload.items) || payload.items.length > MAX_ANNOTATION_CLIPBOARD_ITEMS) return [];
    let bodyLength = 0;
    const items: AnnotationClipboardItem[] = [];
    for (const item of payload.items) {
      if (!isRecord(item) || !Number.isInteger(item.relativeOffset) ||
        (item.relativeOffset as number) < 0 || (item.relativeOffset as number) > pastedText.length ||
        typeof item.body !== 'string' || item.body.length > MAX_ANNOTATION_BODY_LENGTH) return [];
      bodyLength += item.body.length;
      if (bodyLength > MAX_ANNOTATION_CLIPBOARD_BODY) return [];
      items.push({ relativeOffset: item.relativeOffset as number, body: item.body });
    }
    return items;
  } catch {
    return [];
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

function moveAnchorOffset(offset: number, start: number, end: number, target: number): number {
  const length = end - start;
  if (target < start) {
    if (offset > start && offset <= end) return target + offset - start;
    if (offset > target && offset <= start) return offset + length;
    return offset;
  }
  const destination = target - length;
  if (offset > start && offset <= end) return destination + offset - start;
  if (offset > end && offset <= target) return offset - length;
  return offset;
}
