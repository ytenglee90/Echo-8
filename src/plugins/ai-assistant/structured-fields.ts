import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextSource, AIInlineReference, AIPreparedSource } from '../../protocols/ai.ts';
import type { CanvasControlPlan } from '../../protocols/canvas-control.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { ContentSearchResultV2 } from '../../protocols/search.ts';
import { yieldToMainThread } from '../../services/async-control.ts';
import { canvasTitleAliases, normalizeCanvasTitle } from '../../services/canvas-titles.ts';
import { estimateAITokens } from './evidence-boundaries.ts';
import { readContextSource } from './context-source-reader.ts';
import { recallConversation } from './conversation-recall.ts';

const FIELDS = '身份|职业|年龄|外貌|动机|姓名|性格|出身|阵营|地点|时间|口头禅';
const COMPLETE = new RegExp(String.raw`^(?:给|为)\s*(.+?组)(?:里|内|中的?)?\s*缺(?:少)?\s*(${FIELDS})\s*的(卡片?|节点|文本框)\s*(?:补上|补全|填写)\s*\2(?:[。！!])?$`, 'u');
const RESTORE = new RegExp(String.raw`^恢复第\s*(\d+)\s*轮(?:的)?(.{1,80}?)(?:的)?(${FIELDS})(?:[，,]\s*保留[^。！？]+)?[。！!]?$`, 'u');
const CHECK = new RegExp(String.raw`^(?:检查|查找|找出)\s*(.+?组)(?:里|内|中的?)?\s*缺(?:少)?\s*(${FIELDS})\s*的(卡片?|节点|文本框)[。！!]?$`, 'u');
const SCAN_OLD = new RegExp(String.raw`^(.{1,60}?)(?:的)?(${FIELDS})(?:改了|已经更改|已更新)[，,]\s*(?:找出|查找|查一下)(?:还)?(?:写着|提到|包含)旧\2的(?:卡片?|节点|文本框)[。！!]?$`, 'u');
const MAX_BODY = 8_192;

export type FieldTask = { kind: 'complete' | 'check'; group: string; field: string; presentation?: ContentSummary['presentation'] } |
  { kind: 'restore'; target: string; field: string; turn: number } | { kind: 'age-conflicts'; group?: string } |
  { kind: 'scan-old'; target: string; field: string };
export interface FieldTarget { id: string; start: number; deleteCount: number; expectedRevision: number; prefix: string }
interface FieldPreparation {
  sources?: AIPreparedSource[];
  field?: string;
  fields?: FieldTarget[];
  fixedPlan?: CanvasControlPlan;
  clarify?: string;
}

export function structuredFieldTask(prompt: string): FieldTask | undefined {
  const text = prompt.trim().replace(/^@画布操作\s+/u, '').replace(/^(?:请|帮我)\s*/u, '');
  const age = /^(?:查|检查|核对)(?:\s*(.+?组)(?:里|内|中的?)?)?\s*年龄(?:矛盾|冲突|不一致)(?:[，,]?(?:并)?定位原句)?[。！!]?$/u.exec(text);
  if (age) return { kind: 'age-conflicts', group: age[1] };
  const scanOld = SCAN_OLD.exec(text);
  if (scanOld) return { kind: 'scan-old', target: scanOld[1]!, field: scanOld[2]! };
  const complete = COMPLETE.exec(text);
  const groupFields = complete ?? CHECK.exec(text);
  if (groupFields) return { kind: complete ? 'complete' : 'check', group: groupFields[1]!, field: groupFields[2]!,
    presentation: groupFields[3] === '文本框' ? 'text-box' : groupFields[3] === '节点' ? undefined : 'card' };
  const restore = RESTORE.exec(text);
  if (restore) return { kind: 'restore', turn: Number(restore[1]), target: restore[2]!.replace(/的$/u, ''), field: restore[3]! };
  return undefined;
}

function fieldRanges(body: string, field: string) {
  const pattern = new RegExp(String.raw`^[ \t]*(?:[-*][ \t]+)?${field}[ \t]*[：:][ \t]*([^\r\n]*)`, 'gmu');
  return [...body.matchAll(pattern)].map(match => ({ start: match.index! + match[0].length - match[1]!.length, value: match[1]!.trimEnd(),
    lineStart: match.index!, line: match[0].trimEnd() }));
}

async function currentBody(context: PluginContext, source: AIContextSource, signal: AbortSignal): Promise<string> {
  if (source.length > MAX_BODY) throw new Error(`「${source.title}」正文较长，请先指定字段所在的段落。`);
  const read = await readContextSource(context, { sourceId: source.sourceId, start: 0, length: source.length }, signal);
  if (read.source?.revision !== source.revision || read.start !== 0 || (read.text ?? '').length !== source.length) throw new Error('定位时正文发生变化，请重试。');
  return read.text ?? '';
}

