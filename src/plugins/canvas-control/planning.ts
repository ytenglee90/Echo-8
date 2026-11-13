import type { PluginContext } from '../../core/contracts.ts';
import type { CanvasControlAction, CanvasControlNodePlan, CanvasControlGroupPlan, CanvasControlPatchPlan, CanvasControlPlan, ControlGroupAction, ControlConnectionAction, ControlNodeAction } from '../../protocols/canvas-control.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { EntityDeletePlan } from '../../protocols/selection.ts';
import { assertNotAborted } from '../../services/async-control.ts';
import { readControlOwners, optionalControlOwner, type ControlSnapshot } from './context.ts';

export function validateControlScope(plan: CanvasControlPlan, snapshot: ControlSnapshot): void {
  const refs = new Set(plan.actions.flatMap(action => 'ref' in action ? [action.ref] : []));
  const known = new Set([...snapshot.nodes.map(node => node.id), ...snapshot.groups.map(group => group.id)]);
  for (const ref of refs) if (known.has(ref) || snapshot.writable.has(ref)) throw new Error('新对象代号与既有对象冲突');
  const deleted = new Set(plan.actions.flatMap(action => action.type === 'delete' ? action.ids : []));
  for (const action of plan.actions) {
    if ((action.type === 'create-group' || action.type === 'update-group') && !snapshot.available.groups) throw new Error('请先启用群组插件');
    if ((action.type === 'create-connection' || action.type === 'update-connection') && !snapshot.available.connections) throw new Error('请先启用连线插件');
    if (action.type === 'delete' && (!snapshot.available.groups || !snapshot.available.connections)) throw new Error('删除前请启用群组和连线插件');
    if ('id' in action && !snapshot.writable.has(action.id)) throw new Error('AI 计划修改了当前控制范围外的对象');
    if (action.type === 'delete' && action.ids.some(id => !snapshot.writable.has(id))) throw new Error('AI 计划删除了当前控制范围外的对象');
    const references = 'members' in action ? action.members ?? [] : 'from' in action || 'to' in action ? [action.from, action.to].filter((id): id is string => id !== undefined) : [];
    if (references.some(id => (!known.has(id) && !refs.has(id)) || deleted.has(id))) throw new Error('操作计划引用了不存在、范围外或待删除对象');
    if ('members' in action && action.members?.some(id => known.has(id) && !snapshot.writable.has(id))) throw new Error('群组成员不在可修改范围内');
  }
}

