const DEFAULT_NODE_TITLE = '未命名节点';

export function normalizeNodeTitle(title: string | undefined, fallback = DEFAULT_NODE_TITLE): string {
  return title?.trim() || fallback;
}

export function nodeTitleKey(title: string): string {
  return title.normalize('NFKC');
}

export function isNodeTitleTaken(
  title: string,
  existing: Iterable<{ id: string; title: string }>,
  excludedId?: string,
): boolean {
  const key = nodeTitleKey(title);
  for (const item of existing) {
    if (item.id !== excludedId && nodeTitleKey(item.title) === key) return true;
  }
  return false;
}

export function createUniqueNodeTitle(
  requestedTitle: string | undefined,
  existing: Iterable<{ id: string; title: string }>,
  reservedTitles: Iterable<string> = [],
  fallback = DEFAULT_NODE_TITLE,
): string {
  const requested = normalizeNodeTitle(requestedTitle, fallback);
  const used = new Set<string>();
  for (const item of existing) used.add(nodeTitleKey(item.title));
  for (const title of reservedTitles) used.add(nodeTitleKey(title));
  if (!used.has(nodeTitleKey(requested))) return requested;

  const numbered = /^(.*?)(?:\s+(\d+))$/u.exec(requested);
  const base = numbered?.[1]?.trim() || requested;
  let sequence = Math.max(2, Number(numbered?.[2] ?? 1) + 1);
  while (used.has(nodeTitleKey(`${base} ${sequence}`))) sequence += 1;
  return `${base} ${sequence}`;
}

export interface NodeTitleAllocator {
  reserve(title: string): void;
  allocate(requestedTitle: string | undefined, fallback?: string): string;
}

export function createNodeTitleAllocator(existingTitles: Iterable<string>): NodeTitleAllocator {
  const used = new Set<string>();
  const nextSequences = new Map<string, number>();
  const reserve = (title: string) => {
    used.add(nodeTitleKey(title));
  };
  for (const title of existingTitles) reserve(title);
  return {
    reserve,
    allocate(requestedTitle, fallback = DEFAULT_NODE_TITLE) {
      const requested = normalizeNodeTitle(requestedTitle, fallback);
      if (!used.has(nodeTitleKey(requested))) {
        reserve(requested);
        return requested;
      }
      const numbered = /^(.*?)(?:\s+(\d+))$/u.exec(requested);
      const base = numbered?.[1]?.trim() || requested;
      const minimum = Math.max(2, Number(numbered?.[2] ?? 1) + 1);
      let sequence = Math.max(minimum, nextSequences.get(base) ?? minimum);
      while (used.has(nodeTitleKey(`${base} ${sequence}`))) sequence += 1;
      const resolved = `${base} ${sequence}`;
      nextSequences.set(base, sequence + 1);
      reserve(resolved);
      return resolved;
    },
  };
}
