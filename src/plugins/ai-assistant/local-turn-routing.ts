import type { PluginContext } from '../../core/contracts.ts';
import type { LocalLanguageResult } from '../../protocols/local-language.ts';
import { predictLocalIntent } from '../../services/local-intent-semantics.ts';
import { compileLocalClause, isLocalDiscussion, localInstructionContext, splitLocalInstruction } from './local-instruction-parser.ts';
import { isAbortError, isCapabilityUnavailable } from './runtime-errors.ts';
import type { AITurnRoute } from './turn-route.ts';

export interface LocalTurnInterpretation {
  instructions?: string[];
  expectedSelectionCount?: number;
  clarification?: string;
}

const CREATE_PREFIX = /^(?:在(?:当前)?画布上\s*)?(?:新建|创建|新增|造|制作|添加|做|建|搞|来|摆)\s*(?=[零一二两三四五六七八九十百\d]+\s*[张个份块])/u;
const COUNT_PREFIX = /^[零一二两三四五六七八九十百\d]+\s*[张个份块]/u;
const UNCLEAR = '我还不能可靠确定这句话要执行的动作。请说明要改哪些对象、做什么操作。';

async function classifyLocally(context: PluginContext, texts: string[], signal: AbortSignal) {
  try {
    const result = await context.capabilities.request<LocalLanguageResult>('language.embed@1', { texts }, signal);
    if (result.ready && result.vectors.length === texts.length) {
      return result.vectors.map(vector => predictLocalIntent(vector, result.modelId));
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (!isCapabilityUnavailable(error, 'language.embed@1')) context.diagnostics.warn('本地意图解析未就绪', error);
  }
  return undefined;
}

/** The current user text is the only authority. No canvas body is classified. */
export async function interpretLocalTurn(context: PluginContext, prompt: string, route: AITurnRoute, signal: AbortSignal): Promise<LocalTurnInterpretation> {
  if (route.applyItems || route.fieldTask || route.restructureTask || route.history || route.category === 'mixed' ||
    route.clarification || !['general', 'canvas-control'].includes(route.operation) || route.local?.kind === 'content') return {};
  if (route.local || route.interpretedSearch) return {};
  if (isLocalDiscussion(prompt) || prompt.length > 2000) return {};
  const clauses = splitLocalInstruction(prompt);
  const startsWithCreation = CREATE_PREFIX.test(clauses[0] ?? '');
  if (startsWithCreation && clauses.some(clause => /^(?:并|同时|再)?(?:为[^，。]{0,20})?(?:写|撰写|填|补写|设计|生成)(?:一段|一份|一篇|正文|内容|背景)/u.test(clause))) return {};
  if (!clauses.length || clauses.length > 16) return startsWithCreation ? { clarification: '请将本次画布操作拆成几组发送。' } : {};
  const describesGroup = (clause: string) => /(?:打组|分组)$/u.test(clause);
  const describesLink = (clause: string) => /连接|指向|连到/u.test(clause);
  const exactCreations = startsWithCreation && clauses.every((clause, index) =>
    CREATE_PREFIX.test(clause) || index > 0 && (COUNT_PREFIX.test(clause) || describesGroup(clause) || describesLink(clause)));
  const knownCanvas = route.category !== 'chat' || startsWithCreation;
  const whole = knownCanvas ? undefined : await classifyLocally(context, [prompt], signal);
  if (!knownCanvas) {
    const [intent] = whole ?? [];
    if (!intent || intent.kind === 'chat' || intent.kind === 'generate') return {};
    if (intent.score < 0.55 || intent.margin < 0.15) return route.readCanvas ? { clarification: UNCLEAR } : {};
  }
  const scores = exactCreations ? undefined : clauses.length === 1 && whole ? whole : await classifyLocally(context, clauses, signal);
  const slots = localInstructionContext();
  const instructions: string[] = [];
  for (const [index, clause] of clauses.entries()) {
    let kind: Parameters<typeof compileLocalClause>[1] | undefined;
    if (CREATE_PREFIX.test(clause)) kind = 'create';
    else if (slots.created.length && describesGroup(clause)) kind = 'group';
    else if (slots.created.length && describesLink(clause)) kind = 'connect';
    else if (slots.created.length && COUNT_PREFIX.test(clause)) kind = 'create';
    if (!kind) {
      const predicted = scores?.[index];
      if (!predicted) return instructions.length ? { clarification: UNCLEAR } : {};
      if (predicted.kind === 'generate' || predicted.kind === 'chat') return instructions.length ? { clarification: UNCLEAR } : {};
      if (predicted.score < 0.55 || predicted.margin < 0.15) return knownCanvas && !startsWithCreation ? {} : { clarification: UNCLEAR };
      kind = predicted.kind;
    }
    const compiled = compileLocalClause(clause, kind, slots);
    if (!compiled?.length) return !startsWithCreation && !instructions.length && knownCanvas ? {} : {
      clarification: '请补充要操作的对象、数量或具体改法，画布尚未修改。',
    };
    instructions.push(...compiled);
    if (instructions.length > 80) return { clarification: '这次超过 80 项操作，请分批发送。' };
  }
  return { instructions, expectedSelectionCount: slots.expectedSelectionCount };
}