export async function planControlApplication(context: PluginContext, snapshot: ControlSnapshot, plan: CanvasControlPlan, signal?: AbortSignal): Promise<CanvasControlPatchPlan> {
  validateControlScope(plan, snapshot);
  const [currentNodes, owners] = await Promise.all([
    context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: snapshot.nodes.map(node => node.id) }, signal),
    readControlOwners(context, signal),
  ]);
  const groups = owners.groups ?? [];
  const graph = owners.graph ?? { version: 1 as const, connections: [], junctions: [] };
  for (const node of snapshot.nodes) {
    const current = currentNodes.find(item => item.id === node.id);
    if (!current || current.nodeRevision !== node.nodeRevision || current.revision !== node.revision) throw new Error('控制范围内的文字对象已经变化，请重新生成计划');
  }
  for (const group of snapshot.groups) if (groups.find(item => item.id === group.id)?.revision !== group.revision) throw new Error('控制范围内的群组已经变化，请重新生成计划');
  for (const edge of snapshot.graph.connections) if (graph.connections.find(item => item.id === edge.id)?.revision !== edge.revision) throw new Error('控制范围内的连线已经变化，请重新生成计划');
  const allNodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1', undefined, signal);
  const parts: CanvasControlPatchPlan[] = [];
  const aliases = new Map<string, string>();
  let nextCreation = 0;
  const creates = plan.actions.filter(action => action.type === 'create-node');
  const columnWidth = Math.max(340, ...creates.map(action => action.width ?? 340)) + 60;
  const rowHeight = Math.max(220, ...creates.map(action => action.height ?? 220)) + 80;
  const nodeActions: ControlNodeAction[] = plan.actions.filter((action): action is ControlNodeAction => action.type === 'create-node' || action.type === 'update-node').map(action => {
    if (action.type !== 'create-node') return action;
    const index = nextCreation++;
    return { ...action, x: action.x ?? snapshot.origin.x + (index % 3) * columnWidth, y: action.y ?? snapshot.origin.y + Math.floor(index / 3) * rowHeight };
  });
  let plannedNodes: ContentSummary[] = [];
  if (nodeActions.length) {
    const part = await context.capabilities.request<CanvasControlNodePlan>(nodeActions.some(action => action.edit) ? 'canvasControl.nodesPlan@2' : 'canvasControl.nodesPlan@1', { actions: nodeActions, expected: snapshot.nodes }, signal);
    parts.push(part); plannedNodes = part.nodes;
    for (const [ref, id] of Object.entries(part.created)) aliases.set(ref, id);
  }
  const nodes = new Map([...allNodes, ...plannedNodes].map(node => [node.id, node]));
  const resolve = (id: string) => aliases.get(id) ?? id;
  const groupActions: ControlGroupAction[] = plan.actions.filter((action): action is ControlGroupAction => action.type === 'create-group' || action.type === 'update-group')
    .map(action => ({ ...action, ...('members' in action && action.members ? { members: action.members.map(resolve) } : {}) }));
  let targets = await context.capabilities.request<import('../../protocols/connections.ts').ConnectionTarget[]>('connections.targets@1', { nodes: [...nodes.values()] }, signal).catch(optionalControlOwner) ?? [];
  if (groupActions.length) {
    const part = await context.capabilities.request<CanvasControlGroupPlan>('canvasControl.groupsPlan@1', { actions: groupActions, expected: snapshot.groups, nodes: [...nodes.values()] }, signal);
    parts.push(part); targets = part.targets.map(target => ({ ...target, kind: 'group' }));
    for (const [ref, id] of Object.entries(part.created)) aliases.set(ref, id);
  }
  const connectionActions: ControlConnectionAction[] = plan.actions.filter((action): action is ControlConnectionAction => action.type === 'create-connection' || action.type === 'update-connection')
    .map(action => ({ ...action, ...(action.from ? { from: resolve(action.from) } : {}), ...(action.to ? { to: resolve(action.to) } : {}) }));
  if (connectionActions.length) {
    const part = await context.capabilities.request<CanvasControlPatchPlan>('canvasControl.connectionsPlan@1', { actions: connectionActions, expected: snapshot.graph.connections, nodes: [...nodes.values(), ...targets] }, signal);
    parts.push(part);
    for (const [ref, id] of Object.entries(part.created)) aliases.set(ref, id);
  }
  const deletions = plan.actions.flatMap(action => action.type === 'delete' ? action.ids : []);
  if (deletions.length) {
    if (!owners.groups || !owners.graph) throw new Error('删除前请启用群组和连线插件，以便完整清理对象关系');
    const plans = await context.capabilities.requestAll<EntityDeletePlan>('entity.deletePlan@1', { ids: deletions }, signal);
    parts.push(...plans.map(part => ({ ...part, created: {} })));
  }
  const patches = parts.flatMap(part => part.patches);
  const touched = new Set<string>();
  for (const patch of patches) {
    const key = JSON.stringify([patch.domain, patch.namespace, patch.key]);
    if (touched.has(key)) throw new Error('这些操作会交叉修改同一对象，请拆成两批计划');
    touched.add(key);
  }
  assertNotAborted(signal);
  return { patches, events: parts.flatMap(part => part.events ?? []), created: Object.fromEntries(aliases) };
}

export function controlActionLabel(action: CanvasControlAction, titles: Record<string, string>): string {
  const name = 'ref' in action ? action.ref : 'id' in action ? titles[action.id] ?? action.id : '';
  switch (action.type) {
    case 'create-node': return `新建${action.presentation === 'text-box' ? '文本框' : '文字节点'} · ${action.title}`;
    case 'update-node': return `修改文字对象 · ${name}`;
    case 'create-group': return `新建群组 · ${action.title}`;
    case 'update-group': return `修改群组 · ${name}`;
    case 'create-connection': return `新建${action.line === 'dashed' ? '虚线' : '实线'} · ${action.label ?? action.ref}`;
    case 'update-connection': return `修改连线 · ${name}`;
    case 'delete': return `删除 · ${action.ids.map(id => titles[id] ?? id).join('、')}`;
  }
}
