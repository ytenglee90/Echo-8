import type { EventDeclaration, PatchOperation } from './state.ts';

export interface ClipboardFragment {
  owner: string;
  version: 1;
  entityIds: string[];
  payload: unknown;
}

export interface ClipboardBundle {
  format: 'application/x-echo-8-canvas+json';
  version: 1;
  copiedAt: number;
  sourceIds: string[];
  fragments: ClipboardFragment[];
  plainTextPreview: string;
}

export interface ClipboardInstantiateInput {
  fragments: ClipboardFragment[];
  idMap: Record<string, string>;
  offset: { x: number; y: number };
}

export interface ClipboardInstantiatePlan {
  patches: PatchOperation[];
  events?: EventDeclaration[];
  createdIds?: string[];
  selectIds?: string[];
}

/** Stable, caller-captured object IDs. Resolving them never changes the live selection. */
export interface ClipboardCopySelectionRequest {
  sourceIds: string[];
  expectedKind?: 'text-node' | 'group' | 'connection';
}

export interface ClipboardCapturedPasteRequest {
  copiedAt: number;
  sourceIds: string[];
}

export interface ClipboardSourceSnapshot {
  copiedAt?: number;
  sourceIds: string[];
}

export type ClipboardDuplicateRequest = ClipboardCopySelectionRequest & { includeInternalRelations?: true } & (
  | { offset: { x: number; y: number } }
  | { direction: 'right' | 'left' | 'down' | 'up'; gap?: number }
);

export interface ClipboardDuplicateResult {
  created: number;
  createdIds: string[];
  entityIds: string[];
  sourceIds: string[];
}

export function isClipboardDuplicateRequest(value: unknown): value is ClipboardDuplicateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every(key => ['sourceIds', 'expectedKind', 'offset', 'direction', 'gap', 'includeInternalRelations'].includes(key)) ||
    input.includeInternalRelations !== undefined && input.includeInternalRelations !== true ||
    !isClipboardCopySelectionRequest({ sourceIds: input.sourceIds, expectedKind: input.expectedKind })) return false;
  const bounded = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1e9;
  if (input.offset !== undefined) {
    const offset = input.offset as Record<string, unknown>;
    return input.direction === undefined && input.gap === undefined && !!offset && typeof offset === 'object' &&
      !Array.isArray(offset) && Object.keys(offset).length === 2 && bounded(offset.x) && bounded(offset.y);
  }
  return typeof input.direction === 'string' && ['right', 'left', 'down', 'up'].includes(input.direction) &&
    (input.gap === undefined || typeof input.gap === 'number' && Number.isFinite(input.gap) && input.gap >= 0 && input.gap <= 10000);
}

export function isClipboardCapturedPasteRequest(value: unknown): value is ClipboardCapturedPasteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Partial<ClipboardCapturedPasteRequest>;
  return Object.keys(value).length === 2 && Object.keys(value).every(key => key === 'copiedAt' || key === 'sourceIds') &&
    typeof request.copiedAt === 'number' &&
    Number.isSafeInteger(request.copiedAt) && request.copiedAt > 0 &&
    isClipboardCopySelectionRequest({ sourceIds: request.sourceIds });
}

export const MAX_CLIPBOARD_SOURCE_IDS = 5000;

export function isClipboardCopySelectionRequest(value: unknown): value is ClipboardCopySelectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { sourceIds, expectedKind } = value as Partial<ClipboardCopySelectionRequest>;
  return Object.keys(value).every(key => key === 'sourceIds' || key === 'expectedKind') &&
    Array.isArray(sourceIds) && sourceIds.length > 0 && sourceIds.length <= MAX_CLIPBOARD_SOURCE_IDS &&
    sourceIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200) &&
    new Set(sourceIds).size === sourceIds.length &&
    (expectedKind === undefined || ['text-node', 'group', 'connection'].includes(expectedKind));
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'clipboard.copySelection@1': CommandContract<ClipboardCopySelectionRequest, { count: number }>;
    'clipboard.cutSelection@1': CommandContract<ClipboardCopySelectionRequest, { count: number }>;
    'clipboard.pasteCaptured@1': CommandContract<ClipboardCapturedPasteRequest, { created: number }>;
    'clipboard.duplicateCaptured@1': CommandContract<ClipboardDuplicateRequest, ClipboardDuplicateResult>;
  }
}

declare module './messages.ts' {
  interface ApplicationCapabilityMap {
    'clipboard.sources@1': MessageContract<undefined, ClipboardSourceSnapshot>;
  }
}
