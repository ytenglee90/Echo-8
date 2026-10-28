import type { EventDeclaration, PatchOperation } from '../core/contracts.ts';
import type { CommandContract } from './commands.ts';

export type AnnotationTarget =
  | { kind: 'text-node'; targetId: string }
  | { kind: 'group'; targetId: string }
  | { kind: 'text-range'; targetId: string; offset: number };

export interface AnnotationRecord {
  id: string;
  target: AnnotationTarget;
  body: string;
  /** Optional marker override; absence inherits the global annotation color. */
  color?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface AnnotationOpenState {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Floating in the workspace; nested inside the fullscreen editor while immersive. */
  surface?: 'floating' | 'immersive';
}

export interface AnnotationCreateRequest {
  target: AnnotationTarget;
  body?: string;
  anchor?: { x: number; y: number };
}

export interface AnnotationOpenRequest {
  id: string;
  anchor?: { x: number; y: number };
}

export interface AnnotationUpdateRequest {
  id: string;
  body: string;
  expectedRevision: number;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'annotation.update': CommandContract<AnnotationUpdateRequest, { revision: number }>;
  }
}

export interface ContentAnchorTransformRequest {
  nodeId: string;
  start: number;
  deleteCount: number;
  insertLength: number;
}

export interface ContentAnchorTransformPlan {
  patches: PatchOperation[];
  events?: EventDeclaration[];
}

export const ANNOTATION_TEXT_CLIPBOARD_MIME = 'application/x-echo8-text-annotations+json';
export const MAX_ANNOTATION_BODY_LENGTH = 200_000;
export const MAX_ANNOTATION_CLIPBOARD_ITEMS = 256;
export const MAX_ANNOTATION_CLIPBOARD_BODY = 1_000_000;

export interface AnnotationClipboardItem {
  /** UTF-16 offset from the beginning of the copied plain-text range. */
  relativeOffset: number;
  body: string;
}

export interface ContentAnnotationCloneRequest {
  nodeId: string;
  insertionStart: number;
  insertionLength: number;
  items: AnnotationClipboardItem[];
}

export interface ContentAnchorMoveRequest {
  nodeId: string;
  start: number;
  end: number;
  /** Destination offset in the pre-move document. */
  target: number;
}
