/** Human/AI-authored, checksum-free input; normal saves remain native project v2. */
export const AI_TEXT_BOOK_KIND = 'echo-8-ai-book' as const;
export const AI_TEXT_BOOK_VERSION = 1 as const;

export interface AITextBookManifestV1 {
  type: 'manifest';
  kind: typeof AI_TEXT_BOOK_KIND;
  formatVersion: typeof AI_TEXT_BOOK_VERSION;
  title?: string;
}

export interface AITextBookNodeV1 {
  type: 'node';
  id: string;
  category: string;
  name: string;
  text?: string;
  section?: string;
  presentation?: 'card' | 'text-box';
  color?: string;
  order?: number;
}

/** Appends literal text to a previously declared node, without joining its full body. */
export interface AITextBookTextV1 {
  type: 'text';
  id: string;
  text: string;
}

export interface AITextBookLinkV1 {
  type: 'link';
  from: string;
  to: string;
  kind: 'sequence' | 'insert';
  label?: string;
}

export interface AITextBookEndV1 { type: 'end' }
