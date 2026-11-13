import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextSource, AIPreparedContext, AIProposalRecord } from '../../protocols/ai.ts';
import type { EditorSelectionSnapshot } from '../../protocols/editor.ts';
import { readContextSource } from './context-source-reader.ts';
import { estimateAITokens } from './evidence-boundaries.ts';
import { naturalName } from '../../services/natural-canvas-rules.ts';

export function naturalWritebackIntent(prompt: string) {
  const text = prompt.trim().replace(/^请\s*/u, '');
  const selected = /^(?:(?:把|将)?(?:选中的?文字|这段选区|选区|这段).{0,30}(?:润色|改写|缩短|重写|扩写|翻译|精简|更.{1,12})|(?:润色|改写|缩短|重写|扩写|翻译|精简)(?:一下)?(?:这段|选区|选中的?文字)).*$/u.test(text);
  const followup = /^(?:(?:把)?刚才那段)?(?:再短一点|再精简一点|再含蓄一点|再改写一下)(?:[，,].*)?[。！]?$/u.test(prompt.trim());
  const described = /^(?:把|将)(?:写|提到|描述)?\s*[「“"]?(.{1,60}?)[」”"]?(?:的)?那(?:一)?段\s*(?:缩短|精简|改写|润色|写得|改得|写短|改短).*$/u.exec(prompt.trim());
  const namedAppend = /^(?:把|将)(.{1,120}?)写进(.{1,80}?)(?:的正文|设定|正文)[。！]?$/u.exec(prompt.trim());
  if (selected) return { kind: 'selection' as const };
  if (followup) return { kind: 'followup' as const };
  if (namedAppend) return { kind: 'append' as const, name: namedAppend[2]!.trim() };
  const namedParagraph = /^(?:把|将)(.+?)(?:里|中|内)(?:写|提到|描述)?(.+?)(?:的)?那(?:一)?段\s*(?:缩短|精简|改写|润色|扩写|翻译|写得|改得|写短|改短).*$/u.exec(text);
  if (namedParagraph) return { kind: 'description' as const, name: naturalName(namedParagraph[1]!), phrase: naturalName(namedParagraph[2]!) };
  if (described) return { kind: 'description' as const, phrase: described[1]!.trim() };
  const whole = /^(?:润色|扩写|缩写|精简|改写|翻译|重写)(?:一下)?\s*(.+?)(?:的(?:正文|全文|内容))?[。！]?$/u.exec(text);
  if (whole && !/\s|[，,]|到\d|成.{1,8}文/u.test(whole[1]!)) return { kind: 'named' as const, name: naturalName(whole[1]!) };
  return undefined;
}

export function writebackTaskInstructions(prompt: string, previous: readonly string[] = []): string[] {
  const current = prompt.split(/(?<=[。！？\n])/u).filter(sentence => /保留|别改|不要|必须|禁止|不能|不得|不改|限制|口吻|语气|不超过|至少/u.test(sentence));
  const prior = Array.isArray(previous) ? previous.filter(sentence => typeof sentence === 'string') : [];
  const instructions = [...new Set([...prior, ...current].map(sentence => sentence.trim()).filter(Boolean))];
  if (instructions.join('\n').length > 6_000) throw new Error('当前任务的明确约束超过可发送预算，请开始一个较短的新任务。');
  return instructions;
}

