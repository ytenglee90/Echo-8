import { createId, type DomainSnapshot, type MessageEnvelope, type PatchOperation, type TransactionProposal } from './contracts.ts';
import { HistoryService, type HistoryEntry, type HistorySnapshot, validateHistorySnapshot } from './history.ts';
import { StateStore } from './store.ts';
import { scrubRetiredDocument, scrubRetiredHistory } from './legacy-migrations.ts';

export interface TransactionCommitRecord {
  id: string;
  label: string;
  timestamp: number;
  forward: PatchOperation[];
  inverse: PatchOperation[];
  sourceMessageId: string;
  historyAction: 'record' | 'undo' | 'redo' | 'none';
  mergeKey?: string;
  mergeWindowMs?: number;
}

type EventPublisher = (type: string, payload: unknown, source: string, causationId?: string) => Promise<void>;
type PersistenceSink = (record: TransactionCommitRecord) => void;
type NamespaceOwnerResolver = (domain: PatchOperation['domain'], namespace: string) => string | undefined;
type WriteAuthorizer = (owner: string) => boolean;

export class TransactionManager {
  private readonly store: StateStore;
  private readonly history: HistoryService;
  private readonly writeToken: symbol;
  private publishEvent: EventPublisher = async () => undefined;
  private persist: PersistenceSink = () => undefined;
  private resolveNamespaceOwner: NamespaceOwnerResolver = () => undefined;
  private canWrite: WriteAuthorizer = (owner) => owner.startsWith('core');
  private active = false;

  constructor(store: StateStore, history: HistoryService, writeToken: symbol) {
    this.store = store;
    this.history = history;
    this.writeToken = writeToken;
  }

  setEventPublisher(publisher: EventPublisher): void {
    this.publishEvent = publisher;
  }

  setPersistenceSink(sink: PersistenceSink): void {
    this.persist = sink;
  }

  setNamespaceOwnerResolver(resolver: NamespaceOwnerResolver): void {
    this.resolveNamespaceOwner = resolver;
  }

  setWriteAuthorizer(authorizer: WriteAuthorizer): void {
    this.canWrite = authorizer;
  }

  async commit(
    proposal: TransactionProposal,
    envelope: MessageEnvelope,
    proposalOwner: string,
  ): Promise<string> {
    if (this.active) throw new Error('Nested durable transactions are not allowed');
    const forward = normalizePatches(proposal.patches);
    if (forward.length === 0) return createId('transaction-empty');
    const domains = new Set(forward.map((patch) => patch.domain));
    if (domains.size > 1) {
      throw new Error('Document and personal-workspace patches must use separate transactions');
    }
    if (proposal.history !== false && domains.has('workspace')) {
      throw new Error('Personal workspace transactions cannot enter document history');
    }
    for (const patch of forward) {
      const declaredOwner = this.resolveNamespaceOwner(patch.domain, patch.namespace);
      const schemaOwner = patch.schemaOwner ?? proposalOwner;
      if (!declaredOwner && !schemaOwner.startsWith('core')) {
        throw new Error(`Namespace has no registered owner: ${patch.domain}.${patch.namespace}`);
      }
      if (declaredOwner && declaredOwner !== schemaOwner) {
        throw new Error(
          `Patch owner mismatch for ${patch.domain}.${patch.namespace}: ${schemaOwner} cannot write ${declaredOwner}`,
        );
      }
      if (!this.canWrite(schemaOwner)) {
        throw new Error(`Permission denied for ${schemaOwner}: durable writes require store.own.write`);
      }
    }

    const id = createId('transaction');
    const inverse = this.buildInverse(forward);
    let committed: TransactionCommitRecord | undefined;
    this.active = true;
    try {
      this.store.apply(forward, this.writeToken);
      const timestamp = Date.now();
      if (proposal.history !== false && domains.has('document')) {
        this.history.record({
          id,
          label: proposal.label,
          timestamp,
          forward,
          inverse,
          mergeKey: proposal.mergeKey,
          mergeWindowMs: proposal.mergeWindowMs,
        });
      }
      committed = {
        id,
        label: proposal.label,
        timestamp,
        forward,
        inverse,
        sourceMessageId: envelope.id,
        historyAction: proposal.history === false ? 'none' : 'record',
        mergeKey: proposal.mergeKey,
        mergeWindowMs: proposal.mergeWindowMs,
      };
      this.persist(committed);
    } finally {
      this.active = false;
    }

    await this.publishEvent(
      'transaction.committed',
      { id, label: proposal.label, record: committed },
      'core.transaction',
      envelope.id,
    );

    for (const event of proposal.events ?? []) {
      await this.publishEvent(event.type, event.payload, 'core.transaction', envelope.id);
    }
    return id;
  }

