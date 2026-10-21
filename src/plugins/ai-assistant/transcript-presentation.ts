import type {
  AIContextSource,
  AIPreparedContext,
  AIPreparedSource,
} from '../../protocols/ai.ts';
import type { AIResponseCitation, AIResponseDetail } from './types.ts';

export interface AITranscriptMessageView {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  meta: string;
  reasoning?: string;
  citations?: readonly AIResponseCitation[];
}

export type AITranscriptTextSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'citation';
      key: string;
      ordinal: number;
      sourceId: string;
      label: string;
      clickable: boolean;
      missing: boolean;
    };

/**
 * Converts the append-only transcript format into a UI projection. The
 * transcript remains authoritative; this view model is deliberately derived
 * and is never written back to the store.
 */
export function parseTranscriptMessages(
  text: string,
  totalTurns: number,
  detailsByTurn: ReadonlyMap<number, Pick<AIResponseDetail, 'reasoning' | 'citations'>>,
): AITranscriptMessageView[] {
  const header = /^\[(用户|助手)(?:\s*·\s*([^\]]+))?\]\s*$/gmu;
  const matches = [...text.matchAll(header)];
  const firstTurn = Math.max(0, totalTurns - matches.length);
  return matches.flatMap((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const body = text.slice(start, end).trim();
    if (!body) return [];
    const detail = match[1] === '助手'
      ? detailsByTurn.get(firstTurn + index + 1)
      : undefined;
    return [{
      key: `${match.index ?? index}:${match[1]}`,
      role: match[1] === '用户' ? 'user' as const : 'assistant' as const,
      text: body,
      meta: match[2]?.trim() ?? '',
      ...(detail?.reasoning ? { reasoning: detail.reasoning } : {}),
      ...(detail?.citations?.length ? { citations: detail.citations } : {}),
    }];
  });
}

/** Captures only citation ordinals that the model actually used in its answer. */
export function collectAIResponseCitations(
  text: string,
  sources: readonly AIPreparedSource[],
): AIResponseCitation[] {
  const ordinals = new Set(
    [...text.matchAll(/\[来源\s*(\d+)\]/gu)]
      .map((match) => Number.parseInt(match[1] ?? '', 10))
      .filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0),
  );
  return sources.flatMap((source, index) => {
    const ordinal = index + 1;
    return ordinals.has(ordinal) ? [{
      ordinal,
      sourceId: source.sourceId,
      title: source.title,
      kind: source.kind,
      revision: source.revision,
    }] : [];
  });
}

/** Replaces stable numbered markers with a current, human-readable source projection. */
export function splitAIResponseCitations(
  text: string,
  citations: readonly AIResponseCitation[],
  currentSources: readonly AIContextSource[],
): AITranscriptTextSegment[] {
  const citationByOrdinal = new Map(citations.map((citation) => [citation.ordinal, citation]));
  const currentById = new Map(currentSources.map((source) => [source.sourceId, source]));
  const segments: AITranscriptTextSegment[] = [];
  const pattern = /\[来源\s*(\d+)\]/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? cursor;
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) });
    const ordinal = Number.parseInt(match[1] ?? '', 10);
    const citation = citationByOrdinal.get(ordinal);
    if (!citation) {
      segments.push({ kind: 'text', text: match[0] });
    } else {
      const current = currentById.get(citation.sourceId);
      segments.push({
        kind: 'citation',
        key: `${start}:${ordinal}:${citation.sourceId}`,
        ordinal,
        sourceId: citation.sourceId,
        label: current?.title.trim() || citation.title.trim() || '未命名节点',
        clickable: current?.kind === 'text',
        missing: citation.kind === 'text' && !current,
      });
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: 'text', text }];
}

export function contextSourceReasonText(reason: AIPreparedContext['sources'][number]['reason']): string {
  return reason === 'explicit-reference'
    ? '明确 @ 引用'
    : reason === 'recent-conversation'
      ? '本对话原文'
      : reason === 'conversation-memory'
        ? '历史对话索引命中'
        : '关键词相关';
}

export function memoryIssueText(issue: NonNullable<AIPreparedContext['memoryIssues']>[number]): string {
  if (issue.recovery === 'current-source-verified') return '旧索引已过期，本次已读取并核对当前原文；后台正在重建';
  const label = ({
    'source-missing': '原文记忆节点不存在',
    'source-revision-changed': '原文已修改，索引需要重建',
    'index-node-missing': '可读索引节点不存在',
    'hub-node-missing': '未连接到 AI 记忆中心',
  })[issue.reason];
  return issue.recovery === 'rebuild-pending' ? `${label}，后台已排队` : label;
}

export function evidenceBoundaryText(boundary: AIPreparedContext['sources'][number]['boundary']): string {
  return ({
    'conversation-turn': '完整对话轮次',
    'code-block': '代码块',
    'markdown-table': '完整 Markdown 表格',
    'markdown-list': '完整 Markdown 列表',
    paragraph: '完整段落',
    sentence: '完整句子',
    range: '连续范围',
  })[boundary ?? 'range'];
}

export function formatAITimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}
