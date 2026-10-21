import type { EventDeclaration, PatchOperation } from '../core/contracts.ts';
import type { CommandContract } from './commands.ts';

export type ContentNodePresentation = 'card' | 'text-box';

export interface ContentNodeResizeLimits {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

export interface ContentSummary {
  id: string;
  title: string;
  preview: string;
  x: number;
  y: number;
  width: number;
  height: number;
  titleColor: string;
  textColor: string;
  /** Optional for older/third-party summary providers; absence means the ordinary card presentation. */
  presentation?: ContentNodePresentation;
  /** Active-presentation resize limits supplied by the content owner. */
  resizeLimits?: ContentNodeResizeLimits;
  revision: number;
  nodeRevision?: number;
  length: number;
}

/** Canvas documents are ordinary user nodes; system documents stay editable without entering the canvas catalog. */
export type ContentPlacement = 'canvas' | 'system';

export interface ContentCatalogRequest {
  sinceVersion?: number;
}

export interface ContentCatalogDelta {
  version: number;
  reset: boolean;
  summaries: ContentSummary[];
  removedIds: string[];
}

export interface ContentCatalogInvalidation {
  version: number;
  geometry?: boolean;
}

export interface ContentMetricsRequest {
  nodeIds: string[];
}

export interface ContentSummariesRequest {
  nodeIds: string[];
}

export interface ContentMetricsSnapshot {
  nodeCount: number;
  utf16Units: number;
}

export interface ContentNodeMetrics {
  nodeId: string;
  revision: number;
  utf16Units: number;
  graphemes: number;
  nonWhitespaceGraphemes: number;
}

/** Exact, Unicode-aware metrics for a bounded set of known text-node IDs. */
export interface ContentMetricsSnapshotV2 extends ContentMetricsSnapshot {
  graphemes: number;
  nonWhitespaceGraphemes: number;
  byNode: Record<string, ContentNodeMetrics>;
}

export interface ContentNodeMetricsV3 extends ContentNodeMetrics {
  /** Chinese writing characters plus contiguous non-East-Asian word/number runs. */
  writingUnits: number;
}

/** Exact editor writing metrics without changing the established character-count contract. */
export interface ContentMetricsSnapshotV3 extends ContentMetricsSnapshotV2 {
  writingUnits: number;
  byNode: Record<string, ContentNodeMetricsV3>;
}

export interface NodePosition {
  id: string;
  x: number;
  y: number;
}

export interface ContentMovePlanRequest {
  positions: NodePosition[];
}

export interface ContentMovePlan {
  positions: NodePosition[];
  patches: PatchOperation[];
  events?: EventDeclaration[];
}

export interface ContentRenamePlanRequest {
  nodeId: string;
  title: string;
  expectedNodeRevision?: number;
  /** Titles already reserved by the caller's not-yet-committed compound plan. */
  reservedTitles?: string[];
}

export interface ContentRenamePlan {
  nodeId: string;
  nodeRevision: number;
  resolvedTitle: string;
  patches: PatchOperation[];
  events?: EventDeclaration[];
}

export interface ContentCreatePlanRequest {
  title: string;
  body?: string;
  x?: number;
  y?: number;
  /** Keeps infrastructure nodes out of automatic AI retrieval while preserving explicit access. */
  automaticContext?: boolean;
  /** Defaults to canvas. System documents remain addressable by id but are omitted from canvas-facing catalogs. */
  placement?: ContentPlacement;
  /** Titles already planned in the caller's not-yet-committed batch. */
  reservedTitles?: string[];
}

export interface ContentPlacementPlanRequest {
  nodeId: string;
  placement: ContentPlacement;
}

export interface ContentClonePlanRequest {
  sourceId: string;
  expectedRevision: number;
  title: string;
  x?: number;
  y?: number;
}

/** Creates an ordinary canvas copy from any readable text document, including system-owned documents. */
export interface ContentMaterializeCopyRequest {
  sourceId: string;
  title?: string;
  x: number;
  y: number;
}

export interface ContentAppendPlanRequest {
  nodeId: string;
  text: string;
  expectedRevision: number;
}

export interface ContentDeltaPlanRequest {
  nodeId: string;
  start: number;
  deleteCount: number;
  insert: string;
  expectedRevision: number;
}

export interface ContentMutationPlan {
  nodeId: string;
  revision: number;
  length: number;
  resolvedTitle?: string;
  geometry?: { x: number; y: number; width: number; height: number };
  patches: PatchOperation[];
  events?: EventDeclaration[];
}

export interface ContentStorageInfoRequest {
  nodeId: string;
}

export interface ContentStorageInfo {
  nodeId: string;
  revision: number;
  length: number;
  storageVersion: 2;
  chunkSize: number;
  chunkCount: number;
  largestChunk: number;
}

export interface ContentReferenceDropZone {
  owner: string;
  active: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface ContentReferenceDragPreview {
  sourceId?: string;
  targetOwner?: string;
  overTarget?: boolean;
  clear?: boolean;
}

export interface ContentReferenceDrop {
  sourceId: string;
  targetOwner: string;
}

export interface SetNodePresentationRequest {
  id: string;
  presentation: ContentNodePresentation;
  expectedRevision?: number;
}

export interface SetNodePresentationResult {
  presentation: ContentNodePresentation;
  width: number;
  height: number;
  revision: number;
}

export interface ToggleSelectedNodePresentationResult {
  changed: number;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'node.presentation.set': CommandContract<SetNodePresentationRequest, SetNodePresentationResult>;
    'node.toggleSelectedPresentation': CommandContract<undefined, ToggleSelectedNodePresentationResult>;
  }
}
