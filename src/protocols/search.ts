import type { EventDeclaration, PatchOperation } from '../core/contracts.ts';

export type SearchScope = 'current' | 'canvas';

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
  start: number;
  length: number;
  matchedText: string;
  preview: string;
  revision: number;
}

export interface ContentSearchResult {
  hits: SearchHit[];
  scannedNodes: number;
  truncated: boolean;
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

export interface SearchResult extends ContentSearchResult {
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
}

export interface ContentReplaceRequest {
  hits: SearchHit[];
  replacement: string;
}

export interface SearchReplaceTargetsRequest extends ContentReplaceRequest {
  selectedNodeIds: string[];
  /** Exactly one current editor hit; ignored when result-list nodes are selected. */
  currentHit?: SearchHit;
}

export interface ContentReplacePlan {
  patches: PatchOperation[];
  events?: EventDeclaration[];
  replaced: number;
  affectedNodes: number;
}
