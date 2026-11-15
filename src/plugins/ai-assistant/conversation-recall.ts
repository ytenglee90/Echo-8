import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextSource } from '../../protocols/ai.ts';
import { yieldToMainThread } from '../../services/async-control.ts';
import { readContextSource } from './context-source-reader.ts';
import { estimateAITokens } from './evidence-boundaries.ts';

const RANGE = 16_384;
const MAX_SCAN = 128 * RANGE;
const MAX_ENTRY = 12_000;
const HEADER = /^\[(用户|助手)(?:[ \t]*·[^\]\r\n]+)?\][ \t]*\r?$/gmu;
const FIELD = /职业|身份|年龄|外貌|动机|姓名|性格|出身|阵营|地点|时间|口头禅/u;
const CONFIRM = /(?:@(?:确认|修改)|确认(?:为|是)?|确定(?:为|是)?|定为|最终|决定(?:采用)?|改成|改为|就用)/u;
const SUGGEST = /建议|可以设为|可以是|不妨|候选/u;
const REPLACE = /@修改|改成|改为|换成|最终|取代|替换/u;

interface Entry {
  start: number;
  length: number;
  turn: number;
  role: '用户' | '助手';
  field?: string;
  subject?: string;
  kind?: 'confirmed' | 'suggestion';
  replaces?: number;
}

interface Directory {
  revision: number;
  length: number;
  entries: Entry[];
}

const directories = new WeakMap<PluginContext, Map<string, Directory>>();

export function exactHistoryRequest(prompt: string): boolean {
  return /第\s*\d+\s*轮|(?:最早|之前|上次|以前)(?:\S{0,4})?(?:确认|决定|定下|定的|设定|建议)|按旧设定/u.test(prompt);
}

async function readRange(context: PluginContext, source: AIContextSource, start: number, length: number, signal: AbortSignal): Promise<string> {
  const result = await readContextSource(context, { sourceId: source.sourceId, start, length }, signal);
  if (result.source?.revision !== source.revision || result.start !== start || result.text?.length !== length) {
    throw new Error('对话原文在检索期间已变化，请重试。');
  }
  return result.text;
}

async function conversationDirectory(context: PluginContext, source: AIContextSource, signal: AbortSignal): Promise<{ directory?: Directory; reads: number }> {
  const cache = directories.get(context) ?? new Map<string, Directory>();
  const cached = cache.get(source.sourceId);
  if (cached?.revision === source.revision && cached.length === source.length) return { directory: cached, reads: 0 };
  if (source.length > MAX_SCAN) return { reads: 0 };
  const entries: Entry[] = [];
  const previous = new Map<string, number>();
  const directory = { revision: source.revision, length: source.length, entries };
  let offset = 0;
  let pending = '';
  let pendingClipped = false;
  let turn = 0;
  let reads = 0;
  const add = (role: Entry['role'], body: string, start: number, length: number) => {
    if (role === '用户') turn++;
    const field = FIELD.exec(body);
    const authority = role === '用户' ? CONFIRM.exec(body) : SUGGEST.exec(body);
    const kind = authority && !/[？?]\s*$/u.test(body) &&
      !/^(?:如果|假如|假设|请|帮我|还没|尚未|不要|先别)|未确认|没有确认|不确定|没有决定/u.test(body)
      ? role === '用户' ? 'confirmed' as const : 'suggestion' as const : undefined;
    const subject = field && /([\p{Letter}\d·_-]{1,24})(?:的)?$/u.exec(body.slice(0, field.index))?.[1]
      ?.replace(/^(?:我|现在|正式|确认|确定|决定|最终|把|将|修改|建议|关于|给)+/u, '').replace(/的$/u, '');
    const key = field ? (subject ?? '') + '\u0000' + field[0] : '';
    const replaces = kind === 'confirmed' && key && REPLACE.test(body) ? previous.get(key) : undefined;
    entries.push({ start, length, turn, role, ...(field ? { field: field[0] } : {}), ...(subject ? { subject } : {}),
      ...(kind && field ? { kind } : {}), ...(replaces === undefined ? {} : { replaces }) });
    if (kind === 'confirmed' && key) previous.set(key, start);
  };
  for (let start = 0; start < source.length; start += RANGE) {
    signal.throwIfAborted();
    const end = Math.min(source.length, start + RANGE);
    const chunk = await readRange(context, source, start, end - start, signal);
    reads++;
    const text = pending + chunk;
    const headers = [...text.matchAll(HEADER)];
    if (pendingClipped) offset = start - pending.length;
    for (let index = 0; index < headers.length; index++) {
      const header = headers[index]!;
      const next = headers[index + 1]?.index ?? (end === source.length ? text.length : undefined);
      if (next === undefined) break;
      const bodyStart = header.index! + header[0].length;
      add(header[1] as Entry['role'], text.slice(bodyStart, Math.min(next, bodyStart + MAX_ENTRY)).trim(),
        offset + header.index!, next - header.index!);
    }
    const tail = headers.at(-1);
    const keep = tail?.index ?? Math.max(0, text.length - 256);
    if (end === source.length) break;
    pendingClipped = Boolean(tail && text.length - keep > MAX_ENTRY);
    if (pendingClipped) {
      const bodyStart = tail!.index! + tail![0].length;
      add(tail![1] as Entry['role'], text.slice(bodyStart, bodyStart + MAX_ENTRY).trim(), offset + tail!.index!, MAX_ENTRY + 1);
      pending = text.slice(-256);
      offset = end - pending.length;
    } else {
      pending = text.slice(keep);
      offset += keep;
    }
    if (reads % 4 === 0) await yieldToMainThread();
  }
  cache.delete(source.sourceId);
  cache.set(source.sourceId, directory);
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
  directories.set(context, cache);
  return { directory, reads };
}

