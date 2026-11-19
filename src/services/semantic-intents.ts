import { isRecord } from '../core/contracts.ts';
import type { WorkspaceRequirement, SemanticWorkspacePlan } from './workspace-semantic-plan.ts';

export interface SemanticIntent {
  id: string;
  kind: 'query' | 'control' | 'create' | 'transform' | 'write' | 'change' | 'delete';
  request: string;
  objects: Array<{ role: 'source' | 'target' | 'destination'; name?: string; from?: string }>;
  dependsOn: string[];
  output?: 'object' | 'text' | 'value';
}
export interface SemanticIntentGraph {
  version: 1;
  intents: SemanticIntent[];
  coverage: Array<{ requirementId: string; intentIds: string[] }>;
  clarification: string;
}

/** Semantic goals precede registered action IDs. These are not executable commands or model reasoning. */
export function readSemanticIntents(raw: unknown, requirements: WorkspaceRequirement[]): SemanticIntentGraph {
  const invalid = (detail: string) => new Error('自然语言拆解不完整：' + detail + '。未执行任何操作。');
  if (!isRecord(raw) || Object.keys(raw).some(key => !['version', 'intents', 'coverage', 'clarification'].includes(key)) || raw.version !== 1 ||
    !Array.isArray(raw.intents) || raw.intents.length > 24 || !Array.isArray(raw.coverage) || typeof raw.clarification !== 'string' || raw.clarification.length > 800) throw invalid('需要动作、对象、依赖及原句覆盖关系');
  if (raw.clarification) return { version: 1, intents: [], coverage: [], clarification: raw.clarification };
  const intents: SemanticIntent[] = [];
  for (const row of raw.intents) {
    if (!isRecord(row) || Object.keys(row).some(key => !['id', 'kind', 'request', 'objects', 'dependsOn', 'output'].includes(key)) ||
      typeof row.id !== 'string' || !/^[\w.:-]{1,80}$/u.test(row.id) || intents.some(intent => intent.id === row.id) ||
      !['query', 'control', 'create', 'transform', 'write', 'change', 'delete'].includes(String(row.kind)) ||
      typeof row.request !== 'string' || !row.request.trim() || row.request.length > 2000 || !Array.isArray(row.objects) || row.objects.length > 20 ||
      !Array.isArray(row.dependsOn) || row.dependsOn.length > 24 || row.dependsOn.some(id => !intents.some(intent => intent.id === id)) ||
      row.output !== undefined && !['object', 'text', 'value'].includes(String(row.output))) throw invalid('动作字段或依赖无效');
    const objects: SemanticIntent['objects'] = [];
    for (const object of row.objects) {
      if (!isRecord(object) || Object.keys(object).some(key => !['role', 'name', 'from'].includes(key)) ||
        !['source', 'target', 'destination'].includes(String(object.role)) || (object.name === undefined) === (object.from === undefined) ||
        object.name !== undefined && (typeof object.name !== 'string' || !object.name.trim() || object.name.length > 200) ||
        object.from !== undefined && (typeof object.from !== 'string' || !row.dependsOn.includes(object.from))) throw invalid('来源或目标没有明确绑定');
      const producer = typeof object.from === 'string' ? intents.find(intent => intent.id === object.from) : undefined;
      if (object.from && (!producer?.output || object.role === 'destination' && producer.output !== 'object')) throw invalid('引用的前步结果类型不符');
      objects.push(object as SemanticIntent['objects'][number]);
    }
    if (row.kind === 'create' && row.output !== 'object' || row.kind === 'transform' && (row.output !== 'text' || !objects.some(object => object.role === 'source')) ||
      row.kind === 'write' && (!objects.some(object => object.role === 'source') || !objects.some(object => object.role === 'destination'))) throw invalid('创建、正文处理或写入缺少必要输入输出');
    intents.push({ id: row.id, kind: row.kind as SemanticIntent['kind'], request: row.request.trim(), objects, dependsOn: row.dependsOn as string[],
      ...(row.output ? { output: row.output as SemanticIntent['output'] } : {}) });
  }
  const covered = new Set<string>(), used = new Set<string>();
  const coverage: SemanticIntentGraph['coverage'] = [];
  for (const row of raw.coverage) {
    if (!isRecord(row) || Object.keys(row).some(key => !['requirementId', 'intentIds'].includes(key)) || typeof row.requirementId !== 'string' ||
      covered.has(row.requirementId) || !requirements.some(req => req.id === row.requirementId) || !Array.isArray(row.intentIds) || !row.intentIds.length ||
      row.intentIds.some(id => !intents.some(intent => intent.id === id))) throw invalid('原句要求有遗漏或重复');
    covered.add(row.requirementId); row.intentIds.forEach(id => used.add(String(id)));
    coverage.push(row as SemanticIntentGraph['coverage'][number]);
  }
  if (!intents.length || requirements.some(req => !covered.has(req.id)) || intents.some(intent => !used.has(intent.id))) throw invalid('并非全部要求都有动作');
  return { version: 1, intents, coverage, clarification: '' };
}

/** Multiple semantic actions cannot all claim one executable step. A validated prose workflow is one atomic write. */
export function validateIntentMapping(graph: SemanticIntentGraph, plan: SemanticWorkspacePlan, compositionAction: string): void {
  if (plan.phase !== 'final' || plan.clarification || !plan.coverage.length) return;
  const owners = new Map<string, string>();
  for (const intent of graph.intents) {
    const row = plan.coverage.find(row => row.requirementId === intent.id);
    if (!row || row.status === 'observed') continue;
    for (const stepId of row.stepIds) {
      const step = plan.steps.find(step => step.id === stepId);
      if (step?.action === compositionAction) continue;
      if (owners.has(stepId) && owners.get(stepId) !== intent.id) throw new Error('多个语义动作被合并成同一步，可能遗漏操作');
      owners.set(stepId, intent.id);
    }
    for (const dependency of intent.dependsOn) {
      const prior = plan.coverage.find(row => row.requirementId === dependency);
      if (prior?.status === 'observed') continue;
      const earliest = Math.min(...row.stepIds.map(id => plan.steps.findIndex(step => step.id === id)));
      if (prior?.stepIds.some(id => !row.stepIds.includes(id) && plan.steps.findIndex(step => step.id === id) >= earliest)) throw new Error('执行动作没有保留语义步骤的前后依赖');
    }
  }
}
