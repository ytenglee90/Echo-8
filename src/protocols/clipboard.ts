import type { EventDeclaration, PatchOperation } from '../core/contracts.ts';

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
