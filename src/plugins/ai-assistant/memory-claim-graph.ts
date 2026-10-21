import type { AIMemoryClaimRecord, AIMemoryIndexRecord } from '../../protocols/ai.ts';
import { memoryTermOccurrences } from './memory-terms.ts';

/**
 * This is a deliberately small, derived claim graph rather than a durable
 * GraphRAG database. It is rebuilt for a retrieval request from user-explicit
 * claims only. Original memory text remains the sole evidence sent to a model.
 */
const MAX_RELATION_INDEXES = 240;
const MAX_RELATION_CLAIMS = 600;
const MAX_RELATION_SEEDS = 12;
const MAX_RELATION_EVIDENCE = 24;
const MAX_RELATION_EVIDENCE_PER_SOURCE = 4;

export type MemoryClaimRelationKind = 'same-scope' | 'same-subject' | 'same-value';

export interface MemoryClaimRelationEvidence {
  kind: MemoryClaimRelationKind;
  seedClaimId: string;
  targetClaimId: string;
  sourceId: string;
  start: number;
  branchIndex: number;
}

export interface MemoryClaimRelationMatch {
  score: number;
  anchorStarts: number[];
  coveredBranches: number[];
  evidence: MemoryClaimRelationEvidence[];
}

export interface MemoryClaimRelationExpansion {
  matches: ReadonlyMap<string, MemoryClaimRelationMatch>;
  relatedSources: number;
  evidenceCount: number;
}

interface ClaimReference {
  index: AIMemoryIndexRecord;
  claim: AIMemoryClaimRecord;
  key: string;
  scopeKey?: string;
  subjectKey: string;
  valueKey?: string;
  terms: Set<string>;
}

interface ClaimSeed {
  reference: ClaimReference;
  branchIndex: number;
  matchedTerms: number;
}

/**
 * Finds one-hop, explainable associations from claims that already match the
 * user's question. A relation can only be shared explicit scope, exact subject,
 * or exact current value; it never creates a new factual assertion.
 */
export function expandMemoryClaimRelations(
  branches: readonly string[][],
  memoryIndexes: readonly AIMemoryIndexRecord[],
): MemoryClaimRelationExpansion {
  if (branches.length === 0) return emptyExpansion();
  const references = buildClaimReferences(memoryIndexes);
  if (references.length === 0) return emptyExpansion();

  const byScope = new Map<string, ClaimReference[]>();
  const bySubject = new Map<string, ClaimReference[]>();
  const byValue = new Map<string, ClaimReference[]>();
  for (const reference of references) {
    if (reference.scopeKey) addToGroup(byScope, reference.scopeKey, reference);
    addToGroup(bySubject, reference.subjectKey, reference);
    if (reference.valueKey) addToGroup(byValue, reference.valueKey, reference);
  }

  const seeds: ClaimSeed[] = [];
  for (let branchIndex = 0; branchIndex < branches.length; branchIndex += 1) {
    for (const reference of references) {
      const matchedTerms = branches[branchIndex].filter((term) => reference.terms.has(term)).length;
      if (matchedTerms > 0) seeds.push({ reference, branchIndex, matchedTerms });
    }
  }
  const limitedSeeds = seeds
    .sort((left, right) => right.matchedTerms - left.matchedTerms ||
      right.reference.index.createdAt - left.reference.index.createdAt ||
      left.reference.claim.start - right.reference.claim.start)
    .slice(0, MAX_RELATION_SEEDS);
  if (limitedSeeds.length === 0) return emptyExpansion();

  const matches = new Map<string, MemoryClaimRelationMatch>();
  let evidenceCount = 0;
  outer: for (const seed of limitedSeeds) {
    const related = relatedClaims(seed.reference, byScope, bySubject, byValue);
    for (const { reference: target, kind } of related) {
      if (evidenceCount >= MAX_RELATION_EVIDENCE) break outer;
      const existing = matches.get(target.index.sourceId) ?? {
        score: 0,
        anchorStarts: [],
        coveredBranches: [],
        evidence: [],
      };
      if (existing.evidence.length >= MAX_RELATION_EVIDENCE_PER_SOURCE) continue;
      const duplicate = existing.evidence.some((item) =>
        item.seedClaimId === seed.reference.claim.id &&
        item.targetClaimId === target.claim.id &&
        item.branchIndex === seed.branchIndex);
      if (duplicate) continue;

      existing.score = Math.min(18, existing.score + relationWeight(kind));
      if (!existing.coveredBranches.includes(seed.branchIndex)) {
        existing.coveredBranches.push(seed.branchIndex);
      }
      if (existing.anchorStarts.length < 4 &&
        existing.anchorStarts.every((start) => Math.abs(start - target.claim.start) > 320)) {
        existing.anchorStarts.push(target.claim.start);
      }
      existing.evidence.push({
        kind,
        seedClaimId: seed.reference.claim.id,
        targetClaimId: target.claim.id,
        sourceId: target.index.sourceId,
        start: target.claim.start,
        branchIndex: seed.branchIndex,
      });
      matches.set(target.index.sourceId, existing);
      evidenceCount += 1;
    }
  }
  return { matches, relatedSources: matches.size, evidenceCount };
}

