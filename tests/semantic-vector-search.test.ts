import assert from 'node:assert/strict';
import test from 'node:test';

import type { AIContextSource } from '../src/protocols/ai.ts';
import {
  searchSemanticVectorCache,
  semanticVectorCacheStats,
  type SemanticVectorChunk,
} from '../src/services/semantic-vector-search.ts';

const source = (sourceId: string, title: string): AIContextSource => ({
  sourceId,
  provider: 'test',
  kind: 'text',
  title,
  revision: 1,
  length: 10,
});

const chunk = (
  sourceValue: AIContextSource,
  vector: number[],
  start: number,
  coverage: SemanticVectorChunk['coverage'] = 'full',
): SemanticVectorChunk => ({
  source: sourceValue,
  start,
  length: 4,
  preview: `${sourceValue.title}-${start}`,
  vector: Float32Array.from(vector),
  coverage,
});

test('semantic vector search keeps one best block per source with deterministic filtering and ranking', () => {
  const first = source('first', '乙');
  const second = source('second', '甲');
  const cache = new Map<string, SemanticVectorChunk[]>([
    [first.sourceId, [chunk(first, [0.2, 0], 0), chunk(first, [0.9, 0], 4)]],
    [second.sourceId, [chunk(second, [0.9, 0], 0, 'sampled')]],
  ]);

  const result = searchSemanticVectorCache(
    cache.values(),
    Float32Array.from([1, 0]),
    { terms: ['查询'], maxResults: 2 },
    'test-semantic',
  );

  assert.equal(result.provider, 'test-semantic');
  assert.equal(result.scanned, 3);
  assert.deepEqual(result.hits.map((hit) => [hit.source.sourceId, hit.start]), [
    ['second', 0],
    ['first', 4],
  ]);

  const filtered = searchSemanticVectorCache(
    cache.values(),
    Float32Array.from([1, 0]),
    { terms: ['查询'], maxResults: 2, sourceIds: ['first'] },
    'test-semantic',
  );
  assert.deepEqual(filtered.hits.map((hit) => hit.source.sourceId), ['first']);
  assert.deepEqual(semanticVectorCacheStats(cache.values()), { chunks: 3, partialSources: 1 });
});
