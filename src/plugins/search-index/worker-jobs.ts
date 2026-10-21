export const SEARCH_INDEX_BLOOM_JOB = 'search-index.bloom@1';
export const SEARCH_INDEX_SIGNATURE_JOB = 'search-index.signature@1';
export const SEARCH_INDEX_POSTINGS_JOB = 'search-index.postings@1';
export const SEARCH_INDEX_ANALYZE_JOB = 'search-index.analyze@1';
export const SEARCH_INDEX_RANK_JOB = 'search-index.rank@1';

export const SEARCH_INDEX_BLOOM_WORDS = 128;
export const SEARCH_INDEX_MAX_POSTING_TERMS_PER_CHUNK = 4_096;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface SearchIndexBloomRequest {
  text: string;
}

export interface SearchIndexSignature {
  bloom: Uint32Array;
  /** Sorted term fingerprints. Empty when this chunk deliberately falls back to Bloom scanning. */
  termHashes: Uint32Array;
  overflow: boolean;
}

export interface SearchIndexPostingsRequest {
  chunks: Array<{
    key: number;
    termHashes: Uint32Array;
  }>;
}

export interface SearchIndexCompressedPostings {
  /** Sorted term fingerprints. */
  termHashes: Uint32Array;
  /** Byte offsets into postings; one sentinel offset follows the final term. */
  offsets: Uint32Array;
  /** Delta-varint encoded, sorted chunk keys. */
  postings: Uint8Array;
}

export interface SearchIndexAnalyzeRequest {
  terms: string[];
  phrase: string;
  chunks: Array<{
    key: number;
    title: string;
    text: string;
  }>;
}

export interface SearchIndexAnalyzedChunk {
  key: number;
  textLength: number;
  termFrequency: Array<[string, number]>;
  firstMatch: number;
  phraseMatch: boolean;
  previewStart: number;
  preview: string;
}

export interface SearchIndexRankRequest {
  totalChunks: number;
  terms: string[];
  candidates: Array<{
    key: number;
    title: string;
    textLength: number;
    termFrequency: Array<[string, number]>;
    phraseMatch: boolean;
  }>;
}

export interface SearchIndexRankedChunk {
  key: number;
  score: number;
}

export function buildSearchBloom(text: string): Uint32Array {
  return buildSearchSignature(text).bloom;
}

export function buildSearchSignature(text: string): SearchIndexSignature {
  const bloom = new Uint32Array(SEARCH_INDEX_BLOOM_WORDS);
  const terms = indexTerms(text);
  for (const term of terms) addTerm(bloom, term);
  const overflow = terms.size > SEARCH_INDEX_MAX_POSTING_TERMS_PER_CHUNK;
  const hashes = overflow
    ? new Uint32Array()
    : Uint32Array.from([...new Set([...terms].map(termFingerprint))].sort((left, right) => left - right));
  return { bloom, termHashes: hashes, overflow };
}

export function buildCompressedSearchPostings(
  input: SearchIndexPostingsRequest,
): SearchIndexCompressedPostings {
  const postingsByTerm = new Map<number, number[]>();
  for (const chunk of input.chunks) {
    let previous = -1;
    for (const hash of chunk.termHashes) {
      if (hash === previous) continue;
      previous = hash;
      const postings = postingsByTerm.get(hash);
      if (postings) postings.push(chunk.key);
      else postingsByTerm.set(hash, [chunk.key]);
    }
  }

  const termHashes = Uint32Array.from([...postingsByTerm.keys()].sort((left, right) => left - right));
  const offsets = new Uint32Array(termHashes.length + 1);
  const bytes: number[] = [];
  for (let termIndex = 0; termIndex < termHashes.length; termIndex += 1) {
    offsets[termIndex] = bytes.length;
    let previous = 0;
    const keys = [...new Set(postingsByTerm.get(termHashes[termIndex]) ?? [])]
      .sort((left, right) => left - right);
    for (const key of keys) {
      encodeUnsignedVarint(key - previous, bytes);
      previous = key;
    }
  }
  offsets[termHashes.length] = bytes.length;
  return { termHashes, offsets, postings: Uint8Array.from(bytes) };
}

export function findSearchPostingKeys(
  index: SearchIndexCompressedPostings,
  term: string,
): Uint32Array | undefined {
  const hashes = searchTermFingerprints(term);
  if (hashes.length === 0) return undefined;
  let intersection: Uint32Array | undefined;
  for (const hash of hashes) {
    const termIndex = binarySearch(index.termHashes, hash);
    if (termIndex < 0) return new Uint32Array();
    const posting = decodePostingList(index.postings, index.offsets[termIndex], index.offsets[termIndex + 1]);
    intersection = intersection ? intersectSorted(intersection, posting) : posting;
    if (intersection.length === 0) return intersection;
  }
  return intersection ?? new Uint32Array();
}

