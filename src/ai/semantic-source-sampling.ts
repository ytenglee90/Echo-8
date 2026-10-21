import type { PluginContext } from '../core/contracts.ts';
import type {
  AIContextCatalogContribution,
  AIContextReadContribution,
  AIContextSource,
} from '../protocols/ai.ts';
import {
  FULL_SEMANTIC_COVERAGE_LENGTH,
  MAX_SEMANTIC_BLOCKS_PER_SOURCE,
  SEMANTIC_BLOCK_LENGTH,
  partitionSemanticText,
  semanticBlockAround,
  stratifiedSemanticAnchors,
} from './semantic-blocks.ts';

const SOURCE_READ_WINDOW = 64 * 1024;
const LARGE_SOURCE_PROBE_MARGIN = 640;

export interface SemanticSourceSamples {
  source: AIContextSource;
  samples: Array<{ start: number; text: string; fingerprint: string }>;
  coverage: 'full' | 'sampled';
}

/**
 * Reads only sources that the content providers explicitly permit for automatic retrieval.
 * It is shared by local and remote semantic providers so their range, privacy and large-text
 * behavior cannot drift.
 */
export async function readSemanticCatalog(context: PluginContext, signal: AbortSignal): Promise<AIContextSource[]> {
  const contributions = await context.capabilities.requestAll<AIContextCatalogContribution>(
    'context.catalog@1', undefined, signal,
  );
  const sources = new Map<string, AIContextSource>();
  for (const source of contributions.flatMap((contribution) => contribution.sources)) {
    if (source.automaticRetrieval === false) continue;
    if (!sources.has(source.sourceId)) sources.set(source.sourceId, source);
  }
  return [...sources.values()];
}

export async function sampleSemanticSource(
  context: PluginContext,
  source: AIContextSource,
  signal: AbortSignal,
): Promise<SemanticSourceSamples> {
  if (source.length <= 0) {
    return {
      source,
      samples: [{ start: 0, text: source.title, fingerprint: semanticBlockFingerprint(source.title, source.title) }],
      coverage: 'full',
    };
  }
  if (source.length <= FULL_SEMANTIC_COVERAGE_LENGTH) {
    const text = await readBoundedSemanticSource(context, source, signal);
    const samples = partitionSemanticText(text).map((block) => ({
      ...block,
      fingerprint: semanticBlockFingerprint(source.title, block.text),
    }));
    if (samples.length === 0) {
      samples.push({ start: 0, text: source.title, fingerprint: semanticBlockFingerprint(source.title, source.title) });
    }
    return { source, samples, coverage: 'full' };
  }

  const samples: SemanticSourceSamples['samples'] = [];
  const seen = new Set<string>();
  for (const anchor of stratifiedSemanticAnchors(source.length)) {
    assertNotAborted(signal);
    const start = Math.max(0, anchor - Math.floor(SEMANTIC_BLOCK_LENGTH / 2) - LARGE_SOURCE_PROBE_MARGIN);
    const length = Math.min(source.length - start, SEMANTIC_BLOCK_LENGTH + LARGE_SOURCE_PROBE_MARGIN * 2);
    const probe = await readSemanticSource(context, source.sourceId, start, length, signal);
    const block = semanticBlockAround(probe, start, anchor);
    if (!block) continue;
    const key = `${block.start}:${block.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({ ...block, fingerprint: semanticBlockFingerprint(source.title, block.text) });
    if (samples.length >= MAX_SEMANTIC_BLOCKS_PER_SOURCE) break;
  }
  if (samples.length === 0) {
    samples.push({ start: 0, text: source.title, fingerprint: semanticBlockFingerprint(source.title, source.title) });
  }
  return { source, samples, coverage: 'sampled' };
}

export function semanticBlockFingerprint(title: string, text: string): string {
  const value = `${title}\n${text}`.slice(0, SEMANTIC_BLOCK_LENGTH + 240);
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = (Math.imul(second, 33) ^ code) >>> 0;
  }
  return `${value.length.toString(36)}:${first.toString(36)}:${second.toString(36)}`;
}

export function semanticPreview(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 420);
}

async function readBoundedSemanticSource(
  context: PluginContext,
  source: AIContextSource,
  signal: AbortSignal,
): Promise<string> {
  const parts: string[] = [];
  for (let start = 0; start < source.length; start += SOURCE_READ_WINDOW) {
    assertNotAborted(signal);
    parts.push(await readSemanticSource(
      context,
      source.sourceId,
      start,
      Math.min(SOURCE_READ_WINDOW, source.length - start),
      signal,
    ));
  }
  return parts.join('');
}

async function readSemanticSource(
  context: PluginContext,
  sourceId: string,
  start: number,
  length: number,
  signal: AbortSignal,
): Promise<string> {
  const contributions = await context.capabilities.requestAll<AIContextReadContribution>(
    'context.read@1', { sourceId, start, length }, signal,
  );
  return contributions.find((contribution) => contribution.handled)?.text ?? '';
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
