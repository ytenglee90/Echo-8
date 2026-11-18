import { isRecord, type PluginContext, type PluginDefinition, type PluginSnapshot, type RegisteredAction } from '../../core/contracts.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { FileRuntimeState, LocalFileTaskResult } from '../../protocols/files.ts';
import type { CanvasReviewReceipt } from '../../protocols/canvas-control.ts';
import type {
  WorkspaceActionIndex, WorkspaceRuntimeCatalog, WorkspacePlan, WorkspacePlanReceipt, WorkspacePlanResume, WorkspacePlanStep, WorkspaceStepReceipt, WorkspaceTarget,
} from '../../protocols/workspace-actions.ts';
import { defineManifest } from '../manifest.ts';
import { actionSources, documentPreview, isWorkspaceTarget, localActions, matchingNodes, type LocalAction } from './actions.ts';
import { batchableActions, compileDocumentBatch } from './document-batch.ts';
import { UI_SURFACE_REVEALED_EVENT, uiSurfaceRevealed } from '../../protocols/ui.ts';
import { bindResults, resultDependencies } from './result-references.ts';
import { buildCoverage } from './coverage.ts';
import { cancelWorkspaceQuery, clearWorkspaceQueries, readWorkspaceQuery } from './query-tasks.ts';

const command = 'workspace.plan.run@1';
const query = 'workspace.actions@1';
export const WORKSPACE_ACTIONS_NAMESPACE = 'workspaceActions';
const allowedPlanKeys = ['version', 'id', 'steps', 'constraints', 'verify'];
const allowedStepKeys = ['id', 'action', 'arguments', 'dependsOn', 'when'];

function onlyKeys(input: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(input).every(key => keys.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{L}\p{N}._:-]{1,120}$/u.test(value);
}

function isStep(value: unknown): value is WorkspacePlanStep {
  return isRecord(value) && onlyKeys(value, allowedStepKeys) &&
    isIdentifier(value.id) && isIdentifier(value.action) &&
    (value.arguments === undefined || isRecord(value.arguments)) &&
    (value.dependsOn === undefined || Array.isArray(value.dependsOn) && value.dependsOn.length <= 24 &&
      value.dependsOn.every(isIdentifier)) &&
    (value.when === undefined || isRecord(value.when) && onlyKeys(value.when, ['step', 'exists']) &&
      isIdentifier(value.when.step) && typeof value.when.exists === 'boolean');
}

function isPlan(value: unknown): value is WorkspacePlan {
  return isRecord(value) && onlyKeys(value, allowedPlanKeys) && value.version === 1 && isIdentifier(value.id) &&
    Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= 24 && value.steps.every(isStep) &&
    (value.verify === undefined || Array.isArray(value.verify) && value.verify.length <= 24 && value.verify.every(check =>
      isRecord(check) && onlyKeys(check, ['action', 'arguments', 'field', 'equals']) && isIdentifier(check.action) &&
      (check.arguments === undefined || isRecord(check.arguments)) && Object.hasOwn(check, 'equals') &&
      Array.isArray(check.field) && check.field.length > 0 && check.field.length <= 8 &&
      check.field.every(field => typeof field === 'string' && /^[\p{L}\p{N}_-]{1,100}$/u.test(field)))) &&
    (value.constraints === undefined || isRecord(value.constraints) &&
      onlyKeys(value.constraints, ['effectScope', 'documentRevision']) &&
      (value.constraints.effectScope === undefined || ['read-only', 'workspace'].includes(String(value.constraints.effectScope))) &&
      (value.constraints.documentRevision === undefined || typeof value.constraints.documentRevision === 'number' &&
        Number.isSafeInteger(value.constraints.documentRevision) && value.constraints.documentRevision >= 0));
}

function isResume(value: unknown): value is WorkspacePlanResume {
  return isRecord(value) && onlyKeys(value, ['id', 'choices', 'apply', 'retryFailed']) && isIdentifier(value.id) &&
    (value.retryFailed === undefined || typeof value.retryFailed === 'boolean') &&
    (value.apply === undefined || Array.isArray(value.apply) && value.apply.length <= 24 && value.apply.every(isIdentifier)) &&
    (value.choices === undefined || isRecord(value.choices) && Object.keys(value.choices).length <= 24 &&
      Object.entries(value.choices).every(([step, choice]) => isIdentifier(step) && isRecord(choice) &&
        onlyKeys(choice, ['argument', 'index', 'id']) && isIdentifier(choice.argument) &&
        (choice.index === undefined || Number.isInteger(choice.index) && Number(choice.index) >= 0 && Number(choice.index) < 80) && typeof choice.id === 'string' &&
        choice.id.length > 0 && choice.id.length <= 200));
}

