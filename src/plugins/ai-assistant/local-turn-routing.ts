import type { PluginContext } from '../../core/contracts.ts';
import type { LocalLanguageResult } from '../../protocols/local-language.ts';
import type { AIProviderCatalog } from '../../protocols/ai.ts';
import { predictLocalIntent } from '../../services/local-intent-semantics.ts';
import { compileLocalClause, isLocalDiscussion, LOCAL_GROUP_CLAUSE, localInstructionContext, splitLocalInstruction } from './local-instruction-parser.ts';
import { isAbortError, isCapabilityUnavailable } from './runtime-errors.ts';
import type { AITurnRoute } from './turn-route.ts';
import { isNearConversationFollowup, isStandaloneConversation } from './context-intent.ts';
import { canvasIntentText, isCanvasStatusFollowup, naturalCanvasOperation } from '../../services/ai-task-route.ts';
import { MAX_LOCAL_CREATIONS } from './creation-batches.ts';
import { conversationDraftRequest } from './conversation-recall.ts';
import { isCanvasFailureFollowup } from './canvas-recovery.ts';

export interface LocalTurnInterpretation {
  instructions?: string[];
  expectedSelectionCount?: number;
  clarification?: string;
}

const CREATE_PREFIX = /^(?:在(?:当前)?画布上\s*)?(?:新建|创建|新增|造|制作|添加|做|建|搞|来|摆)\s*(?=[零一二两三四五六七八九十百\d]+\s*[张个份块])/u;
const GENERATE_PREFIX = /^(?:在(?:当前)?画布上\s*)?生成\s*(?=[零一二两三四五六七八九十百\d]+\s*[张个份块])/u;
const COUNT_PREFIX = /^[零一二两三四五六七八九十百\d]+\s*[张个份块]/u;
const UNCLEAR = '我还不能可靠确定这句话要执行的动作。请说明要改哪些对象、做什么操作。';
export const LOCAL_LANGUAGE_TIMEOUT_MS = 3 * 60_000;

async function classifyLocally(context: PluginContext, texts: string[], signal: AbortSignal) {
  try {
    const result = await context.capabilities.request<LocalLanguageResult>('language.embed@1', { texts }, signal);
    signal.throwIfAborted();
    if (result.ready && result.vectors.length === texts.length) {
      return result.vectors.map(vector => predictLocalIntent(vector, result.modelId));
    }
  } catch (error) {
    signal.throwIfAborted();
    if (isAbortError(error)) throw error;
    if (!isCapabilityUnavailable(error, 'language.embed@1')) context.diagnostics.warn('本地意图解析未就绪', error);
  }
  return undefined;
}

const describesGroup = (clause: string) => LOCAL_GROUP_CLAUSE.test(clause);
const describesLink = (clause: string) => /连接|指向|连到/u.test(clause);
const operationLimit = (instructions: string[]) => instructions.length > 512 || instructions.filter(text => naturalCanvasOperation(text)?.kind === 'create').length > MAX_LOCAL_CREATIONS
  ? `本次解析为 ${instructions.length} 项操作，新建最多支持 ${MAX_LOCAL_CREATIONS} 个节点及其分组和连线。画布尚未修改。`
  : instructions.length > 80 && instructions.some(text => !['create', 'group', 'connect', 'connect-many'].includes(naturalCanvasOperation(text)?.kind ?? ''))
    ? `本次解析为 ${instructions.length} 项操作。包含分组、连线或已有对象修改时，最多支持 80 项原子操作；独立新建可自动分批。画布尚未修改。` : undefined;

function explicitClauseKind(clause: string, hasCreated: boolean, generateBatch: boolean): 'create' | 'group' | 'connect' | undefined {
  if (CREATE_PREFIX.test(clause) || generateBatch && GENERATE_PREFIX.test(clause)) return 'create';
  if (!hasCreated) return undefined;
  if (describesGroup(clause)) return 'group';
  if (describesLink(clause)) return 'connect';
  if (COUNT_PREFIX.test(clause)) return 'create';
  return undefined;
}

