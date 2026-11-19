import { isRecord } from '../../core/contracts.ts';
import type { AIOperation } from '../../protocols/ai.ts';
import type { WorkspaceActionDescriptor } from '../../protocols/workspace-actions.ts';
import { naturalName, NATURAL_QUOTED_NAME } from '../../services/natural-canvas-rules.ts';
import { workspaceRequestText } from '../../services/workspace-request-intent.ts';
import { workspaceRequirements } from '../../services/workspace-semantic-plan.ts';

export interface TextCompositionTask {
  operation: AIOperation;
  sourceNames: string[];
  sourceIds?: string[];
  sourceRevisions?: Record<string, number>;
  title?: string;
  instruction: string;
  reuseDraft?: boolean;
  draftOnly?: boolean;
  destinationId?: string;
  writeMode?: 'append' | 'replace';
}

export function textCompositionSteps(task: TextCompositionTask) {
  return [
    { id: 'new-node', kind: 'create-node', title: task.title ?? '' },
    { id: 'body', kind: 'transform-text', operation: task.operation, sourceIds: task.sourceIds ?? [], sourceNames: task.sourceNames, instruction: task.instruction },
    { id: 'write', kind: 'fill-node', targetFrom: 'new-node', textFrom: 'body' },
  ];
}

const OPERATIONS: Record<string, AIOperation> = { 改写: 'rewrite', 重写: 'rewrite', 润色: 'polish', 扩写: 'expand', 续写: 'expand',
  缩写: 'shorten', 精简: 'shorten', 缩短: 'shorten', 总结: 'summarize', 概括: 'summarize', 翻译: 'translate', 创作: 'general', 生成: 'general' };
const VERB = Object.keys(OPERATIONS).join('|');
const NODE = '(?:节点|卡片|文本框|卡)';
const CREATE = new RegExp(`^(?:(?:用|使用)(?:一个|一张)?新(?:的)?${NODE}(?:来)?(?:插入|填入|写入|保存|存放|装入)(?:内容|结果|正文|改写结果)?|(?:新建|创建|新增)(?:的)?(?:一个|一张)?(?:新(?:的)?)?${NODE}(?:的)?(?:插入|填入|写入|保存)?(?:内容|结果|正文)?|(?:写入|填入|保存到|输出到?)(?:一个|一张)?新(?:的)?${NODE}(?:内容|结果)?)$`, 'u');
const DESTINATION = new RegExp(`(?:(?:新|新建|创建|新增)(?:的)?(?:一个|一张)?${NODE}|(?:新建|创建|新增)(?:一个|一张)?(?:名为|叫)|另(?:建|存)|另外(?:建|创建))`, 'u');
const literal = new RegExp(NATURAL_QUOTED_NAME + '|@\\[[^\\]\\r\\n]+\\](?:\\([^)]*\\))?', 'gu');
const safeName = (value: string) => value && value.length <= 120 && !/[\r\n\u0000]/u.test(value);
const clean = (text: string) => workspaceRequestText(text).replace(/^(?:然后|接着|随后|并且|同时|并|再)\s*/u, '').trim();

/** A bounded text-to-new-object request; quoted story text never authorizes an operation. */
export function isTextCompositionRequest(prompt: string): boolean {
  const text = clean(prompt.replace(literal, '□'));
  if (/^(?:先别|不要|别|不用|暂不|如果|假如|假设|如何|怎么|为什么|解释|讨论)/u.test(text) || /(?:只讨论|不执行|不要执行|是什么意思)/u.test(text)) return false;
  return text.length <= 2_000 && DESTINATION.test(text) &&
    (new RegExp(VERB, 'u').test(text) || /(?:正文|内容|结果|草稿|成稿).{0,12}(?:放|装|填|写|存)|(?:放|装|填|写|存).{0,12}(?:正文|内容|结果|草稿|成稿)/u.test(text));
}

