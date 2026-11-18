import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextSource, AIInlineReference, AIPreparedSource } from '../../protocols/ai.ts';
import type { CanvasAgentQueryResult } from '../../protocols/canvas-agent.ts';
import type { CanvasControlPlan } from '../../protocols/canvas-control.ts';
import { naturalName, naturalNames, NATURAL_QUOTED_NAME } from '../../services/natural-canvas-rules.ts';
import { canvasTitleAliases, normalizeCanvasTitle } from '../../services/canvas-titles.ts';
import { readContextSource } from './context-source-reader.ts';
import { estimateAITokens } from './evidence-boundaries.ts';

interface RestructureTask { names: string[]; titles: string[]; reconnect: boolean }
export interface RestructureBinding { ids: string[]; titles: string[]; reconnect: boolean }

/** Bind all three explicit fields regardless of their order; quoted names are data. */
function rewriteIntoNewNode(text: string): RestructureTask | undefined {
  if (text.includes('\u0000')) return undefined;
  const literals: string[] = [];
  const protectedText = text.replace(new RegExp(NATURAL_QUOTED_NAME, 'gu'), value => `\u0000${literals.push(value) - 1}\u0000`);
  const clauses = protectedText.split(/[，,；;]/u).map(clause => clause.trim()).filter(Boolean);
  if (clauses.length !== 3) return undefined;
  const restore = (value: string) => naturalName(value.replace(/\u0000(\d+)\u0000/gu, (_, index: string) => literals[Number(index)]!));
  let source: string | undefined;
  let title: string | undefined;
  let create = false;
  for (const clause of clauses) {
    const name = /^(?:标题|名称|名字)(?:为|是|叫|设为|设置为|[：:])\s*[：:]?\s*(.+)$/u.exec(clause);
    if (name && !title) { title = restore(name[1]!); continue; }
    const rewrite = /^(?:改写|重写|润色)\s*(.+?)(?:的)?(?:内容|正文|全文)$/u.exec(clause) ??
      /^(?:内容|正文)(?:为|是|[：:])\s*[：:]?\s*(?:改写|重写|润色)后的\s*(.+?)(?:的)?(?:内容|正文|全文)$/u.exec(clause);
    if (rewrite && !source) { source = restore(rewrite[1]!); continue; }
    if (!create && /^(?:(?:用|使用)(?:一个|一张)?新(?:的)?(?:节点|卡片)(?:来)?(?:插入|写入|保存|存放)(?:内容|结果|正文|改写结果)?|(?:新建|创建|新增)(?:一个|一张)?(?:新(?:的)?)?(?:节点|卡片)|(?:写入|输出到?)(?:一个|一张)?新(?:的)?节点(?:内容|结果)?)$/u.test(clause)) {
      create = true; continue;
    }
    return undefined;
  }
  return create && source && title && source.length <= 120 && title.length <= 120
    ? { names: [source], titles: [title], reconnect: false } : undefined;
}

export function cardRestructureTask(prompt: string): RestructureTask | undefined {
  const text = prompt.trim().replace(/^@画布操作\s+/u, '').replace(/^(?:请|帮我)\s*/u, '').replace(/[，,。！!]+$/u, '');
  const reconnect = /(?:重接|重新连接|迁移)(?:相关|原有)?连线/u.test(text);
  const rewrite = rewriteIntoNewNode(text);
  if (rewrite) return rewrite;
  const split = /^(?:把|将)\s*(.+?)\s*拆(?:分)?成\s*(.+?)(?:[二两三四五六七八九十\d]+\s*(?:张|个)(?:新卡|卡片?|节点)?)(?:[，,]\s*保留原卡)?(?:[，,]?\s*(?:并|再)?(?:重接|重新连接)(?:相关|原有)?连线)?$/u.exec(text);
  if (split) {
    const titles = naturalNames(split[2]!);
    if (titles.length >= 2 && titles.length <= 10 && new Set(titles.map(normalizeCanvasTitle)).size === titles.length) {
      return { names: [naturalName(split[1]!)], titles, reconnect };
    }
  }
  const merge = /^(?:把|将)\s*(.+?)\s*合并成\s*(?:一张(?:新卡)?(?:叫|名为)?\s*)?(.+?)(?:[，,]\s*保留原卡)?(?:[，,]?\s*(?:并|再)?(?:重接|重新连接)(?:相关|原有)?连线)?$/u.exec(text);
  if (merge) {
    const names = naturalNames(merge[1]!);
    const title = naturalName(merge[2]!);
    if (names.length >= 2 && names.length <= 10 && title.length <= 120) return { names, titles: [title], reconnect };
  }
  return undefined;
}