function evidence(source: AIContextSource, body: string): AIPreparedSource {
  return { ...source, start: 0, length: body.length, text: body, complete: true, boundary: 'range', reason: 'explicit-reference' };
}

function historicalFieldValues(text: string, field: string): string[] {
  const lines = fieldRanges(text, field).map(range => range.value).filter(Boolean);
  if (lines.length) return lines;
  const inline = new RegExp(String.raw`${field}(?:\s*(?:确认|确定)?(?:为|是)|\s*(?:改成|改为|定为))\s*([^，。！？；\r\n]{1,120})`, 'u').exec(text);
  return inline ? [inline[1]!.trim().replace(/^[「『“"]|[」』”"]$/gu, '')] : [];
}

export async function prepareStructuredFields(
  context: PluginContext, task: FieldTask, catalog: AIContextSource[], budget: { characters: number; tokens: number },
  signal: AbortSignal, refs: AIInlineReference[] = [], transcript?: AIContextSource,
): Promise<FieldPreparation> {
  const scope = catalog.filter(source => source.kind === 'text' && source.provider !== 'ai-assistant' &&
    (source.automaticRetrieval !== false || refs.some(ref => ref.sourceId === source.sourceId)));
  if (task.kind === 'scan-old') {
    const ask = { clarify: `没有找到可核对的「${task.target}」旧${task.field}。请提供旧值或旧原句。` };
    if (!transcript) return ask;
    const recalled = await recallConversation(context, transcript, `按之前定的${task.target}${task.field}`, 4_000, 1_500, signal, true);
    const values = [...new Set(recalled.evidence.flatMap(entry => historicalFieldValues(entry.text, task.field)))].filter(Boolean);
    if (values.length !== 1) return ask;
    const query = values[0]!;
    if (!scope.length) return { clarify: '没有可自动读取的卡片。' };
    const result = await context.capabilities.request<ContentSearchResultV2>('content.search@2', {
      query, nodeIds: scope.map(source => source.sourceId), matchCase: true, wholeWord: false, maxResults: 24,
    }, signal);
    const byId = new Map(scope.map(source => [source.sourceId, source]));
    const hits = result.hits.filter(hit => hit.field === 'body' && byId.has(hit.nodeId));
    const sources = hits.map(hit => ({ ...evidence({ ...byId.get(hit.nodeId)!, revision: hit.revision }, hit.matchedText), start: hit.start }));
    return { sources, clarify: hits.length ? `旧${task.field}记录为「${query}」。以下正文出现该词，请核对是否指同一对象。${result.truncated ? ' 仅显示首批命中。' : ''}\n` +
      hits.map((hit, index) => `- ${hit.title} · ${hit.preview} [来源 ${index + 1}]`).join('\n') : `没有找到包含旧值「${query}」的正文。` };
  }
  if (task.kind === 'restore') {
    const field = task.field;
    const selected = refs.find(ref => ref.token === task.target);
    const name = normalizeCanvasTitle(task.target.replace(/^[「『“"]|[」』”"]$/gu, ''));
    const found = scope.filter(source => selected ? source.sourceId === selected.sourceId
      : canvasTitleAliases(source.title).some(alias => alias === name || alias.replace(/卡(?:片)?$/u, '') === name));
    if (found.length !== 1) return { clarify: '请用 @ 指定需要恢复字段的唯一卡片。' };
    if (!transcript || selected?.sourceId === transcript.sourceId) return { clarify: '当前对话中没有可读取的历史原文。' };
    const recalled = await recallConversation(context, transcript, `第${task.turn}轮的${field}`, budget.characters, budget.tokens, signal);
    const originalValues = [...new Set(recalled.evidence.flatMap(entry => historicalFieldValues(entry.text, field)))];
    if (originalValues.length !== 1) return { clarify: `第 ${task.turn} 轮没有唯一可核对的「${field}」旧值。请指定原句或版本。` };
    const source = found[0]!;
    const body = await currentBody(context, source, signal);
    const ranges = fieldRanges(body, field);
    if (ranges.length !== 1) return { clarify: `请明确「${source.title}」中要恢复的「${field}」字段所在行。` };
    const range = ranges[0]!;
    if (range.value === originalValues[0]) return { clarify: `「${source.title}」的${field}已经与第 ${task.turn} 轮一致。` };
    return { sources: [evidence(source, ''), ...recalled.evidence.map(item => ({
      ...transcript, ...item, complete: true, boundary: 'conversation-turn' as const, reason: 'conversation-memory' as const,
    }))], fixedPlan: { version: 2, actions: [{ type: 'update-node', id: source.sourceId, edit: {
      start: range.start, deleteCount: range.value.length, insert: originalValues[0]!, expectedRevision: source.revision,
    } }] } };
  }
  const groups = task.group ? (await context.capabilities.request<GroupRecord[]>('groups.list@1', undefined, signal))
    .filter(group => normalizeCanvasTitle(group.title) === normalizeCanvasTitle(task.group!)) : [];
  if (task.group && groups.length !== 1) return { clarify: `请指定唯一的「${task.group}」群组。` };
  const members = groups[0] && new Set(groups[0].memberIds);
  let candidates = members ? scope.filter(source => members.has(source.sourceId)) : scope;
  if (!candidates.length || candidates.length > 80) return { clarify: '请指定含有 1 至 80 张可读取卡片的群组。' };
  if (task.kind === 'age-conflicts') return checkAges(context, candidates, signal);
  if (task.presentation) {
    const summaries = await context.capabilities.request<ContentSummary[]>('content.summariesById@1',
      { nodeIds: candidates.map(item => item.sourceId) }, signal);
    const matching = new Set(summaries.filter(item => (item.presentation ?? 'card') === task.presentation).map(item => item.id));
    candidates = candidates.filter(source => matching.has(source.sourceId));
    if (!candidates.length) return { clarify: `「${task.group}」中没有符合要求的${task.presentation === 'card' ? '卡片' : '文本框'}。` };
  }
  const field = task.field;
  const fields: FieldTarget[] = [], sources: AIPreparedSource[] = [];
  for (const [index, source] of candidates.entries()) {
    signal.throwIfAborted();
    const body = await currentBody(context, source, signal);
    const ranges = fieldRanges(body, field);
    if (ranges.length > 1) return { clarify: `「${source.title}」有多个「${field}」字段，请先明确要检查的字段。` };
    const range = ranges[0];
    if (!range?.value) {
      const prefix = range ? '' : (body && !body.endsWith('\n') ? '\n' : '') + field + '：';
      fields.push({ id: source.sourceId, start: range?.start ?? source.length, deleteCount: 0, expectedRevision: source.revision, prefix });
      sources.push(evidence(source, body));
    }
    if (index % 8 === 7) await yieldToMainThread();
  }
  if (!fields.length) return { clarify: `「${task.group}」的可读卡片都已有「${field}」。` };
  if (task.kind === 'check') return { clarify: `「${task.group}」中有 ${fields.length} 张卡缺少「${field}」\n` +
    sources.map(source => `- ${source.title}（${fieldRanges(source.text, field).length ? '字段为空' : '未找到字段'}）`).join('\n') };
  if (sources.length > 12 || sources.reduce((total, source) => total + source.length, 0) > budget.characters ||
    sources.reduce((total, source) => total + estimateAITokens(source.text), 0) > budget.tokens) {
    return { clarify: '命中的卡片正文超过本轮预算，请分批补全或缩小群组范围。' };
  }
  return { field, fields, sources };
}

