import { createId, type PluginContext, type TaskHandle } from '../../core/contracts.ts';
import type {
  AIGenerateRequest,
  AIGenerateResult,
  AIMemoryCandidateDraft,
  AIMemoryCandidateRecord,
  AIMemoryClaimKind,
  AIMemoryIndexRecord,
  AISessionRecord,
  AIStatusSignal,
} from '../../protocols/ai.ts';
import {
  isMemoryCandidateCommitPayload,
  isMemoryCandidateExtractPayload,
  isMemoryCandidateIdPayload,
  type MemoryCandidateCommitPayload,
  type MemoryCandidateExtractPayload,
  type MemoryCandidateIdPayload,
} from './command-payloads.ts';
import { readContextSource } from './context-source-reader.ts';
import { normalizeMemoryField } from './memory-artifacts.ts';
import {
  AI_SESSION_NAMESPACE,
  formatAITranscriptEntry,
  planTranscriptAppend,
  sessionTranscriptSourceId,
} from './transcript-storage.ts';
import type { AIAssistantInstanceState } from './types.ts';

export const AI_MEMORY_CANDIDATE_NAMESPACE = 'aiMemoryCandidates';
const CANDIDATE_SOURCE_WINDOW = 7_200;
const MAX_CANDIDATES_PER_EXTRACTION = 8;

export interface AIMemoryCandidateRuntimeOptions {
  tasks: Map<string, TaskHandle<MemoryCandidateCommitPayload>>;
  readSessions(): Record<string, AISessionRecord>;
  readCandidates(): Record<string, AIMemoryCandidateRecord>;
  /** Formal, user-confirmed claims. Candidates must never duplicate these. */
  readMemoryIndexes(): Record<string, AIMemoryIndexRecord>;
  readAssistantInstances(): AIAssistantInstanceState[];
}

/**
 * Candidate extraction is deliberately opt-in. Its output stays outside the
 * retrieval index and turns into a formal claim only through an explicit
 * acceptance, which appends an auditable user directive to the transcript.
 */
