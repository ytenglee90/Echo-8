import type {
  DomainSnapshot,
  PatchOperation,
  PluginDefinition,
  RetiredDataScrubRule,
  StoreSnapshot,
} from './contracts.ts';
import type { HistoryEntry, HistorySnapshot } from './history.ts';

/**
 * Applies plugin-owned retirement rules without teaching the kernel any plugin
 * schema. Rules are synchronous and idempotent because one value can appear in
 * active state, history, journal and recovery points.
 */
export class RetiredDataRegistry {
  readonly migrationKey: string;
  private readonly byNamespace = new Map<string, RetiredDataScrubRule[]>();

  constructor(rules: readonly RetiredDataScrubRule[]) {
    const ids = new Set<string>();
    for (const rule of rules) {
      if (ids.has(rule.id)) throw new Error(`Duplicate retired-data scrubber id: ${rule.id}`);
      ids.add(rule.id);
      const namespaceRules = this.byNamespace.get(rule.namespace) ?? [];
      namespaceRules.push(rule);
      this.byNamespace.set(rule.namespace, namespaceRules);
    }
    this.migrationKey = `retired-data:${[...ids].sort().join(',') || 'none'}`;
  }

  scrubStore(snapshot: StoreSnapshot): { value: StoreSnapshot; changed: boolean } {
    const value = structuredClone(snapshot);
    return { value, changed: this.scrubStoreInPlace(value) };
  }

  scrubDocument(snapshot: DomainSnapshot): { value: DomainSnapshot; changed: boolean } {
    const value = structuredClone(snapshot);
    return { value, changed: this.scrubDomainInPlace(value) };
  }

  scrubHistory(snapshot: HistorySnapshot): { value: HistorySnapshot; changed: boolean } {
    const value = structuredClone(snapshot);
    return { value, changed: this.scrubHistoryInPlace(value) };
  }

  scrubPatch(patch: PatchOperation): { value: PatchOperation; changed: boolean } {
    const value = structuredClone(patch);
    return { value, changed: this.scrubPatchInPlace(value) };
  }

  scrubStoreInPlace(snapshot: StoreSnapshot): boolean {
    const document = this.scrubDomainInPlace(snapshot.document);
    const workspace = this.scrubDomainInPlace(snapshot.workspace);
    return document || workspace;
  }

  scrubHistoryInPlace(snapshot: HistorySnapshot): boolean {
    let changed = false;
    const scrubEntries = (entries: HistoryEntry[]) => {
      for (const entry of entries) {
        for (const patch of entry.forward) changed = this.scrubPatchInPlace(patch) || changed;
        for (const patch of entry.inverse) changed = this.scrubPatchInPlace(patch) || changed;
      }
    };
    scrubEntries(snapshot.undo);
    scrubEntries(snapshot.redo);
    return changed;
  }

  private scrubDomainInPlace(snapshot: DomainSnapshot): boolean {
    let changed = false;
    for (const [namespace, records] of Object.entries(snapshot.namespaces)) {
      for (const record of Object.values(records)) {
        changed = this.scrubNamespaceValueInPlace(namespace, record) || changed;
      }
    }
    return changed;
  }

  private scrubPatchInPlace(patch: PatchOperation): boolean {
    return patch.op === 'set' && this.scrubNamespaceValueInPlace(patch.namespace, patch.value);
  }

  private scrubNamespaceValueInPlace(namespace: string, value: unknown): boolean {
    let changed = false;
    for (const rule of this.byNamespace.get(namespace) ?? []) {
      changed = rule.scrubInPlace(value) || changed;
    }
    return changed;
  }
}

export function createRetiredDataRegistry(
  definitions: readonly PluginDefinition[],
): RetiredDataRegistry {
  return new RetiredDataRegistry(
    definitions.flatMap((definition) => definition.retiredDataScrubbers ?? []),
  );
}
