import { isRecord } from '../core/contracts.ts';
import type { WorkspacePlanStep, WorkspaceStepReceipt } from '../protocols/workspace-actions.ts';
import { NATURAL_QUOTED_NAME } from './natural-canvas-rules.ts';

export interface WorkspaceRequirement { id: string; text: string }
const START = '(?:把|将|给|让|打开|关闭|开启|关掉|收起|展开|显示|隐藏|进入|退出|切换|切到|换|改|调|设|选|删|移|清|连|断开|取消|恢复|返回|聚焦|定位|找|查|看|列|读|启用|停用|禁用|新建|创建|添加|保存|撤销|重做|缩放|放大|缩小|横排|竖排|排列|请|帮我|顺便|去|到|翻|亮出|弹开|不要|别|否则|如果|若)';
const SEPARATOR = new RegExp('[，,；;。\\n]+\\s*|(?:然后|接着|随后|最后|并且|同时|顺便|以及|(?<!不)再|并)\\s*(?=' + START + ')', 'u');

/** Keep literal names and coordinate pairs intact; every remaining clause must be accounted for. */
export function workspaceRequirements(prompt: string): WorkspaceRequirement[] {
  const literals: string[] = [];
  const masked = prompt.trim().replace(/^@(?:画布操作|通用)\s+/u, '')
    .replace(new RegExp(NATURAL_QUOTED_NAME + '|[（(][^()（）\\r\\n]{0,120}[)）]|[-\\d.]+\\s*[,，]\\s*[-\\d.]+', 'gu'), value =>
      '\uE100' + (literals.push(value) - 1) + '\uE101');
  return masked.split(SEPARATOR).map(text => text.trim()
    .replace(/^(?:(?:先|然后|接着|随后|最后|再|并且|同时|顺便|以及)\s*)+/u, '')
    .replace(/[。！!？?]+$/u, '').trim()).filter(Boolean).map((text, index) => ({
      id: 'r' + (index + 1), text: text.replace(/\uE100(\d+)\uE101/gu, (_token, n: string) => literals[Number(n)]!),
    }));
}

export class IncompleteWorkspacePlan extends Error {}
export interface SemanticWorkspacePlan {
  phase: 'final' | 'observe'; steps: WorkspacePlanStep[]; clarification: string;
  coverage: Array<{ requirementId: string; stepIds: string[]; status: string }>;
}
const ID = /^[\p{L}\p{N}._:-]{1,100}$/u;

