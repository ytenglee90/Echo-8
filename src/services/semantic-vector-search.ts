import type {
  AIContextSearchContribution,
  AIContextSearchRequest,
  AIContextSource,
} from '../protocols/ai.ts';

export interface SemanticVectorChunk {
  source: AIContextSource;
  start: number;
  length: number;
  preview: string;
  vector: Float32Array;
  coverage: 'full' | 'sampled';
}

/**
 * Applies the provider-neutral part of semantic retrieval: one best block per
 * source, deterministic ranking, optional source filtering, and bounded output.
 */
export function searchSemanticVectorCache(
  chunksBySource: Iterable<readonly SemanticVectorChunk[]>,
  queryVector: Float32Array,
  input: AIContextSearchRequest,
  provider: string,
): AIContextSearchContribution {
  const filter = input.sourceIds?.length ? new Set(input.sourceIds) : undefined;
  const hits: AIContextSearchContribution['hits'] = [];
  let scanned = 0;
  for (const chunks of chunksBySource) {
    if (!chunks.length || (filter && !filter.has(chunks[0].source.sourceId))) continue;
    let best: SemanticVectorChunk | undefined;
    let bestScore = -Infinity;
    for (const chunk of chunks) {
      scanned += 1;
      if (chunk.vector.length !== queryVector.length) continue;
      const score = dotProduct(queryVector, chunk.vector);
      if (score > bestScore) {
        best = chunk;
        bestScore = score;
      }
    }
    if (best) {
      hits.push({
        source: { ...best.source },
        start: best.start,
        length: best.length,
        preview: best.preview,
        score: bestScore,
        retrievalMethod: 'semantic',
      });
    }
  }
  hits.sort((left, right) =>
    right.score - left.score || left.source.title.localeCompare(right.source.title, 'zh-CN'));
  return { provider, hits: hits.slice(0, input.maxResults), scanned };
}

export function semanticVectorCacheStats(
  chunksBySource: Iterable<readonly SemanticVectorChunk[]>,
): { chunks: number; partialSources: number } {
  let chunks = 0;
  let partialSources = 0;
  for (const sourceChunks of chunksBySource) {
    chunks += sourceChunks.length;
    if (sourceChunks[0]?.coverage === 'sampled') partialSources += 1;
  }
  return { chunks, partialSources };
}

function dotProduct(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}
