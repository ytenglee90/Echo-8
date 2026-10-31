import type { PluginContext } from '../../core/contracts.ts';
import type {
  AIContextCatalogContribution,
  AIContextReadContribution,
  AIContextReadRequest,
  AIContextSource,
  AIPreparedSource,
  AIProposalRecord,
} from '../../protocols/ai.ts';
import { assertNotAborted } from '../../services/async-control.ts';
import {
  emptyEvidenceBlock,
  enclosingChatExchange,
  enclosingChatTurn,
  enclosingCodeBlock,
  enclosingMarkdownList,
  enclosingMarkdownTable,
  enclosingParagraph,
  enclosingSentence,
  estimateAITokens,
  evidenceFromLocalRange,
  firstChatTurnAtOrAfter,
  fitRangeEndToTokenBudget,
  fitRangeStartToTokenBudget,
  lastBoundaryWithinBudget,
  rangeFitsBudget,
  tailBoundaryCandidates,
  type EvidenceBlock,
  type TextRange,
} from './evidence-boundaries.ts';
import {
  internalTranscriptSessionId,
  readInternalTranscript,
} from './transcript-storage.ts';

const COMPLETE_SOURCE_READ_CHUNK = 256 * 1024;

export async function readContextCatalog(context: PluginContext): Promise<AIContextSource[]> {
  const contributions = await context.capabilities.requestAll<AIContextCatalogContribution>('context.catalog@1');
  const sources = contributions.flatMap((contribution) => contribution.sources);
  const ids = new Set<string>();
  return sources.filter((source) => {
    if (ids.has(source.sourceId)) return false;
    ids.add(source.sourceId);
    return true;
  });
}

export async function readContextSource(
  context: PluginContext,
  request: AIContextReadRequest,
  signal?: AbortSignal,
): Promise<AIContextReadContribution> {
  const internalSessionId = internalTranscriptSessionId(request.sourceId);
  if (internalSessionId) return readInternalTranscript(context, internalSessionId, request, signal);
  const contributions = await context.capabilities.requestAll<AIContextReadContribution>(
    'context.read@1',
    request,
    signal,
  );
  const handled = contributions.find((contribution) => contribution.handled);
  if (!handled) throw new Error(`上下文来源当前不可读：${request.sourceId}`);
  if (!handled.source) throw new Error(`上下文来源已经不存在：${request.sourceId}`);
  return handled;
}

export async function readContextSourceRevision(
  context: PluginContext,
  sourceId: string,
): Promise<number> {
  const result = await readContextSource(context, { sourceId, start: 0, length: 0 });
  return result.source!.revision;
}

/**
 * Reserved for explicit export/import jobs. Reads bounded ranges with revision
 * checks; retrieval and ordinary prompting must use the evidence readers below.
 */
export async function readCompleteContextSourceText(
  context: PluginContext,
  sourceId: string,
  signal?: AbortSignal,
  expectedRevision?: number,
  report?: (progress: number) => void,
): Promise<string> {
  const metadata = await readContextSource(context, { sourceId, start: 0, length: 0 }, signal);
  const length = metadata.source?.length ?? 0;
  if (expectedRevision !== undefined && metadata.source?.revision !== expectedRevision) {
    throw new Error('读取原文期间内容版本已经变化');
  }
  if (length === 0) return '';
  const pieces: string[] = [];
  for (let start = 0; start < length; start += COMPLETE_SOURCE_READ_CHUNK) {
    assertNotAborted(signal);
    const part = await readContextSource(context, {
      sourceId,
      start,
      length: Math.min(COMPLETE_SOURCE_READ_CHUNK, length - start),
    }, signal);
    if (expectedRevision !== undefined && part.source?.revision !== expectedRevision) {
      throw new Error('读取原文期间内容版本已经变化');
    }
    pieces.push(part.text ?? '');
    report?.(Math.min(1, (start + (part.text?.length ?? 0)) / length));
  }
  if (expectedRevision !== undefined &&
    await readContextSourceRevision(context, sourceId) !== expectedRevision) {
    throw new Error('读取原文期间内容版本已经变化');
  }
  return pieces.join('');
}

export async function readContextSourceLength(
  context: PluginContext,
  sourceId: string,
): Promise<number> {
  const result = await readContextSource(context, { sourceId, start: 0, length: 0 });
  return result.source!.length;
}

export async function revalidatePreparedSources(
  context: PluginContext,
  sources: AIPreparedSource[],
  options?: {
    allowUnchangedRangeRevisionAdvanceFor?: ReadonlySet<string>;
  },
): Promise<void> {
  for (const source of sources) {
    const current = await readContextSource(context, {
      sourceId: source.sourceId,
      start: source.start,
      length: 0,
    });
    if (current.source?.revision === source.revision) continue;
    if (current.source && options?.allowUnchangedRangeRevisionAdvanceFor?.has(source.sourceId)) {
      const reread = await readContextSource(context, {
        sourceId: source.sourceId,
        start: source.start,
        length: source.length,
      });
      if (reread.source?.revision === current.source.revision && reread.text === source.text) {
        source.revision = current.source.revision;
        source.title = current.source.title;
        continue;
      }
    }
    throw new Error(`来源“${source.title}”已修改，请重新准备上下文`);
  }
}

export async function revalidateSourceRefs(
  context: PluginContext,
  refs: AIProposalRecord['sourceRefs'],
): Promise<void> {
  for (const source of refs) {
    const current = await readContextSource(context, {
      sourceId: source.sourceId,
      start: source.start,
      length: 0,
    });
    if (current.source?.revision !== source.revision) {
      throw new Error(`提案来源“${source.title}”已变化，请重新生成后再接受`);
    }
  }
}