export async function bindNaturalWriteback(context: PluginContext, intent: NonNullable<ReturnType<typeof naturalWritebackIntent>>, catalog: AIContextSource[], explicit: string[], previous: AIProposalRecord | undefined, signal: AbortSignal): Promise<AIPreparedContext['writebackTarget']> {
  const selection = await context.capabilities.request<EditorSelectionSnapshot | undefined>('editor.selection@1', undefined, signal).catch(() => undefined);
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  const ref = explicit.length === 1 ? catalog.find(source => source.sourceId === explicit[0] || source.title === explicit[0]) : undefined;
  const requestedName = 'name' in intent ? intent.name : undefined;
  const namedSources = requestedName ? catalog.filter(source => source.kind === 'text' && source.automaticRetrieval !== false &&
    source.title.normalize('NFKC').toLocaleLowerCase() === requestedName.normalize('NFKC').toLocaleLowerCase()) : [];
  const named = ref ?? (namedSources.length === 1 ? namedSources[0] : undefined);
  if (requestedName && !named) throw new Error(namedSources.length > 1 ? `「${requestedName}」有多个同名节点，请选定具体版本。` : `允许的画布范围内没有找到「${requestedName}」。`);
  if (intent.kind === 'named') {
    if (!named || !named.length) throw new Error('目标正文为空，请说明要创作的内容。');
    return { nodeId: named.sourceId, expectedRevision: named.revision, start: 0, end: named.length, mode: 'replace' };
  }
  if (intent.kind === 'append') {
    const named = catalog.filter(source => source.kind === 'text' && source.automaticRetrieval !== false && source.title.normalize('NFKC') === intent.name.normalize('NFKC'));
    const source = ref ?? (named.length === 1 ? named[0] : undefined);
    if (!source) throw new Error('请用 @ 指定要追加正文的节点。');
    return { nodeId: source.sourceId, expectedRevision: source.revision, start: source.length, end: source.length, mode: 'append' };
  }
  if (intent.kind === 'followup') {
    const target = previous?.suggestedTarget;
    if (!previous || !target?.range || previous.status === 'dismissed') throw new Error('没有可沿用的段落，请 @ 引用节点并指明段落。');
    const accepted = previous.status === 'accepted' ? previous.acceptedTarget : undefined;
    const source = catalog.find(item => item.sourceId === (accepted?.nodeId ?? target.nodeId));
    if (!source || source.revision !== (accepted ? previous.acceptedRevision : target.expectedRevision)) throw new Error('刚才的段落已变化或操作已撤销，请重新定位。');
    const start = accepted?.mode === 'replace' ? accepted.start : target.range.start;
    const end = accepted ? start + previous.text.length : target.range.end;
    return { nodeId: source.sourceId, expectedRevision: source.revision, start, end, mode: 'replace' };
  }
  if (intent.kind === 'selection') {
    const source = selection && catalog.find(item => item.sourceId === selection.id);
    if (!source || !selection || selection.start === selection.end || (ref && ref.sourceId !== source.sourceId)) throw new Error('请先在正文编辑器中选中要修改的文字。');
    return { nodeId: source.sourceId, expectedRevision: source.revision, start: Math.min(selection.start, selection.end), end: Math.max(selection.start, selection.end), mode: 'replace' };
  }
  const active = named ?? ref ?? (selection && catalog.find(source => source.sourceId === selection.id));
  const canvasSelection = !active ? await context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal).catch(() => undefined) : undefined;
  const scope = active ? [active] : canvasSelection?.ids.length === 1 ? catalog.filter(source => source.sourceId === canvasSelection.ids[0]) : [];
  if (!scope.length) throw new Error('请先选中一个正文节点，或用 @ 指定要改写的节点。');
  const source = scope[0]!;
  if (source.length > 512 * 1024) throw new Error('正文过长，请先选中对应段落。');
  const hits: number[] = [];
  for (let start = 0; start < source.length && hits.length < 2; start += 8_192) {
    const chunk = await readContextSource(context, { sourceId: source.sourceId, start, length: 8_192 + intent.phrase.length - 1 }, signal);
    if (chunk.source?.revision !== source.revision) throw new Error('定位期间正文已变化，请重试。');
    const text = chunk.text ?? '';
    for (let index = text.indexOf(intent.phrase); index >= 0 && index < 8_192 && hits.length < 2; index = text.indexOf(intent.phrase, index + 1)) hits.push(start + index);
  }
  if (hits.length !== 1) throw new Error(hits.length ? '这段描述匹配多处，请引用更具体的原文。' : '没有在目标正文找到这段描述，请选中原文或提供关键词。');
  const anchor = hits[0]!, start = Math.max(0, anchor - 4_096);
  const chunk = await readContextSource(context, { sourceId: source.sourceId, start, length: 8_192 }, signal);
  if (chunk.source?.revision !== source.revision) throw new Error('定位期间正文已变化，请重试。');
  const text = chunk.text ?? '';
  const paragraph = [...text.matchAll(/\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/gu)].find(item => start + item.index! <= anchor && start + item.index! + item[0].length > anchor);
  if (!paragraph) throw new Error('没有定位到完整段落。');
  const left = start + paragraph.index!, right = left + paragraph[0].trimEnd().length;
  if ((left === start && start > 0) || (right >= start + text.length && right < source.length)) throw new Error('段落较长，请直接选中要改写的文字。');
  return { nodeId: source.sourceId, expectedRevision: source.revision, start: left, end: right, mode: 'replace' };
}

export async function readBoundWriteback(context: PluginContext, source: AIContextSource, target: NonNullable<AIPreparedContext['writebackTarget']>, characters: number, tokens: number, signal: AbortSignal) {
  if (target.mode === 'append') {
    const start = Math.max(0, source.length - Math.min(characters, 2_000));
    const read = await readContextSource(context, { sourceId: source.sourceId, start, length: source.length - start }, signal);
    if (read.source?.revision !== target.expectedRevision) throw new Error('目标正文已经变化，请重新定位。');
    const text = read.text ?? '';
    if (estimateAITokens(text) > tokens) throw new Error('目标正文尾部超过本轮预算。');
    return { start, length: text.length, text };
  }
  if (target.start < 0 || target.end > source.length || target.end <= target.start || target.end - target.start > characters) throw new Error('目标范围超出本轮可发送长度，请缩小选区。');
  const side = Math.min(250, Math.floor((characters - target.end + target.start) / 2));
  const start = Math.max(0, target.start - side);
  const length = Math.min(source.length, target.end + side) - start;
  const read = await readContextSource(context, { sourceId: source.sourceId, start, length }, signal);
  if (read.source?.revision !== target.expectedRevision) throw new Error('目标正文已经变化，请重新定位。');
  const text = read.text ?? '';
  if (estimateAITokens(text) > tokens) throw new Error('目标范围超过本轮正文预算，请缩小选区。');
  return { start, length: text.length, text };
}
