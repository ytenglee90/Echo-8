import {
  createId,
  type CommandRegistration,
  type MessageEnvelope,
  type QueryRegistration,
} from './contracts.ts';
import { DiagnosticsService } from './diagnostics.ts';
import { TransactionManager } from './transaction-manager.ts';

interface OwnedCommand extends CommandRegistration {
  owner: string;
}

interface OwnedQuery extends QueryRegistration {
  owner: string;
}

interface OwnedListener {
  owner: string;
  listener: (envelope: MessageEnvelope) => void | Promise<void>;
  active: boolean;
}

interface MessageParent {
  id: string;
  correlationId: string;
  depth: number;
}

const MAX_MESSAGE_DEPTH = 48;
const MAX_PENDING_COMMANDS = 2048;

export class MessageRouter {
  private readonly commands = new Map<string, OwnedCommand>();
  private readonly queries = new Map<string, OwnedQuery>();
  private readonly events = new Map<string, Set<OwnedListener>>();
  private readonly signals = new Map<string, Set<OwnedListener>>();
  private readonly pendingSignals = new Map<string, MessageEnvelope>();
  private readonly eventTails = new Map<string, Promise<void>>();
  private commandTail: Promise<unknown> = Promise.resolve();
  private pendingCommands = 0;
  private readonly executingCommandIds = new Set<string>();
  private readonly lineage = new Map<string, MessageParent>();
  private readonly commandListeners = new Set<() => void>();
  private commandVersion = 0;
  private signalScheduled = false;
  private admission: (owner: string) => boolean = (owner) => owner.startsWith('core');
  private readonly transactions: TransactionManager;
  private readonly diagnostics: DiagnosticsService;

  constructor(transactions: TransactionManager, diagnostics: DiagnosticsService) {
    this.transactions = transactions;
    this.diagnostics = diagnostics;
    this.transactions.setEventPublisher((type, payload, source, causationId) =>
      this.publishEvent(type, payload, source, causationId),
    );
  }

  setAdmissionChecker(checker: (owner: string) => boolean): void {
    this.admission = checker;
  }

  registerCommand<TPayload = unknown, TResult = unknown>(
    owner: string,
    registration: CommandRegistration<TPayload, TResult>,
  ): () => void {
    if (this.commands.has(registration.type)) throw new Error(`Command already registered: ${registration.type}`);
    const owned = { ...registration, owner } as OwnedCommand;
    this.commands.set(registration.type, owned);
    this.bumpCommands();
    return () => {
      if (this.commands.get(registration.type) !== owned) return;
      this.commands.delete(registration.type);
      this.bumpCommands();
    };
  }

  isCommandAvailable(type: string): boolean {
    const registration = this.commands.get(type);
    return Boolean(registration && this.admission(registration.owner));
  }

