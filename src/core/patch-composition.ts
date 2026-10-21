import type { PatchOperation } from './contracts.ts';

export interface PatchComposition {
  forward: PatchOperation[];
  inverse: PatchOperation[];
}

/**
 * Composes two adjacent, already-valid patch pairs into one state transition.
 *
 * Patches address independent store records. For a record touched more than
 * once, redo only needs the final write while undo must retain the value from
 * before the first write. Records created and removed inside the merged
 * session disappear from both directions entirely.
 */
export function composePatchPairs(
  previousForward: readonly PatchOperation[],
  previousInverse: readonly PatchOperation[],
  nextForward: readonly PatchOperation[],
  nextInverse: readonly PatchOperation[],
): PatchComposition {
  const previousTargets = new Set(previousForward.map(patchTarget));
  const forward = lastPatchPerTarget([...previousForward, ...nextForward]);
  const inverse = lastPatchPerTarget([
    ...nextInverse.filter((patch) => !previousTargets.has(patchTarget(patch))),
    ...previousInverse,
  ]);
  const inverseByTarget = new Map(inverse.map((patch) => [patchTarget(patch), patch]));
  const noEffectTargets = new Set<string>();
  for (const patch of forward) {
    const initial = inverseByTarget.get(patchTarget(patch));
    if (initial?.op === 'delete' && patch.op === 'delete') {
      noEffectTargets.add(patchTarget(patch));
    }
  }
  return {
    forward: forward.filter((patch) => !noEffectTargets.has(patchTarget(patch))),
    inverse: inverse.filter((patch) => !noEffectTargets.has(patchTarget(patch))),
  };
}

export function canMergePatchEntries(
  previous: { mergeKey?: string; timestamp: number },
  next: { mergeKey?: string; mergeWindowMs?: number; timestamp: number },
): boolean {
  return Boolean(
    next.mergeKey &&
    previous.mergeKey === next.mergeKey &&
    next.timestamp >= previous.timestamp &&
    next.timestamp - previous.timestamp <= (next.mergeWindowMs ?? 1_200),
  );
}

function lastPatchPerTarget(patches: readonly PatchOperation[]): PatchOperation[] {
  const byTarget = new Map<string, PatchOperation>();
  for (const patch of patches) byTarget.set(patchTarget(patch), patch);
  return [...byTarget.values()];
}

function patchTarget(patch: PatchOperation): string {
  return `${patch.domain}\u0000${patch.namespace}\u0000${patch.key}`;
}