export function registerAIMemoryCandidateRuntime(
  context: PluginContext,
  options: AIMemoryCandidateRuntimeOptions,
): void {
  context.commands.register<MemoryCandidateExtractPayload, { taskId: string }>({
    type: 'ai.memory.candidates.extract',
    validate: isMemoryCandidateExtractPayload,
    handle: (payload) => {
      const assistant = options.readAssistantInstances().find((item) => item.id === payload.assistantId);
      if (!assistant) throw new Error('AI 助手窗口已经关闭');
      const session = options.readSessions()[assistant.sessionId];
      if (!session) throw new Error('当前 AI 对话已经不存在');
      options.tasks.get(session.id)?.cancel();
      context.signals.emit('ai.status', {
        state: 'preparing',
        message: '正在从当前对话提炼待确认记忆',
        sessionId: session.id,
      } satisfies AIStatusSignal);
      const task = context.tasks.schedule<MemoryCandidateCommitPayload>({
        category: 'ai-memory-candidate-extraction',
        label: '正在提炼待确认的 AI 记忆',
        priority: 4,
        timeoutMs: 90_000,
        estimatedCost: 2,
        run: async (signal, report) => {
          report(0.1);
          const sourceId = sessionTranscriptSourceId(session);
          const metadata = await readContextSource(context, { sourceId, start: 0, length: 0 }, signal);
          if (!metadata.source || metadata.source.length === 0) throw new Error('当前对话没有可提炼的原文');
          const start = payload.sourceStart === undefined
            ? Math.max(0, metadata.source.length - CANDIDATE_SOURCE_WINDOW)
            : Math.min(metadata.source.length, payload.sourceStart);
          const length = payload.sourceLength === undefined
            ? metadata.source.length - start
            : Math.min(payload.sourceLength, CANDIDATE_SOURCE_WINDOW, metadata.source.length - start);
          if (length <= 0) throw new Error('本轮用户原文已经不可读取，未提炼候选');
          const evidence = await readContextSource(context, {
            sourceId,
            start,
            length,
          }, signal);
          if (evidence.source?.revision !== metadata.source.revision) {
            throw new Error('提炼期间对话发生变化，请稍后重试');
          }
          report(0.25);
          const generated = await context.capabilities.request<AIGenerateResult>('ai.generate@1', {
            providerId: assistant.providerProfileId,
            temperature: 0,
            maxOutputTokens: 1_200,
            messages: buildCandidateExtractionMessages(evidence.text ?? ''),
          } satisfies AIGenerateRequest, signal);
          report(0.85);
          const candidates = parseMemoryCandidateResponse(generated.text, evidence.text ?? '');
          report(1);
          return {
            sessionId: session.id,
            sourceId,
            sourceRevision: metadata.source.revision,
            sourceStart: start,
            sourceLength: length,
            extractor: { provider: generated.provider, model: generated.model },
            candidates,
          };
        },
      });
      options.tasks.set(session.id, task);
      void task.result.then(
        async (result) => {
          if (options.tasks.get(session.id) === task) options.tasks.delete(session.id);
          const committed = await context.commands.dispatch(
            'ai.memory.candidates.commit',
            result,
          );
          context.signals.emit('ai.status', {
            state: 'complete',
            message: committed.stale
              ? '对话已更新，未保存过期候选'
              : committed.created > 0
                ? `已生成 ${committed.created} 条待确认记忆${committed.duplicates > 0
                  ? `（已忽略 ${committed.duplicates} 条已确认的重复记忆）`
                  : ''}`
                : committed.duplicates > 0
                  ? `没有新增候选：已忽略 ${committed.duplicates} 条已确认的重复记忆`
                  : '没有发现可安全提炼的待确认记忆',
            sessionId: session.id,
          } satisfies AIStatusSignal);
        },
        (error) => {
          if (options.tasks.get(session.id) === task) options.tasks.delete(session.id);
          if ((error as { name?: string })?.name === 'AbortError') return;
          context.signals.emit('ai.status', {
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
            sessionId: session.id,
          } satisfies AIStatusSignal);
        },
      ).catch((error) => context.diagnostics.warn('提交 AI 记忆候选失败', error));
      return { result: { taskId: task.id } };
    },
  });
  context.commands.register({
    type: 'ai.memory.candidates.commit',
    validate: isMemoryCandidateCommitPayload,
    handle: async (payload) => {
      const session = options.readSessions()[payload.sessionId];
      if (!session || sessionTranscriptSourceId(session) !== payload.sourceId) {
        return { result: { created: 0, stale: true, duplicates: 0 } };
      }
      const source = await readContextSource(context, { sourceId: payload.sourceId, start: 0, length: 0 });
      if (!source.source || source.source.revision !== payload.sourceRevision) {
        return { result: { created: 0, stale: true, duplicates: 0 } };
      }
      const windowStart = payload.sourceStart;
      const window = await readContextSource(context, {
        sourceId: payload.sourceId,
        start: windowStart,
        length: Math.min(payload.sourceLength, source.source.length - windowStart),
      });
      if (window.source?.revision !== payload.sourceRevision) return { result: { created: 0, stale: true, duplicates: 0 } };
      const existing = Object.values(options.readCandidates());
      const now = Date.now();
      const bound = bindCandidateDrafts(
        payload.candidates,
        window.text ?? '',
        windowStart,
        payload,
        now,
      ).filter((candidate) => !existing.some((current) => sameCandidate(current, candidate)));
      const records = bound.filter((candidate) => !isCandidateAlreadyIndexed(candidate, options.readMemoryIndexes()));
      const duplicates = bound.length - records.length;
      if (records.length === 0) return { result: { created: 0, stale: false, duplicates } };
      return {
        result: { created: records.length, stale: false, duplicates },
        transaction: {
          label: '记录 AI 待确认记忆',
          patches: records.map((candidate) => ({
            op: 'set' as const,
            domain: 'document' as const,
            namespace: AI_MEMORY_CANDIDATE_NAMESPACE,
            key: candidate.id,
            value: candidate,
          })),
          events: [{ type: 'ai.memory.candidates.updated', payload: { sessionId: payload.sessionId } }],
        },
      };
    },
  });
  context.commands.register<MemoryCandidateIdPayload>({
    type: 'ai.memory.candidate.accept',
    validate: isMemoryCandidateIdPayload,
    handle: async (payload) => {
      const candidate = options.readCandidates()[payload.candidateId];
      if (!candidate || candidate.status !== 'pending') throw new Error('这条待确认记忆已经不存在或已处理');
      const session = options.readSessions()[candidate.sessionId];
      if (!session || candidate.sourceId !== sessionTranscriptSourceId(session)) {
        throw new Error('候选对应的对话已经不存在，不能确认');
      }
      const evidence = await readContextSource(context, {
        sourceId: candidate.sourceId,
        start: candidate.sourceStart,
        length: candidate.sourceLength,
      });
      if (evidence.text !== candidate.sourceQuote) {
        throw new Error('候选的原文证据已经变化，请重新提炼');
      }
      const expectedRevision = evidence.source?.revision;
      if (expectedRevision === undefined) throw new Error('候选的原文证据已经不可读取');
      const directive = candidateDirective(candidate);
      const append = await planTranscriptAppend(
        context,
        session,
        formatAITranscriptEntry('用户', directive, 'general', Date.now()),
        expectedRevision,
      );
      const now = Date.now();
      const nextSession: AISessionRecord = {
        ...session,
        transcriptRevision: append.revision,
        transcriptLength: append.length,
        transcriptEntries: append.entries,
        revision: session.revision + 1,
        turns: session.turns + 1,
        updatedAt: now,
      };
      return {
        transaction: {
          label: '确认 AI 记忆候选',
          patches: [
            ...append.patches,
            { op: 'set', domain: 'document', namespace: AI_SESSION_NAMESPACE, key: session.id, value: nextSession },
            {
              op: 'set', domain: 'document', namespace: AI_MEMORY_CANDIDATE_NAMESPACE, key: candidate.id,
              value: { ...candidate, status: 'accepted', acceptedAt: now, updatedAt: now },
            },
          ],
          events: [
            ...append.events,
            { type: 'ai.memory.candidates.updated', payload: { sessionId: session.id } },
          ],
        },
      };
    },
  });
  context.commands.register<MemoryCandidateIdPayload>({
    type: 'ai.memory.candidate.dismiss',
    validate: isMemoryCandidateIdPayload,
    handle: (payload) => {
      const candidate = options.readCandidates()[payload.candidateId];
      if (!candidate || candidate.status !== 'pending') throw new Error('这条待确认记忆已经不存在或已处理');
      const now = Date.now();
      return {
        transaction: {
          label: '忽略 AI 记忆候选',
          patches: [{
            op: 'set', domain: 'document', namespace: AI_MEMORY_CANDIDATE_NAMESPACE, key: candidate.id,
            value: { ...candidate, status: 'dismissed', updatedAt: now },
          }],
          events: [{ type: 'ai.memory.candidates.updated', payload: { sessionId: candidate.sessionId } }],
        },
      };
    },
  });
}

