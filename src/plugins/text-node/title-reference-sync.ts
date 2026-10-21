import type { SearchHit } from '../../protocols/search.ts';
import { contentChunkLengths, type TextContentRecord } from './content-storage.ts';
import { yieldToMainThread, type TextNodeRecord } from './operations.ts';

export const MAX_TITLE_REFERENCE_REPLACEMENTS = 5_000;

export function isReferenceTitle(title: string): boolean {
  const trimmed = title.trim();
  return [...trimmed].length >= 2 && trimmed.length <= 160;
}

export async function findLinkedTitleHits({
  node,
  content,
  targetNodeId,
  targetTitle,
  catalogTitles,
  readChunk,
  limit,
}: {
  node: TextNodeRecord;
  content: TextContentRecord;
  targetNodeId: string;
  targetTitle: string;
  catalogTitles: readonly string[];
  readChunk: (index: number) => string;
  limit: number;
}): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  if (node.id === targetNodeId || !isReferenceTitle(targetTitle) || limit <= 0) {
    return { hits: [], truncated: false };
  }
  const longerTitles = catalogTitles
    .filter((title) => title.length > targetTitle.length && title.startsWith(targetTitle))
    .sort((left, right) => right.length - left.length);
  const maximumMatchLength = Math.max(targetTitle.length, longerTitles[0]?.length ?? 0);
  const carrySize = Math.max(0, targetTitle.length - 1);
  const lengths = contentChunkLengths(content);
  const chunks = new Map<number, string>();
  const getChunk = (index: number) => {
    const cached = chunks.get(index);
    if (cached !== undefined) return cached;
    const value = readChunk(index);
    chunks.set(index, value);
    return value;
  };
  const readAhead = (startIndex: number) => {
    let value = '';
    for (let index = startIndex; index < lengths.length && value.length < maximumMatchLength; index += 1) {
      value += getChunk(index);
    }
    return value.slice(0, maximumMatchLength);
  };

  const hits: SearchHit[] = [];
  let carry = '';
  let offset = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const chunk = getChunk(index);
    const window = carry + chunk + readAhead(index + 1);
    const base = offset - carry.length;
    let searchFrom = 0;
    while (searchFrom <= window.length - targetTitle.length) {
      const localStart = window.indexOf(targetTitle, searchFrom);
      if (localStart < 0) break;
      const start = base + localStart;
      const end = start + targetTitle.length;
      const longerMatch = longerTitles.find((title) => window.startsWith(title, localStart));
      const consumedLength = longerMatch?.length ?? targetTitle.length;
      searchFrom = localStart + Math.max(1, consumedLength);
      if (longerMatch || end <= offset || end > offset + chunk.length) continue;
      hits.push({
        nodeId: node.id,
        title: node.title,
        start,
        length: targetTitle.length,
        matchedText: targetTitle,
        preview: window.slice(
          Math.max(0, localStart - 36),
          Math.min(window.length, localStart + targetTitle.length + 36),
        ),
        revision: content.revision,
      });
      if (hits.length >= limit) return { hits, truncated: true };
    }
    carry = (carry + chunk).slice(-carrySize);
    offset += chunk.length;
    if (index % 8 === 7) await yieldToMainThread();
  }
  return { hits, truncated: false };
}