export async function readHeadEvidenceBlock(
  context: PluginContext,
  source: AIContextSource,
  maxLength: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<EvidenceBlock> {
  if (maxLength <= 0 || source.length <= 0) return emptyEvidenceBlock();
  const probeLength = Math.min(source.length, maxLength + 640);
  const read = await readContextSource(
    context,
    { sourceId: source.sourceId, start: 0, length: probeLength },
    signal,
  );
  const text = read.text ?? '';
  if (!text) return emptyEvidenceBlock();
  if (source.length <= maxLength && text.length <= maxLength && estimateAITokens(text) <= maxTokens) {
    return evidenceFromLocalRange(0, text, { start: 0, end: text.length }, 'range', true);
  }
  const boundary = lastBoundaryWithinBudget(text, Math.min(maxLength, text.length), maxTokens);
  const end = boundary > 0
    ? boundary
    : fitRangeEndToTokenBudget(text, 0, Math.min(maxLength, text.length), maxTokens);
  return evidenceFromLocalRange(0, text, { start: 0, end }, 'paragraph', boundary > 0);
}

export async function readTailEvidenceBlock(
  context: PluginContext,
  source: AIContextSource,
  maxLength: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<EvidenceBlock> {
  if (maxLength <= 0 || source.length <= 0) return emptyEvidenceBlock();
  const probeStart = Math.max(0, source.length - maxLength - 800);
  const read = await readContextSource(context, {
    sourceId: source.sourceId,
    start: probeStart,
    length: source.length - probeStart,
  }, signal);
  const text = read.text ?? '';
  if (!text) return emptyEvidenceBlock();
  if (text.length <= maxLength && estimateAITokens(text) <= maxTokens) {
    return evidenceFromLocalRange(probeStart, text, { start: 0, end: text.length }, 'range', probeStart === 0);
  }
  const desiredStart = text.length - maxLength;
  const starts = tailBoundaryCandidates(text, desiredStart);
  const start = starts.find((candidate) => estimateAITokens(text.slice(candidate)) <= maxTokens) ??
    fitRangeStartToTokenBudget(text, Math.max(0, desiredStart), text.length, maxTokens);
  const chatStart = firstChatTurnAtOrAfter(text, start) === start ? start : undefined;
  const naturalStart = starts.includes(start) ? start : undefined;
  return evidenceFromLocalRange(
    probeStart,
    text,
    { start, end: text.length },
    chatStart !== undefined ? 'conversation-turn' : 'paragraph',
    naturalStart !== undefined,
  );
}

export async function readNaturalEvidenceBlock(
  context: PluginContext,
  source: AIContextSource,
  anchorStart: number,
  maxLength: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<EvidenceBlock> {
  if (maxLength <= 0 || source.length <= 0) return emptyEvidenceBlock();
  const safeAnchor = Math.max(0, Math.min(source.length - 1, anchorStart));
  const margin = Math.min(800, Math.max(320, maxLength));
  const probeStart = Math.max(0, safeAnchor - margin);
  const probeLength = Math.min(source.length - probeStart, maxLength + margin * 2);
  const read = await readContextSource(context, {
    sourceId: source.sourceId,
    start: probeStart,
    length: probeLength,
  }, signal);
  const text = read.text ?? '';
  if (!text) return emptyEvidenceBlock();
  const anchor = Math.max(0, Math.min(text.length - 1, safeAnchor - probeStart));

  const code = enclosingCodeBlock(text, anchor);
  if (code) {
    if (rangeFitsBudget(text, code, maxLength, maxTokens)) {
      return evidenceFromLocalRange(probeStart, text, code, 'code-block', true);
    }
    const start = Math.max(code.start, Math.min(anchor - Math.floor(maxLength / 3), code.end - maxLength));
    const end = fitRangeEndToTokenBudget(text, start, Math.min(code.end, start + maxLength), maxTokens);
    return evidenceFromLocalRange(probeStart, text, { start, end }, 'code-block', false);
  }

  const structural: Array<{ range?: TextRange; boundary: EvidenceBlock['boundary'] }> = [
    { range: enclosingMarkdownTable(text, anchor), boundary: 'markdown-table' },
    { range: enclosingMarkdownList(text, anchor), boundary: 'markdown-list' },
    { range: enclosingChatExchange(text, anchor), boundary: 'conversation-turn' },
    { range: enclosingChatTurn(text, anchor), boundary: 'conversation-turn' },
    { range: enclosingParagraph(text, anchor), boundary: 'paragraph' },
    { range: enclosingSentence(text, anchor), boundary: 'sentence' },
  ];
  for (const candidate of structural) {
    if (candidate.range && rangeFitsBudget(text, candidate.range, maxLength, maxTokens)) {
      return evidenceFromLocalRange(probeStart, text, candidate.range, candidate.boundary, true);
    }
  }

  const hardStart = Math.max(0, Math.min(anchor - Math.min(240, Math.floor(maxLength / 3)), text.length - maxLength));
  const hardEnd = fitRangeEndToTokenBudget(
    text,
    hardStart,
    Math.min(text.length, hardStart + maxLength),
    maxTokens,
  );
  return evidenceFromLocalRange(
    probeStart,
    text,
    { start: hardStart, end: hardEnd },
    'range',
    probeStart + hardStart === 0 && probeStart + hardEnd >= source.length,
  );
}