/** This is an internal model transport, not a new public execution protocol. Legacy single-clause output stays compatible. */
export function readSemanticWorkspacePlan(raw: unknown, requirements: WorkspaceRequirement[], expected: ReadonlyMap<string, string[]>,
  observed: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map()): SemanticWorkspacePlan {
  if (!isRecord(raw) || Object.keys(raw).some(key => !['version', 'phase', 'steps', 'coverage', 'clarification'].includes(key)) ||
      !Array.isArray(raw.steps) || raw.steps.length > 24 || typeof raw.clarification !== 'string' || raw.clarification.length > 800 ||
      raw.version !== undefined && raw.version !== 2 || raw.phase !== undefined && !['final', 'observe'].includes(String(raw.phase))) {
    throw new Error('模型返回的解析格式无效，未执行任何操作。');
  }
  const phase = raw.phase === 'observe' ? 'observe' : 'final';
  const versioned = raw.version === 2;
  const rawSteps = raw.steps;
  const branching = rawSteps.some(step => isRecord(step) && step.when !== undefined);
  const steps: WorkspacePlanStep[] = rawSteps.map((step, index) => {
    if (!isRecord(step) || Object.keys(step).some(key => !['id', 'action', 'arguments', 'dependsOn', 'when'].includes(key)) ||
        typeof step.action !== 'string' || !isRecord(step.arguments) ||
        step.id !== undefined && (typeof step.id !== 'string' || !ID.test(step.id)) ||
        !versioned && (step.dependsOn !== undefined || step.when !== undefined) ||
        step.dependsOn !== undefined && (!Array.isArray(step.dependsOn) || step.dependsOn.length > 24 || step.dependsOn.some(id => typeof id !== 'string' || !ID.test(id))) ||
        step.when !== undefined && (!isRecord(step.when) || Object.keys(step.when).some(key => !['step', 'exists'].includes(key)) ||
          typeof step.when.step !== 'string' || !ID.test(step.when.step) || typeof step.when.exists !== 'boolean')) {
      throw new Error('模型选择了无效动作步骤，未执行计划。');
    }
    const previous: unknown = rawSteps[index - 1];
    const previousId = isRecord(previous) && typeof previous.id === 'string' ? previous.id : 'model-' + index;
    return { id: typeof step.id === 'string' ? step.id : 'model-' + (index + 1), action: step.action, arguments: step.arguments,
      ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn as string[] } : !branching && index ? { dependsOn: [previousId] } : {}),
      ...(step.when ? { when: step.when as WorkspacePlanStep['when'] } : {}) };
  });
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('模型步骤编号重复，未执行计划。');
  if (raw.clarification || !steps.length) return { phase, steps: [], coverage: [], clarification: raw.clarification || '当前动作目录无法完整执行这项要求，请补充具体对象或操作。' };
  if (!versioned && requirements.length === 1 && phase === 'final') return { phase, steps, coverage: [], clarification: '' };
  if (!versioned || !Array.isArray(raw.coverage) || raw.coverage.length !== requirements.length) {
    throw new IncompleteWorkspacePlan('模型未逐项说明原句要求的覆盖情况。');
  }
  const mapped = new Set<string>(); const used = new Set<string>();
  const coverage: SemanticWorkspacePlan['coverage'] = [];
  for (const row of raw.coverage) {
    if (!isRecord(row) || Object.keys(row).some(key => !['requirementId', 'stepIds', 'status'].includes(key)) ||
        typeof row.requirementId !== 'string' || !requirements.some(req => req.id === row.requirementId) || mapped.has(row.requirementId) ||
        !Array.isArray(row.stepIds) || row.stepIds.length > 24 || row.stepIds.some(id => typeof id !== 'string' ||
          !(row.status === 'observed' ? observed.get(String(row.requirementId))?.has(id) : steps.some(step => step.id === id))) ||
        !['planned', 'observing', 'observed', 'pending', 'unsupported'].includes(String(row.status))) {
      throw new IncompleteWorkspacePlan('模型的子句与动作对应关系无效。');
    }
    const stepIds = row.stepIds;
    mapped.add(row.requirementId);
    if (row.status !== 'observed') stepIds.forEach(id => used.add(String(id)));
    if (phase === 'final' && (!['planned', 'observed'].includes(String(row.status)) || !stepIds.length)) throw new IncompleteWorkspacePlan('模型尚未完整覆盖子句 ' + row.requirementId + '。');
    if (phase === 'final' && (expected.get(row.requirementId) ?? []).some(action =>
      !(row.status === 'observed' ? stepIds.some(id => observed.get(String(row.requirementId))?.get(String(id)) === action)
        : steps.some(step => stepIds.includes(step.id) && step.action === action)))) {
      throw new IncompleteWorkspacePlan('子句 ' + row.requirementId + ' 的已知动作被遗漏或替换。');
    }
    coverage.push({ requirementId: row.requirementId, stepIds: stepIds as string[], status: String(row.status) });
  }
  if (steps.some(step => !used.has(step.id))) throw new IncompleteWorkspacePlan('模型包含未对应用户要求的动作。');
  return { phase, steps, coverage, clarification: '' };
}

/** Only bounded public metadata may be observed during planning. Body text and personal settings are excluded. */
export const SEMANTIC_OBSERVATION_ACTIONS = new Set(['content.find', 'node.inspect', 'selection.read', 'selection.resolve', 'viewport.read', 'viewport.size',
  'group.list', 'group.inspect', 'connection.graph', 'connection.inspect', 'minimap.read', 'editor.read', 'document.revision']);
const METADATA_KEYS = new Set(['id', 'title', 'name', 'count', 'matches', 'ids', 'groups', 'connections', 'from', 'to', 'nodeId', 'memberIds',
  'revision', 'nodeRevision', 'x', 'y', 'width', 'height', 'zoom', 'length', 'presentation', 'open', 'panes', 'nodeIds', 'targetId']);
export function semanticObservations(receipt: { steps: WorkspaceStepReceipt[] }, visibleIds: ReadonlySet<string>) {
  let truncated = false;
  const compact = (value: unknown, depth = 0): unknown => {
    if (depth > 6) { truncated = true; return undefined; }
    if (Array.isArray(value)) {
      const items = value.slice(0, 40).filter(item => !isRecord(item) || typeof item.id !== 'string' || visibleIds.has(item.id));
      if (items.length !== value.length) truncated = true;
      return items.map(item => compact(item, depth + 1));
    }
    if (isRecord(value)) {
      const result = Object.fromEntries(Object.entries(value).filter(([key]) => METADATA_KEYS.has(key))
        .map(([key, item]) => {
          const filtered = Array.isArray(item) && ['ids', 'memberIds', 'nodeIds'].includes(key)
            ? item.filter(id => typeof id === 'string' && visibleIds.has(id)) : item;
          if (Array.isArray(item) && Array.isArray(filtered) && item.length !== filtered.length) truncated = true;
          return [key, compact(filtered, depth + 1)];
        }));
      if (Array.isArray(result.matches)) result.count = result.matches.length;
      return result;
    }
    if (typeof value === 'string' && value.length > 200) truncated = true;
    return typeof value === 'string' ? value.slice(0, 200) : typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
  };
  return receipt.steps.map(step => {
    truncated = false;
    const result = compact(step.result);
    return { id: step.id, action: step.action, status: step.status, result, truncated };
  });
}
