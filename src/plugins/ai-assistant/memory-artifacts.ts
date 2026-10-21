import type { AIMemoryClaimRecord, AIMemoryIndexDraft } from '../../protocols/ai.ts';
import type { FileReadWriteTarget } from '../../protocols/files.ts';

export const AI_MEMORY_FILE_ORIGINAL_SUFFIX = '-对话原文.txt';
export const AI_MEMORY_FILE_INDEX_SUFFIX = '-检索索引.txt';

export interface MemoryFilePair {
  stem: string;
  original: FileReadWriteTarget;
  index: FileReadWriteTarget;
}

export function pairMemoryFiles(sources: FileReadWriteTarget[]): MemoryFilePair[] {
  const grouped = new Map<string, { original?: FileReadWriteTarget; index?: FileReadWriteTarget }>();
  for (const source of sources) {
    const name = source.name.normalize('NFC');
    const originalStem = name.endsWith(AI_MEMORY_FILE_ORIGINAL_SUFFIX)
      ? name.slice(0, -AI_MEMORY_FILE_ORIGINAL_SUFFIX.length)
      : undefined;
    const indexStem = name.endsWith(AI_MEMORY_FILE_INDEX_SUFFIX)
      ? name.slice(0, -AI_MEMORY_FILE_INDEX_SUFFIX.length)
      : undefined;
    const stem = originalStem ?? indexStem;
    if (!stem) continue;
    const entry = grouped.get(stem) ?? {};
    if (originalStem !== undefined) entry.original = source;
    if (indexStem !== undefined) entry.index = source;
    grouped.set(stem, entry);
  }
  return [...grouped.entries()].flatMap(([stem, pair]) =>
    pair.original && pair.index ? [{ stem, original: pair.original, index: pair.index }] : []);
}

export function parseImportedMemoryTitle(indexText: string, stem: string): string {
  const fromIndex = indexText.match(/^原文记忆：(.+)$/mu)?.[1]?.trim();
  return normalizeMemoryField(fromIndex || stem.replace(/-[a-z0-9]{6,16}$/iu, ''), 120) || '导入的 AI 记忆';
}

export function parseImportedMemoryIndex(
  indexText: string,
  originalText: string,
  sourceRevision: number,
  createdAt: number,
): AIMemoryIndexDraft {
  const normalized = indexText.replace(/\r\n?/gu, '\n');
  const keywordsText = sectionAfterHeading(normalized, '关键词').split('\n')[0] ?? '';
  const keywords = [...new Set(keywordsText.split(/[、，,；;\s]+/u).map((term) => term.trim()).filter((term) =>
    term && term !== '暂无'))].slice(0, 32);
  const summary = normalizeMemoryField(
    sectionBetweenHeadings(normalized, '目录摘要（仅用于定位，不是记忆原文）', '用户明确记忆指令') ||
      originalText.slice(0, 600),
    1_000,
  );
  return {
    sourceRevision,
    sourceLength: originalText.length,
    summary,
    keywords,
    anchors: keywords.flatMap((term) => {
      const start = originalText.indexOf(term);
      return start >= 0 ? [{ term, start, length: term.length }] : [];
    }).slice(0, 128),
    claims: [],
    createdAt,
  };
}

export function countTranscriptTurns(text: string): number {
  return [...text.matchAll(/^\[(?:用户|助手)(?:\s*·\s*[^\]]+)?\]\s*$/gmu)].length;
}

export function createMemoryFileStem(title: string, sourceId: string): string {
  const safe = (title.trim() || 'AI-记忆')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .slice(0, 90);
  const identity = sourceId.replace(/[^a-z0-9]/giu, '').slice(-10) || 'memory';
  return `${safe}-${identity}`;
}

export function memoryIndexTitle(title: string): string {
  const suffix = ' · 记忆索引';
  return `${title.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`;
}

export function normalizeMemoryField(value: string, maxLength: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}

export function formatMemoryIndexText(
  index: AIMemoryIndexDraft,
  metadata: { archiveNodeId: string; archiveTitle: string; savedAt: number },
): string {
  const claimLines = (index.claims ?? []).flatMap((claim) => [
    `- ${memoryClaimLabel(claim)} ${claim.subject}${claim.scope ? `（${claim.scope}）` : ''}` +
      `${claim.previousValue ? `：${claim.previousValue} → ${claim.value ?? ''}` : claim.value ? `：${claim.value}` : ''}`,
    `  证据位置：${claim.start}–${claim.start + claim.length}`,
  ]);
  return [
    'AI 对话记忆索引 v2',
    '',
    `原文记忆：${metadata.archiveTitle}`,
    `原文节点：${metadata.archiveNodeId}`,
    `保存时间：${new Date(metadata.savedAt).toLocaleString('zh-CN')}`,
    `原文修订：${index.sourceRevision}`,
    `原文长度：${index.sourceLength.toLocaleString()} UTF-16 字符`,
    '',
    '关键词',
    index.keywords.join('、') || '暂无',
    '',
    '目录摘要（仅用于定位，不是记忆原文）',
    index.summary || '暂无',
    '',
    '用户明确记忆指令',
    ...(claimLines.length > 0 ? claimLines : ['暂无。可在后续对话中使用 @确认、@修改、@废弃 或 @分支。']),
    '',
    '准确性规则',
    '- 本节点只是目录，回答必须回到原文记忆节点取证。',
    '- 索引与原文版本不一致时，必须停止使用并重新建立索引。',
    '- 未明确解决的冲突必须展示给用户，不能静默覆盖。',
  ].join('\n');
}

function sectionAfterHeading(text: string, heading: string): string {
  const marker = `${heading}\n`;
  const start = text.indexOf(marker);
  return start < 0 ? '' : text.slice(start + marker.length).trimStart();
}

function sectionBetweenHeadings(text: string, startHeading: string, endHeading: string): string {
  const rest = sectionAfterHeading(text, startHeading);
  const end = rest.indexOf(`\n${endHeading}`);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function memoryClaimLabel(claim: AIMemoryClaimRecord): string {
  return ({ confirm: '[确认]', modify: '[修改]', deprecate: '[废弃]', branch: '[分支]' })[claim.kind];
}
