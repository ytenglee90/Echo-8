import { createId } from '../../core/contracts.ts';
import type {
  AIContextReadContribution,
  AIContextReadRequest,
  AIMemoryClaimRecord,
  AIMemoryIndexDraft,
} from '../../protocols/ai.ts';
import { normalizeMemoryField } from './memory-artifacts.ts';
import { MEMORY_STOP_TERMS, memoryTermOccurrences } from './memory-terms.ts';

const MEMORY_SCAN_CHUNK = 32 * 1024;
export const MEMORY_SOURCE_WINDOW = 1_600;

export type MemorySourceReader = (
  request: AIContextReadRequest,
  signal?: AbortSignal,
) => Promise<AIContextReadContribution>;

interface MemoryTermStat {
  count: number;
  starts: number[];
}

interface MemoryDirectiveScanState {
  carry: string;
  carryStart: number;
  role?: '用户' | '助手' | '系统';
  claims: AIMemoryClaimRecord[];
}

export async function buildMemoryIndexDraft(
  readSource: MemorySourceReader,
  sourceId: string,
  title: string,
  signal: AbortSignal,
  report: (progress: number) => void,
  waitIfPaused: () => Promise<void>,
): Promise<AIMemoryIndexDraft> {
  const metadata = await readSource({ sourceId, start: 0, length: 0 }, signal);
  const source = metadata.source;
  if (!source || source.length === 0) throw new Error('原文记忆没有可以建立索引的内容');
  const stats = new Map<string, MemoryTermStat>();
  const firstSamples: string[] = [];
  const lastSamples: string[] = [];
  const directiveState: MemoryDirectiveScanState = {
    carry: '',
    carryStart: 0,
    claims: [],
  };
  recordMemoryTerms(title, 0, stats);

  for (let offset = 0; offset < source.length; offset += MEMORY_SCAN_CHUNK) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    await waitIfPaused();
    const read = await readSource({
      sourceId: source.sourceId,
      start: offset,
      length: Math.min(MEMORY_SCAN_CHUNK, source.length - offset),
    }, signal);
    if (read.source?.revision !== source.revision) throw new Error('建立索引期间原文发生变化，请重新执行');
    const text = read.text ?? '';
    recordMemoryTerms(text, offset, stats);
    collectMemorySamples(text, firstSamples, lastSamples);
    scanMemoryDirectives(text, offset, directiveState);
    if (stats.size > 6_000) trimMemoryStats(stats, 4_000);
    report(Math.min(0.96, (offset + text.length) / source.length));
    if (!text) break;
  }
  finishMemoryDirectiveScan(directiveState);

  const eligible = [...stats.entries()].filter(([term]) => !MEMORY_STOP_TERMS.has(term));
  const frequent = [...eligible]
    .sort((left, right) => right[1].count - left[1].count || right[0].length - left[0].length);
  const distinctive = [...eligible]
    .filter(([term]) => /[a-z0-9]/iu.test(term) && term.length >= 5)
    .sort((left, right) => right[0].length - left[0].length || right[1].count - left[1].count)
    .slice(0, 8);
  const rankedMap = new Map<string, MemoryTermStat>();
  for (const entry of [...distinctive, ...frequent]) {
    if (!rankedMap.has(entry[0])) rankedMap.set(entry[0], entry[1]);
    if (rankedMap.size >= 32) break;
  }
  const ranked = [...rankedMap.entries()];
  const keywords = ranked.map(([term]) => term);
  const samples = [...new Set([...firstSamples, ...lastSamples])].slice(0, 5);
  const summary = [
    `主题：${title}`,
    keywords.length ? `关键词：${keywords.slice(0, 12).join('、')}` : '',
    samples.length ? `要点摘录：${samples.join('；')}` : '',
  ].filter(Boolean).join('\n').slice(0, 720);
  report(1);
  return {
    sourceRevision: source.revision,
    sourceLength: source.length,
    summary,
    keywords,
    anchors: ranked.flatMap(([term, stat]) => stat.starts.map((start) => ({
      term,
      start,
      length: Math.min(MEMORY_SOURCE_WINDOW, Math.max(0, source.length - start)),
    }))),
    claims: directiveState.claims,
    createdAt: Date.now(),
  };
}

function recordMemoryTerms(text: string, baseOffset: number, stats: Map<string, MemoryTermStat>): void {
  for (const occurrence of memoryTermOccurrences(text)) {
    const current = stats.get(occurrence.term);
    if (current) {
      current.count += 1;
      const start = baseOffset + occurrence.index;
      if (current.starts.length < 4 && current.starts.every((item) => Math.abs(item - start) > 160)) {
        current.starts.push(start);
      }
    } else {
      stats.set(occurrence.term, { count: 1, starts: [baseOffset + occurrence.index] });
    }
  }
}