export async function recallConversation(
  context: PluginContext, source: AIContextSource, prompt: string, characters: number, tokens: number, signal: AbortSignal, previousVersion = false,
) {
  const { directory, reads } = await conversationDirectory(context, source, signal);
  const field = FIELD.exec(prompt)?.[0];
  const numbered = /第\s*(\d+)\s*轮/u.exec(prompt);
  const oldest = /最早|第一次/u.test(prompt);
  const suggestion = /(?:你|助手).{0,12}建议|最早建议/u.test(prompt);
  const applicable = (directory?.entries ?? []).filter(entry => !field || entry.field === field);
  let matches: Entry[];
  let competing = false;
  let ambiguousSubjects: string[] = [];
  if (numbered) matches = (directory?.entries ?? []).filter(entry => entry.turn === Number(numbered[1]));
  else {
    const candidates = applicable.filter(entry => entry.kind === (suggestion ? 'suggestion' : 'confirmed'));
    const subjectMatches = candidates.filter(entry => entry.subject && prompt.includes(entry.subject));
    const subjects = [...new Set(candidates.flatMap(entry => entry.subject ? [entry.subject] : []))];
    if (!subjectMatches.length && field && subjects.length > 1) ambiguousSubjects = subjects.slice(0, 5);
    const relevant = subjectMatches.length ? subjectMatches : ambiguousSubjects.length ? [] : candidates;
    const replaced = new Set(relevant.flatMap(entry => entry.replaces === undefined ? [] : [entry.replaces]));
    const active = oldest || suggestion ? relevant : relevant.filter(entry => !replaced.has(entry.start));
    // Retain competing confirmed decisions as evidence so the caller can ask the user to choose.
    competing = !oldest && !suggestion && active.length > 1;
    matches = previousVersion && active.length === 1 ? relevant.filter(entry => entry.start === active[0]!.replaces)
      : previousVersion ? [] : oldest ? active.slice(0, 1) : active.slice(suggestion ? -1 : -3);
  }
  const evidence = [];
  for (const entry of matches) {
    if (entry.length > characters || entry.length > MAX_ENTRY) continue;
    const text = await readRange(context, source, entry.start, entry.length, signal);
    const estimatedTokens = estimateAITokens(text);
    if (estimatedTokens > tokens) continue;
    evidence.push({ ...entry, text, estimatedTokens });
    characters -= entry.length;
    tokens -= estimatedTokens;
  }
  return { evidence, reads: reads + evidence.length, candidates: matches.length, boundedOut: !directory, competing, ambiguousSubjects };
}