/** Consume every clause, including destination fields. Unconsumed requirements go to semantic parsing. */
export function readTextComposition(prompt: string): TextCompositionTask | undefined {
  if (!isTextCompositionRequest(prompt)) return undefined;
  const clauses = workspaceRequirements(clean(prompt)).map(req => clean(req.text));
  if (clauses.length < 2 || clauses.length > 6) return undefined;
  let title: string | undefined, source: string | undefined, operation: AIOperation | undefined;
  let create = false, reuseDraft = false, draftOnly = false;
  for (const clause of clauses) {
    const name = /^(?:标题|名称|名字)(?:为|是|叫|设为|设置为|[：:])\s*[：:]?\s*(.+)$/u.exec(clause);
    if (name && title === undefined) { title = naturalName(name[1]!); if (!safeName(title)) return undefined; continue; }
    if (!create && CREATE.test(clause)) { create = true; continue; }
    const namedCreate = new RegExp(`^(?:新建|创建|新增)(?:一个|一张)?(?:名为|叫做?|标题为)\\s*(.+?)(?:的)?${NODE}$`, 'u').exec(clause);
    if (!create && namedCreate && title === undefined) {
      title = naturalName(namedCreate[1]!); if (!safeName(title)) return undefined; create = true; continue;
    }
    if (/^(?:把|将)?(?:改写|重写|润色|扩写|续写|缩写|精简|缩短|总结|概括|翻译)?(?:后的)?(?:结果|正文|内容|成稿)(?:再)?(?:填入|写入|填到|写到|放进|放入|装入)(?:一个|一张)?(?:新建|新|创建)(?:的)?(?:节点|卡片|卡|文本框)$/u.test(clause)) {
      create = true; continue;
    }
    const rewrite = new RegExp(`^(${VERB})(?:一下)?\\s*(.+?)(?:的)?(?:内容|正文|全文)$`, 'u').exec(clause);
    const body = new RegExp(`^(?:正文(?:内容)?|内容)(?:为|是|[：:])\\s*[：:]?\\s*(${VERB})后的\\s*(.+?)(?:的)?(?:内容|正文|全文)$`, 'u').exec(clause);
    const postfix = new RegExp(`^(?:把|将)\\s*(.+?)(?:的)?(?:内容|正文|全文)(?:进行)?(${VERB})(?:一下)?$`, 'u').exec(clause);
    const transform = rewrite ?? body ?? (postfix ? [postfix[0], postfix[2], postfix[1]] : undefined);
    if (transform && !operation) {
      operation = OPERATIONS[transform[1]!]!; source = naturalName(transform[2]!);
      if (!safeName(source) || /(?:并|然后|再)(?:删除|移动|连接|新建)|[，,；;]/u.test(transform[2]!.replace(literal, '□'))) return undefined;
      reuseDraft = Boolean(body); continue;
    }
    if (!operation && /^(?:(?:把|将)?(?:刚才|上面|上一段|之前)(?:已经)?(?:改写好|改写|润色好|生成|写好)(?:的)?(?:正文|内容|结果|草稿|成稿)(?:原样)?(?:写入|填入|放进|保存到|装进)(?:一个|一张)?新(?:的)?(?:节点|卡片|卡)|(?:正文(?:内容)?|内容)(?:为|是)(?:刚才|上面|上一段)(?:改写|生成|写好)(?:的)?(?:正文|内容|结果|草稿|成稿))$/u.test(clause)) {
      operation = 'general'; draftOnly = true; reuseDraft = true;
      if (DESTINATION.test(clause)) create = true;
      continue;
    }
    if (title === undefined && /^(?:叫|名为|命名为|取名为)\s*.+$/u.test(clause)) {
      title = naturalName(clause.replace(/^(?:叫|名为|命名为|取名为)\s*/u, '')); if (!safeName(title)) return undefined; continue;
    }
    return undefined;
  }
  return create && operation && (source || draftOnly) ? { operation, sourceNames: source ? [source] : [], title,
    instruction: prompt, reuseDraft, draftOnly } : undefined;
}

