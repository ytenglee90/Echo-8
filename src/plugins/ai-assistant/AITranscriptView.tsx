import { useMemo } from 'react';
import type { AIContextSource } from '../../protocols/ai.ts';
import type { AIResponseCitation, AIResponseDetail } from './types.ts';
import {
  parseTranscriptMessages,
  splitAIResponseCitations,
} from './transcript-presentation.ts';

export function AITranscriptView({
  text,
  turns,
  sessionId,
  responseDetails,
  currentSources,
  onOpenSource,
}: {
  text: string;
  turns: number;
  sessionId?: string;
  responseDetails: readonly AIResponseDetail[];
  currentSources: readonly AIContextSource[];
  onOpenSource: (sourceId: string) => void;
}) {
  const messages = useMemo(
    () => parseTranscriptMessages(
      text,
      turns,
      new Map(responseDetails
        .filter((detail) => detail.sessionId === sessionId)
        .map((detail) => [detail.turn, detail])),
    ),
    [responseDetails, sessionId, text, turns],
  );
  return (
    <div className="ai-chat-transcript" role="log" aria-label="AI 对话记录" tabIndex={0}>
      {messages.map((message) => (
        <article className={`ai-chat-bubble ${message.role}`} key={message.key}>
          {message.reasoning && <details className="ai-reasoning-block">
            <summary>思考过程</summary>
            <p>{message.reasoning}</p>
          </details>}
          <AITranscriptMessageText
            text={message.text}
            citations={message.citations ?? []}
            currentSources={currentSources}
            onOpenSource={onOpenSource}
          />
          {message.meta && <small>{message.meta}</small>}
        </article>
      ))}
    </div>
  );
}

function AITranscriptMessageText({
  text,
  citations,
  currentSources,
  onOpenSource,
}: {
  text: string;
  citations: readonly AIResponseCitation[];
  currentSources: readonly AIContextSource[];
  onOpenSource: (sourceId: string) => void;
}) {
  const segments = useMemo(
    () => splitAIResponseCitations(text, citations, currentSources),
    [citations, currentSources, text],
  );
  return <p>{segments.map((segment, index) => segment.kind === 'text'
    ? <span key={`text:${index}`}>{segment.text}</span>
    : segment.clickable
      ? <button
          key={segment.key}
          type="button"
          className="ai-source-citation"
          title={`来源 ${segment.ordinal}：打开文字节点“${segment.label}”`}
          aria-label={`打开来源文字节点：${segment.label}`}
          onClick={() => onOpenSource(segment.sourceId)}
        >来源：{segment.label}</button>
      : <span
          key={segment.key}
          className={`ai-source-citation ai-source-citation-static${segment.missing ? ' is-missing' : ''}`}
          title={segment.missing ? `来源文字节点“${segment.label}”已经不存在` : `来源：${segment.label}`}
        >来源：{segment.label}</span>)}</p>;
}
