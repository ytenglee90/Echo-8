import { createId, isRecord, type PluginDefinition } from '../../core/contracts.ts';
import { CANVAS_CONTROL_RESUME, CANVAS_CONTROL_RESULT, type CanvasControlAdmission, type CanvasControlOffer, type CanvasControlReview, type CanvasControlState } from '../../protocols/canvas-control.ts';
import type { AppearanceEntityRef, AppearanceReadContribution, AppearanceUpdatePlan } from '../../protocols/appearance.ts';
import type { ContentReplacePlan } from '../../protocols/search.ts';
import { OPERATION_LOG_STAGE, OPERATION_LOG_STAGE_V2, type OperationStatus, type OperationStageUpdate, type OperationStageUpdateV2 } from '../../protocols/operation-log.ts';
import { canvasRequestsAllNodes, naturalCanvasOperation, needsCanvasSearchInterpretation, type NaturalCanvasOperation } from '../../services/ai-task-route.ts';
import { validateAIContextSearchRequest } from '../../protocols/ai.ts';
import { parseCanvasControlPlan } from '../../services/canvas-control-validation.ts';
import { defineManifest } from '../manifest.ts';
import { captureControlSnapshot, controlInstruction, controlContextV2, type ControlSnapshot } from './context.ts';
import { controlTaskState, readTaskMarkers, type StoredControlReview } from './task-state.ts';
import { lineStyleFollowup, localLinePlan, localOperation, localPlan } from './local-operations.ts';
import { discoverControlTargets } from './target-discovery.ts';
import { resolveNaturalOperation, shadeColor, type NaturalControlResult, type NaturalControlState } from './natural-operations.ts';
import { planControlApplication, validateControlScope } from './planning.ts';
import { actionCounts, controlFailureReason, localOperationDetail } from './operation-details.ts';
import type { CanvasAgentQuery, CanvasAgentSubmission } from '../../protocols/canvas-agent.ts';
import { grantAgentSnapshot, newAgentDiscovery, queryAgentCanvas, readAgentCanvas, type AgentDiscoverySession } from './agent-discovery.ts';
import { prepareAgentPlan } from './agent-planning.ts';
import { verifyControlApplication } from './verification.ts';