  subscribeCommands(listener: () => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  getCommandVersion = (): number => this.commandVersion;

  registerQuery<TPayload = unknown, TResult = unknown>(
    owner: string,
    registration: QueryRegistration<TPayload, TResult>,
  ): () => void {
    if (this.queries.has(registration.type)) throw new Error(`Query already registered: ${registration.type}`);
    const owned = { ...registration, owner } as OwnedQuery;
    this.queries.set(registration.type, owned);
    return () => {
      if (this.queries.get(registration.type) === owned) this.queries.delete(registration.type);
    };
  }

  subscribeEvent(
    owner: string,
    type: string,
    listener: OwnedListener['listener'],
  ): () => void {
    const listeners = this.events.get(type) ?? new Set<OwnedListener>();
    const owned = { owner, listener, active: true };
    listeners.add(owned);
    this.events.set(type, listeners);
    return () => {
      owned.active = false;
      listeners.delete(owned);
      if (listeners.size === 0) this.events.delete(type);
    };
  }

  subscribeSignal(
    owner: string,
    type: string,
    listener: OwnedListener['listener'],
  ): () => void {
    const listeners = this.signals.get(type) ?? new Set<OwnedListener>();
    const owned = { owner, listener, active: true };
    listeners.add(owned);
    this.signals.set(type, listeners);
    return () => {
      owned.active = false;
      listeners.delete(owned);
      if (listeners.size === 0) this.signals.delete(type);
    };
  }

  dispatch<TResult = unknown>(
    type: string,
    payload: unknown,
    sourcePlugin: string,
    parent?: MessageParent,
  ): Promise<TResult> {
    if (parent && this.executingCommandIds.has(parent.id)) {
      this.diagnostics.increment('rejectedMessages');
      throw new Error(
        `Nested command dispatch would block the serial queue at ${type}; use the explicit compound-command channel`,
      );
    }
    if (parent && parent.depth + 1 > MAX_MESSAGE_DEPTH) {
      this.diagnostics.increment('rejectedMessages');
      throw new Error(`Message propagation depth exceeded at ${type}`);
    }
    if (this.pendingCommands >= MAX_PENDING_COMMANDS) {
      this.diagnostics.increment('rejectedMessages');
      throw new Error(`Command queue limit exceeded at ${type}`);
    }
    const envelope = this.envelope(type, payload, sourcePlugin, 50, parent);
    this.lineage.set(envelope.id, envelope);
    this.pendingCommands += 1;
    const run = () => this.executeCommand<TResult>(envelope);
    const result = this.commandTail.then(run, run);
    this.commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pendingCommands -= 1;
      this.lineage.delete(envelope.id);
    });
  }

  /** Runs a declared child command in the same serialized command turn. */
  invoke<TResult = unknown>(
    type: string,
    payload: unknown,
    sourcePlugin: string,
    parent?: MessageParent,
  ): Promise<TResult> {
    if (!parent || !this.executingCommandIds.has(parent.id)) {
      this.diagnostics.increment('rejectedMessages');
      throw new Error(`Compound command invocation is only available inside an active command: ${type}`);
    }
    if (parent.depth + 1 > MAX_MESSAGE_DEPTH) {
      this.diagnostics.increment('rejectedMessages');
      throw new Error(`Message propagation depth exceeded at ${type}`);
    }
    const envelope = this.envelope(type, payload, sourcePlugin, 50, parent);
    this.lineage.set(envelope.id, envelope);
    return this.executeCommand<TResult>(envelope).finally(() => this.lineage.delete(envelope.id));
  }

  /** Queues a declared child command after the active turn; callers cannot accidentally await it. */
  defer(
    type: string,
    payload: unknown,
    sourcePlugin: string,
    parent?: MessageParent,
  ): void {
    if (!parent || !this.executingCommandIds.has(parent.id)) {
      this.diagnostics.increment('rejectedMessages');
      throw new Error(`Deferred command is only available inside an active command: ${type}`);
    }
    if (parent.depth + 1 > MAX_MESSAGE_DEPTH) {
      this.diagnostics.increment('rejectedMessages');
      throw new Error(`Message propagation depth exceeded at ${type}`);
    }
    if (this.pendingCommands >= MAX_PENDING_COMMANDS) {
      this.diagnostics.increment('rejectedMessages');
      throw new Error(`Command queue limit exceeded at ${type}`);
    }
    const envelope = this.envelope(type, payload, sourcePlugin, 50, parent);
    this.lineage.set(envelope.id, envelope);
    this.pendingCommands += 1;
    const run = () => this.executeCommand(envelope);
    const result = this.commandTail.then(run, run);
    this.commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    void result.catch((error) => {
      this.diagnostics.record('error', sourcePlugin, `Deferred command failed: ${type}`, error);
    }).finally(() => {
      this.pendingCommands -= 1;
      this.lineage.delete(envelope.id);
    });
  }

  async ask<TResult = unknown>(type: string, payload: unknown, sourcePlugin: string): Promise<TResult> {
    const registration = this.queries.get(type);
    if (!registration || !this.admission(registration.owner)) throw new Error(`Query unavailable: ${type}`);
    if (registration.validate && !registration.validate(payload)) throw new Error(`Invalid query payload: ${type}`);
    this.diagnostics.increment('queries');
    return (await registration.handle(payload, this.envelope(type, payload, sourcePlugin))) as TResult;
  }

  emitSignal(type: string, payload: unknown, sourcePlugin: string, parent?: MessageParent): void {
    if (parent && parent.depth + 1 > MAX_MESSAGE_DEPTH) {
      this.diagnostics.increment('rejectedMessages');
      throw new Error(`Signal propagation depth exceeded at ${type}`);
    }
    const envelope = this.envelope(type, payload, sourcePlugin, 100, parent);
    this.pendingSignals.set(`${sourcePlugin}:${type}`, envelope);
    if (this.signalScheduled) return;
    this.signalScheduled = true;
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => void this.flushSignals());
    } else {
      queueMicrotask(() => void this.flushSignals());
    }
  }

  async publishEvent(
    type: string,
    payload: unknown,
    sourcePlugin: string,
    causationId?: string,
  ): Promise<void> {
    const parent = causationId ? this.lineage.get(causationId) : undefined;
    const envelope = {
      ...this.envelope(type, payload, sourcePlugin, 50, parent),
      causationId,
    };
    this.diagnostics.increment('events');
    for (const owned of this.events.get(type) ?? []) {
      if (!this.admission(owned.owner)) continue;
      this.scheduleEventDelivery(owned, envelope);
    }
  }

  private scheduleEventDelivery(owned: OwnedListener, envelope: MessageEnvelope): void {
    const previous = this.eventTails.get(owned.owner) ?? Promise.resolve();
    const delivery = previous.then(async () => {
      if (!owned.active || !this.admission(owned.owner)) return;
      try {
        await owned.listener(envelope);
      } catch (error) {
        this.diagnostics.record('error', owned.owner, `Event handler failed: ${envelope.type}`, error);
      }
    });
    const settled = delivery.then(() => undefined, () => undefined);
    this.eventTails.set(owned.owner, settled);
    void settled.finally(() => {
      if (this.eventTails.get(owned.owner) === settled) this.eventTails.delete(owned.owner);
    });
  }

  private async executeCommand<TResult>(envelope: MessageEnvelope): Promise<TResult> {
    const registration = this.commands.get(envelope.type);
    if (!registration || !this.admission(registration.owner)) {
      throw new Error(`Command unavailable: ${envelope.type}`);
    }
    if (registration.validate && !registration.validate(envelope.payload)) {
      throw new Error(`Invalid command payload: ${envelope.type}`);
    }
    this.diagnostics.increment('commands');
    this.executingCommandIds.add(envelope.id);
    try {
      const outcome = await registration.handle(envelope.payload, envelope);
      if (outcome.transaction) {
        await this.transactions.commit(outcome.transaction, envelope, registration.owner);
      }
      return outcome.result as TResult;
    } catch (error) {
      this.diagnostics.record('error', registration.owner, `Command failed: ${envelope.type}`, error);
      throw error;
    } finally {
      this.executingCommandIds.delete(envelope.id);
    }
  }

  private async flushSignals(): Promise<void> {
    this.signalScheduled = false;
    const signals = [...this.pendingSignals.values()];
    this.pendingSignals.clear();
    this.diagnostics.increment('signals');
    for (const envelope of signals) {
      for (const owned of this.signals.get(envelope.type) ?? []) {
        if (!this.admission(owned.owner)) continue;
        try {
          await owned.listener(envelope);
        } catch (error) {
          this.diagnostics.record('error', owned.owner, `Signal handler failed: ${envelope.type}`, error);
        }
      }
    }
  }

  private bumpCommands(): void {
    this.commandVersion += 1;
    for (const listener of this.commandListeners) listener();
  }

  private envelope<T>(
    type: string,
    payload: T,
    sourcePlugin: string,
    priority = 50,
    parent?: MessageParent,
  ): MessageEnvelope<T> {
    const id = createId('message');
    return {
      id,
      type,
      schemaVersion: 1,
      sourcePlugin,
      causationId: parent?.id,
      correlationId: parent?.correlationId ?? id,
      timestamp: Date.now(),
      priority,
      depth: parent ? parent.depth + 1 : 0,
      payload,
    };
  }
}