/** Internal planning instruction, compiled into the existing prose and create-plan owners. Never dispatched as a public action. */
export const TEXT_COMPOSITION_ACTION: WorkspaceActionDescriptor = {
  id: 'text.composeAndWrite', owner: 'ai-assistant', label: '读取指定来源、处理正文并将实际结果写入明确目标', category: '正文生成与写入',
  effect: 'document', status: 'available', parameters: {}, inputSchema: { type: 'object', additionalProperties: false,
    required: ['steps'], properties: { steps: { type: 'array', minItems: 2, maxItems: 3, items: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['id', 'kind', 'title'], properties: {
        id: { type: 'string' }, kind: { const: 'create-node' }, title: { type: 'string', maxLength: 120 } } },
      { type: 'object', additionalProperties: false, required: ['id', 'kind', 'sourceIds', 'operation', 'instruction'], properties: {
        id: { type: 'string' }, kind: { const: 'transform-text' }, sourceIds: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 10 },
        operation: { type: 'string', enum: [...new Set(Object.values(OPERATIONS))] }, instruction: { type: 'string', minLength: 1, maxLength: 2000 } } },
      { type: 'object', additionalProperties: false, required: ['id', 'kind', 'targetFrom', 'textFrom'], properties: {
        id: { type: 'string' }, kind: { const: 'fill-node' }, targetFrom: { type: 'string' }, textFrom: { type: 'string' } } },
      { type: 'object', additionalProperties: false, required: ['id', 'kind', 'targetId', 'textFrom', 'mode'], properties: {
        id: { type: 'string' }, kind: { const: 'fill-node' }, targetId: { type: 'string' }, textFrom: { type: 'string' }, mode: { enum: ['append', 'replace'] } } },
    ] } } } },
};

export function readModelTextComposition(args: Record<string, unknown>, nodes: Array<{ id: string; revision: number }>, prompt: string): TextCompositionTask {
  const invalid = () => new Error('模型必须完整拆解新建节点、处理来源正文和填入新节点三步，并正确引用前两步；尚未生成或写入正文。');
  if (Object.keys(args).length !== 1 || !Array.isArray(args.steps) || args.steps.length < 2 || args.steps.length > 3 || args.steps.some(step =>
    !isRecord(step) || typeof step.id !== 'string' || !/^[\w.-]{1,80}$/u.test(step.id)) || new Set(args.steps.map(step => step.id)).size !== args.steps.length) throw invalid();
  const steps = args.steps as Array<Record<string, unknown>>;
  const create = steps.find(step => step.kind === 'create-node'), transform = steps.find(step => step.kind === 'transform-text'), fill = steps.find(step => step.kind === 'fill-node');
  if (!transform || !fill || (create ? args.steps.length !== 3 || Object.keys(create).some(key => !['id', 'kind', 'title'].includes(key)) : args.steps.length !== 2) ||
    Object.keys(transform).some(key => !['id', 'kind', 'sourceIds', 'operation', 'instruction'].includes(key)) ||
    Object.keys(fill).some(key => !['id', 'kind', 'targetFrom', 'targetId', 'textFrom', 'mode'].includes(key)) ||
    (create ? fill.targetFrom !== create.id || fill.targetId !== undefined || fill.mode !== undefined : fill.targetFrom !== undefined || !nodes.some(node => node.id === fill.targetId) || !['append', 'replace'].includes(String(fill.mode))) || fill.textFrom !== transform.id ||
    !Array.isArray(transform.sourceIds) || !transform.sourceIds.length && transform.operation !== 'general' || transform.sourceIds.length > 10 || new Set(transform.sourceIds).size !== transform.sourceIds.length ||
    transform.sourceIds.some(id => typeof id !== 'string' || !nodes.some(node => node.id === id)) ||
    typeof transform.operation !== 'string' || !Object.values(OPERATIONS).includes(transform.operation as AIOperation) ||
    typeof transform.instruction !== 'string' || !transform.instruction.trim() || transform.instruction.length > 2000 ||
    create && (typeof create.title !== 'string' || create.title.length > 120 || /[\r\n\u0000]/u.test(create.title))) throw invalid();
  if (typeof create?.title === 'string' && create.title && !prompt.normalize('NFKC').includes(create.title.normalize('NFKC'))) throw new Error('模型不能擅自指定用户未要求的新节点标题。');
  const ids = transform.sourceIds as string[];
  return { operation: transform.operation as AIOperation, sourceNames: [], sourceIds: ids, title: typeof create?.title === 'string' ? create.title || undefined : undefined,
    sourceRevisions: Object.fromEntries(nodes.filter(node => ids.includes(node.id) || node.id === fill.targetId).map(node => [node.id, node.revision])),
    instruction: transform.instruction, ...(!create ? { destinationId: String(fill.targetId), writeMode: fill.mode as 'append' | 'replace' } : {}) };
}

export function isUsableGeneratedBody(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 100_000 &&
    !/^(?:请)?(?:见|参见|参考|使用|填入|插入|写入)(?:上方|下方|下面|上面|下文|上文|以下|上述|如下)(?:的)?(?:改写|生成|润色)?(?:正文|内容|结果|文本)[。！!\s]*$/u.test(value.trim());
}
