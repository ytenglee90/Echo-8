export interface WorkerRequestMessage {
  id: string;
  type: string;
  payload: unknown;
}

export interface WorkerCancelMessage {
  id: string;
  type: 'core.worker.cancel';
}

export interface WorkerResponseMessage {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ManagedWorkerPort {
  postMessage(message: WorkerRequestMessage | WorkerCancelMessage, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponseMessage>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponseMessage>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}

export type ManagedWorkerFactory = () => ManagedWorkerPort;

interface PendingWorkerRequest {
  owner: string;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  abort?: () => void;
}

export class WorkerUnavailableError extends Error {
  constructor() {
    super('Managed background worker is unavailable');
    this.name = 'WorkerUnavailableError';
  }
}

/**
 * Owns the application background worker and keeps feature plugins away from
 * raw Worker construction, listeners, termination and cross-owner jobs.
 */
export class WorkerService {
  private readonly factory?: ManagedWorkerFactory;
  private worker?: ManagedWorkerPort;
  private sequence = 0;
  private readonly pending = new Map<string, PendingWorkerRequest>();

  constructor(factory?: ManagedWorkerFactory) {
    this.factory = factory;
  }

  isAvailable(): boolean {
    return Boolean(this.factory);
  }

  run<TResult>(
    owner: string,
    type: string,
    payload: unknown,
    signal?: AbortSignal,
    transfer: Transferable[] = [],
  ): Promise<TResult> {
    if (!this.factory) return Promise.reject(new WorkerUnavailableError());
    if (!type.startsWith(`${owner}.`)) {
      return Promise.reject(new Error(`Worker job ${type} is outside owner ${owner}`));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const worker = this.ensureWorker();
    const id = `${owner}:worker:${Date.now().toString(36)}:${(this.sequence += 1).toString(36)}`;
    const result = new Promise<TResult>((resolve, reject) => {
      const pending: PendingWorkerRequest = {
        owner,
        resolve: (value) => resolve(value as TResult),
        reject,
        signal,
      };
      if (signal) {
        pending.abort = () => {
          if (!this.pending.delete(id)) return;
          worker.postMessage({ id, type: 'core.worker.cancel' });
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        worker.postMessage({ id, type, payload }, transfer);
      } catch (error) {
        this.settle(id, false, error);
      }
    });
    return result;
  }

  cancelOwner(owner: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.owner !== owner) continue;
      this.pending.delete(id);
      this.worker?.postMessage({ id, type: 'core.worker.cancel' });
      pending.reject(new DOMException('Plugin stopped', 'AbortError'));
      this.cleanupPending(pending);
    }
  }

  dispose(): void {
    this.failAll(new DOMException('Background worker disposed', 'AbortError'));
    this.detachWorker();
  }

  private readonly handleMessage = (event: MessageEvent<WorkerResponseMessage>) => {
    const response = event.data;
    if (!response || typeof response.id !== 'string' || typeof response.ok !== 'boolean') return;
    this.settle(
      response.id,
      response.ok,
      response.ok ? response.result : new Error(response.error || 'Background worker job failed'),
    );
  };

  private readonly handleFailure = () => {
    this.failAll(new Error('Background worker stopped unexpectedly'));
    this.detachWorker();
  };

  private ensureWorker(): ManagedWorkerPort {
    if (this.worker) return this.worker;
    const worker = this.factory!();
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', this.handleFailure);
    worker.addEventListener('messageerror', this.handleFailure);
    this.worker = worker;
    return worker;
  }

  private settle(id: string, ok: boolean, value: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.cleanupPending(pending);
    if (ok) pending.resolve(value);
    else pending.reject(value);
  }

  private failAll(reason: unknown): void {
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private cleanupPending(pending: PendingWorkerRequest): void {
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort);
  }

  private detachWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    worker.removeEventListener('message', this.handleMessage);
    worker.removeEventListener('error', this.handleFailure);
    worker.removeEventListener('messageerror', this.handleFailure);
    worker.terminate();
    this.worker = undefined;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Background worker job cancelled', 'AbortError');
}