function buildClaimReferences(memoryIndexes: readonly AIMemoryIndexRecord[]): ClaimReference[] {
  const references: ClaimReference[] = [];
  const indexes = memoryIndexes
    .filter((index) => index.enabled !== false)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_RELATION_INDEXES);
  for (const index of indexes) {
    for (const claim of index.claims ?? []) {
      if (!isEligibleClaim(claim) || references.length >= MAX_RELATION_CLAIMS) continue;
      const subjectKey = normalizeRelationText(claim.subject);
      if (!subjectKey) continue;
      const valueKey = normalizeRelationText(claim.value ?? '');
      const scopeKey = normalizeRelationText(claim.scope ?? index.scope ?? '');
      const searchable = [claim.subject, claim.value, claim.scope ?? index.scope]
        .filter((value): value is string => Boolean(value)).join(' ');
      references.push({
        index,
        claim,
        key: `${index.sourceId}\u0000${claim.id}`,
        ...(scopeKey ? { scopeKey } : {}),
        subjectKey,
        ...(valueKey.length >= 2 ? { valueKey } : {}),
        terms: new Set(memoryTermOccurrences(searchable).map((item) => item.term)),
      });
    }
  }
  return references;
}

function isEligibleClaim(claim: AIMemoryClaimRecord): boolean {
  return claim.authority === 'user-explicit' &&
    claim.status !== 'candidate' &&
    claim.status !== 'deprecated' &&
    claim.kind !== 'deprecate';
}

function relatedClaims(
  seed: ClaimReference,
  byScope: ReadonlyMap<string, ClaimReference[]>,
  bySubject: ReadonlyMap<string, ClaimReference[]>,
  byValue: ReadonlyMap<string, ClaimReference[]>,
): Array<{ reference: ClaimReference; kind: MemoryClaimRelationKind }> {
  const related = new Map<string, { reference: ClaimReference; kind: MemoryClaimRelationKind }>();
  const add = (items: readonly ClaimReference[] | undefined, kind: MemoryClaimRelationKind) => {
    for (const target of items ?? []) {
      if (target.key === seed.key) continue;
      // An explicit applicability scope is a safety boundary. A subject or
      // value that happens to repeat in a different explicit scope is not a
      // graph edge (for example, test versus production configuration).
      if (kind !== 'same-scope' && !scopesAreCompatible(seed, target)) continue;
      const current = related.get(target.key);
      if (!current || relationWeight(kind) > relationWeight(current.kind)) {
        related.set(target.key, { reference: target, kind });
      }
    }
  };
  if (seed.scopeKey) add(byScope.get(seed.scopeKey), 'same-scope');
  add(bySubject.get(seed.subjectKey), 'same-subject');
  if (seed.valueKey) add(byValue.get(seed.valueKey), 'same-value');
  return [...related.values()].sort((left, right) =>
    relationWeight(right.kind) - relationWeight(left.kind) ||
    right.reference.index.createdAt - left.reference.index.createdAt ||
    left.reference.claim.start - right.reference.claim.start);
}

function scopesAreCompatible(left: ClaimReference, right: ClaimReference): boolean {
  return !left.scopeKey || !right.scopeKey || left.scopeKey === right.scopeKey;
}

function relationWeight(kind: MemoryClaimRelationKind): number {
  if (kind === 'same-subject') return 7;
  if (kind === 'same-value') return 6;
  return 5;
}

function addToGroup(group: Map<string, ClaimReference[]>, key: string, reference: ClaimReference): void {
  const items = group.get(key) ?? [];
  items.push(reference);
  group.set(key, items);
}

function normalizeRelationText(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function emptyExpansion(): MemoryClaimRelationExpansion {
  return { matches: new Map(), relatedSources: 0, evidenceCount: 0 };
}
