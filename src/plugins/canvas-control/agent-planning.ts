import { isRecord, type PluginContext } from '../../core/contracts.ts';
import type { CanvasControlAdmission } from '../../protocols/canvas-control.ts';
import type { CanvasAgentSubmission } from '../../protocols/canvas-agent.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import { parseCanvasControlPlan } from '../../services/canvas-control-validation.ts';
import { assertNotAborted } from '../../services/async-control.ts';
import { deniesCanvasCapability } from '../../services/canvas-capabilities.ts';
import { needsCanvasCreationPlanning } from '../../services/ai-task-route.ts';
import { captureControlSnapshot, readControlOwners } from './context.ts';
import { validateControlScope } from './planning.ts';
import type { AgentDiscoverySession } from './agent-discovery.ts';
import type { NaturalControlResult } from './natural-operations.ts';

export async function prepareAgentPlan(
  context: PluginContext, input: CanvasControlAdmission & CanvasAgentSubmission,
  session: AgentDiscoverySession, execution: 'direct' | 'review', signal?: AbortSignal,
) {
  if (!isRecord(input.plan) || (input.focusIds !== undefined && (!Array.isArray(input.focusIds) || input.focusIds.length > 80 || input.focusIds.some(id => typeof id !== 'string'))) ||
    (input.clarification !== undefined && typeof input.clarification !== 'boolean')) throw new Error('画布计划参数无效');
  const plan = parseCanvasControlPlan(JSON.stringify(input.plan));
  if (!input.clarification && needsCanvasCreationPlanning(input.prompt) && !plan.actions.some(action => action.type === 'create-node')) throw new Error('当前文字节点能力已启用，但返回计划没有 create-node。请根据本轮要求生成新节点。');
  if (!plan.actions.length && plan.answer && deniesCanvasCapability(plan.answer)) throw new Error('应用已确认节点读写能力可用。请查询实际对象，或只询问缺少的目标信息。');
  const refs = new Set(plan.actions.flatMap(action => 'ref' in action ? [action.ref] : []));
  const ids = new Set(input.focusIds ?? []);
  for (const action of plan.actions) {
    if ('id' in action) ids.add(action.id);
    if (action.type === 'delete') action.ids.forEach(id => ids.add(id));
    if ('members' in action) action.members?.filter(id => !refs.has(id)).forEach(id => ids.add(id));
    if ('from' in action && action.from && !refs.has(action.from)) ids.add(action.from);
    if ('to' in action && action.to && !refs.has(action.to)) ids.add(action.to);
  }
  for (const id of ids) if (!session.nodes.has(id) && !session.groupRevisions.has(id) && !session.connectionRevisions.has(id)) throw new Error('操作引用了尚未查询、控制范围外的对象，请先查找真实 ID');
  if (input.setting) {
    if (plan.actions.length || input.focusIds?.length || input.clarification) throw new Error('主题或背景设置请单独提交计划');
    if (input.setting.kind === 'theme') {
      if (!['light', 'dark'].includes(input.setting.theme)) throw new Error('主题参数无效');
    } else if (input.setting.kind !== 'background' || !/^#[a-f\d]{6}$/iu.test(input.setting.color)) throw new Error('背景颜色参数无效');
  }
  if (input.clarification && (plan.actions.length || !plan.answer?.trim())) throw new Error('需要补充信息时只返回明确的问题');
  const [nodes, owners] = await Promise.all([
    context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: [...ids].filter(id => session.nodes.has(id)) }, signal),
    readControlOwners(context, signal),
  ]);
  for (const id of ids) {
    const known = session.nodes.get(id);
    if (known) {
      const current = nodes.find(node => node.id === id);
      if (!current || current.revision !== known.revision || (current.nodeRevision ?? current.revision) !== known.nodeRevision) throw new Error('已查询的节点已变化，请重新发送任务');
    }
    if (session.groupRevisions.has(id) && owners.groups?.find(group => group.id === id)?.revision !== session.groupRevisions.get(id)) throw new Error('已查询的群组已变化，请重新发送任务');
    if (session.connectionRevisions.has(id) && owners.graph?.connections.find(edge => edge.id === id)?.revision !== session.connectionRevisions.get(id)) throw new Error('已查询的连线已变化，请重新发送任务');
  }
  const snapshot = await captureControlSnapshot(context, { ...input, sourceIds: [...ids] }, 'selection', signal, undefined, true);
  snapshot.execution = execution;
  validateControlScope(plan, snapshot);
  assertNotAborted(signal);
  const local: NaturalControlResult = { plan, targets: [...ids],
    ...(input.setting ? { setting: input.setting.kind === 'theme' ? { ...input.setting, names: [] } : input.setting } : {}),
    ...(input.focusIds?.length ? { focus: input.focusIds } : {}),
    next: { ids: nodes.length ? nodes.map(node => node.id) : [...session.nodes.keys()].slice(-12),
      pendingTask: input.clarification ? { goal: input.prompt.slice(0, 1000), question: plan.answer!.slice(0, 800) } : undefined },
  };
  return { snapshot, local, text: JSON.stringify(plan) };
}