async function checkAges(context: PluginContext, candidates: AIContextSource[], signal: AbortSignal): Promise<FieldPreparation> {
  const records = new Map<string, Array<{ age: number; source: AIPreparedSource }>>();
  for (const [index, source] of candidates.entries()) {
    const body = await currentBody(context, source, signal);
    const names = fieldRanges(body, '姓名').map(item => item.value).filter(Boolean);
    if (names.length > 1) continue;
    const name = normalizeCanvasTitle(names[0] ?? source.title);
    if (!name) continue;
    const ages = records.get(name) ?? [];
    for (const range of fieldRanges(body, '年龄')) {
      const parsed = /^(\d{1,3})(?:\s*岁)?$/u.exec(range.value);
      if (!parsed) continue;
      ages.push({ age: Number(parsed[1]), source: { ...evidence(source, range.line), start: range.lineStart } });
    }
    if (ages.length) records.set(name, ages);
    if (index % 8 === 7) await yieldToMainThread();
  }
  const conflicts = [...records.values()].filter(items => new Set(items.map(item => item.age)).size > 1);
  const sources = conflicts.flatMap(items => items.map(item => item.source));
  if (sources.length > 24) return { clarify: '匹配到的年龄字段较多，请指定一个人物或缩小群组范围。' };
  return { sources, clarify: sources.length ? '发现同名对象的年龄字段值不一致，请结合版本或时间线核对。\n' +
    sources.map((item, index) => `- ${item.title} · ${item.text} [来源 ${index + 1}]`).join('\n') : '未发现同名对象的数字年龄字段值不一致。' };
}
