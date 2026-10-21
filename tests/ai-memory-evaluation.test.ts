import assert from 'node:assert/strict';
import test from 'node:test';

import type { AIMemoryClaimRecord, AIMemoryIndexRecord } from '../src/protocols/ai.ts';
import {
  detectMemoryConflicts,
  matchConversationMemories,
} from '../src/plugins/ai-assistant/memory-retrieval.ts';
import {
  MEMORY_CONFLICT_EVALUATION_CASES,
  MEMORY_RETRIEVAL_EVALUATION_CASES,
} from './fixtures/ai-memory-evaluation.ts';

test('AI memory retrieval evaluation set meets exact recall and leakage gates', () => {
  let expected = 0;
  let recalled = 0;
  let forbidden = 0;
  for (const fixture of MEMORY_RETRIEVAL_EVALUATION_CASES) {
    const memories = Object.fromEntries(fixture.memories.map((item, index) => {
      const record = memory(item.sourceId, index + 1, {
        summary: item.summary,
        keywords: item.keywords,
        scope: item.scope,
      });
      return [record.sourceId, record];
    }));
    const result = matchConversationMemories(
      fixture.prompt,
      memories,
      new Set(fixture.forcedSourceIds ?? []),
    );
    const actual = new Set(result.matches.map((match) => match.index.sourceId));
    for (const sourceId of fixture.expectedSourceIds) {
      expected += 1;
      if (actual.has(sourceId)) recalled += 1;
    }
    for (const sourceId of fixture.forbiddenSourceIds ?? []) {
      if (actual.has(sourceId)) forbidden += 1;
    }
  }
  assert.equal(recalled / expected, 1, 'memory retrieval recall fell below the release gate');
  assert.equal(forbidden, 0, 'an explicitly forbidden unrelated memory leaked into results');
});

test('AI memory version and scope evaluation set resolves every declared case', () => {
  for (const fixture of MEMORY_CONFLICT_EVALUATION_CASES) {
    const memories = fixture.memories.map((item) => memory(item.sourceId, item.createdAt, {
      claims: item.claims.map((claim, sequence) => ({
        id: `${item.sourceId}:claim:${sequence}`,
        kind: claim.kind,
        status: claim.kind === 'deprecate' ? 'deprecated' : claim.kind === 'branch' ? 'branch' : 'current',
        subject: claim.subject,
        value: claim.value,
        previousValue: claim.previousValue,
        scope: claim.scope,
        start: sequence * 20,
        length: 10,
        authority: 'user-explicit',
        sequence,
      } satisfies AIMemoryClaimRecord)),
    }));
    const conflicts = detectMemoryConflicts(memories, fixture.prompt);
    if (fixture.expected === 'none') {
      assert.equal(conflicts.length, 0, fixture.name);
      continue;
    }
    assert.equal(conflicts.length, 1, fixture.name);
    assert.equal(
      conflicts[0]?.resolution,
      fixture.expected === 'resolved' ? 'resolved-by-explicit-modification' : 'unresolved',
      fixture.name,
    );
    if (fixture.currentValue) assert.equal(conflicts[0]?.currentValue, fixture.currentValue, fixture.name);
  }
});

function memory(
  sourceId: string,
  createdAt: number,
  overrides: Partial<AIMemoryIndexRecord> = {},
): AIMemoryIndexRecord {
  return {
    sessionId: `session:${sourceId}`,
    sourceId,
    title: sourceId,
    schemaVersion: 2,
    sourceRevision: 1,
    sourceLength: 100,
    summary: '',
    keywords: [],
    anchors: [],
    createdAt,
    ...overrides,
  };
}
