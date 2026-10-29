import type { PluginManifest } from './contracts.ts';
import type { StoreSnapshot, TransactionCommitRecord } from '../protocols/state.ts';

export interface WorkspacePersistencePolicy {
  isSessionOnly(namespace: string, key: string): boolean;
  scrubStore(snapshot: StoreSnapshot): boolean;
  scrubRecord(record: TransactionCommitRecord): TransactionCommitRecord | undefined;
}

/**
 * Compiles plugin-owned session layout declarations into one mandatory
 * persistence boundary. Runtime workspace state stays transactional and
 * observable, while declared window/layout records never reach checkpoints or
 * the recovery journal.
 */
export function createWorkspacePersistencePolicy(
  manifests: readonly PluginManifest[],
): WorkspacePersistencePolicy {
  const completeNamespaces = new Set<string>();
  const keysByNamespace = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    for (const [namespace, declaration] of Object.entries(manifest.sessionOnlyWorkspace)) {
      if (declaration === undefined) continue;
      if (declaration === true) {
        completeNamespaces.add(namespace);
        keysByNamespace.delete(namespace);
        continue;
      }
      if (completeNamespaces.has(namespace)) continue;
      const keys = keysByNamespace.get(namespace) ?? new Set<string>();
      for (const key of declaration) keys.add(key);
      keysByNamespace.set(namespace, keys);
    }
  }

  const isSessionOnly = (namespace: string, key: string): boolean =>
    completeNamespaces.has(namespace) || keysByNamespace.get(namespace)?.has(key) === true;

  return {
    isSessionOnly,
    scrubStore(snapshot) {
      let changed = false;
      for (const namespace of completeNamespaces) {
        if (!(namespace in snapshot.workspace.namespaces)) continue;
        delete snapshot.workspace.namespaces[namespace];
        changed = true;
      }
      for (const [namespace, keys] of keysByNamespace) {
        const records = snapshot.workspace.namespaces[namespace];
        if (!records) continue;
        for (const key of keys) {
          if (!(key in records)) continue;
          delete records[key];
          changed = true;
        }
        if (Object.keys(records).length === 0) delete snapshot.workspace.namespaces[namespace];
      }
      return changed;
    },
    scrubRecord(record) {
      const keep = (patch: TransactionCommitRecord['forward'][number]) =>
        patch.domain !== 'workspace' || !isSessionOnly(patch.namespace, patch.key);
      const forward = record.forward.filter(keep);
      const inverse = record.inverse.filter(keep);
      if (record.forward.length > 0 && forward.length === 0) return undefined;
      return { ...record, forward, inverse };
    },
  };
}
