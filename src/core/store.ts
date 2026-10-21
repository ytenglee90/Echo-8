import type { DomainSnapshot, PatchOperation, StoreDomain, StoreSnapshot } from './contracts.ts';
import { yieldToMainThread } from './async.ts';

const emptyDomain = (): DomainSnapshot => ({ revision: 0, namespaces: {} });

export function createEmptySnapshot(): StoreSnapshot {
  return {
    formatVersion: 1,
    document: emptyDomain(),
    workspace: emptyDomain(),
  };
}

export interface SnapshotAsyncOptions {
  /**
   * Store records are immutable after admission. A mandatory persistence
   * service may preserve references for namespaces it immediately
   * externalizes, avoiding a full copy of very large content chunks.
   */
  preserveImmutableNamespaces?: ReadonlySet<string>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class StateStore {
  private document: DomainSnapshot = emptyDomain();
  private workspace: DomainSnapshot = emptyDomain();
  private ephemeral: DomainSnapshot = emptyDomain();
  private derived: DomainSnapshot = emptyDomain();
  private version = 0;
  private readonly namespaceRevisions = new Map<string, number>();
  private readonly namespaceChanges = new Map<string, Array<{ revision: number; keys: string[] }>>();
  private readonly listeners = new Set<() => void>();
  private readonly writeToken: symbol;

  constructor(writeToken: symbol) {
    this.writeToken = writeToken;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion = (): number => this.version;

  getDomainRevision(domain: StoreDomain): number {
    return this.domain(domain).revision;
  }

  getNamespaceRevision(domain: StoreDomain, namespace: string): number {
    return this.namespaceRevisions.get(`${domain}:${namespace}`) ?? 0;
  }

  getNamespaceChanges(domain: StoreDomain, namespace: string, sinceRevision: number): {
    revision: number;
    reset: boolean;
    keys: string[];
  } {
    const target = `${domain}:${namespace}`;
    const revision = this.namespaceRevisions.get(target) ?? 0;
    if (sinceRevision === revision) return { revision, reset: false, keys: [] };
    const changes = this.namespaceChanges.get(target) ?? [];
    const firstRevision = changes[0]?.revision;
    if (sinceRevision < 0 || sinceRevision > revision || firstRevision === undefined || sinceRevision < firstRevision - 1) {
      return { revision, reset: true, keys: [] };
    }
    return {
      revision,
      reset: false,
      keys: [...new Set(changes.filter((change) => change.revision > sinceRevision).flatMap((change) => change.keys))],
    };
  }

  readNamespace<TRecord = Record<string, unknown>>(
    domain: StoreDomain,
    namespace: string,
  ): TRecord {
    return clone((this.domain(domain).namespaces[namespace] ?? {}) as TRecord);
  }

  readNamespacePrefix<TRecord = Record<string, unknown>>(
    domain: StoreDomain,
    namespace: string,
    prefix: string,
  ): TRecord {
    const source = this.domain(domain).namespaces[namespace] ?? {};
    const selected: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith(prefix)) selected[key] = clone(value);
    }
    return selected as TRecord;
  }

  readNamespaceKeyRange<TRecord = Record<string, unknown>>(
    domain: StoreDomain,
    namespace: string,
    startInclusive: string,
    endExclusive: string,
    includePrevious = false,
  ): TRecord {
    const source = this.domain(domain).namespaces[namespace] ?? {};
    const selected: Record<string, unknown> = {};
    let previousKey: string | undefined;
    for (const key of Object.keys(source)) {
      if (key < startInclusive) {
        if (includePrevious && (!previousKey || key > previousKey)) previousKey = key;
        continue;
      }
      if (key < endExclusive) selected[key] = clone(source[key]);
    }
    if (previousKey) selected[previousKey] = clone(source[previousKey]);
    return selected as TRecord;
  }

  readValue<TValue = unknown>(
    domain: StoreDomain,
    namespace: string,
    key: string,
  ): TValue | undefined {
    const value = this.domain(domain).namespaces[namespace]?.[key];
    return value === undefined ? undefined : clone(value as TValue);
  }

  hasValue(domain: StoreDomain, namespace: string, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(
      this.domain(domain).namespaces[namespace] ?? {},
      key,
    );
  }

  countNamespace(domain: StoreDomain, namespace: string): number {
    return Object.keys(this.domain(domain).namespaces[namespace] ?? {}).length;
  }

  snapshot(): StoreSnapshot {
    return clone({
      formatVersion: 1,
      document: this.document,
      workspace: this.workspace,
    });
  }

  async snapshotAsync(signal?: AbortSignal, options: SnapshotAsyncOptions = {}): Promise<StoreSnapshot> {
    const capturedDocument = captureDomain(this.document);
    const capturedWorkspace = captureDomain(this.workspace);
    const [document, workspace] = await Promise.all([
      cloneCapturedDomain(capturedDocument, signal, options),
      cloneCapturedDomain(capturedWorkspace, signal, options),
    ]);
    return { formatVersion: 1, document, workspace };
  }

  summary(): Array<{
    domain: StoreDomain;
    revision: number;
    namespaceCount: number;
    recordCount: number;
    namespaces: Array<{ id: string; records: number }>;
  }> {
    const domains: StoreDomain[] = ['document', 'workspace', 'ephemeral', 'derived'];
    return domains.map((domainName) => {
      const domain = this.domain(domainName);
      const namespaces = Object.entries(domain.namespaces)
        .map(([id, records]) => ({ id, records: Object.keys(records).length }))
        .sort((left, right) => left.id.localeCompare(right.id));
      return {
        domain: domainName,
        revision: domain.revision,
        namespaceCount: namespaces.length,
        recordCount: namespaces.reduce((total, namespace) => total + namespace.records, 0),
        namespaces,
      };
    });
  }

