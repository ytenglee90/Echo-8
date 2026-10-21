import type { AIContextSource } from '../../protocols/ai.ts';
import { AI_OPERATION_COMMANDS, compactReferenceToken } from './command-parser.ts';
import { AI_MEMORY_DIRECTIVE_COMMANDS } from './memory-protocol.ts';

export type AIMentionSuggestion =
  | {
      id: string;
      label: string;
      detail: string;
      token: string;
      kind: 'command' | 'memory';
      score: number;
    }
  | {
      id: string;
      sourceId: string;
      label: string;
      detail: string;
      token: string;
      kind: 'source';
      score: number;
    };

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function buildAIMentionSuggestions(
  rawQuery: string,
  sources: readonly AIContextSource[],
  limit = 40,
): AIMentionSuggestion[] {
  const query = normalize(rawQuery);
  const titleCounts = new Map<string, number>();
  for (const source of sources) {
    const title = normalize(source.title);
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }

  const candidates: AIMentionSuggestion[] = [];
  for (const [index, command] of AI_OPERATION_COMMANDS.entries()) {
    const primaryScore = matchScore(command.label, query);
    const secondaryScore = Math.max(matchScore(command.category, query), matchScore(command.description, query));
    if (query && primaryScore === 0 && secondaryScore === 0) continue;
    candidates.push({
      id: `command:${command.operation}`,
      label: `@${command.label}`,
      detail: `${command.category} · ${command.description}`,
      token: `@${command.label}`,
      kind: 'command',
      score: query ? primaryScore * 10 + secondaryScore : 3_000 - index,
    });
  }

  for (const [index, command] of AI_MEMORY_DIRECTIVE_COMMANDS.entries()) {
    const primaryScore = matchScore(command.label, query);
    const secondaryScore = matchScore(command.description, query);
    if (query && primaryScore === 0 && secondaryScore === 0) continue;
    candidates.push({
      id: `memory:${command.label}`,
      label: command.token,
      detail: `记忆管理 · ${command.description}`,
      token: command.token,
      kind: 'memory',
      score: query ? primaryScore * 10 + secondaryScore : 2_000 - index,
    });
  }

  for (const [index, source] of sources.entries()) {
    const primaryScore = matchScore(source.title, query);
    if (query && primaryScore === 0) continue;
    const normalizedTitle = normalize(source.title);
    candidates.push({
      id: `source:${source.sourceId}`,
      sourceId: source.sourceId,
      label: source.title,
      detail: `文字节点 · ${source.length.toLocaleString()} 字符`,
      token: compactReferenceToken(source.title, source.sourceId, (titleCounts.get(normalizedTitle) ?? 0) > 1),
      kind: 'source',
      score: query ? primaryScore * 10 - Math.min(index, 999) / 1_000 : 1_000 - Math.min(index, 999),
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score || kindOrder(left.kind) - kindOrder(right.kind) ||
      collator.compare(left.label, right.label))
    .slice(0, Math.max(1, Math.min(80, Math.round(limit))));
}

function matchScore(value: string, query: string): number {
  if (!query) return 1;
  const candidate = normalize(value);
  if (candidate === query) return 400;
  if (candidate.startsWith(query)) return 300 - Math.min(80, candidate.length - query.length);
  const position = candidate.indexOf(query);
  return position < 0 ? 0 : 200 - Math.min(100, position);
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN');
}

function kindOrder(kind: AIMentionSuggestion['kind']): number {
  return kind === 'command' ? 0 : kind === 'memory' ? 1 : 2;
}
