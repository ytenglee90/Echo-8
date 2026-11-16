import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextSource, AISessionRecord } from '../../protocols/ai.ts';
import { yieldToMainThread } from '../../services/async-control.ts';
import { readContextSource } from './context-source-reader.ts';
import { estimateAITokens } from './evidence-boundaries.ts';
import { internalTranscriptSourceId } from './transcript-storage.ts';

const RANGE = 16_384;
const MAX_SCAN = 128 * RANGE;
const MAX_ENTRY = 12_000;
const MAX_DIRECTORY_ENTRIES = 16_384;
const HEADER = /^\[(用户|助手)(?:[ \t]*·[^\]\r\n]+)?\][ \t]*\r?$/gmu;
const FIELD = /职业|身份|年龄|外貌|动机|姓名|性格|出身|阵营|地点|时间|口头禅/u;
const CONFIRM = /(?:@(?:确认|修改)|确认(?:为|是)?|确定(?:为|是)?|定为|最终|决定(?:采用)?|改成|改为|就用)/u;
const SUGGEST = /建议|可以设为|可以是|不妨|候选/u;
const REPLACE = /@修改|改成|改为|换成|最终|取代|替换/u;
const DRAFT_TOPIC = /开头|开场|结局|结尾|摘要|提要|大纲|标题|文案|设定|简介|邮件|草稿/u;
const DRAFT_NUMBER = /第\s*([一二三四五六七八九1-9])\s*(?:个|份|版|种|案)/u;
const DRAFT_HEADING = /^[\t ]*(?:(?:#{1,6}|[-*])\s+)?(?:\*\*)?(?:第\s*([一二三四五六七八九1-9])\s*(?:个|份|版|种|案)|(?:版本|方案|草稿)\s*([一二三四五六七八九1-9]))(?:\*\*)?(?=[:：、。 .（(\r\n]|$)(?:[ \t]*[:：、]?[ \t]*)/gmu;
const NAMES = '一二三四五六七八九';
const draftNumber = (value: string) => /^[1-9]$/u.test(value) ? Number(value) : NAMES.indexOf(value) + 1;

interface DraftPart { position: number; start: number; length: number }
export interface ConversationDraftRequest { number?: number; topic?: string; keepFirstSentence: boolean; maxCharacters?: number }

export function conversationDraftRequest(prompt: string): ConversationDraftRequest | undefined {
  if (!/缩|压到|短|简化|精简|润色|改写|重写|扩写|保留|改成/u.test(prompt) || /(?:写进|写入|填入|替换到|画布|节点|卡片|@\[)/u.test(prompt)) return undefined;
  const number = DRAFT_NUMBER.exec(prompt)?.[1];
  if (!number && !/刚才那(?:个|版|份)|(?:确认|选中)的(?:那)?(?:一)?版|刚才选的/u.test(prompt)) return undefined;
  const maxCharacters = /(?:压到|缩到|不超过|最多|控制在|精简到)\s*(\d{1,5})\s*字/u.exec(prompt)?.[1];
  return { ...(number ? { number: draftNumber(number) } : {}), topic: DRAFT_TOPIC.exec(prompt)?.[0],
    keepFirstSentence: /(?:保留|原样留|别改|不要改|别动|不要动|保持)\s*(?:原来的?|原文)?\s*(?:第[一1]句|首句)|(?:第[一1]句|首句)\s*(?:保留|不变|照旧|别改|别动|不要动)/u.test(prompt),
    ...(maxCharacters ? { maxCharacters: Number(maxCharacters) } : {}) };
}

function draftParts(body: string, start: number, orderedList: boolean): DraftPart[] {
  const numbered = /^[\t ]*([1-9])[.、)）][\t ]*/gmu;
  const headings = [...body.matchAll(DRAFT_HEADING)];
  const matches = headings.length >= 2 ? headings : orderedList ? [...body.matchAll(numbered)] : [];
  if (matches.length < 2) return [];
  const parts = matches.flatMap((match, index) => {
    const from = match.index + match[0].length;
    const raw = body.slice(from, matches[index + 1]?.index ?? body.length);
    const trimmed = raw.trim();
    return trimmed ? [{ position: draftNumber(match[1] ?? match[2]!), start: start + from + raw.indexOf(trimmed), length: trimmed.length }] : [];
  });
  return parts.length >= 2 && new Set(parts.map(part => part.position)).size === parts.length ? parts : [];
}

interface Entry {
  start: number;
  length: number;
  turn: number;
  role: '用户' | '助手';
  field?: string;
  subject?: string;
  kind?: 'confirmed' | 'suggestion';
  replaces?: number;
  draftParts?: DraftPart[];
  draftTopic?: string;
  acceptedDraft?: { entryStart: number; position: number };
}

interface Directory {
  revision: number;
  length: number;
  entries: Entry[];
  previous: Map<string, number>;
  turn: number;
  topic?: string;
  expectsVariants: boolean;
  appended?: { revision: number; length: number };
}

const directories = new WeakMap<PluginContext, Map<string, Directory>>();

export function noteConversationAppend(context: PluginContext, session: AISessionRecord, revision: number): void {
  if (session.transcriptSourceId) return;
  const cache = directories.get(context);
  const sourceId = internalTranscriptSourceId(session.id);
  const directory = cache?.get(sourceId);
  if (!directory) return;
  const previous = directory.appended ?? directory;
  if (revision === previous.revision && session.transcriptLength === previous.length) return;
  if (revision !== session.transcriptRevision || revision !== previous.revision + 1 ||
    session.transcriptLength === undefined || session.transcriptLength <= previous.length) {
    cache!.delete(sourceId);
    return;
  }
  directory.appended = { revision, length: session.transcriptLength };
}

export function invalidateConversationDirectories(context: PluginContext): void {
  directories.delete(context);
}

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
  directories.set(context, cache);
  const cached = cache.get(source.sourceId);
  if (cached?.revision === source.revision && cached.length === source.length) return { directory: cached, reads: 0 };
  const seed = cached?.appended?.revision === source.revision && cached.appended.length === source.length ? cached : undefined;
  const scanStart = seed?.length ?? 0;
  if (source.length - scanStart > MAX_SCAN) return { reads: 0 };
  const entries = seed?.entries.slice() ?? [];
  const previous = new Map(seed?.previous);
  let offset = scanStart;
  let pending = '';
  let pendingClipped = false;
  let turn = seed?.turn ?? 0;
  let reads = 0;
  let topic = seed?.topic;
  let expectsVariants = seed?.expectsVariants ?? false;
  const add = (role: Entry['role'], rawBody: string, start: number, length: number, bodyStart: number) => {
    const body = rawBody.trim();
    let acceptedDraft: Entry['acceptedDraft'];
    if (role === '用户') {
      turn++;
      topic = DRAFT_TOPIC.exec(body)?.[0];
      expectsVariants = /(?:给|写|列|生成|拟|出|提供|想).{0,10}?(?:[两二三四五2-5]\s*(?:个|种|版|份)|多(?:个|版|种))(?:.{0,20})/u.test(body);
      const selection = DRAFT_NUMBER.exec(body)?.[1];
      if (selection && /(?:留着|选用|就用|更好|采用|定了|确定用|我选|就它)/u.test(body) && !/不要|先别|如果|假如|[？?]\s*$/u.test(body)) {
        const position = draftNumber(selection);
        const previousDraft = entries.findLast(entry => (!topic || entry.draftTopic === topic) && entry.draftParts?.some(part => part.position === position));
        if (previousDraft) acceptedDraft = { position, entryStart: previousDraft.start };
      }
    }
    const parts = role === '助手' && length <= MAX_ENTRY ? draftParts(body, bodyStart + rawBody.indexOf(body), expectsVariants) : [];
    const field = FIELD.exec(body);
    const authority = role === '用户' ? CONFIRM.exec(body) : SUGGEST.exec(body);
    const kind = authority && !/[？?]\s*$/u.test(body) &&
      !/^(?:如果|假如|假设|请|帮我|还没|尚未|不要|先别)|未确认|没有确认|不确定|没有决定/u.test(body)
      ? role === '用户' ? 'confirmed' as const : 'suggestion' as const : undefined;
    const subject = field && /([\p{Letter}\d·_-]{1,24})(?:的)?$/u.exec(body.slice(0, field.index))?.[1]
      ?.replace(/^(?:我|现在|正式|确认|确定|决定|最终|把|将|修改|建议|关于|给)+/u, '').replace(/的$/u, '');
    const key = field ? (subject ?? '') + '\u0000' + field[0] : '';
    const replaces = kind === 'confirmed' && key && REPLACE.test(body) ? previous.get(key) : undefined;
    entries.push({ start, length, turn, role, ...(parts.length ? { draftParts: parts, draftTopic: topic } : {}), ...(acceptedDraft ? { acceptedDraft } : {}),
      ...(field ? { field: field[0] } : {}), ...(subject ? { subject } : {}),
      ...(kind && field ? { kind } : {}), ...(replaces === undefined ? {} : { replaces }) });
    if (kind === 'confirmed' && key) previous.set(key, start);
  };
  for (let start = scanStart; start < source.length; start += RANGE) {
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
      add(header[1] as Entry['role'], text.slice(bodyStart, Math.min(next, bodyStart + MAX_ENTRY)),
        offset + header.index!, next - header.index!, offset + bodyStart);
    }
    const tail = headers.at(-1);
    const keep = tail?.index ?? Math.max(0, text.length - 256);
    if (end === source.length) break;
    pendingClipped = Boolean(tail && text.length - keep > MAX_ENTRY);
    if (pendingClipped) {
      const bodyStart = tail!.index! + tail![0].length;
      add(tail![1] as Entry['role'], text.slice(bodyStart, bodyStart + MAX_ENTRY), offset + tail!.index!, MAX_ENTRY + 1, offset + bodyStart);
      pending = text.slice(-256);
      offset = end - pending.length;
    } else {
      pending = text.slice(keep);
      offset += keep;
    }
    if (entries.length > MAX_DIRECTORY_ENTRIES) return { reads };
    if (reads % 4 === 0) await yieldToMainThread();
  }
  if (entries.length > MAX_DIRECTORY_ENTRIES) return { reads };
  const directory: Directory = { revision: source.revision, length: source.length, entries, previous, turn, topic, expectsVariants };
  if (directories.get(context) === cache && cache.get(source.sourceId) === cached) {
    if (seed?.appended && seed.appended.revision > source.revision) directory.appended = seed.appended;
    cache.delete(source.sourceId);
    cache.set(source.sourceId, directory);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  return { directory, reads };
}

export async function readConversationDraft(context: PluginContext, source: AIContextSource, request: ConversationDraftRequest,
  characters: number, tokens: number, signal: AbortSignal) {
  const { directory } = await conversationDirectory(context, source, signal);
  if (!directory) return { clarify: '这段对话超出本轮可回查的范围。请指明原文范围，或贴出要修改的草稿。' };
  const entries = directory.entries;
  const choices = entries.filter(entry => entry.draftParts?.length && (!request.topic || entry.draftTopic === request.topic) &&
    (!request.number || entry.draftParts.some(part => part.position === request.number)));
  const accepted = entries.findLast(entry => entry.acceptedDraft &&
    choices.some(choice => choice.start === entry.acceptedDraft!.entryStart))?.acceptedDraft;
  const latest = choices.find(entry => entry === entries.at(-1));
  const selected = latest ?? choices.find(entry => entry.start === accepted?.entryStart) ?? (choices.length === 1 ? choices[0] : undefined);
  if (!selected) return { clarify: choices.length ? '对话中有多组草稿。请补充主题或指明你要改写的那一轮。'
    : request.number ? '没有定位到要改的草稿。请指明是哪一轮，或贴出那一版原文。' : undefined };
  const part = selected.draftParts?.find(item => item.position === (request.number ?? (accepted?.entryStart === selected.start ? accepted.position : undefined)));
  if (!part) return { clarify: '你要修改这组草稿中的哪一版？' };
  if (part.length > characters) return { clarify: '这版草稿超过本轮可用范围，请指出要改写的段落。' };
  const text = await readRange(context, source, part.start, part.length, signal);
  const estimatedTokens = estimateAITokens(text);
  if (estimatedTokens > tokens) return { clarify: '这版草稿超过本轮可用范围，请指出要改写的段落。' };
  return { draft: { ...part, text, estimatedTokens } };
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
