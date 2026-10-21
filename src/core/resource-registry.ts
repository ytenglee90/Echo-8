export type ResourceKind =
  | 'command'
  | 'event'
  | 'query'
  | 'signal'
  | 'capability'
  | 'ui'
  | 'action'
  | 'shortcut'
  | 'task'
  | 'worker'
  | 'network'
  | 'timer'
  | 'listener'
  | 'file'
  | 'other';

interface ResourceRecord {
  id: number;
  kind: ResourceKind;
  dispose: () => void | Promise<void>;
}

export class ResourceRegistry {
  private nextId = 1;
  private readonly owners = new Map<string, Map<number, ResourceRecord>>();

  track(owner: string, kind: ResourceKind, dispose: () => void | Promise<void>): () => void {
    const resources = this.owners.get(owner) ?? new Map<number, ResourceRecord>();
    const record: ResourceRecord = { id: this.nextId++, kind, dispose };
    resources.set(record.id, record);
    this.owners.set(owner, resources);

    return () => {
      resources.delete(record.id);
      if (resources.size === 0) this.owners.delete(owner);
    };
  }

  count(owner?: string): number {
    if (owner) return this.owners.get(owner)?.size ?? 0;
    let total = 0;
    for (const resources of this.owners.values()) total += resources.size;
    return total;
  }

  summary(): Array<{ owner: string; total: number; kinds: Partial<Record<ResourceKind, number>> }> {
    return [...this.owners.entries()]
      .map(([owner, resources]) => {
        const kinds: Partial<Record<ResourceKind, number>> = {};
        for (const resource of resources.values()) kinds[resource.kind] = (kinds[resource.kind] ?? 0) + 1;
        return { owner, total: resources.size, kinds };
      })
      .sort((left, right) => left.owner.localeCompare(right.owner));
  }

  async releaseOwner(owner: string): Promise<void> {
    const resources = [...(this.owners.get(owner)?.values() ?? [])].reverse();
    this.owners.delete(owner);
    const errors: unknown[] = [];
    for (const resource of resources) {
      try {
        await resource.dispose();
      } catch (error) {
        errors.push({ kind: resource.kind, error });
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to release every resource owned by ${owner}`);
    }
  }
}
