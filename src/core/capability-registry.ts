import type { CapabilityProvider } from './contracts.ts';

interface RegisteredProvider extends CapabilityProvider {
  owner: string;
}

export class CapabilityRegistry {
  private readonly providers = new Map<string, RegisteredProvider[]>();
  private readonly listeners = new Set<() => void>();
  private readonly suspendedOwners = new Set<string>();
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private version = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion = (): number => this.version;

  register<TInput = unknown, TResult = unknown>(
    owner: string,
    provider: CapabilityProvider<TInput, TResult>,
  ): () => void {
    const list = this.providers.get(provider.key) ?? [];
    if (list.some((item) => item.owner === owner)) {
      throw new Error(`${owner} already provides ${provider.key}`);
    }
    const registered = { ...provider, owner } as RegisteredProvider;
    list.push(registered);
    list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.owner.localeCompare(b.owner));
    this.providers.set(provider.key, list);
    this.bump();
    return () => {
      const current = this.providers.get(provider.key) ?? [];
      const next = current.filter((item) => item !== registered);
      if (next.length > 0) this.providers.set(provider.key, next);
      else this.providers.delete(provider.key);
      this.bump();
    };
  }

  has(key: string): boolean {
    return this.availableProviders(key).length > 0;
  }

  async request<TResult>(key: string, input?: unknown, signal?: AbortSignal): Promise<TResult> {
    if (signal?.aborted) throw new DOMException('Capability request aborted', 'AbortError');
    const provider = this.availableProviders(key)[0];
    if (!provider) throw new Error(`Capability unavailable: ${key}`);
    return (await this.invoke(provider, input, signal)) as TResult;
  }

  requestSync<TResult>(key: string, input?: unknown): TResult {
    const provider = this.availableProviders(key)[0];
    if (!provider) throw new Error(`Capability unavailable: ${key}`);
    const result = provider.invoke(input);
    if (result instanceof Promise || (result && typeof (result as PromiseLike<unknown>).then === 'function')) {
      throw new Error(`Capability ${key} is asynchronous and cannot run in an interaction frame`);
    }
    return result as TResult;
  }

  async requestAll<TResult>(key: string, input?: unknown, signal?: AbortSignal): Promise<TResult[]> {
    if (signal?.aborted) throw new DOMException('Capability request aborted', 'AbortError');
    const providers = this.availableProviders(key);
    return Promise.all(
      providers.map(async (provider) => {
        if (signal?.aborted) throw new DOMException('Capability request aborted', 'AbortError');
        return (await this.invoke(provider, input, signal)) as TResult;
      }),
    );
  }

  resumeOwner(owner: string): void {
    if (!this.suspendedOwners.delete(owner)) return;
    this.bump();
  }

  /** Reject new calls, abort cooperative calls, then wait until every provider invocation settles. */
  async suspendOwner(owner: string): Promise<void> {
    const changed = !this.suspendedOwners.has(owner);
    this.suspendedOwners.add(owner);
    if (changed) this.bump();
    for (const controller of this.controllers.get(owner) ?? []) {
      controller.abort(new DOMException(`Capability provider ${owner} is stopping`, 'AbortError'));
    }
    const pending = [...this.inFlight.get(owner) ?? []];
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  list(): Array<{ key: string; providers: string[] }> {
    return [...this.providers.entries()].map(([key, providers]) => ({
      key,
      providers: providers.filter((provider) => !this.suspendedOwners.has(provider.owner))
        .map((provider) => provider.owner),
    })).filter((item) => item.providers.length > 0);
  }

  private availableProviders(key: string): RegisteredProvider[] {
    return (this.providers.get(key) ?? []).filter((provider) => !this.suspendedOwners.has(provider.owner));
  }

  private invoke(provider: RegisteredProvider, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.suspendedOwners.has(provider.owner)) {
      return Promise.reject(new Error(`Capability unavailable: ${provider.key}`));
    }
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', relayAbort, { once: true });
    if (signal?.aborted) relayAbort();
    const controllers = this.controllers.get(provider.owner) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(provider.owner, controllers);

    let operation: Promise<unknown>;
    try {
      operation = Promise.resolve(provider.invoke(input, controller.signal));
    } catch (error) {
      operation = Promise.reject(error);
    }
    const tracked = operation.finally(() => {
      signal?.removeEventListener('abort', relayAbort);
      controllers.delete(controller);
      if (controllers.size === 0) this.controllers.delete(provider.owner);
      const ownerCalls = this.inFlight.get(provider.owner);
      ownerCalls?.delete(tracked);
      if (ownerCalls?.size === 0) this.inFlight.delete(provider.owner);
    });
    const ownerCalls = this.inFlight.get(provider.owner) ?? new Set<Promise<unknown>>();
    ownerCalls.add(tracked);
    this.inFlight.set(provider.owner, ownerCalls);
    return tracked;
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
