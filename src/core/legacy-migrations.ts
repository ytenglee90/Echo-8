import type { DomainSnapshot, PatchOperation, StoreSnapshot } from './contracts.ts';
import type { HistoryEntry, HistorySnapshot } from './history.ts';

export const RETIRED_DATA_MIGRATION = 'retired-privacy-and-recent-metrics-v1';

export function scrubRetiredStore(snapshot: StoreSnapshot): { value: StoreSnapshot; changed: boolean } {
  const value = structuredClone(snapshot);
  return { value, changed: scrubRetiredStoreInPlace(value) };
}

export function scrubRetiredDocument(snapshot: DomainSnapshot): { value: DomainSnapshot; changed: boolean } {
  const value = structuredClone(snapshot);
  return { value, changed: scrubRetiredDomainInPlace(value) };
}

export function scrubRetiredHistory(snapshot: HistorySnapshot): { value: HistorySnapshot; changed: boolean } {
  const value = structuredClone(snapshot);
  return { value, changed: scrubRetiredHistoryInPlace(value) };
}

export function scrubRetiredPatch(patch: PatchOperation): { value: PatchOperation; changed: boolean } {
  const value = structuredClone(patch);
  return { value, changed: scrubRetiredPatchInPlace(value) };
}

/** Scrubs a snapshot that is already an isolated clone owned by the caller. */
export function scrubRetiredStoreInPlace(snapshot: StoreSnapshot): boolean {
  const document = scrubRetiredDomainInPlace(snapshot.document);
  const workspace = scrubRetiredDomainInPlace(snapshot.workspace);
  return document || workspace;
}

/** Scrubs a history snapshot that is already an isolated clone owned by the caller. */
export function scrubRetiredHistoryInPlace(snapshot: HistorySnapshot): boolean {
  let changed = false;
  const scrubEntries = (entries: HistoryEntry[]) => {
    for (const entry of entries) {
      for (const patch of entry.forward) changed = scrubRetiredPatchInPlace(patch) || changed;
      for (const patch of entry.inverse) changed = scrubRetiredPatchInPlace(patch) || changed;
    }
  };
  scrubEntries(snapshot.undo);
  scrubEntries(snapshot.redo);
  return changed;
}

function scrubRetiredDomainInPlace(snapshot: DomainSnapshot): boolean {
  let changed = false;
  for (const [namespace, records] of Object.entries(snapshot.namespaces)) {
    for (const record of Object.values(records)) {
      if (scrubNamespaceValueInPlace(namespace, record)) changed = true;
    }
  }
  return changed;
}

function scrubRetiredPatchInPlace(patch: PatchOperation): boolean {
  return patch.op === 'set' && scrubNamespaceValueInPlace(patch.namespace, patch.value);
}

function scrubNamespaceValueInPlace(namespace: string, source: unknown): boolean {
  if (namespace === 'textNode') return removeOwnKeysInPlace(source, ['private']);
  if (namespace === 'aiProposals') return scrubProposalInPlace(source);
  if (namespace === 'editor') return removeOwnKeysInPlace(source, ['recentBuckets', 'recentWindowMs']);
  if (namespace === 'clipboard') return scrubClipboardInPlace(source);
  return false;
}

function scrubProposalInPlace(source: unknown): boolean {
  if (!isRecord(source) || !Array.isArray(source.sourceRefs)) return false;
  let changed = false;
  for (const reference of source.sourceRefs) {
    changed = removeOwnKeysInPlace(reference, ['private']) || changed;
  }
  return changed;
}

function scrubClipboardInPlace(source: unknown): boolean {
  if (!isRecord(source) || !Array.isArray(source.fragments)) return false;
  let changed = false;
  for (const fragment of source.fragments) {
    if (!isRecord(fragment) || fragment.owner !== 'text-node' || !isRecord(fragment.payload) ||
      !Array.isArray(fragment.payload.nodes)) continue;
    for (const entry of fragment.payload.nodes) {
      if (!isRecord(entry) || !isRecord(entry.node)) continue;
      changed = removeOwnKeysInPlace(entry.node, ['private']) || changed;
    }
  }
  return changed;
}

function removeOwnKeysInPlace(source: unknown, keys: string[]): boolean {
  if (!isRecord(source)) return false;
  let changed = false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    delete source[key];
    changed = true;
  }
  return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
