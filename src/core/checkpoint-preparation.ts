import type { PatchOperation } from './contracts.ts';
import type { PersistedApplication } from './persistence.ts';

export const CONTENT_CHUNK_NAMESPACE = 'textContentChunk';
export const CONTENT_CHUNK_REFERENCE = '__echo8ContentChunkRef';

export interface ChunkExternalizedApplication {
  persistenceStorageVersion: 2;
  application: PersistedApplication;
  contentChunkIds: string[];
  activeContentChunkIds: string[];
}

export type StoredPersistedApplication = PersistedApplication | ChunkExternalizedApplication;

export interface ExternalizedCheckpoint {
  stored: ChunkExternalizedApplication;
  chunks: Map<string, unknown>;
}

export function externalizeContentChunks(application: PersistedApplication): ExternalizedCheckpoint {
  const sourceChunks = application.store.document.namespaces[CONTENT_CHUNK_NAMESPACE] ?? {};
  const chunks = new Map(Object.entries(sourceChunks));
  const history = {
    undo: application.history.undo.map((entry) => ({
      ...entry,
      forward: externalizeChunkPatches(entry.forward, chunks),
      inverse: externalizeChunkPatches(entry.inverse, chunks),
    })),
    redo: application.history.redo.map((entry) => ({
      ...entry,
      forward: externalizeChunkPatches(entry.forward, chunks),
      inverse: externalizeChunkPatches(entry.inverse, chunks),
    })),
  };
  const applicationWithoutChunks: PersistedApplication = {
    ...application,
    history,
    store: {
      ...application.store,
      document: {
        ...application.store.document,
        namespaces: {
          ...application.store.document.namespaces,
          [CONTENT_CHUNK_NAMESPACE]: {},
        },
      },
    },
  };
  return {
    stored: {
      persistenceStorageVersion: 2,
      application: applicationWithoutChunks,
      contentChunkIds: [...chunks.keys()],
      activeContentChunkIds: Object.keys(sourceChunks),
    },
    chunks,
  };
}

export function validateExternalizedCheckpoint(value: unknown): asserts value is ExternalizedCheckpoint {
  if (!isRecord(value) || !(value.chunks instanceof Map)) {
    throw new Error('Background checkpoint preparation returned invalid data');
  }
  validateChunkExternalizedApplication(value.stored);
  const declared = new Set(value.stored.contentChunkIds);
  for (const id of value.stored.activeContentChunkIds) {
    if (!declared.has(id) || !value.chunks.has(id)) {
      throw new Error(`Background checkpoint preparation omitted content chunk ${id}`);
    }
  }
  for (const id of value.chunks.keys()) {
    if (typeof id !== 'string' || !declared.has(id)) {
      throw new Error('Background checkpoint preparation returned an undeclared content chunk');
    }
  }
}

export function validateChunkExternalizedApplication(
  value: unknown,
): asserts value is ChunkExternalizedApplication {
  if (!isRecord(value) || value.persistenceStorageVersion !== 2 ||
    !isPersistedApplication(value.application) || !isStringList(value.contentChunkIds) ||
    !isStringList(value.activeContentChunkIds)) {
    throw new Error('Background checkpoint structure is invalid');
  }
  const declared = new Set(value.contentChunkIds);
  if (value.activeContentChunkIds.some((id) => !declared.has(id))) {
    throw new Error('Background checkpoint structure omitted an active content chunk');
  }
}

function externalizeChunkPatches(
  patches: PatchOperation[],
  chunks: Map<string, unknown>,
): PatchOperation[] {
  return patches.map((patch) => {
    if (patch.op !== 'set' || patch.domain !== 'document' || patch.namespace !== CONTENT_CHUNK_NAMESPACE) {
      return patch;
    }
    chunks.set(patch.key, patch.value);
    return { ...patch, value: { [CONTENT_CHUNK_REFERENCE]: patch.key } };
  });
}

function isPersistedApplication(value: unknown): value is PersistedApplication {
  return isRecord(value) && value.formatVersion === 1 && Number.isFinite(value.savedAt) &&
    isRecord(value.store) && isRecord(value.history);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