function isPlanId(value: unknown): value is { id: string } {
  return isRecord(value) && Object.keys(value).length === 1 && isIdentifier(value.id);
}

function dependencies(step: WorkspacePlanStep): string[] {
  const refs = (value: unknown): string[] => isWorkspaceTarget(value) ? ('from' in value ? [value.from] : []) :
    Array.isArray(value) ? value.flatMap(refs) : isRecord(value) ? Object.values(value).flatMap(refs) : [];
  return [...new Set([
    ...(step.dependsOn ?? []), ...(step.when ? [step.when.step] : []),
    ...refs(step.arguments ?? {}), ...resultDependencies(step.arguments),
  ])];
}

function actionAvailable(action: LocalAction, catalog: WorkspaceRuntimeCatalog, active: ReadonlySet<string>): boolean {
  return active.has(action.descriptor.owner) &&
    action.commands.every(type => catalog.commands.some(entry => entry.type === type && entry.available &&
      (!action.requiresCommandOwner || entry.owner === action.descriptor.owner))) &&
    action.queries.every(type => catalog.queries.some(entry => entry.type === type && entry.available)) &&
    action.capabilities.every(key => catalog.capabilities.some(entry => entry.key === key && entry.providers.length));
}

async function preflight(context: PluginContext, plan: WorkspacePlan, byId: Map<string, LocalAction>): Promise<void> {
  const catalog = await context.queries.ask<WorkspaceRuntimeCatalog>('system.actionCatalog@1');
  const active = new Set((await context.queries.ask<PluginSnapshot[]>('system.plugins')).filter(p => p.status === 'active').map(p => p.id));
  const preceding = new Map<string, string>();
  let documentSteps = 0;
  for (const step of plan.steps) {
    const action = byId.get(step.action);
    if (!action || !actionAvailable(action, catalog, active)) throw new Error('本地动作不可用：' + step.action);
    if (!action.validate(step.arguments ?? {}) || action.preflight && !resultDependencies(step.arguments).length && !await action.preflight(context, step.arguments ?? {})) {
      throw new Error('本地动作参数无效：' + step.action);
    }
    if (preceding.has(step.id) || dependencies(step).some(id => !preceding.has(id))) {
      throw new Error('计划步骤必须唯一，且只能引用前置步骤');
    }
    if (step.when && preceding.get(step.when.step) !== 'content.find') throw new Error('条件步骤必须引用对象查找');
    if (action.descriptor.effect === 'document') documentSteps += 1;
    const scope = plan.constraints?.effectScope;
    if (scope === 'read-only' && action.descriptor.effect !== 'query' ||
        scope === 'workspace' && !['query', 'workspace'].includes(action.descriptor.effect)) {
      throw new Error('动作超出本轮计划的作用范围：' + step.action);
    }
    preceding.set(step.id, step.action);
  }
  if (documentSteps > 1) {
    const indices = plan.steps.flatMap((step, i) => byId.get(step.action)?.descriptor.effect === 'document' ? [i] : []);
    if (indices.at(-1)! - indices[0]! + 1 !== indices.length ||
      indices.some(i => !batchableActions.has(plan.steps[i]!.action))) {
      throw new Error('这些文档动作无法安全合并，请使用明确的原子文档预览');
    }
    if (indices.some(i => {
      const step = plan.steps[i]!;
      return step.action === 'node.create' && (step.arguments?.x === undefined || step.arguments?.y === undefined);
    })) throw new Error('组合创建节点时请提供明确的画布坐标');
    if (!catalog.commands.some(entry => entry.type === 'canvasControl.workspacePreview@1' && entry.available)) throw new Error('原子文档预览当前不可用');
    const members = new Set(indices.map(i => plan.steps[i]!.id));
    if (indices.some(i => resultDependencies(plan.steps[i]!.arguments).some(dep => members.has(dep)))) {
      throw new Error('原子文档组中的新对象请使用目标 from 引用');
    }
  }
  for (const check of plan.verify ?? []) {
    const action = byId.get(check.action);
    if (!action || action.descriptor.effect !== 'query' || !actionAvailable(action, catalog, active) || !action.validate(check.arguments ?? {}) ||
      action.preflight && !await action.preflight(context, check.arguments ?? {})) {
      throw new Error('结果核验必须使用可用的只读动作');
    }
    if ([...resultDependencies(check.arguments), ...resultDependencies(check.equals)].some(id => !preceding.has(id))) {
      throw new Error('结果核验引用了不存在的步骤');
    }
  }
}