  hydrate(snapshot: StoreSnapshot, token: symbol): void {
    this.assertToken(token);
    if (snapshot.formatVersion !== 1) throw new Error('Unsupported store snapshot');
    this.document = clone(snapshot.document);
    this.workspace = clone(snapshot.workspace);
    this.ephemeral = emptyDomain();
    this.derived = emptyDomain();
    this.namespaceRevisions.clear();
    this.namespaceChanges.clear();
    for (const [namespace] of Object.entries(this.document.namespaces)) {
      this.namespaceRevisions.set(`document:${namespace}`, 1);
    }
    for (const [namespace] of Object.entries(this.workspace.namespaces)) {
      this.namespaceRevisions.set(`workspace:${namespace}`, 1);
    }
    this.bump();
  }

  replaceDocument(snapshot: DomainSnapshot, token: symbol): void {
    this.assertToken(token);
    validateDomainSnapshot(snapshot);
    this.document = clone(snapshot);
    this.document.revision += 1;
    this.ephemeral = emptyDomain();
    this.derived = emptyDomain();
    for (const key of [...this.namespaceRevisions.keys()]) {
      if (key.startsWith('document:')) this.namespaceRevisions.delete(key);
    }
    for (const key of [...this.namespaceChanges.keys()]) {
      if (key.startsWith('document:')) this.namespaceChanges.delete(key);
    }
    for (const [namespace] of Object.entries(this.document.namespaces)) {
      this.namespaceRevisions.set(`document:${namespace}`, 1);
    }
    this.bump();
  }

  apply(patches: PatchOperation[], token: symbol): void {
    this.assertToken(token);
    const touched = new Set<StoreDomain>();
    const touchedNamespaces = new Map<string, Set<string>>();
    for (const patch of patches) {
      const domain = this.domain(patch.domain);
      const namespace = domain.namespaces[patch.namespace] ?? {};
      domain.namespaces[patch.namespace] = namespace;
      if (patch.op === 'set') namespace[patch.key] = clone(patch.value);
      else delete namespace[patch.key];
      touched.add(patch.domain);
      const namespaceKey = `${patch.domain}:${patch.namespace}`;
      const keys = touchedNamespaces.get(namespaceKey) ?? new Set<string>();
      keys.add(patch.key);
      touchedNamespaces.set(namespaceKey, keys);
    }
    for (const domain of touched) this.domain(domain).revision += 1;
    for (const [key, changedKeys] of touchedNamespaces) {
      const revision = (this.namespaceRevisions.get(key) ?? 0) + 1;
      this.namespaceRevisions.set(key, revision);
      const changes = this.namespaceChanges.get(key) ?? [];
      changes.push({ revision, keys: [...changedKeys] });
      if (changes.length > 4096) changes.splice(0, changes.length - 4096);
      this.namespaceChanges.set(key, changes);
    }
    if (patches.length > 0) this.bump();
  }

  applyEphemeral(
    domainName: Extract<StoreDomain, 'ephemeral' | 'derived'>,
    namespace: string,
    key: string,
    value: unknown,
    token: symbol,
  ): void {
    this.assertToken(token);
    const domain = this.domain(domainName);
    domain.namespaces[namespace] ??= {};
    domain.namespaces[namespace][key] = clone(value);
    domain.revision += 1;
    this.bump();
  }

  private domain(domain: StoreDomain): DomainSnapshot {
    if (domain === 'document') return this.document;
    if (domain === 'workspace') return this.workspace;
    if (domain === 'ephemeral') return this.ephemeral;
    return this.derived;
  }

  private assertToken(token: symbol): void {
    if (token !== this.writeToken) throw new Error('Store writes require the kernel write token');
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

interface CapturedDomain {
  revision: number;
  namespaces: Array<[string, Array<[string, unknown]>]>;
}

function captureDomain(domain: DomainSnapshot): CapturedDomain {
  return {
    revision: domain.revision,
    namespaces: Object.entries(domain.namespaces)
      .map(([namespace, records]) => [namespace, Object.entries(records)]),
  };
}

async function cloneCapturedDomain(
  captured: CapturedDomain,
  signal?: AbortSignal,
  options: SnapshotAsyncOptions = {},
): Promise<DomainSnapshot> {
  const result: DomainSnapshot = { revision: captured.revision, namespaces: {} };
  let sliceStarted = now();
  let recordsInSlice = 0;
  for (const [namespace, records] of captured.namespaces) {
    const destination: Record<string, unknown> = {};
    result.namespaces[namespace] = destination;
    for (const [key, value] of records) {
      throwIfAborted(signal);
      destination[key] = options.preserveImmutableNamespaces?.has(namespace) ? value : clone(value);
      recordsInSlice += 1;
      if (recordsInSlice >= 128 || now() - sliceStarted >= 8) {
        await yieldToMainThread();
        sliceStarted = now();
        recordsInSlice = 0;
      }
    }
  }
  return result;
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Snapshot cancelled', 'AbortError');
}

export function validateDomainSnapshot(snapshot: DomainSnapshot): void {
  if (!snapshot || !Number.isInteger(snapshot.revision) || snapshot.revision < 0 ||
    typeof snapshot.namespaces !== 'object' || snapshot.namespaces === null || Array.isArray(snapshot.namespaces)) {
    throw new Error('Invalid document snapshot');
  }
  for (const [namespace, values] of Object.entries(snapshot.namespaces)) {
    if (!namespace || typeof values !== 'object' || values === null || Array.isArray(values)) {
      throw new Error(`Invalid document namespace: ${namespace || '(empty)'}`);
    }
  }
}
