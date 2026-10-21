import type { CommandContract } from './commands.ts';

export interface TextDocumentFormat {
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  color: string;
  firstLineIndent: number;
  paragraphSpacing: number;
}

export interface TextFormatSnapshot {
  nodeId: string;
  revision: number;
  format: TextDocumentFormat;
}

export type TextFormatScope = 'selection' | 'paragraph';
export type TextAnchorBias = 'before' | 'after';

/**
 * An offset alone is ambiguous when text is inserted exactly at its boundary.
 * Bias makes that decision durable, deterministic and replayable.
 */
export interface TextAnchor {
  offset: number;
  bias: TextAnchorBias;
}

export interface TextFormatMark {
  id: string;
  nodeId: string;
  scope: TextFormatScope;
  start: TextAnchor;
  end: TextAnchor;
  format: Partial<TextDocumentFormat>;
  revision: number;
}

export interface TextFormattingSnapshot extends TextFormatSnapshot {
  contentRevision: number;
  rangeStart: number;
  rangeLength: number;
  marks: TextFormatMark[];
}

export interface SetTextDocumentFormatRequest {
  nodeId: string;
  expectedRevision: number;
  patch: Partial<TextDocumentFormat>;
}

export interface SetTextRangeFormatRequest {
  nodeId: string;
  expectedRevision: number;
  expectedContentRevision: number;
  start: number;
  end: number;
  scope: TextFormatScope;
  patch: Partial<TextDocumentFormat>;
}

export interface TextFormattingRequest {
  nodeId: string;
  start?: number;
  length?: number;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'content.setDocumentFormat': CommandContract<SetTextDocumentFormatRequest, TextFormatSnapshot>;
    'content.setRangeFormat': CommandContract<SetTextRangeFormatRequest, TextFormattingSnapshot>;
  }
}

export const DEFAULT_TEXT_DOCUMENT_FORMAT: Readonly<TextDocumentFormat> = Object.freeze({
  fontSize: 15,
  fontWeight: 400,
  lineHeight: 1.7,
  letterSpacing: 0,
  color: '#2f3035',
  firstLineIndent: 0,
  paragraphSpacing: 0.35,
});