export const CONTROL_UI_NAMESPACE = 'canvasControlUI';
export function createCanvasControlPlugin(panel?: unknown, toolbar?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('canvas-control', 'AI 画布控制', {
      namespaces: [CONTROL_UI_NAMESPACE], namespaceDomains: { [CONTROL_UI_NAMESPACE]: 'workspace' },
      sessionOnlyWorkspace: { [CONTROL_UI_NAMESPACE]: true },
      requiresCapabilities: ['content.summaries@1', 'content.summariesById@1', 'selection.read@1', 'selection.resolve@1', 'selection.entities@1', 'canvasControl.nodesPlan@1'],
      optionalCapabilities: ['context.catalog@1', 'context.read@1', 'context.search@1', 'context.search@3', 'context.semanticSearch@3', 'appearance.read@1', 'appearance.updatePlan@1', 'canvasControl.nodesPlan@2', 'groups.list@1', 'connections.graph@1', 'connections.targets@1', 'entity.deletePlan@1', 'canvasControl.groupsPlan@1', 'canvasControl.connectionsPlan@1', 'content.replacePlan@2'],
      providesCapabilities: ['canvasControl.agentQuery@1', 'canvasControl.agentRead@1', 'canvasControl.agentPlan@1', 'canvasControl.bindContent@1', 'canvasControl.context@1', 'canvasControl.context@2', 'canvasControl.localPlan@1', 'canvasControl.taskState@1', 'canvasControl.searchPlan@1'],
      commands: ['canvasControl.open@1', 'canvasControl.close@1', 'canvasControl.scope@1', 'canvasControl.execution@1', 'canvasControl.offer@1', 'canvasControl.generate@1', 'canvasControl.apply@1', 'canvasControl.commit@1', 'canvasControl.dismiss@1', 'canvasControl.navigate@1', 'canvasControl.background.apply@1', 'canvasControl.background.dismiss@1'],
      dispatches: ['canvasControl.apply@1', 'canvasControl.commit@1', 'canvasControl.offer@1', 'canvasControl.generate@1', 'selection.set', 'canvas.focusSelection', 'palette.setPreferences'],
      queries: ['canvasControl.state@1'],
      events: ['document.replaced', 'history.changed', 'canvas.appearance.changed', 'canvasControl.background.applied@1'], signals: [CANVAS_CONTROL_RESUME, CANVAS_CONTROL_RESULT, 'canvasControl.updated@1', 'appearance.color.preview', OPERATION_LOG_STAGE, OPERATION_LOG_STAGE_V2],
      ui: ['canvas-control.panel', 'canvas-control.toolbar'], actions: ['canvas-control.open-action'],
      shortcuts: ['canvas-control.open-shortcut'],
      permissions: ['store.own.read', 'store.own.write', 'content.context.read', 'ui.top.contribute', 'ui.overlay.contribute', 'ui.action.register', 'ui.shortcut.register'],
    }),
    start(context) {
      const snapshots = new Map<string, ControlSnapshot>();
      const reviews = new Map<string, StoredControlReview>();
      const applying = new Map<string, string>();
      const generating = new Set<string>();
      const lastNatural = new Map<string, NaturalControlState>();
      const localResults = new Map<string, NaturalControlResult>();
      const agentSessions = new Map<string, AgentDiscoverySession>();
      let navigation: CanvasControlState['navigation'];
      let choice: { input: CanvasControlAdmission; name: string; ids: string[]; chosen: Map<string, string> } | undefined;
      let background: { id: string; color: string; previous: string; entity: AppearanceEntityRef } | undefined;
      const logPlan = (id: string, state: OperationStatus) => {
        const draft = reviews.get(id);
        if (!draft) return;
        const operation = naturalCanvasOperation(draft.snapshot.prompt);
        context.signals.emit(OPERATION_LOG_STAGE_V2, {
          id, phase: 'canvas-plan', state, relatedId: draft.snapshot.preparationId, expiresAt: draft.snapshot.expiresAt,
          count: draft.review.replacement?.count ?? draft.review.actions.length,
          detail: { ...(operation ? localOperationDetail(operation) : { route: 'model' as const }),
            step: state === 'running' ? 'commit' : state === 'pending' || state === 'waiting' ? 'review' : 'done',
            matched: draft.snapshot.nodes.length, actions: actionCounts(draft.review.actions),
            reason: state === 'pending' ? (execution() === 'review' ? 'review-preference' : 'review-existing') :
              state === 'waiting' ? 'ready-direct' : state === 'applied' ? 'applied' :
                state === 'failed' ? controlFailureReason(new Error(draft.review.error)) : state === 'expired' ? 'expired' : undefined },
        } satisfies OperationStageUpdateV2);
        if (!generating.has(id) && (state === 'applied' || state === 'failed' || state === 'dismissed')) context.signals.emit(CANVAS_CONTROL_RESULT, {
          sessionId: draft.review.sessionId, preparationId: draft.snapshot.preparationId, prompt: draft.snapshot.prompt,
          status: state, count: draft.review.actions.length, verification: draft.review.verification?.status,
        });
      };
      const logBackground = (id: string, state: OperationStatus) =>
        context.signals.emit(OPERATION_LOG_STAGE, { id, relatedId: id, phase: 'canvas-background', state } satisfies OperationStageUpdate);
      const scope = () => context.store.readValue<'selection' | 'canvas'>(CONTROL_UI_NAMESPACE, 'scope') ?? 'selection';
      const execution = () => context.store.readValue<'direct' | 'review'>(CONTROL_UI_NAMESPACE, 'execution') ?? 'direct';
      const state = (): CanvasControlState => ({
        open: context.store.readValue<boolean>(CONTROL_UI_NAMESPACE, 'open') === true,
        scope: scope(),
        execution: execution(),
        reviews: [...reviews.values()].map(({ review }) => structuredClone(review)),
        navigation,
        background: background && { color: background.color, previous: background.previous },
      });
      const publish = () => context.signals.emit('canvasControl.updated@1');
      const clearBackground = (state: 'applied' | 'dismissed' = 'dismissed') => {
        if (background) logBackground(background.id, state);
        background = undefined; context.signals.emit('appearance.color.preview', { clear: true }); publish();
      };
      const openSurface = () => context.ui.activateSurface('overlay.floating', 'canvas-control.panel', 'canvasControl.close@1');
      const uiPatch = (key: string, value: unknown) => ({ op: 'set' as const, domain: 'workspace' as const, namespace: CONTROL_UI_NAMESPACE, key, value });
      const showControl = () => ({ label: '显示画布操作', history: false as const, patches: [uiPatch('open', true)] });
      const focus = (ids: string[]) => {
        if (!panel || !ids.length) return;
        context.commands.defer('selection.set', { ids, mode: 'replace' });
        context.commands.defer('canvas.focusSelection');
      };
      const remember = (sessionId: string, next: Partial<NaturalControlState>) => lastNatural.set(sessionId, { ids: [], ...lastNatural.get(sessionId), ...next });
      const agentSession = (input: CanvasControlAdmission) => {
        if (!isAdmission(input)) throw new Error('画布工具请求无效');
        let session = agentSessions.get(input.preparationId);
        if (session && (session.sessionId !== input.sessionId || session.prompt !== input.prompt || session.expiresAt < Date.now())) throw new Error('画布工具任务已失效');
        if (!session) {
          session = newAgentDiscovery(input);
          agentSessions.set(input.preparationId, session);
          while (agentSessions.size > 8) agentSessions.delete(agentSessions.keys().next().value!);
        }
        return session;
      };
      context.capabilities.provide({ key: 'canvasControl.agentQuery@1', invoke: async (input: CanvasControlAdmission & { query: CanvasAgentQuery }, signal) => {
        const id = createId('canvas-agent-query');
        const started = performance.now();
        context.signals.emit(OPERATION_LOG_STAGE_V2, { id, relatedId: input.preparationId, phase: 'canvas-targets', state: 'running', detail: { step: 'targets', route: 'model' } } satisfies OperationStageUpdateV2);
        try {
        const result = await queryAgentCanvas(context, input, agentSession(input), lastNatural.get(input.sessionId) ?? { ids: [] }, signal);
        context.signals.emit(OPERATION_LOG_STAGE_V2, { id, relatedId: input.preparationId, phase: 'canvas-targets', state: 'completed', elapsedMs: performance.now() - started,
          detail: { step: 'targets', route: 'model', scope: input.query.mode === 'all' ? 'canvas' : input.query.mode === 'selection' ? 'selection' : 'named', matched: result.nodes.length,
            queryMode: input.query.mode, reason: result.nodes.length ? 'model-plan' : 'empty-targets' } } satisfies OperationStageUpdateV2);
        if (input.query.mode === 'state') result.tasks = await controlTaskState(context, [...reviews.values()], { sessionId: input.sessionId }, signal);
        return result;
        } catch (error) {
          context.signals.emit(OPERATION_LOG_STAGE_V2, { id, relatedId: input.preparationId, phase: 'canvas-targets', state: signal?.aborted ? 'cancelled' : 'failed', elapsedMs: performance.now() - started,
            detail: { step: 'targets', reason: controlFailureReason(error) } } satisfies OperationStageUpdateV2);
          throw error;
        }
      } });
      context.capabilities.provide({ key: 'canvasControl.agentRead@1', invoke: async (input: CanvasControlAdmission & { id: string; start?: number; length?: number }, signal) => {
        const id = createId('canvas-agent-read');
        const started = performance.now();
        const trace = (state: OperationStatus, detail?: OperationStageUpdateV2['detail']) => context.signals.emit(OPERATION_LOG_STAGE_V2,
          { id, relatedId: input.preparationId, phase: 'canvas-read', state, elapsedMs: performance.now() - started, detail: { step: 'read', route: 'model', ...detail } } satisfies OperationStageUpdateV2);
        trace('running');
        try {
          const result = await readAgentCanvas(context, input, agentSession(input), signal);
          trace('completed', { readCharacters: result.text.length });
          return result;
        } catch (error) { trace(signal?.aborted ? 'cancelled' : 'failed', { reason: controlFailureReason(error) }); throw error; }
      } });
      context.capabilities.provide({ key: 'canvasControl.agentPlan@1', invoke: async (input: CanvasControlAdmission & CanvasAgentSubmission, signal) => {
        const id = createId('canvas-agent-validation');
        const started = performance.now();
        const trace = (state: OperationStatus, detail?: OperationStageUpdateV2['detail']) => context.signals.emit(OPERATION_LOG_STAGE_V2,
          { id, relatedId: input.preparationId, phase: 'canvas-validation', state, elapsedMs: performance.now() - started, detail: { step: 'validate', route: 'model', ...detail } } satisfies OperationStageUpdateV2);
        trace('running');
        try {
        const prepared = await prepareAgentPlan(context, input, agentSession(input), execution(), signal);
        snapshots.set(input.preparationId, prepared.snapshot);
        localResults.set(input.preparationId, prepared.local);
        while (localResults.size > 8) localResults.delete(localResults.keys().next().value!);
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
        trace('completed', { actions: actionCounts(prepared.local.plan.actions), reason: prepared.local.plan.actions.length ? 'model-plan' : 'no-change' });
        return { text: prepared.text };
        } catch (error) { trace(signal?.aborted ? 'cancelled' : 'failed', { reason: controlFailureReason(error) }); throw error; }
      } });
      const naturalPlan = async (input: CanvasControlAdmission, chosen = new Map<string, string>(), signal?: AbortSignal, interpreted?: NaturalCanvasOperation) => {
        const operation = interpreted ?? naturalCanvasOperation(input.prompt);
        if (!operation) return undefined;
        const trace = (state: OperationStatus, detail: OperationStageUpdateV2['detail']) => context.signals.emit(OPERATION_LOG_STAGE_V2, {
          id: input.preparationId, relatedId: input.preparationId, phase: 'canvas-targets', state,
          detail: { ...localOperationDetail(operation), ...detail },
        } satisfies OperationStageUpdateV2);
        trace('running', { step: 'targets' });
        const previous = lastNatural.get(input.sessionId) ?? { ids: [] };
        let result: NaturalControlResult;
        if (operation.kind === 'content') {
          result = await resolveNaturalOperation(context, input, { kind: 'find', names: operation.names }, previous, chosen, signal);
          if (result.focus?.length && !result.choice) {
            trace('completed', { step: 'targets', matched: result.focus.length, reason: 'model-plan' });
            return { handled: false as const, sourceIds: result.focus };
          }
        } else if (operation.kind === 'theme' || operation.kind === 'background') {
          result = { plan: { version: 1, actions: [] }, setting: operation };
        } else if (operation.kind === 'line' && !operation.names.length && operation.reference !== 'selection' && previous.pendingLine) {
          result = { plan: { version: 1, actions: [] }, pendingLine: { id: previous.pendingLine, line: operation.line } };
        } else {
          result = await resolveNaturalOperation(context, input, operation, previous, chosen, signal);
          if (operation.kind === 'relative-color' && operation.names.join('') === '它们') {
            const latest = [...reviews.values()].filter(draft => draft.review.sessionId === input.sessionId).at(-1);
            const actions = latest?.review.actions ?? [];
            if (latest?.review.status === 'pending' && latest.snapshot.expiresAt >= Date.now() && actions.length &&
              actions.every(action => (action.type === 'update-node' || action.type === 'create-node') && action.color)) {
              result = { plan: { version: 1, actions: [] }, pendingColor: { id: latest.review.id, direction: operation.direction } };
            }
          }
        }
        trace('completed', { step: 'targets', matched: result.targets?.length ?? result.focus?.length ?? 0,
          candidates: result.choice?.ids.length ?? 0, actions: actionCounts(result.plan.actions),
          reason: result.choice ? 'ambiguous-target' : result.plan.actions.length ? 'local-rule' : result.focus?.length ? 'no-change' : 'empty-targets' });
        const snapshot = await captureControlSnapshot(context, { ...input, sourceIds: result.targets ?? [] }, 'selection', signal, undefined, true);
        const createsDirectly = operation.kind === 'create' || operation.kind === 'connect' || operation.kind === 'connect-many' ||
          (operation.kind === 'batch' && result.plan.actions.every(action => action.type === 'create-node' || action.type === 'create-connection' || action.type === 'create-group'));
        snapshot.execution = createsDirectly ? execution() : 'review';
        validateControlScope(result.plan, snapshot);
        snapshots.set(input.preparationId, snapshot);
        localResults.set(input.preparationId, { ...result, chosen });
        while (localResults.size > 8) localResults.delete(localResults.keys().next().value!);
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
        return { handled: true as const, text: JSON.stringify(result.plan), ...(result.unresolvedTarget ? { unresolvedTarget: true } : {}) };
      };
      context.capabilities.provide({ key: 'canvasControl.bindContent@1', invoke: async (input: CanvasControlAdmission, signal) => {
        if (!isAdmission(input)) throw new Error('画布控制请求无效');
        const operation = naturalCanvasOperation(input.prompt);
        if (operation?.kind !== 'content') return { ids: [], needsChoice: false };
        const result = await resolveNaturalOperation(context, input, { kind: 'find', names: operation.names }, lastNatural.get(input.sessionId) ?? { ids: [] }, new Map(), signal);
        return { ids: result.choice ? [] : result.focus ?? [], needsChoice: Boolean(result.choice || !result.focus?.length) };
      } });
      context.capabilities.provide({ key: 'canvasControl.searchPlan@1', invoke: async (input: CanvasControlAdmission & { terms: string[]; ungrouped: boolean }, signal) => {
        if (!isAdmission(input) || !needsCanvasSearchInterpretation(input.prompt) || typeof input.ungrouped !== 'boolean') throw new Error('当前请求不是画布线索筛选');
        validateAIContextSearchRequest({ terms: input.terms, maxResults: 50 });
        return (await naturalPlan(input, undefined, signal, { kind: 'search', names: [], terms: input.terms, ungrouped: input.ungrouped }))!;
      } });
      context.capabilities.provide({ key: 'canvasControl.taskState@1', invoke: (input: { sessionId: string; targetIds?: string[] }, signal) => {
        if (!isRecord(input) || typeof input.sessionId !== 'string' || input.sessionId.length > 200 ||
          (input.targetIds !== undefined && (!Array.isArray(input.targetIds) || input.targetIds.length > 80 || input.targetIds.some(id => typeof id !== 'string')))) throw new Error('任务状态请求无效');
        return controlTaskState(context, [...reviews.values()], input, signal);
      } });
      context.capabilities.provide({ key: 'canvasControl.context@2', invoke: async (input: CanvasControlAdmission & { purpose?: import('../../protocols/canvas-control.ts').CanvasControlPurpose }, signal) => {
        if (!isAdmission(input) || (input.purpose !== undefined && !['appearance', 'move', 'creation', 'structure', 'content', 'general'].includes(input.purpose))) throw new Error('画布控制请求无效');
        const discovery = await discoverControlTargets(context, input, [...reviews.values()], signal);
        const requestedScope = canvasRequestsAllNodes(input.prompt) ? 'canvas' : scope();
        const previous = /它们|这些|刚才(?:的|那批|创建)/u.test(input.prompt) ? lastNatural.get(input.sessionId)?.ids ?? [] : [];
        const snapshot = await captureControlSnapshot(context, { ...input, sourceIds: [...new Set([...(input.sourceIds ?? []), ...previous])] }, requestedScope, signal, discovery);
        snapshot.execution = execution();
        context.signals.emit(OPERATION_LOG_STAGE_V2, { id: input.preparationId, relatedId: input.preparationId, phase: 'canvas-targets', state: 'completed',
          detail: { step: 'targets', route: 'model', scope: requestedScope === 'canvas' ? 'canvas' : discovery.names.length ? 'named' : 'selection',
            matched: snapshot.nodes.length, reason: snapshot.nodes.length ? 'model-plan' : 'empty-targets' } } satisfies OperationStageUpdateV2);
        snapshots.set(input.preparationId, snapshot);
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
        const result = controlContextV2(snapshot, input.purpose);
        const agent = agentSessions.get(input.preparationId);
        if (agent) grantAgentSnapshot(agent, snapshot);
        if (result.instruction.length + result.objectDirectory.length > 24_000) throw new Error('对象目录过大，请缩小范围');
        return result;
      } });
      context.capabilities.provide({ key: 'canvasControl.localPlan@1', invoke: async (input: CanvasControlAdmission, signal) => {
        if (!isAdmission(input)) throw new Error('画布控制请求无效');
        const resolved = await naturalPlan(input, undefined, signal).catch(error => {
          context.signals.emit(OPERATION_LOG_STAGE_V2, { id: input.preparationId, relatedId: input.preparationId, phase: 'canvas-targets', state: 'failed',
            detail: { step: 'targets', reason: controlFailureReason(error) } } satisfies OperationStageUpdateV2);
          throw error;
        });
        if (resolved) return resolved;
        const operation = localOperation(input.prompt);
        const line = lineStyleFollowup(input.prompt);
        if ((!operation && !line) || scope() !== 'selection') return { handled: false };
        const discovery = line ? await discoverControlTargets(context, input, [...reviews.values()], signal) : undefined;
        const snapshot = await captureControlSnapshot(context, input, scope(), signal, discovery);
        snapshot.execution = 'review';
        const plan = line ? localLinePlan(snapshot, line) : localPlan(snapshot, operation!);
        if (!plan) return { handled: false };
        validateControlScope(plan, snapshot);
        snapshots.set(input.preparationId, snapshot);
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
        return { handled: true, text: JSON.stringify(plan) };
      } });
      context.capabilities.provide<CanvasControlAdmission, { instruction: string }>({
        key: 'canvasControl.context@1',
        invoke: async (input, signal) => {
          if (!isAdmission(input)) throw new Error('画布控制请求无效');
          const snapshot = await captureControlSnapshot(context, input, scope(), signal);
          snapshot.execution = execution();
          if (signal?.aborted) throw new Error('画布控制已取消');
          const instruction = controlInstruction(snapshot);
          if (instruction.length > 24_000) throw new Error('对象目录过大，请缩小控制范围');
          for (const [id, old] of snapshots) if (old.sessionId === input.sessionId) snapshots.delete(id);
          snapshots.set(input.preparationId, snapshot);
          while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
          return { instruction };
        },
      });
      context.queries.register({ type: 'canvasControl.state@1', handle: state });
      context.commands.register({ type: 'canvasControl.open@1', handle: () => {
        openSurface();
        if (context.store.readValue<boolean>(CONTROL_UI_NAMESPACE, 'open') === true) return {};
        return { transaction: { label: '打开画布控制', history: false, patches: [uiPatch('open', true)] } };
      } });
      context.commands.register({ type: 'canvasControl.close@1', handle: () => {
        context.ui.deactivateSurface('overlay.floating', 'canvas-control.panel');
        if (background) clearBackground();
        return { transaction: { label: '关闭画布控制', history: false, patches: [uiPatch('open', false)] } };
      } });
      context.commands.register({ type: 'canvasControl.scope@1', validate: (input): input is { scope: 'selection' | 'canvas' } => isRecord(input) && (input.scope === 'selection' || input.scope === 'canvas'), handle: input => ({
        transaction: { label: '设置 AI 画布控制范围', history: false, patches: [uiPatch('scope', input.scope)] },
      }) });
      context.commands.register({ type: 'canvasControl.execution@1', validate: (input): input is { execution: 'direct' | 'review' } => isRecord(input) && (input.execution === 'direct' || input.execution === 'review'), handle: input => ({
        transaction: { label: '设置画布生成方式', history: false, patches: [uiPatch('execution', input.execution)] },
      }) });
      context.commands.register({ type: 'canvasControl.navigate@1', validate: isPlanId, handle: async input => {
        if (choice && navigation?.choice && choice.ids.includes(input.id)) {
          const current = choice;
          choice = undefined;
          const chosen = new Map(current.chosen).set(current.name, input.id);
          const admission = { ...current.input, preparationId: createId('canvas-choice') };
          const plan = await naturalPlan(admission, chosen);
          if (!plan) throw new Error('原请求已经失效');
          if (!plan.handled) {
            if (plan.sourceIds.length) context.signals.emit(CANVAS_CONTROL_RESUME, { ...admission, sourceIds: plan.sourceIds });
            navigation = undefined;
            publish();
            return {};
          }
          const offered = await context.commands.invoke('canvasControl.offer@1', { ...admission, text: plan.text, complete: true });
          if (offered.directPlanId) await context.commands.invoke('canvasControl.generate@1', { id: offered.directPlanId });
          publish();
          return { result: offered };
        }
        if (!navigation?.items.some(item => item.id === input.id)) throw new Error('结果已失效，请重新查找');
        focus([input.id]);
        return {};
      } });
      context.commands.register({ type: 'canvasControl.background.apply@1', handle: async () => {
        if (!background) throw new Error('没有待应用的背景颜色');
        const current = background;
        const updates = await context.capabilities.requestAll<AppearanceUpdatePlan>('appearance.updatePlan@1', { kind: 'canvas-background', color: current.color, entities: [current.entity] });
        const patches = updates.flatMap(update => update.patches);
        if (!patches.length) throw new Error('画布背景更新不可用，请重新准备预览');
        return { transaction: { label: 'AI 修改画布背景', patches, events: [
          { type: 'canvasControl.background.applied@1', payload: { operationLogBackgroundId: current.id } },
          ...updates.flatMap(update => update.events ?? []),
        ] } };
      } });
      context.commands.register({ type: 'canvasControl.background.dismiss@1', handle: () => { clearBackground(); return {}; } });
      context.commands.register({ type: 'canvasControl.offer@1', validate: (input): input is CanvasControlOffer => isAdmission(input) && typeof (input as CanvasControlOffer).text === 'string' && typeof (input as CanvasControlOffer).complete === 'boolean', handle: async input => {
        const snapshot = snapshots.get(input.preparationId);
        if (!snapshot || snapshot.expiresAt < Date.now() || snapshot.sessionId !== input.sessionId || snapshot.prompt !== input.prompt) throw new Error('本轮画布控制范围已失效，请重新发送要求');
        if (!input.complete) throw new Error('画布操作计划被平台截断，请缩小任务后重新生成');
        const local = localResults.get(input.preparationId);
        if (local && input.text !== JSON.stringify(local.plan)) throw new Error('本地操作计划已变化，请重新发送要求');
        const plan = parseCanvasControlPlan(input.text);
        validateControlScope(plan, snapshot);
        snapshots.delete(input.preparationId);
        localResults.delete(input.preparationId);
        if (local) {
          choice = local.choice ? { input, ...local.choice, chosen: new Map(local.chosen) } : undefined;
          navigation = local.navigation;
          if (local.next) remember(input.sessionId, { unfinishedConnection: undefined, ...local.next });
          if (local.focus && local.selectionMode) await context.commands.invoke('selection.set', { ids: local.focus, mode: local.selectionMode });
          else if (local.focus) focus(local.focus);
          if (local.navigation) { openSurface(); publish(); }
          if (local.setting?.kind === 'theme') {
            await context.commands.invoke('palette.setPreferences', { themeId: local.setting.theme });
            return { result: { message: `已切换为${local.setting.theme === 'dark' ? '深色' : '浅色'}主题。` } };
          }
          if (local.setting?.kind === 'background') {
            const targets = await context.capabilities.requestAll<AppearanceReadContribution>('appearance.read@1', { mode: 'global', selectedIds: [] });
            const target = targets.flatMap(item => item.targets).find(item => item.kind === 'canvas-background');
            if (!target?.entities[0]) throw new Error('当前画布背景不可用');
            if (target.color === local.setting.color) return { result: { message: '画布已使用这个背景颜色。' } };
            if (background) logBackground(background.id, 'dismissed');
            background = { id: input.preparationId, color: local.setting.color, previous: target.color, entity: target.entities[0] };
            logBackground(background.id, 'pending');
            context.signals.emit('appearance.color.preview', { kind: 'canvas-background', color: background.color, entityIds: ['canvas'] });
            openSurface(); publish();
            return { result: { message: '已准备画布背景颜色，请在画布控制中预览并应用。' }, transaction: showControl() };
          }
          if (local.pendingLine) {
            const { id, line: style } = local.pendingLine;
            const pending = reviews.get(id);
            const line = lastNatural.get(input.sessionId)?.pendingLine === id && pending?.review.status === 'pending' &&
              pending.snapshot.expiresAt >= Date.now() && pending.review.actions.length === 1 ? pending.review.actions[0] : undefined;
            if (!line || (line.type !== 'create-connection' && line.type !== 'update-connection')) return { result: { message: '上一条连线预览已失效，请重新指定端点。' } };
            line.line = style;
            openSurface(); publish();
            return { result: { message: `已把待应用的连线预览改为${line.line === 'dashed' ? '虚线' : '实线'}。` }, transaction: showControl() };
          }
          if (local.pendingColor) {
            const pending = reviews.get(local.pendingColor.id);
            if (!pending || pending.review.sessionId !== input.sessionId || pending.review.status !== 'pending' ||
              pending.snapshot.expiresAt < Date.now()) return { result: { message: '上一份配色预览已失效，请重新指定目标。' } };
            for (const action of pending.review.actions) {
              if ((action.type === 'create-node' || action.type === 'update-node') && action.color) {
                action.color = shadeColor(action.color, local.pendingColor.direction);
              }
            }
            openSurface(); publish();
            return { result: { message: '已调整待应用计划中的颜色。' }, transaction: showControl() };
          }
        }
        if (!plan.actions.length && !local?.replacement) return { result: { message: plan.answer?.trim() || '本次没有需要应用的画布操作。' }, ...(local?.navigation ? { transaction: showControl() } : {}) };
        const id = createId('canvas-plan');
        const titles = Object.fromEntries([...snapshot.nodes.map(node => [node.id, node.title]), ...snapshot.groups.map(group => [group.id, group.title]), ...snapshot.graph.connections.map(edge => [edge.id, edge.label || '连线']), ...plan.actions.flatMap(action => 'ref' in action ? [[action.ref, 'title' in action ? action.title : action.label || '连线']] : [])]);
        if (local) for (const edge of snapshot.graph.connections) {
          titles[edge.id] = `${titles[edge.from.nodeId] ?? edge.from.nodeId} → ${titles[edge.to.nodeId] ?? edge.to.nodeId}`;
        }
        const review: CanvasControlReview = { id, sessionId: input.sessionId, createdAt: Date.now(), status: 'pending', actions: plan.actions, titles, planVersion: plan.version };
        if (local?.replacement) {
          const { hits, replacement } = local.replacement;
          review.replacement = { count: hits.length, nodeCount: new Set(hits.map(hit => hit.nodeId)).size,
            from: hits[0]!.matchedText, to: replacement, examples: hits.slice(0, 5).map(hit => `${hit.title} · ${hit.preview}`) };
        }
        reviews.set(id, { review, snapshot, replacement: local?.replacement });
        if (local && plan.actions.length === 1 && (plan.actions[0]?.type === 'create-connection' || plan.actions[0]?.type === 'update-connection')) remember(input.sessionId, { pendingLine: id });
        while (reviews.size > 8) {
          const oldest = reviews.keys().next().value!;
          if (reviews.get(oldest)?.review.status === 'pending') logPlan(oldest, 'expired');
          reviews.delete(oldest);
        }
        if (snapshot.execution === 'direct' && execution() === 'direct' && canGenerateDirectly(review, snapshot)) {
          logPlan(id, 'waiting');
          publish();
          return { result: { message: `已准备 ${plan.actions.length} 项操作，将直接生成到画布，无需点击应用。完成后可一次撤销。`, directPlanId: id } };
        }
        logPlan(id, 'pending');
        openSurface(); publish();
        return { result: { message: review.replacement ? `已找到 ${review.replacement.nodeCount} 个节点中的 ${review.replacement.count} 处正文。请检查替换预览。` : `${review.error ? `直接生成未成功：${review.error}。` : ''}已生成 ${plan.actions.length} 项画布操作计划。请在“画布控制”中检查，点击底部固定的“应用整份计划”。` },
          transaction: { label: '显示 AI 画布操作计划', history: false, patches: [uiPatch('open', true)] } };
      } });
      context.commands.register({ type: 'canvasControl.generate@1', validate: isPlanId, handle: async input => {
        const draft = reviews.get(input.id);
        if (!draft || draft.review.status !== 'pending') throw new Error('这份操作计划已处理或不存在');
        if (draft.snapshot.execution !== 'direct' || execution() !== 'direct' || !canGenerateDirectly(draft.review, draft.snapshot)) {
          logPlan(input.id, 'pending');
          openSurface(); publish();
          return { result: { message: '本轮需要先预览，请在画布控制底部点击“应用整份计划”。' }, transaction: { label: '显示待应用计划', history: false, patches: [uiPatch('open', true)] } };
        }
        let applied: { createdIds: string[] };
        try {
          generating.add(input.id);
          applied = await context.commands.invoke('canvasControl.apply@1', input);
        }
        catch (error) {
          draft.review.error = error instanceof Error ? error.message : String(error);
          openSurface(); publish();
          return { result: { message: `直接生成未成功：${draft.review.error}。计划已保留，可在画布控制检查。` }, transaction: { label: '显示生成失败计划', history: false, patches: [uiPatch('open', true)] } };
        } finally { generating.delete(input.id); }
        if (draft.review.verification && draft.review.verification.status !== 'verified') {
          return { result: { message: '画布修改已提交，回读核对尚未通过。请查看画布控制中的核对结果，可撤销本次操作。' } };
        }
        const single = draft.review.actions.length === 1 ? draft.review.actions[0] : undefined;
        if (single?.type === 'create-connection') {
          const { titles } = draft.review;
          return { result: { message: `已连线 · ${titles[single.from] ?? single.from} → ${titles[single.to] ?? single.to}（${single.line === 'dashed' ? '虚线' : '实线'}），可一次撤销。` } };
        }
        if (panel && applied.createdIds.length) {
          try {
            context.commands.defer('selection.set', { ids: applied.createdIds, mode: 'replace' });
            context.commands.defer('canvas.focusSelection');
          } catch (error) { context.diagnostics.warn('新对象已生成，但未能聚焦', error); }
        }
        return { result: { message: `已直接完成 ${draft.review.actions.length} 项操作，内容已生成到画布，可一次撤销。` } };
      } });
      context.commands.register({ type: 'canvasControl.apply@1', validate: isPlanId, handle: async input => {
        const draft = reviews.get(input.id);
        if (!draft || draft.snapshot.expiresAt < Date.now()) {
          if (draft) logPlan(input.id, 'expired');
          throw new Error('操作计划已经过期，请重新生成');
        }
        if (draft.review.status !== 'pending' || applying.has(input.id)) throw new Error('这份操作计划已处理');
        const token = createId('control-commit');
        applying.set(input.id, token);
        logPlan(input.id, 'running');
        try {
          const changedIds = [...new Set([...draft.snapshot.writable, ...draft.review.actions.flatMap(action => 'id' in action ? [action.id] : [])])];
          draft.before = (await readTaskMarkers(context, changedIds)).markers;
          const result = await context.commands.invoke('canvasControl.commit@1', { id: input.id, token });
          draft.createdIds = result.createdIds;
          draft.created = result.created;
          const single = draft.review.actions.length === 1 ? draft.review.actions[0] : undefined;
          const current = await readTaskMarkers(context, [...changedIds, ...result.createdIds]).catch(() => undefined);
          const createdIds = new Set(result.createdIds);
          const nodeIds = current?.nodes.filter(node => createdIds.has(node.id)).map(node => node.id);
          if (nodeIds?.length) remember(draft.review.sessionId, { ids: nodeIds, createdIds: nodeIds, unfinishedConnection: undefined });
          if (single?.type === 'create-connection' || single?.type === 'update-connection') remember(draft.review.sessionId, { pendingLine: undefined, lineId: single.type === 'update-connection' ? single.id : result.createdIds[0] });
          if (single?.type === 'create-group' || single?.type === 'update-group') remember(draft.review.sessionId, { groupId: single.type === 'update-group' ? single.id : result.createdIds[0] });
          draft.after = current?.markers;
          draft.review.error = undefined;
          if (!draft.replacement) draft.review.verification = await verifyControlApplication(context, draft);
          if (draft.review.verification) context.signals.emit(OPERATION_LOG_STAGE_V2, {
            id: input.id, relatedId: draft.snapshot.preparationId, phase: 'canvas-verification',
            state: draft.review.verification.status === 'verified' ? 'completed' : 'failed',
            detail: { step: 'verify', reason: draft.review.verification.status === 'verified' ? 'verified' :
              draft.review.verification.status === 'mismatch' ? 'verification-mismatch' : 'verification-unavailable',
              checked: draft.review.verification.checked, mismatchCount: draft.review.verification.mismatches.length },
          } satisfies OperationStageUpdateV2);
          draft.review.status = 'applied'; logPlan(input.id, 'applied'); publish();
          return { result };
        } catch (error) {
          draft.review.error = error instanceof Error ? error.message : String(error); logPlan(input.id, 'failed'); publish(); throw error;
        } finally { applying.delete(input.id); }
      } });
      context.commands.register({ type: 'canvasControl.commit@1', validate: (input): input is { id: string; token: string } => isPlanId(input) && typeof (input as { token?: unknown }).token === 'string', handle: async input => {
        const draft = reviews.get(input.id);
        if (!draft || applying.get(input.id) !== input.token || draft.review.status !== 'pending') throw new Error('画布控制提交授权已失效');
        if (draft.replacement) {
          if (draft.replacement.hits.some(hit => !draft.snapshot.writable.has(hit.nodeId))) throw new Error('替换目标超出操作范围');
          const replacement = await context.capabilities.request<ContentReplacePlan>('content.replacePlan@2', draft.replacement);
          if (!reviews.has(input.id) || !replacement.patches.length) throw new Error('正文替换计划已失效');
          return { result: { createdIds: [] }, transaction: { label: `替换 ${replacement.replaced} 处正文`, patches: replacement.patches, events: replacement.events } };
        }
        const plan = await planControlApplication(context, draft.snapshot, { version: draft.review.planVersion ?? 1, actions: draft.review.actions });
        if (!reviews.has(input.id)) throw new Error('画布已经切换，请重新生成计划');
        if (!plan.patches.length) throw new Error('计划没有可应用的对象修改');
        return { result: { createdIds: Object.values(plan.created), created: plan.created }, transaction: {
          label: `AI 画布操作（${draft.review.actions.length} 项）`,
          patches: plan.patches, events: plan.events,
        } };
      } });
      context.commands.register({ type: 'canvasControl.dismiss@1', validate: isPlanId, handle: input => {
        const draft = reviews.get(input.id);
        if (!draft) throw new Error('操作计划不存在');
        if (draft.review.status !== 'pending' || applying.has(input.id)) throw new Error('这份操作计划已处理');
        draft.review.status = 'dismissed'; logPlan(input.id, 'dismissed'); publish();
        if (lastNatural.get(draft.review.sessionId)?.pendingLine === input.id) remember(draft.review.sessionId, { pendingLine: undefined });
        return {};
      } });
      context.events.subscribe('document.replaced', () => {
        for (const [id, draft] of reviews) if (draft.review.status === 'pending') logPlan(id, 'expired');
        snapshots.clear(); reviews.clear(); localResults.clear(); agentSessions.clear(); lastNatural.clear(); navigation = undefined;
        if (background) clearBackground(); else publish();
      });
      context.events.subscribe('history.changed', publish);
      context.events.subscribe<{ operationLogBackgroundId?: string }>('canvasControl.background.applied@1', message => {
        if (background?.id === message.payload.operationLogBackgroundId) clearBackground('applied');
      });
      context.events.subscribe('canvas.appearance.changed', () => { if (background) clearBackground(); });
      context.ui.contribute({ id: 'canvas-control.panel', slot: 'overlay.floating', kind: 'view', label: '画布控制', component: panel });
      context.ui.contribute({ id: 'canvas-control.toolbar', slot: 'top.primary', kind: 'view', label: '画布控制', group: 'assist', priority: 80, component: toolbar });
      context.ui.action({ id: 'canvas-control.open-action', label: '画布控制', command: 'canvasControl.open@1', category: 'AI', keywords: ['操作', '节点', '群组', '连线', '控制'], priority: 40 });
      context.ui.shortcut({ id: 'canvas-control.open-shortcut', label: '画布控制', command: 'canvasControl.open@1', category: 'AI' });
    },
  };
}
function isAdmission(input: unknown): input is CanvasControlAdmission {
  return isRecord(input) && typeof input.preparationId === 'string' && input.preparationId.length <= 200 && typeof input.sessionId === 'string' && input.sessionId.length <= 200 && typeof input.prompt === 'string' && input.prompt.length <= 100_000 &&
    (input.sourceIds === undefined || (Array.isArray(input.sourceIds) && input.sourceIds.length <= 80 && input.sourceIds.every(id => typeof id === 'string' && id.length <= 200)));
}
function isPlanId(input: unknown): input is { id: string } { return isRecord(input) && typeof input.id === 'string'; }
function canGenerateDirectly(review: CanvasControlReview, snapshot: ControlSnapshot): boolean {
  return review.actions.every(action => {
    if (action.type === 'create-node' || action.type === 'create-group' || action.type === 'create-connection') return true;
    if (action.type !== 'update-node' || !snapshot.writable.has(action.id)) return false;
    const node = snapshot.nodes.find(item => item.id === action.id);
    if (!node || node.length !== 0 || !Object.keys(action).every(key => ['type', 'id', 'text', 'append', 'edit'].includes(key))) return false;
    if (action.edit) return action.edit.start === 0 && action.edit.deleteCount === 0 && action.edit.expectedRevision === node.revision && Boolean(action.edit.insert.trim());
    return Boolean((action.text ?? action.append)?.trim());
  });
}