export function analyzeSearchChunks(input: SearchIndexAnalyzeRequest): SearchIndexAnalyzedChunk[] {
  return input.chunks.flatMap((chunk) => {
    const searchable = chunk.text.toLocaleLowerCase('zh-CN');
    const searchableTitle = chunk.title.toLocaleLowerCase('zh-CN');
    const termFrequency = new Map<string, number>();
    let firstMatch = -1;
    for (const term of input.terms) {
      let cursor = 0;
      let frequency = 0;
      while (frequency < 64) {
        const found = searchable.indexOf(term, cursor);
        if (found < 0) break;
        if (firstMatch < 0 || found < firstMatch) firstMatch = found;
        frequency += 1;
        cursor = found + Math.max(1, term.length);
      }
      if (frequency > 0 || searchableTitle.includes(term)) {
        termFrequency.set(term, Math.max(1, frequency));
      }
    }
    if (termFrequency.size === 0) return [];
    const localPreviewStart = Math.max(0, firstMatch - 120);
    return [{
      key: chunk.key,
      textLength: chunk.text.length,
      termFrequency: [...termFrequency],
      firstMatch,
      phraseMatch: input.phrase.length >= 2 && searchable.includes(input.phrase),
      previewStart: localPreviewStart,
      preview: chunk.text.slice(localPreviewStart, localPreviewStart + 420).replace(/\s+/gu, ' ').trim(),
    }];
  });
}

export function rankSearchChunks(input: SearchIndexRankRequest): SearchIndexRankedChunk[] {
  const frequencies = input.candidates.map((candidate) => new Map(candidate.termFrequency));
  const documentFrequency = new Map<string, number>();
  for (const term of input.terms) {
    documentFrequency.set(term, frequencies.filter((frequency) => frequency.has(term)).length);
  }
  const averageLength = input.candidates.length > 0
    ? input.candidates.reduce((total, candidate) => total + candidate.textLength, 0) / input.candidates.length
    : 1;
  return input.candidates.map((candidate, index) => {
    const title = candidate.title.toLocaleLowerCase('zh-CN');
    const termFrequency = frequencies[index];
    let score = 0;
    for (const [term, frequency] of termFrequency) {
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (Math.max(1, input.totalChunks) - df + 0.5) / (df + 0.5));
      const normalized = frequency + BM25_K1 * (
        1 - BM25_B + BM25_B * candidate.textLength / Math.max(1, averageLength)
      );
      score += idf * frequency * (BM25_K1 + 1) / normalized;
      if (title.includes(term)) score += idf * 4;
    }
    if (candidate.phraseMatch) score += 8;
    score += termFrequency.size * 0.75;
    return { key: candidate.key, score };
  });
}

export function mightContainSearchTerm(bloom: Uint32Array, term: string): boolean {
  const grams = indexTerms(term);
  return [...grams].every((gram) => hasTerm(bloom, gram));
}

function indexTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const normalized = text.toLocaleLowerCase('zh-CN');
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (token.length < 2) continue;
    if (/^[a-z0-9]+$/u.test(token)) {
      terms.add(token);
      continue;
    }
    for (let size = 2; size <= Math.min(3, token.length); size += 1) {
      for (let index = 0; index <= token.length - size; index += 1) terms.add(token.slice(index, index + size));
    }
  }
  return terms;
}

function searchTermFingerprints(text: string): Uint32Array {
  return Uint32Array.from(
    [...new Set([...indexTerms(text)].map(termFingerprint))].sort((left, right) => left - right),
  );
}

function termFingerprint(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return hash;
}

function encodeUnsignedVarint(value: number, output: number[]): void {
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    output.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  output.push(remaining);
}

function decodePostingList(bytes: Uint8Array, start: number, end: number): Uint32Array {
  const values: number[] = [];
  let cursor = start;
  let previous = 0;
  while (cursor < end) {
    let value = 0;
    let shift = 0;
    while (cursor < end) {
      const byte = bytes[cursor];
      cursor += 1;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    previous += value >>> 0;
    values.push(previous);
  }
  return Uint32Array.from(values);
}

function binarySearch(values: Uint32Array, target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = values[middle];
    if (value === target) return middle;
    if (value < target) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

function intersectSorted(left: Uint32Array, right: Uint32Array): Uint32Array {
  const result: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (leftValue === rightValue) {
      result.push(leftValue);
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftValue < rightValue) leftIndex += 1;
    else rightIndex += 1;
  }
  return Uint32Array.from(result);
}

function addTerm(bloom: Uint32Array, term: string): void {
  for (const hash of hashes(term)) bloom[(hash >>> 5) % bloom.length] |= 1 << (hash & 31);
}

function hasTerm(bloom: Uint32Array, term: string): boolean {
  return hashes(term).every((hash) => (bloom[(hash >>> 5) % bloom.length] & (1 << (hash & 31))) !== 0);
}

function hashes(value: string): number[] {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = (Math.imul(second, 33) ^ code) >>> 0;
  }
  return [first, second, (first + Math.imul(second, 0x9e3779b1)) >>> 0];
}
