import type { EventDeclaration, PatchOperation } from './state.ts';

export type SearchScope = 'current' | 'canvas';
export type SearchField = 'title' | 'body';

export interface ContentSearchRequest {
  query: string;
  nodeIds?: string[];
  matchCase: boolean;
  wholeWord: boolean;
  maxResults: number;
}

export interface SearchHit {
  nodeId: string;
  title: string;
  /** Version-one hits omit this field and always refer to body text. */
  field?: SearchField;
  start: number;
  length: number;
  matchedText: string;
  preview: string;
  revision: number;
}

export interface SearchHitV2 extends SearchHit {
  field: SearchField;
}

export interface ContentSearchResult {
  hits: SearchHit[];
  scannedNodes: number;
  truncated: boolean;
}

/** Title-and-body search result. Title offsets and revisions belong to the node title. */
export interface ContentSearchResultV2 extends Omit<ContentSearchResult, 'hits'> {
  hits: SearchHitV2[];
}

export interface SearchRequest {
  query: string;
  scope: SearchScope;
  matchCase: boolean;
  wholeWord: boolean;
}

export interface SearchQueryPreview extends Omit<SearchRequest, 'scope'> {
  composing: boolean;
}

export interface SearchResult extends ContentSearchResultV2 {
  requestId: string;
  query: string;
  scope: SearchScope;
}

export interface SearchStatus {
  requestId?: string;
  state: 'idle' | 'running' | 'ready' | 'error' | 'replaced';
  message?: string;
}

export interface SearchNavigationSignal {
  nodeId: string;
  index: number;
  total: number;
  scope: 'selection' | 'canvas';
  scopeNodeCount: number;
}

/** Ephemeral exact match presented by the canvas owner during previous/next navigation. */
export interface SearchMatchPreview {
  nodeId?: string;
  field?: SearchField;
  start?: number;
  length?: number;
  clear?: boolean;
}

export interface ContentReplaceRequest {
  hits: SearchHit[];
  replacement: string;
}

export interface SearchReplaceTargetsRequest extends ContentReplaceRequest {
  selectedNodeIds: string[];
  /** Exact highlighted hit. It takes precedence over selected nodes and the canvas fallback. */
  currentHit?: SearchHit;
}

export interface ContentReplacePlan {
  patches: PatchOperation[];
  events?: EventDeclaration[];
  replaced: number;
  affectedNodes: number;
}
