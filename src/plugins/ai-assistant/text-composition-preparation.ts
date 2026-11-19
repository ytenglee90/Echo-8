import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextSource, AIInlineReference, AIPreparedSource, AISessionRecord } from '../../protocols/ai.ts';
import { canvasTitleAliases, normalizeCanvasTitle } from '../../services/canvas-titles.ts';
import { naturalName } from '../../services/natural-canvas-rules.ts';
import { readCanvasDraftEvidence, readContextSource } from './context-source-reader.ts';
import { nativeConversation } from './request-evidence.ts';
import { operationLabel } from './operations.ts';
import { prepareCardRestructure, type RestructureBinding } from './card-restructure.ts';
import { sessionTranscriptSourceId } from './transcript-storage.ts';
import { isUsableGeneratedBody, type TextCompositionTask } from './text-composition.ts';
import type { FieldTarget } from './structured-fields.ts';

export async function prepareTextComposition(context: PluginContext, task: TextCompositionTask, catalog: AIContextSource[],
  refs: AIInlineReference[], session: AISessionRecord, selectionAtSend: string[] | undefined,
  budget: { characters: number; tokens: number }, signal: AbortSignal,
): Promise<{ sources?: AIPreparedSource[]; restructure?: RestructureBinding; compositionWriteTarget?: FieldTarget; textDraft?: string; clarify?: string }> {
  let ids = task.sourceIds ?? [];
  if (!task.sourceIds && task.sourceNames.length) {
    const names = task.sourceNames;
    if (names.length === 1 && /^(?:选中(?:的)?(?:节点|卡片|卡)|当前选中(?:的)?(?:节点|卡片|卡)|这张(?:节点|卡片|卡))$/u.test(names[0]!)) {
      const current = await context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal);
      ids = selectionAtSend ?? current.ids;
      if (ids.length !== 1 || current.ids.length !== ids.length || current.ids.some((id, i) => id !== ids[i])) return { clarify: '请先选中唯一的来源节点；发送后的选区变化时需要重新发送。' };
    } else for (const name of names) {
      const ref = refs.find(item => naturalName(item.token) === name);
      const directId = /^@node:([\w:.-]+)$/u.exec(name)?.[1];
      const matches = catalog.filter(source => source.kind === 'text' && (ref ? source.sourceId === ref.sourceId :
        directId ? source.sourceId === directId : source.automaticRetrieval !== false && canvasTitleAliases(source.title).includes(normalizeCanvasTitle(name))));
      if (matches.length !== 1) return { clarify: `请用 @ 指定唯一的来源卡片「${name}」。` };
      ids.push(matches[0]!.sourceId);
    }
  }
  const metadata = ids.map(id => catalog.find(source => source.sourceId === id && source.kind === 'text'));
  if (!task.draftOnly && (!ids.length && task.operation !== 'general' || metadata.some(source => !source))) return { clarify: '没有找到本轮明确指定的来源节点，尚未生成或写入正文。' };
  if (metadata.some(source => source?.automaticRetrieval === false && !refs.some(ref => ref.sourceId === source.sourceId) && !task.sourceNames.includes('@node:' + source.sourceId))) return { clarify: '来源已关闭自动使用，请用 @ 明确引用后再处理正文。' };
  if (task.sourceRevisions && metadata.some(source => source && source.revision !== task.sourceRevisions![source.sourceId])) throw new Error('模型解析期间来源正文已变化，请重新发送。');
  const title = task.title ?? `${metadata[0]?.title ? metadata[0].title.slice(0, 100) + ' · ' : ''}${task.draftOnly ? '草稿' : operationLabel(task.operation)}结果`;
  let sources: AIPreparedSource[] = [];
  let restructure: RestructureBinding = { ids, titles: [title], reconnect: false };
  if (!task.draftOnly && ids.length) {
    const bound = await prepareCardRestructure(context, { names: [], sourceIds: ids, titles: [title], reconnect: false }, catalog, refs, budget, signal);
    if (bound.clarify || !bound.restructure) return bound;
    sources = bound.sources ?? []; restructure = bound.restructure;
  }
  if (task.destinationId) {
    const target = catalog.find(source => source.sourceId === task.destinationId && source.kind === 'text');
    if (!target || target.automaticRetrieval === false && !refs.some(ref => ref.sourceId === target.sourceId)) return { clarify: '正文写入目标不可用，请用 @ 明确指定目标。' };
    if (target.revision !== task.sourceRevisions?.[target.sourceId]) throw new Error('模型解析期间写入目标已变化，请重新发送。');
    if (!sources.some(source => source.sourceId === target.sourceId)) {
      const bound = await prepareCardRestructure(context, { names: [], sourceIds: [target.sourceId], titles: [title], reconnect: false, allowEmpty: true }, catalog, refs, budget, signal);
      if (bound.clarify || !bound.sources) return { clarify: bound.clarify ?? '目标正文不可用。' };
      sources.push(...bound.sources);
    }
    return { sources, compositionWriteTarget: { id: target.sourceId, expectedRevision: target.revision,
      start: task.writeMode === 'append' ? target.length : 0, deleteCount: task.writeMode === 'append' ? 0 : target.length,
      prefix: task.writeMode === 'append' && target.length ? '\n\n' : '' } };
  }
  if (task.reuseDraft && session.turns > 0) {
    const source = (await readContextSource(context, { sourceId: sessionTranscriptSourceId(session), start: 0, length: 0 }, signal)).source;
    const block = source && await readCanvasDraftEvidence(context, source, Math.min(8_192, budget.characters), budget.tokens, signal,
      task.draftOnly ? {} : { topic: metadata[0]?.title });
    if (source && block?.complete && block.text) {
      const messages = nativeConversation(block.text, task.instruction, true, true, true);
      const request = messages.findLast(message => message.role === 'user')?.content ?? '';
      const answer = messages.findLast(message => message.role === 'assistant')?.content;
      const marker = answer && /(?:^|\n)改写正文(?:[（(]供(?:填入|插入)新节点[）)])?\s*[：:]\s*\n/u.exec(answer);
      const body = marker ? answer!.slice(marker.index + marker[0].length).trim() : answer?.trim();
      const relevant = task.draftOnly || metadata.some(item => item && request.includes(item.title)) && /改写|重写|润色|扩写|精简|总结|翻译/u.test(request);
      if (relevant && isUsableGeneratedBody(body) && !/^(?:模型已解析|已准备|已完成|请明确|请补充|未执行|这项画布操作)/u.test(body) && !/^[{[]/u.test(body)) {
        sources.push({ ...source, ...block, reason: 'recent-conversation' });
        return { sources, restructure, textDraft: body };
      }
    }
    if (task.draftOnly) return { clarify: '没有找到本对话里可完整沿用的正文。请指定草稿，或明确要处理的来源节点。' };
  }
  return { sources, restructure: { ...restructure, instruction: `处理方式：${operationLabel(task.operation)}。${task.instruction}。只生成处理后的实际正文，应用保留来源并把结果填入新节点。` } };
}