export async function prepareCardRestructure(
  context: PluginContext, task: RestructureTask, catalog: AIContextSource[], refs: AIInlineReference[],
  budget: { characters: number; tokens: number }, signal: AbortSignal,
): Promise<{ sources?: AIPreparedSource[]; restructure?: RestructureBinding; clarify?: string }> {
  const sources: AIPreparedSource[] = [];
  for (const name of task.names) {
    const ref = refs.find(item => naturalName(item.token) === name);
    const candidates = catalog.filter(source => source.kind === 'text' && (ref ? source.sourceId === ref.sourceId :
      source.automaticRetrieval !== false && canvasTitleAliases(source.title).includes(normalizeCanvasTitle(name))));
    if (candidates.length !== 1) return { clarify: `请用 @ 指定唯一的来源卡片「${name}」。` };
    const source = candidates[0]!;
    if (source.length > budget.characters || source.length > 8_192) return { clarify: `「${source.title}」正文超出拆合预算，请先指定需要处理的段落。` };
    const result = await readContextSource(context, { sourceId: source.sourceId, start: 0, length: source.length }, signal);
    const body = result.text ?? '';
    if (result.source?.revision !== source.revision || result.start !== 0 || body.length !== source.length) throw new Error('来源卡片已经变化，请重试。');
    const tokens = estimateAITokens(body);
    if (tokens > budget.tokens) return { clarify: '来源正文合计超出拆合预算，请分批处理。' };
    budget.characters -= body.length;
    budget.tokens -= tokens;
    sources.push({ ...source, start: 0, text: body, complete: true, boundary: 'range', reason: 'explicit-reference' });
  }
  const ids = sources.map(source => source.sourceId);
  if (new Set(ids).size !== ids.length) return { clarify: '请指定互不相同的来源卡片。' };
  if (sources.every(source => !source.text.trim())) return { clarify: '来源正文为空，请先指定有内容的卡片。' };
  return { sources, restructure: { ids, titles: task.titles, reconnect: task.reconnect } };
}

export function validateCardRestructurePlan(binding: RestructureBinding, plan: CanvasControlPlan, relations: CanvasAgentQueryResult['connections'] = []): void {
  const created = plan.actions.filter(action => action.type === 'create-node');
  const changes = plan.actions.filter(action => action.type === 'update-connection');
  const refs = new Set(created.map(action => action.ref));
  const titles = created.map(action => normalizeCanvasTitle(action.title));
  const incident = relations.filter(edge => binding.ids.includes(edge.from) !== binding.ids.includes(edge.to));
  if (created.length !== binding.titles.length || !binding.titles.every(title => titles.includes(normalizeCanvasTitle(title))) ||
    created.some(action => !action.text?.trim()) || plan.actions.length !== created.length + changes.length ||
    changes.length !== (binding.reconnect ? incident.length : 0)) {
    throw new Error('拆合计划须保留原卡，按指定标题新建卡片，并只调整本轮指定的相关连线。');
  }
  if (binding.reconnect && !incident.every(edge => {
    const change = changes.find(action => action.id === edge.id);
    if (!change || Object.keys(change).some(key => !['type', 'id', 'from', 'to'].includes(key))) return false;
    return binding.ids.includes(edge.from) ? refs.has(change.from ?? '') && (change.to === undefined || change.to === edge.to) :
      refs.has(change.to ?? '') && (change.from === undefined || change.from === edge.from);
  })) throw new Error('重接时仅把原卡一侧的端点改到新卡，保留另一端、方向、线型和标签。');
}
