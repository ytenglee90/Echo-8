import type { AIOperation, AIPreparedContext } from '../../protocols/ai.ts';
import type { CanvasControlPlan } from '../../protocols/canvas-control.ts';
import type { CanvasAgentQueryResult } from '../../protocols/canvas-agent.ts';
import {
  asksForCanvasContinuation, canvasCommandText, canvasControlPurpose, isGeometryOnlyCanvasTask,
  naturalCanvasOperation, needsCanvasActionPlanning, needsCanvasCreationPlanning,
  needsCanvasSearchInterpretation, requestsCanvasHistory, reusesCanvasDraft,
} from '../../services/ai-task-route.ts';
import { naturalAIOperation } from './operations.ts';
import { exactHistoryRequest } from './conversation-recall.ts';
import { structuredFieldTask, type FieldTarget } from './structured-fields.ts';
import { cardRestructureTask, type RestructureBinding } from './card-restructure.ts';

const OBJECT = /画布|卡(?:片)?|节点|文本框|群组|选区|连线|这条线/u;
const ANALYSIS = /总结|概括|归纳|对比|比较|分析|检查|核对|找出|根据|结合|参考/u;
const APPLY = /写进|写入|填入|同步到|补上|改成|改为|恢复|连上|连起来|重接|高亮|拆成|合并|分列|移到|删除/u;
const MIXED_WRITE = /^([\s\S]*?)\s*(?:[，,；;]\s*|然后\s*|并\s*|再\s*)(?:(?:把|将)\s*(?:结果|总结|它)\s*)?(?:写进|写入|填入|同步到)\s*(.+?)\s*[。！!]?$/u;

export function mixedCanvasWrite(prompt: string) {
  const match = MIXED_WRITE.exec(prompt.replace(/^\s*@画布操作\s+/u, '').trim());
  return match && ANALYSIS.test(canvasCommandText(match[1]!)) ? { readPrompt: match[1]!, destination: match[2]! } : undefined;
}
const DISCUSSION = /(?:怎么|如何|怎样|是否|有什么|有哪些|建议|能否|能不能|可不可以)/u;