function buildCandidateExtractionMessages(source: string): AIGenerateRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        '你是“记忆候选提炼器”，不是对话助手。只识别用户在原文中明确说出的、以后仍有价值的事实、决定、约束或废弃项。',
        '绝不根据助手回答、暗示、常识或语气补全事实；不确定就不输出。候选不会直接生效，仍需用户确认。',
        '只输出 JSON，不要 Markdown、解释或思考过程：{"candidates":[{"kind":"confirm|modify|deprecate|branch","subject":"不超过120字","value":"可选，不超过500字","previousValue":"modify 时旧值","scope":"可选，不超过80字","evidence":"用户原话中的连续精确片段，不超过500字","confidence":0到1}]}。',
        'evidence 必须逐字来自一个 [用户 · ...] 段落，且不能跨角色；最多 8 条。confirm/branch 必须有 value，modify 必须同时有 previousValue 和 value。',
      ].join('\n'),
    },
    { role: 'user', content: `以下是当前对话末尾原文：\n\n${source}` },
  ];
}

/** Parses and source-binds untrusted model output. Invalid or inferred items are discarded. */
export function parseMemoryCandidateResponse(text: string, source: string): AIMemoryCandidateDraft[] {
  const raw = parseCandidateJson(text);
  if (!raw) return [];
  const records = Array.isArray(raw) ? raw : Array.isArray(raw.candidates) ? raw.candidates : [];
  const result: AIMemoryCandidateDraft[] = [];
  for (const value of records.slice(0, MAX_CANDIDATES_PER_EXTRACTION)) {
    const candidate = normalizeCandidateDraft(value);
    if (!candidate) continue;
    const start = source.indexOf(candidate.evidence);
    if (start < 0 || !evidenceBelongsToUser(source, start)) continue;
    if (result.some((item) => item.kind === candidate.kind && item.subject === candidate.subject &&
      item.value === candidate.value && item.evidence === candidate.evidence)) continue;
    result.push(candidate);
  }
  return result;
}