class ChooseTarget extends Error {
  readonly matches: ContentSummary[];
  readonly target: WorkspaceTarget;
  constructor(matches: ContentSummary[], target: WorkspaceTarget) {
    super('找到多张同名卡，请选择一个对象后继续。');
    this.matches = matches;
    this.target = target;
  }
}

async function resolveTarget(context: PluginContext, target: WorkspaceTarget, results: Map<string, WorkspaceStepReceipt>): Promise<ContentSummary> {
  if ('title' in target) {
    const matches = matchingNodes(await context.capabilities.request<ContentSummary[]>('content.summaries@1'), target.title);
    if (matches.length > 1) throw new ChooseTarget(matches.slice(0, 20), target);
    if (matches[0]) return matches[0];
    throw new Error('找不到文字节点「' + target.title + '」');
  }
  let id: unknown;
  if ('id' in target) id = target.id;
  else {
    const result = results.get(target.from)?.result;
    if (isRecord(result)) {
      if (Array.isArray(result.matches) && result.matches.length > 1) {
        const ids = result.matches.flatMap(match => isRecord(match) && typeof match.id === 'string' ? [match.id] : []);
        throw new ChooseTarget(await context.capabilities.request<ContentSummary[]>('content.canvasSummariesById@1', { nodeIds: ids }), target);
      }
      const first: unknown = Array.isArray(result.matches) ? result.matches[0] : undefined;
      id = result.id ?? result.targetId ?? (isRecord(first) ? first.id : undefined);
    }
  }
  if (typeof id !== 'string') throw new Error('前置步骤没有返回唯一对象');
  const result = await context.capabilities.request<ContentSummary[]>('content.canvasSummariesById@1', { nodeIds: [id] });
  const node = result.find(item => item.id === id);
  if (!node) throw new Error('引用的文字节点已失效');
  return node;
}

function planStatus(steps: WorkspaceStepReceipt[]): WorkspacePlanReceipt['status'] {
  const failed = steps.some(step => step.status === 'failed');
  if (failed) return steps.some(step => step.status === 'completed') ? 'partial' : 'failed';
  return steps.some(step => step.status === 'waiting') ? 'waiting' : 'completed';
}

function candidateLocation(args: Record<string, unknown>, target: WorkspaceTarget) {
  const matches = (value: unknown) => isWorkspaceTarget(value) && JSON.stringify(value) === JSON.stringify(target);
  for (const [argument, value] of Object.entries(args)) {
    if (matches(value)) return { argument };
    if (Array.isArray(value)) {
      const index = value.findIndex(matches);
      if (index >= 0) return { argument, index };
    }
  }
  return {};
}

function chooseArgument(args: Record<string, unknown>, choice?: NonNullable<WorkspacePlanResume['choices']>[string]) {
  const result = structuredClone(args);
  if (!choice) return result;
  if (choice.index === undefined) result[choice.argument] = { id: choice.id };
  else (result[choice.argument] as unknown[])[choice.index] = { id: choice.id };
  return result;
}