function collectMemorySamples(text: string, firstSamples: string[], lastSamples: string[]): void {
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/\s+/gu, ' ').trim();
    if (line.length < 8 || /^\[[^\]]{1,160}\]$/u.test(line) ||
      /^(当前对话已保存|关键索引：|摘要：)/u.test(line)) continue;
    const sample = line.slice(0, 180);
    if (firstSamples.length < 3 && !firstSamples.includes(sample)) firstSamples.push(sample);
    if (!lastSamples.includes(sample)) lastSamples.push(sample);
    while (lastSamples.length > 2) lastSamples.shift();
  }
}

function scanMemoryDirectives(text: string, baseOffset: number, state: MemoryDirectiveScanState): void {
  const combined = `${state.carry}${text}`;
  const combinedStart = state.carry ? state.carryStart : baseOffset;
  let lineStart = 0;
  for (;;) {
    const newline = combined.indexOf('\n', lineStart);
    if (newline < 0) break;
    processMemoryDirectiveLine(
      combined.slice(lineStart, newline).replace(/\r$/u, ''),
      combinedStart + lineStart,
      state,
    );
    lineStart = newline + 1;
  }
  state.carry = combined.slice(lineStart);
  state.carryStart = combinedStart + lineStart;
}

function finishMemoryDirectiveScan(state: MemoryDirectiveScanState): void {
  if (state.carry) processMemoryDirectiveLine(state.carry.replace(/\r$/u, ''), state.carryStart, state);
  state.carry = '';
}

function processMemoryDirectiveLine(line: string, start: number, state: MemoryDirectiveScanState): void {
  const header = line.match(/^\[(用户|助手|系统)\s*·/u);
  if (header) {
    state.role = header[1] as MemoryDirectiveScanState['role'];
    return;
  }
  if (state.role !== '用户') return;
  const trimmed = line.trim();
  const directiveOffset = line.indexOf('@');
  if (directiveOffset < 0) return;
  const claimStart = start + directiveOffset;
  const modify = trimmed.match(
    /^@修改\s+(?:(.{1,80}?)[｜|]\s*)?(.{1,120}?)[：:]\s*(.{1,500}?)\s*(?:→|->|=>|改为)\s*(.{1,500})$/u,
  );
  if (modify) {
    state.claims.push(memoryClaim('modify', modify[2], modify[4], claimStart, trimmed.length, {
      previousValue: modify[3],
      scope: modify[1],
      sequence: state.claims.length,
    }));
    return;
  }
  const branch = trimmed.match(/^@分支\s+(.{1,80}?)[｜|]\s*(.{1,120}?)[：:]\s*(.{1,500})$/u);
  if (branch) {
    state.claims.push(memoryClaim('branch', branch[2], branch[3], claimStart, trimmed.length, {
      scope: branch[1],
      sequence: state.claims.length,
    }));
    return;
  }
  const confirm = trimmed.match(/^@确认\s+(?:(.{1,80}?)[｜|]\s*)?(.{1,120}?)[：:]\s*(.{1,500})$/u);
  if (confirm) {
    state.claims.push(memoryClaim('confirm', confirm[2], confirm[3], claimStart, trimmed.length, {
      scope: confirm[1],
      sequence: state.claims.length,
    }));
    return;
  }
  const deprecate = trimmed.match(/^@废弃\s+(?:(.{1,80}?)[｜|]\s*)?(.{1,120}?)(?:[：:]\s*(.{1,500}))?$/u);
  if (deprecate) {
    state.claims.push(memoryClaim('deprecate', deprecate[2], deprecate[3], claimStart, trimmed.length, {
      scope: deprecate[1],
      sequence: state.claims.length,
    }));
  }
}

function memoryClaim(
  kind: AIMemoryClaimRecord['kind'],
  subject: string,
  value: string | undefined,
  start: number,
  length: number,
  extra: Pick<AIMemoryClaimRecord, 'previousValue' | 'scope' | 'sequence'> = {},
): AIMemoryClaimRecord {
  return {
    id: createId('memory-claim'),
    kind,
    status: kind === 'deprecate' ? 'deprecated' : kind === 'branch' ? 'branch' : 'current',
    subject: normalizeMemoryField(subject, 120),
    value: value ? normalizeMemoryField(value, 500) : undefined,
    previousValue: extra.previousValue ? normalizeMemoryField(extra.previousValue, 500) : undefined,
    scope: extra.scope ? normalizeMemoryField(extra.scope, 80) : undefined,
    start,
    length,
    authority: 'user-explicit',
    sequence: extra.sequence,
  };
}

function trimMemoryStats(stats: Map<string, MemoryTermStat>, limit: number): void {
  const keep = new Set([...stats.entries()]
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, limit)
    .map(([term]) => term));
  for (const term of stats.keys()) if (!keep.has(term)) stats.delete(term);
}