function parseCandidateJson(text: string): Record<string, unknown> | unknown[] | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  const objectStart = candidate.indexOf('{');
  const arrayStart = candidate.indexOf('[');
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  const end = candidate.startsWith('[', start) ? candidate.lastIndexOf(']') : candidate.lastIndexOf('}');
  const json = start >= 0 && end >= start ? candidate.slice(start, end + 1) : '';
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) || (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> | unknown[] : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCandidateDraft(inputValue: unknown): AIMemoryCandidateDraft | undefined {
  if (!inputValue || typeof inputValue !== 'object') return undefined;
  const input = inputValue as Record<string, unknown>;
  const kind = input.kind;
  if (!isCandidateKind(kind)) return undefined;
  const subject = normalizeField(input.subject, 120);
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim().slice(0, 500) : '';
  const value = normalizeField(input.value, 500);
  const previousValue = normalizeField(input.previousValue, 500);
  const scope = normalizeField(input.scope, 80);
  if (!subject || evidence.length < 2) return undefined;
  const candidate: AIMemoryCandidateDraft = {
    kind,
    subject,
    ...(value ? { value } : {}),
    ...(previousValue ? { previousValue } : {}),
    ...(scope ? { scope } : {}),
    evidence,
    ...(typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? { confidence: Math.max(0, Math.min(1, input.confidence)) }
      : {}),
  };
  if ((kind === 'confirm' || kind === 'branch') && !candidate.value) return undefined;
  if (kind === 'modify' && (!candidate.previousValue || !candidate.value)) return undefined;
  return candidate;
}

function bindCandidateDrafts(
  drafts: AIMemoryCandidateDraft[],
  sourceWindow: string,
  sourceWindowStart: number,
  payload: MemoryCandidateCommitPayload,
  now: number,
): AIMemoryCandidateRecord[] {
  return drafts.flatMap((draft) => {
    const offset = sourceWindow.indexOf(draft.evidence);
    if (offset < 0 || !evidenceBelongsToUser(sourceWindow, offset)) return [];
    return [{
      id: createId('ai-memory-candidate'),
      sessionId: payload.sessionId,
      sourceId: payload.sourceId,
      sourceRevision: payload.sourceRevision,
      sourceStart: sourceWindowStart + offset,
      sourceLength: draft.evidence.length,
      sourceQuote: draft.evidence,
      kind: draft.kind,
      subject: draft.subject,
      ...(draft.value ? { value: draft.value } : {}),
      ...(draft.previousValue ? { previousValue: draft.previousValue } : {}),
      ...(draft.scope ? { scope: draft.scope } : {}),
      confidence: draft.confidence ?? 0.65,
      status: 'pending' as const,
      extractor: payload.extractor,
      createdAt: now,
      updatedAt: now,
    }];
  });
}

function candidateDirective(candidate: AIMemoryCandidateRecord): string {
  const scope = candidate.scope ? `${candidate.scope}｜` : '';
  switch (candidate.kind) {
    case 'confirm':
      if (!candidate.value) throw new Error('确认候选缺少内容，不能写入');
      return `@确认 ${scope}${candidate.subject}: ${candidate.value}`;
    case 'modify':
      if (!candidate.previousValue || !candidate.value) throw new Error('修改候选缺少新旧值，不能写入');
      return `@修改 ${scope}${candidate.subject}: ${candidate.previousValue} → ${candidate.value}`;
    case 'deprecate':
      return `@废弃 ${scope}${candidate.subject}${candidate.value ? `: ${candidate.value}` : ''}`;
    case 'branch':
      if (!candidate.value || !candidate.scope) throw new Error('分支候选缺少范围或内容，不能写入');
      return `@分支 ${candidate.scope}｜${candidate.subject}: ${candidate.value}`;
  }
}

function evidenceBelongsToUser(source: string, start: number): boolean {
  const headerStart = Math.max(0, source.lastIndexOf('\n[', start) + 1);
  const headerEnd = source.indexOf('\n', headerStart);
  const header = source.slice(headerStart, headerEnd < 0 ? source.length : headerEnd);
  return /^\[用户\s*·/u.test(header);
}

function normalizeField(value: unknown, limit: number): string | undefined {
  return typeof value === 'string'
    ? normalizeMemoryField(value.replace(/\s+/gu, ' '), limit) || undefined
    : undefined;
}

function isCandidateKind(value: unknown): value is AIMemoryClaimKind {
  return value === 'confirm' || value === 'modify' || value === 'deprecate' || value === 'branch';
}

function sameCandidate(left: AIMemoryCandidateRecord, right: AIMemoryCandidateRecord): boolean {
  return left.sourceId === right.sourceId && left.sourceStart === right.sourceStart &&
    left.sourceLength === right.sourceLength && left.kind === right.kind && left.subject === right.subject &&
    left.value === right.value && left.previousValue === right.previousValue && left.scope === right.scope;
}

/**
 * Keeps a model suggestion from repeating an equivalent, user-confirmed claim.
 * This intentionally does not treat a different value for the same subject as
 * a duplicate: it may be a real change, which still needs a human decision.
 */
export function isCandidateAlreadyIndexed(
  candidate: Pick<AIMemoryCandidateRecord, 'kind' | 'subject' | 'value' | 'previousValue' | 'scope'>,
  memoryIndexes: Record<string, AIMemoryIndexRecord>,
): boolean {
  return Object.values(memoryIndexes).some((index) => (index.claims ?? []).some((claim) =>
    claim.authority === 'user-explicit' && claim.status !== 'candidate' &&
    claim.kind === candidate.kind &&
    comparableSubject(claim.subject) === comparableSubject(candidate.subject) &&
    comparableScope(claim.scope ?? index.scope) === comparableScope(candidate.scope) &&
    comparableValue(claim.value) === comparableValue(candidate.value) &&
    comparableValue(claim.previousValue) === comparableValue(candidate.previousValue),
  ));
}

function comparableSubject(value: string): string {
  return normalizeMemoryField(value, 120).normalize('NFC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function comparableScope(value: string | undefined): string {
  return value
    ? normalizeMemoryField(value, 80).normalize('NFC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '')
    : '';
}

function comparableValue(value: string | undefined): string {
  return value ? normalizeMemoryField(value, 500).normalize('NFC') : '';
}
