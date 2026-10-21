import {
  createId,
  type EventDeclaration,
  type PatchOperation,
  type PluginContext,
} from '../../core/contracts.ts';
import type {
  AIContextReadContribution,
  AIContextReadRequest,
  AIContextSource,
  AIOperation,
  AISessionRecord,
} from '../../protocols/ai.ts';
import type { ContentAppendPlanRequest, ContentMutationPlan } from '../../protocols/content.ts';
import { operationLabel } from './operations.ts';

export const AI_SESSION_NAMESPACE = 'aiSessions';
export const AI_TRANSCRIPT_NAMESPACE = 'aiTranscriptChunks';

export function formatAITranscriptEntry(
  role: '用户' | '助手',
  text: string,
  operation: AIOperation,
  timestamp: number,
): string {
  return `\n[${role} · ${new Date(timestamp).toLocaleString('zh-CN')} · ${operationLabel(operation)}]\n${text}\n`;
}

export interface AITranscriptChunkRecord {
  id: string;
  sessionId: string;
  sequence: number;
  start: number;
  text: string;
}

export interface TranscriptMutationPlan {
  sourceId: string;
  revision: number;
  start: number;
  length: number;
  entries: number;
  patches: PatchOperation[];
  events: EventDeclaration[];
}

export function internalTranscriptSourceId(sessionId: string): string {
  return `ai-transcript:${sessionId}`;
}

export function internalTranscriptSessionId(sourceId: string): string | undefined {
  return sourceId.startsWith('ai-transcript:') ? sourceId.slice('ai-transcript:'.length) || undefined : undefined;
}

export function sessionTranscriptSourceId(session: AISessionRecord): string {
  return session.transcriptSourceId ?? internalTranscriptSourceId(session.id);
}

export function chunkImportedTranscript(sessionId: string, text: string): Array<{
  key: string;
  chunk: AITranscriptChunkRecord;
}> {
  const result: Array<{ key: string; chunk: AITranscriptChunkRecord }> = [];
  for (let start = 0, sequence = 0; start < text.length; start += 64 * 1024, sequence += 1) {
    const id = createId('ai-transcript-chunk');
    const chunk: AITranscriptChunkRecord = {
      id,
      sessionId,
      sequence,
      start,
      text: text.slice(start, start + 64 * 1024),
    };
    result.push({ key: transcriptChunkKey(sessionId, start, id), chunk });
  }
  return result;
}

export function readInternalTranscript(
  context: PluginContext,
  sessionId: string,
  request: AIContextReadRequest,
  signal?: AbortSignal,
): AIContextReadContribution {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const session = context.store.readValue<AISessionRecord>(AI_SESSION_NAMESPACE, sessionId);
  if (!session || session.transcriptSourceId) return { handled: true };
  const length = Math.max(0, session.transcriptLength ?? 0);
  const start = Math.max(0, Math.min(length, Math.trunc(request.start)));
  const requestedLength = Math.max(0, Math.trunc(request.length));
  const end = Math.min(length, start + requestedLength);
  const source: AIContextSource = {
    sourceId: internalTranscriptSourceId(sessionId),
    provider: 'ai-assistant',
    kind: 'conversation',
    title: session.title,
    revision: Math.max(0, session.transcriptRevision ?? 0),
    length,
    automaticRetrieval: false,
  };
  if (end <= start) return { handled: true, source, start, text: '' };
  const prefix = transcriptChunkPrefix(sessionId);
  const chunks = Object.values(
    context.store.readKeyRange<Record<string, AITranscriptChunkRecord>>(
      AI_TRANSCRIPT_NAMESPACE,
      `${prefix}${String(start).padStart(16, '0')}`,
      `${prefix}${String(end).padStart(16, '0')}`,
      true,
    ),
  )
    .filter((chunk) => chunk.sessionId === sessionId)
    .filter((chunk) => chunk.start < end && chunk.start + chunk.text.length > start)
    .sort((left, right) => left.sequence - right.sequence);
  const text = chunks.map((chunk) => {
    const from = Math.max(0, start - chunk.start);
    const to = Math.min(chunk.text.length, end - chunk.start);
    return chunk.text.slice(from, to);
  }).join('');
  return { handled: true, source, start, text };
}

export async function planTranscriptAppend(
  context: PluginContext,
  session: AISessionRecord,
  text: string,
  expectedRevision: number,
): Promise<TranscriptMutationPlan> {
  if (session.transcriptSourceId) {
    const append = await context.capabilities.request<ContentMutationPlan>(
      'content.appendPlan@1',
      {
        nodeId: session.transcriptSourceId,
        text,
        expectedRevision,
      } satisfies ContentAppendPlanRequest,
    );
    return {
      sourceId: session.transcriptSourceId,
      revision: append.revision,
      start: Math.max(0, append.length - text.length),
      length: append.length,
      entries: Math.max(0, session.transcriptEntries ?? 0) + 1,
      patches: append.patches,
      events: [
        ...(append.events ?? []),
        { type: 'ai.transcript.changed', payload: { sessionId: session.id, revision: append.revision } },
      ],
    };
  }
  const revision = Math.max(0, session.transcriptRevision ?? 0);
  if (revision !== expectedRevision) throw new Error('AI 对话正文版本已经变化');
  const sequence = Math.max(0, session.transcriptEntries ?? 0);
  const start = Math.max(0, session.transcriptLength ?? 0);
  const id = createId('ai-transcript-chunk');
  const chunk: AITranscriptChunkRecord = { id, sessionId: session.id, sequence, start, text };
  return {
    sourceId: internalTranscriptSourceId(session.id),
    revision: revision + 1,
    start,
    length: start + text.length,
    entries: sequence + 1,
    patches: [{
      op: 'set',
      domain: 'document',
      namespace: AI_TRANSCRIPT_NAMESPACE,
      key: transcriptChunkKey(session.id, start, id),
      value: chunk,
    }],
    events: [{
      type: 'ai.transcript.changed',
      payload: { sessionId: session.id, revision: revision + 1 },
    }],
  };
}

function transcriptChunkPrefix(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}:`;
}

function transcriptChunkKey(sessionId: string, start: number, id: string): string {
  return `${transcriptChunkPrefix(sessionId)}${String(start).padStart(16, '0')}:${id}`;
}