function localTurnInput(prompt: string, route: AITurnRoute) {
  const clauses = splitLocalInstruction(canvasIntentText(prompt));
  const generateBatch = clauses.length > 1 && GENERATE_PREFIX.test(clauses[0]!) &&
    clauses.slice(1).every(clause => explicitClauseKind(clause, true, true));
  const startsWithCreation = CREATE_PREFIX.test(clauses[0] ?? '') || generateBatch;
  const compoundCreation = startsWithCreation && clauses.length > 1 &&
    !clauses.slice(1).some(clause => /^(?:叫|就叫|名为|命名为|标题(?:是|为))/u.test(clause));
  if (route.workspaceSteps || route.catalogIntent || route.applyItems || route.fieldTask || route.restructureTask || route.creationText || route.history || route.category === 'mixed' ||
    route.disposition !== 'normal' || route.repeatCreation || isCanvasStatusFollowup(prompt) || isCanvasFailureFollowup(prompt) ||
    route.clarification || !['general', 'canvas-control'].includes(route.operation) || route.local && !compoundCreation || route.native ||
    route.interpretedSearch || isLocalDiscussion(prompt) ||
    route.category === 'chat' && (isStandaloneConversation(prompt) || isNearConversationFollowup(prompt) || conversationDraftRequest(prompt)) || prompt.length > 2000) return undefined;
  if (startsWithCreation && clauses.some(clause => /^(?:并|同时|再)?(?:为[^，。]{0,20})?(?:写|撰写|填|补写|设计|生成)(?:一段|一份|一篇|正文|内容|背景)/u.test(clause))) return undefined;
  const exactCreations = startsWithCreation && clauses.every((clause, index) => explicitClauseKind(clause, index > 0, generateBatch));
  return { clauses, startsWithCreation, exactCreations, generateBatch };
}

export function mayUseLocalLanguage(prompt: string, route: AITurnRoute): boolean {
  const input = localTurnInput(prompt, route);
  return Boolean(input && !compileWithoutModel(input) && input.clauses.length > 0 && input.clauses.length <= 16);
}

export function canCompileLocalCreation(prompt: string, route: AITurnRoute): boolean {
  const input = localTurnInput(prompt, route);
  return Boolean(input && compileWithoutModel(input)?.instructions);
}

/** Compile complete clauses before preparing even the optional on-device model. */
function compileWithoutModel(input: NonNullable<ReturnType<typeof localTurnInput>>): LocalTurnInterpretation | undefined {
  if (!input.clauses.length || input.clauses.length > 16) return undefined;
  const slots = localInstructionContext();
  const instructions: string[] = [];
  for (const clause of input.clauses) {
    const kind = explicitClauseKind(clause, slots.created.length > 0, input.generateBatch);
    const kinds = kind ? [kind] : ['color', 'move', 'connect', 'group', 'ungroup', 'line', 'rename', 'remove', 'presentation'] as const;
    let compiled: string[] | undefined;
    for (const kind of kinds) {
      compiled = compileLocalClause(clause, kind, slots);
      if (compiled?.length) break;
    }
    if (!compiled?.length) return undefined;
    instructions.push(...compiled);
    if (instructions.length > 512) return { clarification: operationLimit(instructions) };
  }
  const clarification = operationLimit(instructions);
  return clarification ? { clarification } : { instructions, expectedSelectionCount: slots.expectedSelectionCount };
}

export function compileLocalInstructions(prompt: string, route: AITurnRoute): LocalTurnInterpretation | undefined {
  const input = localTurnInput(prompt, route);
  return input && compileWithoutModel(input);
}

/** The current user text is the only authority. No canvas body is classified. */
export async function interpretLocalTurn(context: PluginContext, prompt: string, route: AITurnRoute, signal: AbortSignal, providerId?: string): Promise<LocalTurnInterpretation> {
  const input = localTurnInput(prompt, route);
  if (!input) return {};
  if (!input.clauses.length || input.clauses.length > 16) {
    return input.startsWithCreation ? { clarification: '请将本次画布操作拆成几组发送。' } : {};
  }
  const compiled = compileWithoutModel(input);
  if (compiled) return compiled;
  if (input.exactCreations) return interpretLocalClauses(context, prompt, route, input, signal);
  if (route.operation === 'canvas-control') {
    let providers: AIProviderCatalog | undefined;
    try { providers = await context.capabilities.request<AIProviderCatalog>('ai.provider.catalog@1', undefined, signal); } catch { signal.throwIfAborted(); }
    signal.throwIfAborted();
    if (Array.isArray(providers?.options) && providers.options.some(option => option.id === (providerId ?? providers.activeId) && option.configured)) return {};
  }
  const deadline = AbortSignal.timeout(LOCAL_LANGUAGE_TIMEOUT_MS);
  try {
    return await interpretLocalClauses(context, prompt, route, input, AbortSignal.any([signal, deadline]));
  } catch (error) {
    signal.throwIfAborted();
    if (!deadline.aborted) throw error;
    throw new Error('本地语义模型未能及时就绪，请检查模型资源连接后重试。', { cause: error });
  }
}

async function interpretLocalClauses(
  context: PluginContext,
  prompt: string,
  route: AITurnRoute,
  { clauses, startsWithCreation, exactCreations, generateBatch }: NonNullable<ReturnType<typeof localTurnInput>>,
  signal: AbortSignal,
): Promise<LocalTurnInterpretation> {
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
    let kind: Parameters<typeof compileLocalClause>[1] | undefined = explicitClauseKind(clause, slots.created.length > 0, generateBatch);
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
    if (instructions.length > 512) return { clarification: operationLimit(instructions) };
  }
  const clarification = operationLimit(instructions);
  return clarification ? { clarification } : { instructions, expectedSelectionCount: slots.expectedSelectionCount };
}
