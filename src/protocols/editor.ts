import type { TextDocumentFormat } from './formatting.ts';
import type { CommandContract } from './commands.ts';
import type { AnnotationClipboardItem } from './annotations.ts';

export const EDITOR_OPEN_REQUESTED_EVENT = 'editor.open.requested';

export interface EditorOpenRequested {
  id: string;
  reason?: string;
}

export type WritingActivityKind = 'insert' | 'composition' | 'delete' | 'paste' | 'replace' | 'move';

export interface EditorRevealRequest {
  id: string;
  start: number;
  end: number;
  revision?: number;
  requestId: string;
}

export interface EditorContextSnapshot {
  openPanes: string[];
  activePane?: string;
  immersivePane?: string;
}

export interface EditorSelectionSnapshot {
  id: string;
  start: number;
  end: number;
  focused?: boolean;
  /** Viewport coordinate captured by the editor that owns the caret/selection. */
  screenAnchor?: { x: number; y: number };
}

export interface EditorDocumentInvalidation {
  all?: boolean;
  content?: Array<{ id: string; revision?: number }>;
  formatting?: Array<{ id: string; revision?: number }>;
  metadataIds?: string[];
}

export interface EditorPaneState {
  openPanes: string[];
  activePane?: string;
  pendingPane?: string;
  revealRequest?: EditorRevealRequest;
  dockWidth: number;
  immersivePane?: string;
  paneRecency: Record<string, number>;
  paneWindows: Record<string, number>;
  paneRatios: Record<string, number>;
}

export interface WritingActivityRequest {
  nodeId: string;
  kind: WritingActivityKind;
  insertedText: string;
  deletedText: string;
}

export interface WritingMetricsSnapshot {
  nodeId: string;
  startedAt: number;
  lastActivityAt: number;
  activeMs: number;
  typedGraphemes: number;
  deletedGraphemes: number;
  pastedUtf16Units: number;
  idleTimeoutMs: number;
}

export interface EditorMetricsSnapshot {
  runtimeSessionId: string;
  byNode: Record<string, WritingMetricsSnapshot>;
}

export interface EditorMetricsRequest {
  nodeIds: string[];
}

export type EditorSteppedFormatKey =
  | 'fontSize'
  | 'fontWeight'
  | 'lineHeight'
  | 'letterSpacing'
  | 'firstLineIndent'
  | 'paragraphSpacing';

export interface EditorFormatStepRequest {
  id: string;
  property: EditorSteppedFormatKey;
  direction: -1 | 1;
}

export interface ApplyContentDeltaRequest {
  nodeId: string;
  start: number;
  deleteCount: number;
  insert: string;
  expectedRevision?: number;
  typingSessionId?: string;
  inheritFormat?: TextDocumentFormat;
  /** Portable point annotations cloned into the inserted text range. */
  annotationCopies?: AnnotationClipboardItem[];
}

export interface ApplyContentDeltaResult {
  revision: number;
  length: number;
  formatRevision?: number;
}

export interface MoveContentRangeRequest {
  nodeId: string;
  start: number;
  end: number;
  /** Destination offset in the pre-move document. */
  target: number;
  expectedRevision?: number;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'content.applyDelta': CommandContract<ApplyContentDeltaRequest, ApplyContentDeltaResult>;
    'content.moveRange': CommandContract<MoveContentRangeRequest, ApplyContentDeltaResult>;
  }
}
