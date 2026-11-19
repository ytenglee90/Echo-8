import type { AIOperation, AIPreparedContext } from '../../protocols/ai.ts';
import type { CanvasControlPlan, CanvasCompoundTarget } from '../../protocols/canvas-control.ts';
import type { CanvasAgentQueryResult } from '../../protocols/canvas-agent.ts';
import {
  asksForCanvasContinuation, canvasCommandText, canvasControlPurpose, canvasIntentText, canvasRequestDisposition,
  isCanvasRepeatCreation, isCanvasStatusFollowup, isGeometryOnlyCanvasTask,
  naturalCanvasOperation, needsCanvasActionPlanning, needsCanvasCreationPlanning,
  needsCanvasSearchInterpretation, requestsCanvasHistory, reusesCanvasDraft,
} from '../../services/ai-task-route.ts';
import { naturalAIOperation } from './operations.ts';
import { exactHistoryRequest } from './conversation-recall.ts';
import { structuredFieldTask, type FieldTarget } from './structured-fields.ts';
import { cardRestructureTask, type RestructureBinding } from './card-restructure.ts';
import type { BoundCanvasWrite } from './bound-canvas-write.ts';
import { nativeCanvasIntent } from '../../services/native-canvas-intent.ts';
import { canvasCreationWithText } from './local-instruction-parser.ts';
import { readCompoundTurn, readDeferredCanvasTurn } from './compound-turn.ts';
import type { PersonalTurn } from './personal-preferences.ts';
import { isStandaloneConversation } from './context-intent.ts';
import { compileWorkspaceLanguage } from '../../services/workspace-language.ts';
import { workspaceControlClarification } from '../../services/workspace-controls.ts';
import { workspaceCatalogIntent } from '../../services/workspace-catalog-intent.ts';
import { readWorkspaceSequence } from '../../services/workspace-sequence-intent.ts';
import { isCurrentConversationArchiveRequest } from '../../services/conversation-archive-intent.ts';
import { isWorkspacePreviewRequest } from '../../services/workspace-structural-intent.ts';
import { isWorkspaceCommandRequest, needsSemanticCanvasParsing, localCanvasCoversModifiers } from '../../services/workspace-request-intent.ts';
import { workspaceRequirements } from '../../services/workspace-semantic-plan.ts';
import { isTextCompositionRequest, readTextComposition } from './text-composition.ts';

const OBJECT = /画布|卡(?:片)?|节点|文本框|群组|选区|连线|这条线|主题|背景|注释|批注|标注|导航栏|工具栏|编辑器|小地图|视图|缩放/u;
const ANALYSIS = /总结|概括|归纳|对比|比较|分析|检查|核对|找出|根据|结合|参考/u;
const APPLY = /写进|写入|填入|同步到|补上|改成|改为|恢复|连上|连起来|重接|高亮|拆成|合并|分列|移到|删除/u;
const MIXED_WRITE = /^([\s\S]*?)\s*(?:[，,；;]\s*|然后\s*|并\s*|再\s*)(?:(?:把|将)\s*(?:结果|总结|它)\s*)?(?:写进|写入|填入|同步到)\s*(.+?)\s*[。！!]?$/u;

export function mixedCanvasWrite(prompt: string) {
  const match = MIXED_WRITE.exec(prompt.replace(/^\s*@画布操作\s+/u, '').trim());
  return match && ANALYSIS.test(canvasCommandText(match[1]!)) ? { readPrompt: match[1]!, destination: match[2]! } : undefined;
}
const DISCUSSION = /(?:怎么|如何|怎样|是否|有什么|有哪些|建议|能否|能不能|可不可以)/u;
const IMPLICIT_CANVAS_QUESTION = /(?:这|那)(?:两|二|三|四|五|几|\d+)张.{0,12}(?:怎么排|如何排列)|(?:哪张|哪条).{0,10}(?:太暗|太亮|颜色)/u;
const NO_MEMORY = /(?:不(?:要|用)|别|无需|禁止)(?:再|去)?(?:用|使用|读取|搜索|检索|参考|回查|查)?(?:我(?:们)?的)?(?:长期记忆|历史(?:记忆|记录)?|旧对话|过去的对话)/u;