async function execute(
  context: PluginContext, plan: WorkspacePlan, byId: Map<string, LocalAction>, previous: WorkspaceStepReceipt[] = [],
  choices: WorkspacePlanResume['choices'] = {}, retryFailed = false,
): Promise<WorkspacePlanReceipt> {
  const results = new Map<string, WorkspaceStepReceipt>();
  const documentSteps = plan.steps.filter(step => byId.get(step.action)?.descriptor.effect === 'document');
  for (const step of plan.steps) {
    if (results.has(step.id)) continue;
    if (documentSteps.length > 1 && step.id === documentSteps[0]!.id) {
      const old = previous.filter(item => documentSteps.some(step => step.id === item.id));
      if (old.length === documentSteps.length && old.every(item => item.status === 'completed') ||
        old.some(item => item.status === 'waiting') && !documentSteps.some(step => choices[step.id]) ||
        old.some(item => item.status === 'failed') && !retryFailed) {
        old.forEach(item => results.set(item.id, item));
        continue;
      }
      const groupIds = new Set(documentSteps.map(step => step.id));
      const included: WorkspacePlanStep[] = [];
      for (const member of documentSteps) {
        const condition = member.when && results.get(member.when.step)?.result;
        const blocked = dependencies(member).some(dep => groupIds.has(dep)
          ? !included.some(step => step.id === dep) : results.get(dep)?.status !== 'completed');
        if (blocked || member.when && (!isRecord(condition) || (Number(condition.count) > 0) !== member.when.exists)) {
          results.set(member.id, { id: member.id, action: member.action, status: 'skipped', message: '前置步骤或条件未满足' });
        } else {
          const choice = choices[member.id];
          included.push({ ...member, arguments: chooseArgument(member.arguments ?? {}, choice) });
        }
      }
      if (!included.length) continue;
      let resolvingStep = included[0]!.id;
      try {
        const bound = included.map(member => {
          const args = bindResults(member.arguments ?? {}, results) as Record<string, unknown>;
          if (!byId.get(member.action)!.validate(args)) throw new Error('前置结果与文档动作参数不匹配');
          return { ...member, arguments: args };
        });
        const { plan: batch, bindings } = await compileDocumentBatch(bound, (target, stepId) => {
          resolvingStep = stepId;
          return resolveTarget(context, target, results);
        });
        const outcome = await documentPreview(context, batch);
        for (const member of included) results.set(member.id, {
          id: member.id, action: member.action, ...outcome, status: 'waiting',
          result: { ...(isRecord(outcome.result) ? outcome.result : {}), binding: bindings[member.id] },
        });
      } catch (error) {
        for (const member of included) results.set(member.id, {
          id: member.id, action: member.action,
          status: error instanceof ChooseTarget ? member.id === resolvingStep ? 'waiting' : 'skipped' : 'failed',
          message: error instanceof Error ? error.message : '文档组合预检失败',
          ...(error instanceof ChooseTarget && member.id === resolvingStep ? {
            result: { ...candidateLocation(included.find(step => step.id === member.id)?.arguments ?? {}, error.target),
              candidates: error.matches.map(({ id, title, x, y }) => ({ id, title, x, y })) },
          } : {}),
        });
      }
      continue;
    }
    const done = previous.find(item => item.id === step.id);
    if (done?.status === 'completed' || done?.status === 'failed' && !retryFailed) {
      results.set(step.id, done);
      continue;
    }
    if (done?.status === 'waiting' && !choices[step.id]) {
      results.set(step.id, done);
      continue;
    }
    const action = byId.get(step.action)!;
    let outcome: Omit<WorkspaceStepReceipt, 'id' | 'action'>;
    if (dependencies(step).some(dep => results.get(dep)?.status !== 'completed')) {
      outcome = { status: 'skipped', message: '前置步骤未完成' };
    } else {
      try {
        const condition = step.when && results.get(step.when.step)?.result;
        if (step.when && (!isRecord(condition) || (Number(condition.count) > 0) !== step.when.exists)) {
          outcome = { status: 'skipped', message: '条件未满足' };
        } else {
          const choice = choices[step.id];
          const args = chooseArgument(bindResults(step.arguments ?? {}, results) as Record<string, unknown>, choice);
          if (!action.validate(args) || action.preflight && !await action.preflight(context, args)) throw new Error('前置结果与动作参数不匹配');
          const result = await action.run(context, args, target => resolveTarget(context, target, results));
          outcome = { ...result, status: result.status ?? 'completed' };
          if (action.descriptor.effect === 'workspace' && typeof requestAnimationFrame === 'function') {
            await new Promise<void>(resolve => {
              let frame = 0; let done = false;
              const finish = () => { if (done) return; done = true; cancelAnimationFrame(frame); stopTimer(); release(); resolve(); };
              const stopTimer = context.resources.timeout(finish, 80);
              const release = context.resources.track('other', finish);
              frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
            });
          }
        }
      } catch (error) {
        outcome = error instanceof ChooseTarget ? {
          status: 'waiting', message: error.message,
          result: { ...candidateLocation(step.arguments ?? {}, error.target), candidates: error.matches.map(({ id, title, x, y }) => ({ id, title, x, y })) },
        } : { status: 'failed', message: error instanceof Error ? error.message : '本地动作执行失败' };
      }
    }
    results.set(step.id, { id: step.id, action: step.action, ...outcome });
  }
  if ([...results.values()].every(step => step.status === 'completed' || step.status === 'skipped')) {
    for (const [index, check] of (plan.verify ?? []).entries()) {
      const id = '$verify.' + (index + 1);
      try {
        const action = byId.get(check.action)!;
        const args = bindResults(check.arguments ?? {}, results) as Record<string, unknown>;
        if (!action.validate(args) || action.preflight && !await action.preflight(context, args)) throw new Error('核验动作的结果参数无效');
        const outcome = await action.run(context, args, target => resolveTarget(context, target, results));
        if (outcome.status === 'waiting') {
          results.set(id, { id, action: check.action, ...outcome, status: 'waiting' });
          continue;
        }
        const { result } = outcome;
        let actual: unknown = result;
        for (const field of check.field) actual = isRecord(actual) && Object.hasOwn(actual, field) ? actual[field] : undefined;
        if (JSON.stringify(actual) !== JSON.stringify(bindResults(check.equals, results))) throw new Error('回读结果不符合预期：' + check.field.join('.'));
        results.set(id, { id, action: check.action, status: 'completed', result: actual });
      } catch (error) {
        results.set(id, { id, action: check.action, status: 'failed', message: error instanceof Error ? error.message : '结果核验失败' });
      }
    }
  }
  const steps = [...results.values()];
  return { id: plan.id, status: planStatus(steps), steps };
}