export function classifyAITurn(prompt: string, explicit?: AIOperation, requested: AIOperation = 'general') {
  const text = canvasCommandText(prompt).replace(/「[^」\r\n]+」|『[^』\r\n]+』|“[^”\r\n]+”|"[^"\r\n]+"/gu, ' □ ').trim();
  const local = naturalCanvasOperation(prompt);
  const contentOperation = naturalAIOperation(prompt);
  const interpretedSearch = needsCanvasSearchInterpretation(prompt);
  const itemList = /^(?:(?:请|帮我)\s*)?(?:只|仅)?应用\s*第?\s*(\d+(?:\s*(?:[、，,和及与]|以及)\s*第?\s*\d+)*)\s*项[。！!]?$/u.exec(text);
  const applyItems = itemList?.[1]?.match(/\d+/gu)?.map(Number);
  const fieldTask = structuredFieldTask(prompt);
  const restructureTask = cardRestructureTask(prompt);
  const canvas = OBJECT.test(text) || /@\[|@node:/u.test(prompt);
  const prospective = /^(?:如果|假如|假设|先别|先不要|不要|别)/u.test(text.replace(/^请\s*/u, ''));
  const combined = !prospective && ANALYSIS.test(text) &&
    /(?:[，,；;]|之后|后|然后|再|并|并且)(?:\s*(?:把|将)?(?:结果|总结|命中项)?\s*)[^。！？?]{0,30}/u.test(text) &&
    APPLY.test(text.slice(text.search(/总结|概括|归纳|对比|比较|分析|检查|核对|找出|根据|结合|参考/u))) &&
    (canvas || /连上|连起来/u.test(text));
  const writeDestination = !prospective && /^(?:请\s*|帮我\s*)?(?:总结|概括|归纳|对比|比较|分析|检查|根据|结合|参考)[\s\S]*?(?:写进|写入|填入|同步到)\s*(?:[^。？！]{1,120}(?:卡|节点|文本框)|□)/u.test(text);
  const createsResultNode = /(?:写入|输出|保存|另存)(?:为|成|到)(?:(?:一个|一张)?(?:名为|叫)\s*□\s*(?:的)?|(?:一个|一张)?(?:独立的)?)新节点[。！!]?$/u.test(text);
  const mixed = !local && !createsResultNode && (combined || writeDestination);
  const referencedMove = /^(?:把|将)?\s*(?:刚才那张|刚才那个|这张卡|它)\s*(?:再)?(?:挪|移)/u.test(text);
  const restore = /^(?:请\s*|帮我\s*)?恢复第\s*\d+\s*轮/u.test(text);
  const writeCommand = local || applyItems || fieldTask || restructureTask || interpretedSearch || restore || needsCanvasCreationPlanning(prompt) ||
    (!contentOperation && needsCanvasActionPlanning(prompt)) || referencedMove || /^(?:请\s*|帮我\s*)?(?:带我去|跳到)\S/u.test(text);
  const openCanvasTask = !prospective && canvas && /^(?:请\s*|帮我\s*)?(?:给|把|将|恢复|同步|按|沿|找出)/u.test(text) &&
    APPLY.test(text) && !DISCUSSION.test(text);
  // Keep requests such as “让那位…的资料更完整，并和新场景建立联系” on the plan path.
  const indirectTask = !prospective && !DISCUSSION.test(text) &&
    (/^(?:请\s*|帮我\s*)?让.{1,90}(?:资料|正文|设定).{0,50}(?:更完整|补充|建立联系)/u.test(text) ||
      /落实到画布|^让(?:当前)?画布.{0,12}出现|换成.{0,60}关系改成/u.test(text));
  const operation = explicit ?? (writeCommand || mixed || (!contentOperation && openCanvasTask) || indirectTask ? 'canvas-control'
    : requested !== 'general' ? requested : contentOperation ?? 'general');
  const category = operation === 'canvas-control' ? mixed && !interpretedSearch ? 'mixed' : 'operation' : 'chat';
  const history = requestsCanvasHistory(prompt) || exactHistoryRequest(text);
  const draft = category !== 'chat' && !history && reusesCanvasDraft(prompt);
  const continuation = asksForCanvasContinuation(prompt);
  const geometryOnly = category === 'operation' && !history && isGeometryOnlyCanvasTask(prompt);
  const lookupOnly = category === 'operation' && (interpretedSearch ||
    Boolean(local && ['find', 'relations', 'filter', 'search', 'narrow', 'shortest-path', 'audit-names'].includes(local.kind)));
  const mechanical = geometryOnly || lookupOnly || (category === 'operation' && !history && !draft && !continuation &&
    Boolean(local && ['color', 'background', 'theme', 'line', 'connect', 'rename', 'presentation', 'group', 'group-add', 'group-remove', 'ungroup'].includes(local.kind)));
  const clarification = !explicit && !writeCommand && !mixed && /^(?:(?:请|帮我)\s*)?(?:处理|弄|改)一下\s*(?:这个|它|这张卡|这张卡片)?[。！!]?$/u.test(text)
    ? '你希望我在画布上修改什么，还是先讨论怎么改？' : undefined;
  return {
    category, operation, local, history, draft, continuation, mechanical, geometryOnly, interpretedSearch, lookupOnly,
    readCanvas: category !== 'chat' || canvas || /(?:这两张|这三张|它们).{0,10}(?:怎么连|如何连接)/u.test(text),
    purpose: category === 'mixed' ? 'general' as const : canvasControlPurpose(prompt),
    clarification, applyItems, fieldTask, restructureTask,
  } as const;
}

export type AITurnRoute = ReturnType<typeof classifyAITurn>;

export interface TurnAssembly {
  route: AITurnRoute;
  destinationId?: string;
  readIds?: string[];
  clarify?: string;
  fields?: FieldTarget[];
  field?: string;
  fixedPlan?: CanvasControlPlan;
  restructure?: RestructureBinding;
  relations?: CanvasAgentQueryResult['connections'];
  ownerId?: string;
  refreshed?: boolean;
}

// Preparation objects are short-lived and never serialize the routing state into a book.
const assemblies = new WeakMap<AIPreparedContext, TurnAssembly>();

export function rememberTurnAssembly(prepared: AIPreparedContext, assembly: TurnAssembly): AIPreparedContext {
  assemblies.set(prepared, assembly);
  return prepared;
}

export function turnAssembly(prepared: AIPreparedContext): TurnAssembly {
  return assemblies.get(prepared) ?? { route: classifyAITurn(prepared.prompt, undefined, prepared.operation) };
}

export function canvasTurnId(prepared: AIPreparedContext): string {
  return turnAssembly(prepared).ownerId ?? prepared.id;
}