export function classifyAITurn(prompt: string, explicit?: AIOperation, requested: AIOperation = 'general') {
  const textComposition = readTextComposition(prompt);
  const compositionCandidate = Boolean(textComposition) || isTextCompositionRequest(prompt);
  const restructureTask = cardRestructureTask(prompt);
  const text = canvasCommandText(prompt).replace(/「[^」\r\n]+」|『[^』\r\n]+』|“[^”\r\n]+”|"[^"\r\n]+"/gu, ' □ ').trim();
  const parsedLocal = naturalCanvasOperation(prompt);
  const semanticFallback = needsSemanticCanvasParsing(prompt, parsedLocal);
  const local = semanticFallback || compositionCandidate ? undefined : parsedLocal;
  const disposition = canvasRequestDisposition(prompt);
  const allowsWorkspace = !explicit || explicit === 'general' || explicit === 'canvas-control' || Boolean(restructureTask) || compositionCandidate;
  const archiveSession = allowsWorkspace &&
    isCurrentConversationArchiveRequest(prompt);
  const compound = !compositionCandidate && disposition !== 'read-only' && allowsWorkspace
    ? readDeferredCanvasTurn(prompt) ?? readCompoundTurn(prompt) : undefined;
  const candidate = nativeCanvasIntent(prompt);
  const nativeCandidate = !compositionCandidate && (disposition === 'normal' || candidate?.kind === 'connection-inspect') ? candidate : undefined;
  const copyIntent = nativeCandidate?.kind === 'copy' ? workspaceCatalogIntent(prompt) : undefined;
  const native = copyIntent?.steps[0]?.selection && copyIntent.steps[0].action === 'clipboard.copy' ? undefined : nativeCandidate;
  const workspaceSteps = !compositionCandidate && !native && !compound && disposition === 'normal' && allowsWorkspace
    ? compileWorkspaceLanguage(prompt) : undefined;
  const canUseCatalog = !compositionCandidate && !native && !compound && !workspaceSteps && allowsWorkspace;
  const sequence = canUseCatalog && !copyIntent ? readWorkspaceSequence(prompt) : undefined;
  const catalogCandidate = canUseCatalog
    ? copyIntent ?? (sequence?.matched ? sequence.intent : workspaceCatalogIntent(prompt)) : undefined;
  // A direct named group plan already supplies the group reference for later turns.
  const catalogIntent = local?.kind === 'group' && disposition === 'normal' && catalogCandidate?.binding === 'members' &&
    !isWorkspacePreviewRequest(text) ? undefined : catalogCandidate;
  const repeatCreation = isCanvasRepeatCreation(prompt);
  const revisePending = /^(?:取消(?:这次|刚才的|待应用的)?(?:画布)?(?:计划|操作|修改)|放弃(?:这份|刚才的)(?:计划|预览))[。！!]?$/u.test(text)
    ? 'cancel' as const : /^(?:先别删|先不要删|取消删除|保留(?:要删的)?节点)[。！!]?$/u.test(text) ? 'keep-nodes' as const : undefined;
  const contentOperation = naturalAIOperation(prompt);
  const interpretedSearch = needsCanvasSearchInterpretation(prompt);
  const itemList = /^(?:(?:请|帮我)\s*)?(?:只|仅)?应用\s*第?\s*(\d+(?:\s*(?:[、，,和及与]|以及)\s*第?\s*\d+)*)\s*项[。！!]?$/u.exec(text);
  const applyItems = itemList?.[1]?.match(/\d+/gu)?.map(Number);
  const fieldTask = structuredFieldTask(prompt);
  const creationText = !compositionCandidate && !local ? canvasCreationWithText(prompt) : undefined;
  const canvas = OBJECT.test(text) || /@\[|@node:/u.test(prompt);
  const prospective = disposition === 'read-only' || disposition === 'preview' && !local ||
    !local && /^(?:如果|假如|假设|要是|先别|先不要|不要|别|不用|暂不)/u.test(canvasIntentText(text));
  const combined = !prospective && ANALYSIS.test(text) &&
    /(?:[，,；;]|之后|后|然后|再|并|并且)(?:\s*(?:把|将)?(?:结果|总结|命中项)?\s*)[^。！？?]{0,30}/u.test(text) &&
    APPLY.test(text.slice(text.search(/总结|概括|归纳|对比|比较|分析|检查|核对|找出|根据|结合|参考/u))) &&
    (canvas || /连上|连起来/u.test(text));
  const writeDestination = !prospective && /^(?:请\s*|帮我\s*)?(?:总结|概括|归纳|对比|比较|分析|检查|根据|结合|参考)[\s\S]*?(?:写进|写入|填入|同步到)\s*(?:[^。？！]{1,120}(?:卡|节点|文本框)|□)/u.test(text);
  const createsResultNode = /(?:写入|输出|保存|另存)(?:为|成|到)(?:(?:一个|一张)?(?:名为|叫)\s*□\s*(?:的)?|(?:一个|一张)?(?:独立的)?)新节点[。！!]?$/u.test(text);
  const mixed = !local && !createsResultNode && (combined || writeDestination);
  const referencedMove = /^(?:把|将)?\s*(?:刚才那张|刚才那个|这张卡|它)\s*(?:再)?(?:挪|移)/u.test(text);
  const restore = /^(?:请\s*|帮我\s*)?恢复第\s*\d+\s*轮/u.test(text);
  const writeCommand = local || native || applyItems || fieldTask || restructureTask || interpretedSearch || restore || repeatCreation || needsCanvasCreationPlanning(prompt) ||
    (!contentOperation && needsCanvasActionPlanning(prompt)) || referencedMove || /^(?:请\s*|帮我\s*)?(?:带我去|跳到)\S/u.test(text);
  const openCanvasTask = !prospective && canvas && /^(?:请\s*|帮我\s*)?(?:给|把|将|恢复|同步|按|沿|找出)/u.test(text) &&
    APPLY.test(text) && !DISCUSSION.test(text);
  // Keep requests such as “让那位…的资料更完整，并和新场景建立联系” on the plan path.
  const indirectTask = !prospective && !DISCUSSION.test(text) &&
    (/^(?:请\s*|帮我\s*)?让.{1,90}(?:资料|正文|设定).{0,50}(?:更完整|补充|建立联系)/u.test(text) ||
      /落实到画布|^让(?:当前)?画布.{0,12}出现|换成.{0,60}关系改成/u.test(text));
  const workspaceRequest = !contentOperation && disposition === 'normal' && (semanticFallback || isWorkspaceCommandRequest(prompt));
  const uncompiledWorkspace = workspaceRequest && !local && !native && !workspaceSteps && !catalogIntent && !compound &&
    !fieldTask && !restructureTask && !creationText && !repeatCreation && !interpretedSearch;
  const requirements = workspaceRequirements(prompt);
  const incompleteSequence = workspaceRequest && requirements.length > 1 && !localCanvasCoversModifiers(prompt, parsedLocal, requirements.map(req => req.text)) && !workspaceSteps && !catalogIntent &&
    !compound && !restructureTask && !creationText && parsedLocal?.kind !== 'create';
  const operation = revisePending || isCanvasStatusFollowup(prompt) ? 'general'
    : (restructureTask || compositionCandidate) && disposition === 'normal' ? 'canvas-control'
    : catalogIntent || archiveSession || native?.kind === 'connection-inspect' ? 'canvas-control' : disposition === 'read-only' ? 'general'
    : workspaceSteps || compound ? 'canvas-control' : disposition === 'preview' && !local ? 'general'
    : prospective && (!explicit || explicit === 'canvas-control') ? contentOperation ?? 'general' : explicit ?? (writeCommand || mixed || (!contentOperation && openCanvasTask) || indirectTask || workspaceRequest ? 'canvas-control'
    : requested !== 'general' ? requested : contentOperation ?? 'general');
  const category = operation === 'canvas-control' ? (compound && !compound.deferred || mixed && !interpretedSearch) ? 'mixed' : 'operation' : 'chat';
  const excludesHistory = NO_MEMORY.test(text);
  const standalone = category === 'chat' && isStandaloneConversation(prompt);
  const history = !excludesHistory && !standalone && Boolean(requestsCanvasHistory(prompt) || exactHistoryRequest(text));
  const draft = category !== 'chat' && !history && reusesCanvasDraft(prompt);
  const continuation = local?.kind === 'arrange-followup' || asksForCanvasContinuation(prompt);
  const geometryOnly = category === 'operation' && !history && isGeometryOnlyCanvasTask(prompt);
  const lookupOnly = category === 'operation' && (interpretedSearch ||
    Boolean(local && ['find', 'relations', 'filter', 'search', 'narrow', 'shortest-path', 'audit-names'].includes(local.kind)));
  const mechanical = geometryOnly || lookupOnly || Boolean(category === 'operation' && native) || local?.kind === 'arrange-followup' || (category === 'operation' && !history && !draft && !continuation &&
    Boolean(local && ['color', 'background', 'theme', 'line', 'connect', 'rename', 'presentation', 'group', 'group-add', 'group-remove', 'ungroup'].includes(local.kind)));
  const insertion = /^(?:把|将)?\s*.{1,120}?\s*插入(?:到)?\s*.{1,120}?\s*(?:中|里面|里)[。！!]?$/u.test(canvasCommandText(prompt)) &&
    !/正文|文本|文字|内容|引用|链接|群组|分组/u.test(text);
  const ambiguousClear = /^(?:删除|删掉|清空|清除)(?:所有|全部)(?:的)?内容[。！!]?$/u.test(text);
  const controlClarification = workspaceControlClarification(prompt);
  const clarification = controlClarification ? controlClarification : ambiguousClear ? '你要清空选中卡片的正文，还是删除当前画布全部对象？请明确范围；删除前会显示确认预览，画布尚未修改。'
    : insertion ? '“插入”需要明确方式：将来源卡正文追加到目标卡、建立引用连线，还是加入群组？请选择一种；画布尚未修改。'
    : (!explicit || explicit === 'general') && !writeCommand && !mixed && /^(?:(?:请|帮我)\s*)?(?:处理|弄|改|收|整理)一下\s*(?:这个|它|这张卡|这张卡片)?[。！!]?$/u.test(text)
    ? '你希望我在画布上修改什么，还是先讨论怎么改？' : undefined;
  return {
    category, operation, local: incompleteSequence ? undefined : local,
    semanticFallback: uncompiledWorkspace || incompleteSequence || semanticFallback && !workspaceSteps && !catalogIntent && !native && !compound,
    disposition, repeatCreation, native: category === 'operation' && !incompleteSequence ? native : undefined, history, draft, continuation, mechanical, geometryOnly, interpretedSearch, lookupOnly,
    excludesHistory, revisePending, workspaceSteps, archiveSession, catalogIntent: operation === 'canvas-control' ? catalogIntent : undefined,
    compound: operation === 'canvas-control' ? compound : undefined,
    readCanvas: category !== 'chat' || !standalone && (canvas || IMPLICIT_CANVAS_QUESTION.test(text) || /(?:这两张|这三张|它们).{0,10}(?:怎么连|如何连接)/u.test(text)),
    purpose: category === 'mixed' ? 'general' as const : canvasControlPurpose(prompt),
    clarification, applyItems, fieldTask, restructureTask, creationText, textComposition, compositionCandidate,
  } as const;
}

export type AITurnRoute = ReturnType<typeof classifyAITurn>;

export interface TurnAssembly {
  route: AITurnRoute;
  localInstructions?: string[];
  localSourceIds?: string[];
  expectedSelectionCount?: number;
  nativeSelection?: string[];
  conversationDraft?: { firstSentence?: string; maxCharacters?: number };
  contentTargetId?: string;
  explicitCanvasIds?: string[];
  canvasDraftBound?: boolean;
  boundCanvasWrite?: BoundCanvasWrite;
  textDraft?: string;
  compositionWriteTarget?: FieldTarget;
  compoundTargets?: CanvasCompoundTarget[];
  personalTurn?: PersonalTurn;
  recoveryPrompt?: string;
  destinationId?: string;
  readIds?: string[];
  clarify?: string;
  localReply?: string;
  fields?: FieldTarget[];
  field?: string;
  fixedPlan?: CanvasControlPlan;
  restructure?: RestructureBinding;
  relations?: CanvasAgentQueryResult['connections'];
  ownerId?: string;
  refreshed?: boolean;
  workspaceLocalPrompt?: string;
  fallbackToModel?: boolean;
  workspacePlanId?: string;
}

// Preparation objects are short-lived and never serialize the routing state into a book.
const assemblies = new WeakMap<AIPreparedContext, TurnAssembly>();

export function rememberTurnAssembly(prepared: AIPreparedContext, assembly: TurnAssembly): AIPreparedContext {
  assemblies.set(prepared, assembly);
  return prepared;
}

export function turnAssembly(prepared: AIPreparedContext): TurnAssembly {
  let assembly = assemblies.get(prepared);
  if (!assembly) {
    assembly = { route: classifyAITurn(prepared.prompt, undefined, prepared.operation) };
    assemblies.set(prepared, assembly);
  }
  return assembly;
}

export function canvasTurnId(prepared: AIPreparedContext): string {
  return turnAssembly(prepared).ownerId ?? prepared.id;
}

export function isCanvasReceiptTurn(prepared: AIPreparedContext): boolean {
  const assembly = turnAssembly(prepared);
  return Boolean(assembly.localReply || assembly.route.archiveSession || assembly.route.native || assembly.route.workspaceSteps ||
    assembly.route.catalogIntent || assembly.workspaceLocalPrompt);
}