  async undo(causationId?: string): Promise<boolean> {
    const entry = this.history.peekUndo();
    if (!entry) return false;
    const record = this.applyHistory(entry, 'undo', entry.inverse);
    this.history.markUndone();
    await this.publishEvent('history.changed', this.history.getState(), 'core.history', causationId);
    await this.publishEvent('transaction.committed', { id: record.id, label: record.label, record }, 'core.history', causationId);
    return true;
  }

  async redo(causationId?: string): Promise<boolean> {
    const entry = this.history.peekRedo();
    if (!entry) return false;
    const record = this.applyHistory(entry, 'redo', entry.forward);
    this.history.markRedone();
    await this.publishEvent('history.changed', this.history.getState(), 'core.history', causationId);
    await this.publishEvent('transaction.committed', { id: record.id, label: record.label, record }, 'core.history', causationId);
    return true;
  }

  async replaceDocument(
    document: DomainSnapshot,
    history: HistorySnapshot,
    envelope: MessageEnvelope,
    origin: 'file' | 'cloud' | 'new' | 'recovery' | 'external' = 'external',
  ): Promise<string> {
    if (this.active) throw new Error('Document replacement collided with an active transaction');
    validateHistorySnapshot(history);
    const cleanDocument = scrubRetiredDocument(document).value;
    const cleanHistory = scrubRetiredHistory(history).value;
    const id = createId('document-open');
    this.active = true;
    try {
      this.store.replaceDocument(cleanDocument, this.writeToken);
      this.history.import(cleanHistory);
      this.persist({
        id,
        label: '打开书籍',
        timestamp: Date.now(),
        forward: [],
        inverse: [],
        sourceMessageId: envelope.id,
        historyAction: 'none',
      });
    } finally {
      this.active = false;
    }
    await this.publishEvent('document.replaced', { id, origin }, 'core.persistence', envelope.id);
    await this.publishEvent('history.changed', this.history.getState(), 'core.persistence', envelope.id);
    await this.publishEvent('transaction.committed', { id, label: '打开书籍' }, 'core.persistence', envelope.id);
    return id;
  }

  private applyHistory(entry: HistoryEntry, action: 'undo' | 'redo', patches: PatchOperation[]): TransactionCommitRecord {
    if (this.active) throw new Error('History operation collided with an active transaction');
    this.active = true;
    try {
      this.store.apply(patches, this.writeToken);
      const record: TransactionCommitRecord = {
        id: createId(`history-${action}`),
        label: `${action === 'undo' ? '撤销' : '重做'}：${entry.label}`,
        timestamp: Date.now(),
        forward: patches,
        inverse: action === 'undo' ? entry.forward : entry.inverse,
        sourceMessageId: entry.id,
        historyAction: action,
      };
      this.persist(record);
      return record;
    } finally {
      this.active = false;
    }
  }

  private buildInverse(forward: PatchOperation[]): PatchOperation[] {
    return forward
      .map((patch): PatchOperation => {
        if (this.store.hasValue(patch.domain, patch.namespace, patch.key)) {
          return {
            op: 'set',
            domain: patch.domain,
            namespace: patch.namespace,
            key: patch.key,
            value: this.store.readValue(patch.domain, patch.namespace, patch.key),
          };
        }
        return { op: 'delete', domain: patch.domain, namespace: patch.namespace, key: patch.key };
      })
      .reverse();
  }
}

function normalizePatches(patches: PatchOperation[]): PatchOperation[] {
  const byTarget = new Map<string, PatchOperation>();
  for (const patch of patches) {
    if (!patch.namespace || !patch.key) throw new Error('Patch namespace and key are required');
    if (patch.op === 'set' && patch.value === undefined) {
      throw new Error('Use a delete patch instead of setting undefined');
    }
    const target = `${patch.domain}\u0000${patch.namespace}\u0000${patch.key}`;
    byTarget.set(target, structuredClone(patch));
  }
  return [...byTarget.values()];
}