export function createWorkspaceActionsPlugin(panel?: unknown): PluginDefinition { return {
  manifest: defineManifest('workspace-actions', '本地工作区动作', {
    commands: [command, 'workspace.plan.resume@1', 'workspace.plan.cancel@1', 'workspace.actions.open@1', 'workspace.actions.close@1'],
    queries: [query, 'workspace.plan.validate@1', 'workspace.plan.receipt@1', 'workspace.plan.latest@1', 'workspace.queryTask@1', 'workspace.actions.state@1', 'workspace.coverage@1'],
    namespaces: [WORKSPACE_ACTIONS_NAMESPACE], namespaceDomains: { [WORKSPACE_ACTIONS_NAMESPACE]: 'workspace' },
    sessionOnlyWorkspace: { [WORKSPACE_ACTIONS_NAMESPACE]: true },
    ui: ['workspace-actions.panel'],
    asks: [...new Set([query, 'workspace.coverage@1', 'system.actions', 'system.plugins', 'system.document.revision', 'system.action.validate@1', 'system.actionCatalog@1', 'canvasControl.reviewReceipt@1',
      ...localActions.flatMap(action => action.queries)])],
    dispatches: [...new Set(['system.action.invoke@1', 'file.cancelOperation@1', 'canvasControl.apply@1', 'canvasControl.dismiss@1', ...localActions.flatMap(action => action.commands)])],
    optionalCapabilities: [...new Set(['content.summaries@1', 'content.canvasSummariesById@1', 'file.state@1', 'file.operationResult@1',
      ...localActions.flatMap(action => action.capabilities)])],
    permissions: ['history.manage', 'persistence.manage', 'ui.action.execute', 'store.own.read', 'store.own.write', 'ui.right.contribute', 'tasks.schedule'],
    events: ['document.replaced', UI_SURFACE_REVEALED_EVENT],
  }),
  start(context) {
    const setOpen = (open: boolean) => {
      if (open) context.ui.activateSurface('right.primary', 'workspace-actions.panel', 'workspace.actions.close@1');
      else context.ui.deactivateSurface('right.primary', 'workspace-actions.panel');
      return { transaction: { label: open ? '查看本地工作区动作' : '关闭工作区动作', history: false,
        patches: [{ op: 'set' as const, domain: 'workspace' as const, namespace: WORKSPACE_ACTIONS_NAMESPACE, key: 'open', value: open }],
        events: open ? [{ type: UI_SURFACE_REVEALED_EVENT, payload: uiSurfaceRevealed('right.primary', 'workspace-actions', 'workspace-actions.panel') }] : [],
      } };
    };
    context.commands.register({ type: 'workspace.actions.open@1', handle: () => setOpen(true) });
    context.commands.register({ type: 'workspace.actions.close@1', handle: () => setOpen(false) });
    context.queries.register({ type: 'workspace.actions.state@1', handle: () => ({ open: context.store.readValue<boolean>(WORKSPACE_ACTIONS_NAMESPACE, 'open') ?? false }) });
    context.ui.contribute({ id: 'workspace-actions.panel', slot: 'right.primary', kind: 'view', label: '开发者工具：工作区动作', component: panel, priority: 82 });
    const receipts = new Map<string, { signature: string; plan: WorkspacePlan; receipt: WorkspacePlanReceipt;
      bindings: Record<string, Record<string, unknown>> }>();
    context.events.subscribe('document.replaced', () => {
      clearWorkspaceQueries(context);
      for (const entry of receipts.values()) {
        entry.receipt.status = 'expired';
        for (const step of entry.receipt.steps) if (isRecord(step.result) && typeof step.result.workspaceTaskId === 'string') {
          cancelWorkspaceQuery(context, step.result.workspaceTaskId);
        }
      }
    });
    const activeOwners = async () => new Set((await context.queries.ask<PluginSnapshot[]>('system.plugins'))
      .filter(plugin => plugin.status === 'active').map(plugin => plugin.id));
    const runtimeActions = async (): Promise<LocalAction[]> => {
      const registered = await context.queries.ask<RegisteredAction[]>('system.actions');
      const contributions: LocalAction[] = registered.filter(entry => entry.localTool).map(entry => {
        const tool = entry.localTool!;
        const effectiveCommand = tool.version === 2 ? tool.command : entry.command;
        const noArguments = tool.inputSchema.type === 'null';
        const input = (args: Record<string, unknown>) => ({ owner: entry.owner, id: entry.id,
          ...(noArguments ? {} : { arguments: args }) });
        return {
          descriptor: {
            id: 'registered:' + entry.owner + ':' + entry.id, owner: entry.owner,
            label: entry.label, category: entry.category, effect: tool.effect, parameters: {}, inputSchema: tool.inputSchema,
            resultMode: tool.resultMode === 'waiting' ? 'readback' : 'returned',
          },
          commands: [effectiveCommand as LocalAction['commands'][number]], capabilities: [], queries: [],
          requiresCommandOwner: tool.version === 2,
          validate: args => !noArguments || Object.keys(args).length === 0,
          preflight: async (ctx, args) => (await ctx.queries.ask<{ valid: boolean }>('system.action.validate@1', input(args))).valid,
          run: async (ctx, args) => ({
            result: await ctx.commands.invoke('system.action.invoke@1', input(args)),
            ...(tool.resultMode === 'waiting' ? { status: 'waiting' as const, message: '等待功能所有者完成操作' } : {}),
          }),
        };
      });
      return [...localActions, ...contributions];
    };
    context.queries.register<undefined, WorkspaceActionIndex>({ type: query, handle: async () => {
      const active = await activeOwners();
      const registry = await context.queries.ask<WorkspaceRuntimeCatalog>('system.actionCatalog@1');
      const actions: WorkspaceActionIndex['actions'] = (await runtimeActions()).map(action => ({
        ...action.descriptor, sourceKeys: actionSources(action),
        status: actionAvailable(action, registry, active) ? 'available' : 'inactive',
      }));
      const registered = await context.queries.ask<RegisteredAction[]>('system.actions');
      const commands = new Set<string>(localActions.flatMap(action => action.commands));
      for (const entry of registered) {
        if (!active.has(entry.owner) || entry.localTool || commands.has(entry.command)) continue;
        actions.push({
          id: 'manual:' + entry.owner + ':' + entry.id, owner: entry.owner, label: entry.label,
          category: entry.category, effect: 'workspace', parameters: {}, status: 'manual',
          sourceKeys: ['command:' + entry.command],
        });
      }
      return { version: 1, actions, registry };
    } });
    context.queries.register({ type: 'workspace.coverage@1', handle: async () =>
      buildCoverage(await context.queries.ask<WorkspaceActionIndex>(query), await runtimeActions()) });
    context.queries.register({ type: 'workspace.plan.validate@1', validate: isPlan, handle: async input => {
      const byId = new Map((await runtimeActions()).map(action => [action.descriptor.id, action]));
      if (JSON.stringify(input).length > 256 * 1024) throw new Error('计划超过验证上限');
      await preflight(context, input, byId);
      return { steps: input.steps.map(step => ({ label: byId.get(step.action)!.descriptor.label, effect: byId.get(step.action)!.descriptor.effect })) };
    } });
    context.commands.register<WorkspacePlan, WorkspacePlanReceipt>({ type: command, validate: isPlan, handle: async (input, envelope) => {
      const key = envelope.sourcePlugin + ':' + input.id;
      const active = await activeOwners();
      const byId = new Map((await runtimeActions()).map(action => [action.descriptor.id, action]));
      const signature = JSON.stringify(input);
      if (signature.length > 256 * 1024) throw new Error('本地计划过大，请分批处理');
      const previous = receipts.get(key);
      if (previous) {
        if (previous.signature !== signature) throw new Error('同一计划编号不能提交不同内容');
        return { result: structuredClone(previous.receipt) };
      }
      await preflight(context, input, byId);
      const revision = input.constraints?.documentRevision;
      if (revision !== undefined && (await context.queries.ask<{ revision: number }>('system.document.revision')).revision !== revision) {
        throw new Error('书籍内容已变化，请重新准备计划');
      }
      if (active.has('import-export') && input.steps.some(step => byId.get(step.action)?.descriptor.effect === 'document')) {
        const file = await context.capabilities.request<FileRuntimeState>('file.state@1');
        if (file.cloudProjectActive) throw new Error('本地操作计划只能修改本地书籍');
      }
      const plan = structuredClone(input);
      const receipt = await execute(context, plan, byId);
      receipts.set(key, { signature, plan, receipt: structuredClone(receipt), bindings: {} });
      while (receipts.size > 64) receipts.delete(receipts.keys().next().value!);
      return { result: receipt };
    } });
    context.queries.register<{ id: string }, WorkspacePlanReceipt | undefined>({
      type: 'workspace.plan.receipt@1', validate: isPlanId,
      handle: (input, envelope) => {
        const receipt = receipts.get(envelope.sourcePlugin + ':' + input.id)?.receipt;
        return receipt && structuredClone(receipt);
      },
    });
    context.queries.register({ type: 'workspace.plan.latest@1', handle: (_input, envelope) => {
      const entry = [...receipts.entries()].reverse().find(([key]) => key.startsWith(envelope.sourcePlugin + ':'))?.[1];
      return entry ? structuredClone({ plan: entry.plan, receipt: entry.receipt }) : undefined;
    } });
    context.queries.register({ type: 'workspace.queryTask@1', validate: isPlanId,
      handle: ({ id }: { id: string }) => readWorkspaceQuery(context, id) });
    context.commands.register<WorkspacePlanResume, WorkspacePlanReceipt>({
      type: 'workspace.plan.resume@1', validate: isResume, handle: async (input, envelope) => {
        const record = receipts.get(envelope.sourcePlugin + ':' + input.id);
        if (!record || record.receipt.status === 'expired' || record.receipt.status === 'cancelled') {
          throw new Error('这份本地计划已失效');
        }
        const byId = new Map((await runtimeActions()).map(action => [action.descriptor.id, action]));
        await preflight(context, record.plan, byId);
        const chosenBindings: Record<string, Record<string, unknown>> = {};
        for (const [stepId, choice] of Object.entries(input.choices ?? {})) {
          const waiting = record.receipt.steps.find(step => step.id === stepId && step.status === 'waiting');
          const candidates = isRecord(waiting?.result) && waiting.result.candidates;
          const args = record.bindings[stepId] ?? record.plan.steps.find(step => step.id === stepId)?.arguments ?? {};
          const raw = args[choice.argument];
          const original = choice.index === undefined ? raw : Array.isArray(raw) ? raw[choice.index] : undefined;
          if (!isWorkspaceTarget(original) || !Array.isArray(candidates) ||
            !isRecord(waiting?.result) || waiting.result.argument !== choice.argument || waiting.result.index !== choice.index ||
            !candidates.some(item => isRecord(item) && item.id === choice.id)) {
            throw new Error('只能选择该步骤已展示的候选对象');
          }
          chosenBindings[stepId] = chooseArgument(args, choice);
        }
        Object.assign(record.bindings, chosenBindings);
        const apply = input.apply ?? [];
        if (new Set(apply).size !== apply.length) throw new Error('应用步骤不可重复');
        const awaiting = apply.map(id => {
          const step = record.receipt.steps.find(item => item.id === id && item.status === 'waiting' &&
            byId.get(item.action)?.descriptor.effect === 'document');
          if (!step || !isRecord(step.result) || typeof step.result.reviewId !== 'string') throw new Error('没有对应的文档预览');
          return { step, reviewId: step.result.reviewId };
        });
        for (const reviewId of new Set(awaiting.map(item => item.reviewId))) {
          try {
            const before = await context.queries.ask<CanvasReviewReceipt | undefined>('canvasControl.reviewReceipt@1', { id: reviewId });
            if (before?.status !== 'applied') await context.commands.invoke('canvasControl.apply@1', { id: reviewId });
          } catch (error) {
            for (const step of record.receipt.steps) if (step.status === 'waiting' && isRecord(step.result) && step.result.reviewId === reviewId) {
              step.status = 'failed'; step.message = error instanceof Error ? error.message : '文档预览应用失败';
            }
          }
        }
        for (const step of record.receipt.steps) {
          if (step.status !== 'waiting' || !isRecord(step.result) || typeof step.result.reviewId !== 'string') continue;
          const review = await context.queries.ask<CanvasReviewReceipt | undefined>('canvasControl.reviewReceipt@1', { id: step.result.reviewId });
          if (review?.status === 'applied') {
            const binding = step.result.binding;
            step.status = review.verification && review.verification.status !== 'verified' ? 'failed' : 'completed';
            step.result = { ...review, ...(typeof binding === 'string' ? { id: review.created[binding] ?? binding } : {}) };
            delete step.message;
          } else if (review && ['expired', 'dismissed', 'changed', 'undone', 'failed'].includes(review.status)) {
            step.status = 'failed'; step.message = review.error ?? '文档预览已失效或结果已改变';
          }
        }
        for (const step of record.receipt.steps) {
          if (step.status === 'waiting' && isRecord(step.result) && typeof step.result.workspaceTaskId === 'string') {
            const task = readWorkspaceQuery(context, step.result.workspaceTaskId);
            if (task?.state === 'running') continue;
            step.status = task?.state === 'completed' ? 'completed' : 'failed';
            step.result = task?.result;
            step.message = task?.message ?? (task ? undefined : '本地查询结果已过期');
            continue;
          }
          if (step.status !== 'waiting' || !isRecord(step.result) || typeof step.result.taskId !== 'string') continue;
          const task = await context.capabilities.request<LocalFileTaskResult | undefined>('file.operationResult@1', { taskId: step.result.taskId });
          if (!task || task.state === 'running') continue;
          step.status = task.state === 'ready' ? 'completed' : 'failed';
          step.result = task;
          step.message = task.message;
        }
        const boundPlan = { ...record.plan, steps: record.plan.steps.map(step => ({ ...step,
          ...(record.bindings[step.id] ? { arguments: record.bindings[step.id] } : {}) })) };
        const receipt = await execute(context, boundPlan, byId, record.receipt.steps, input.choices, input.retryFailed);
        record.receipt = structuredClone(receipt);
        return { result: receipt };
      },
    });
    context.commands.register<{ id: string }, WorkspacePlanReceipt>({
      type: 'workspace.plan.cancel@1', validate: isPlanId, handle: async (input, envelope) => {
        const record = receipts.get(envelope.sourcePlugin + ':' + input.id);
        if (!record || record.receipt.status === 'expired') throw new Error('这份本地计划已失效');
        for (const step of record.receipt.steps) if (isRecord(step.result) && typeof step.result.workspaceTaskId === 'string') {
          cancelWorkspaceQuery(context, step.result.workspaceTaskId);
        }
        for (const step of record.receipt.steps) if (step.status === 'waiting' && isRecord(step.result) && typeof step.result.taskId === 'string') {
          const requested = await context.commands.invoke('file.cancelOperation@1', { taskId: step.result.taskId });
          step.message = requested.requested ? '已请求取消本地文件任务；已完成的写入不会撤回' : '文件任务已结束，请按实际文件结果核对';
        }
        for (const step of record.receipt.steps) if (step.status === 'waiting' &&
          isRecord(step.result) && typeof step.result.reviewId === 'string') {
          await context.commands.invoke('canvasControl.dismiss@1', { id: step.result.reviewId });
        }
        record.receipt.status = 'cancelled';
        for (const step of record.receipt.steps) if (step.status !== 'completed') {
          step.status = 'skipped';
          step.message ??= '任务已取消';
        }
        return { result: structuredClone(record.receipt) };
      },
    });
  },
}; }

export const workspaceActionsPlugin = createWorkspaceActionsPlugin();
