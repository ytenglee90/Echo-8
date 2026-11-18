import { createId, isRecord, type PluginDefinition } from '../../core/contracts.ts';
import {
  CANVAS_CONTROL_RESUME,
  CANVAS_CONTROL_RESULT,
  type CanvasControlAdmission,
  type CanvasControlNativeRequest,
  type CanvasControlOffer,
  type CanvasControlReceipt,
  type CanvasControlReview,
  type CanvasControlState,
  type CanvasCompoundRequest,
  type CanvasCompoundTarget,
  type CanvasControlPlan,
  type WorkspaceCanvasPreview,
} from '../../protocols/canvas-control.ts';
import { PALETTE_PRESET_LABELS, type AppearanceEntityRef, type AppearanceReadContribution, type AppearanceUpdatePlan } from '../../protocols/appearance.ts';
import { resolveNaturalBatch } from './natural-batch.ts';
import type { ContentReplacePlan } from '../../protocols/search.ts';
import { OPERATION_LOG_STAGE, OPERATION_LOG_STAGE_V2, type OperationStatus, type OperationStageUpdate, type OperationStageUpdateV2 } from '../../protocols/operation-log.ts';
import { asksForCanvasContinuation, canvasCommandText, canvasRequestDisposition, canvasRequestsAllNodes, naturalCanvasOperation, needsCanvasSearchInterpretation, type NaturalCanvasOperation } from '../../services/ai-task-route.ts';
import { validateAIContextSearchRequest } from '../../protocols/ai.ts';
import { parseCanvasControlPlan } from '../../services/canvas-control-validation.ts';
import { defineManifest } from '../manifest.ts';
import { captureControlSnapshot, controlInstruction, controlContextV2, deletionImpact, readControlOwners, type ControlSnapshot } from './context.ts';
import { controlTaskState, readControlReviewStatus, readTaskMarkers, taskMarkerChanges, type StoredControlReview } from './task-state.ts';
import { lineStyleFollowup, localLinePlan, localOperation, localPlan } from './local-operations.ts';
import { discoverControlTargets } from './target-discovery.ts';
import { arrangeControlNodes, resolveNaturalOperation, shadeColor, updateArrangement, type NaturalControlResult, type NaturalControlState } from './natural-operations.ts';
import { planControlApplication, validateControlScope } from './planning.ts';
import { actionCounts, controlFailureReason, localOperationDetail } from './operation-details.ts';
import type { CanvasAgentQuery, CanvasAgentSubmissionV2 } from '../../protocols/canvas-agent.ts';
import { grantAgentSnapshot, newAgentDiscovery, queryAgentCanvas, readAgentCanvas, type AgentDiscoverySession } from './agent-discovery.ts';
import { prepareAgentPlan } from './agent-planning.ts';
import { verifyControlApplication } from './verification.ts';
import { nativeCanvasIntent } from '../../services/native-canvas-intent.ts';
import { prepareNativeCanvasAction } from './native-actions.ts';

const CONTROL_UI_NAMESPACE = 'canvasControlUI';
export function createCanvasControlPlugin(panel?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('canvas-control', 'AI 画布控制', {
      namespaces: [CONTROL_UI_NAMESPACE], namespaceDomains: { [CONTROL_UI_NAMESPACE]: 'workspace' },
      sessionOnlyWorkspace: { [CONTROL_UI_NAMESPACE]: true },
      requiresCapabilities: ['content.summaries@1', 'content.summariesById@1', 'selection.read@1', 'selection.resolve@1', 'selection.entities@1', 'canvasControl.nodesPlan@1'],
      optionalCapabilities: ['canvasControl.nodesPlan@3', 'canvasControl.groupsPlan@2', 'canvasControl.connectionsPlan@2','content.createPlan@1', 'content.search@2', 'context.catalog@1', 'context.read@1', 'context.search@1', 'context.search@3', 'context.semanticSearch@3', 'appearance.read@1', 'appearance.updatePlan@1', 'canvasControl.nodesPlan@2', 'groups.list@1', 'connections.graph@1', 'connections.targets@1', 'annotations.list@1', 'clipboard.state@1', 'entity.deletePlan@1', 'canvasControl.groupsPlan@1', 'canvasControl.connectionsPlan@1', 'content.replacePlan@2'],
      providesCapabilities: ['canvasControl.localCreationPlan@1','canvasControl.agentQuery@1', 'canvasControl.agentRead@1', 'canvasControl.agentPlan@1', 'canvasControl.agentPlan@2', 'canvasControl.bindContent@1', 'canvasControl.context@1', 'canvasControl.context@2', 'canvasControl.context@3', 'canvasControl.localPlan@1', 'canvasControl.localPlan@2', 'canvasControl.taskState@1', 'canvasControl.receipt@1', 'canvasControl.searchPlan@1', 'canvasControl.prepareCompound@1', 'canvasControl.completeCompound@1'],
      commands: ['canvasControl.offerWorkspace@1', 'canvasControl.open@1', 'canvasControl.close@1', 'canvasControl.scope@1', 'canvasControl.execution@1', 'canvasControl.offer@1', 'canvasControl.workspacePreview@1', 'canvasControl.native@1', 'canvasControl.generate@1', 'canvasControl.apply@1', 'canvasControl.applyItems@1', 'canvasControl.applyItems@2', 'canvasControl.updateTitle@1', 'canvasControl.resolveTitles@1', 'canvasControl.commit@1', 'canvasControl.dismiss@1', 'canvasControl.revisePending@1', 'canvasControl.navigate@1', 'canvasControl.background.apply@1', 'canvasControl.background.dismiss@1'],
      dispatches: ['workspace.plan.resume@1', 'workspace.plan.run@1', 'canvasControl.apply@1', 'canvasControl.commit@1', 'canvasControl.offer@1', 'canvasControl.generate@1', 'selection.set', 'selection.delete', 'canvas.focusSelection', 'palette.setPreferences', 'palette.applyAppearance',
        'clipboard.copy', 'clipboard.paste', 'annotation.create', 'annotation.update', 'annotation.delete', 'connection.toolbarToggle@1', 'connection.addJunctionForEdges@1', 'history.undo', 'history.redo',
        'system.action.execute', 'canvas.zoomIn', 'canvas.zoomOut', 'canvas.resetZoom', 'selection.all', 'selection.clear', 'minimap.open', 'minimap.close', 'palette.applyPresetColors@1', 'palette.applyPreset@1'],
      queries: ['canvasControl.state@1', 'canvasControl.reviewReceipt@1'],
      asks: ['workspace.plan.validate@1', 'history.state', 'system.actions', 'system.document.revision'],
      events: ['document.replaced', 'history.changed', 'canvas.appearance.changed', 'canvasControl.background.applied@1'], signals: [CANVAS_CONTROL_RESUME, CANVAS_CONTROL_RESULT, 'canvasControl.updated@1', 'appearance.color.preview', OPERATION_LOG_STAGE, OPERATION_LOG_STAGE_V2],
      ui: ['canvas-control.panel'], actions: ['canvas-control.open-action'],
      shortcuts: ['canvas-control.open-shortcut'],
      permissions: ['store.own.read', 'store.own.write', 'content.context.read', 'history.manage', 'ui.overlay.contribute', 'ui.action.register', 'ui.action.execute', 'ui.shortcut.register'],
    }),
    start(context) {
      const snapshots = new Map<string, ControlSnapshot>();
      const localInterpretations = new Map<string, NaturalCanvasOperation>();
      const reviews = new Map<string, StoredControlReview>();
      const lastPlacementBySession = new Map<string, StoredControlReview>();
      const applying = new Map<string, { token: string; draft: StoredControlReview }>();
      const generating = new Set<string>();
      const receipts = new Map<string, CanvasControlReceipt & { sessionId: string; prompt: string; reviewId?: string }>();
      const lastNatural = new Map<string, NaturalControlState>();
      const localResults = new Map<string, NaturalControlResult>();
      const compoundDrafts = new Map<string, { plan: CanvasControlPlan; markers: string[] }>();
      const agentSessions = new Map<string, AgentDiscoverySession>();
      let navigation: CanvasControlState['navigation'];
      let choice: { input: CanvasControlAdmission; name: string; ids: string[]; chosen: Map<string, string> } | undefined;
      let background: { id: string; color: string; previous: string; entity: AppearanceEntityRef } | undefined;
      const rememberReceipt = (input: CanvasControlAdmission, message: string, status: CanvasControlReceipt['status'],
        links?: Pick<CanvasControlReceipt, 'directPlanId' | 'repeatableCreation'> & { reviewId: string }) => {
        const { preparationId, sessionId, prompt } = input;
        const directPlanId = links?.directPlanId;
        receipts.set(preparationId, { preparationId, sessionId, prompt, message, status, ...links });
        if (receipts.size > 32) receipts.delete(receipts.keys().next().value!);
        return { message, ...(directPlanId ? { directPlanId } : {}) };
      };
      const existingReceipt = (input: CanvasControlAdmission) => {
        const receipt = receipts.get(input.preparationId);
        if (receipt && (receipt.sessionId !== input.sessionId || receipt.prompt !== input.prompt)) throw new Error('画布指令已失效。');
        return receipt;
      };
      const logPlan = (id: string, state: OperationStatus) => {
        const draft = reviews.get(id);
        if (!draft) return;
        const count = draft.review.workspaceSteps?.length ?? (draft.native ? 1 : draft.review.replacement?.count ?? draft.review.actions.length);
        const operation = naturalCanvasOperation(draft.snapshot.prompt);
        if (state === 'applied' || state === 'failed' || state === 'dismissed' || state === 'expired') {
          for (const receipt of receipts.values()) if (receipt.reviewId === id) {
            receipt.status = state;
            receipt.directPlanId = undefined;
          }
        }
        context.signals.emit(OPERATION_LOG_STAGE_V2, {
          id, phase: 'canvas-plan', state, relatedId: draft.snapshot.preparationId, expiresAt: draft.snapshot.expiresAt,
          count,
          detail: { ...(draft.review.workspaceSteps ? { route: 'model' as const, task: 'semantic-plan' as const } : operation ? localOperationDetail(operation) : { route: draft.native ? 'local' as const : 'model' as const }),
            step: state === 'running' ? 'commit' : state === 'pending' || state === 'waiting' ? 'review' : 'done',
            matched: draft.snapshot.nodes.length, actions: actionCounts(draft.review.actions),
            reason: state === 'pending' ? (execution() === 'review' ? 'review-preference' : 'review-existing') :
              state === 'waiting' ? 'ready-direct' : state === 'applied' ? 'applied' :
                state === 'failed' ? controlFailureReason(new Error(draft.review.error)) : state === 'expired' ? 'expired' : undefined },
        } satisfies OperationStageUpdateV2);
        if (!generating.has(id) && (state === 'applied' || state === 'failed' || state === 'dismissed')) context.signals.emit(CANVAS_CONTROL_RESULT, {
          sessionId: draft.review.sessionId, preparationId: draft.snapshot.preparationId, prompt: draft.snapshot.prompt,
          status: state, count, verification: draft.review.verification?.status,
          ...(draft.native && state === 'applied' ? { message: receipts.get(draft.snapshot.preparationId)?.message } : {}),
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
      const reservedCreationTitles = (preparationId: string) => [...reviews.values()].flatMap(draft =>
        draft.snapshot.preparationId !== preparationId && draft.review.status === 'pending' && draft.snapshot.expiresAt >= Date.now()
          ? draft.review.actions.flatMap(action => action.type === 'create-node' ? [action.title] : []) : []);
      const clearBackground = (state: 'applied' | 'dismissed' = 'dismissed') => {
        if (background) {
          const receipt = receipts.get(background.id);
          if (receipt) receipt.status = state;
          logBackground(background.id, state);
        }
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
      const keepReview = (draft: StoredControlReview) => {
        reviews.set(draft.review.id, draft);
        while (reviews.size > 8) {
          const oldest = reviews.keys().next().value!;
          if (reviews.get(oldest)?.review.status === 'pending') logPlan(oldest, 'expired');
          reviews.delete(oldest);
        }
      };
      const agentSession = (input: CanvasControlAdmission) => {
        if (!isAdmission(input)) throw new Error('画布工具请求无效');
        let session = agentSessions.get(input.preparationId);
        if (session && (session.sessionId !== input.sessionId || session.prompt !== input.prompt || session.expiresAt < Date.now())) throw new Error('画布工具任务已失效');
        if (!session) {
          session = newAgentDiscovery(input);
          const existing = snapshots.get(input.preparationId);
          if (existing?.sessionId === input.sessionId && existing.prompt === input.prompt && existing.expiresAt >= Date.now()) grantAgentSnapshot(session, existing);
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
        if (input.query.mode === 'state') result.tasks = await controlTaskState(context, [...new Set([
          ...lastPlacementBySession.values(), ...reviews.values(),
        ])], { sessionId: input.sessionId }, signal);
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
      for (const key of ['canvasControl.agentPlan@1', 'canvasControl.agentPlan@2'] as const) context.capabilities.provide({ key, invoke: async (input: CanvasControlAdmission & CanvasAgentSubmissionV2, signal) => {
        const id = createId('canvas-agent-validation');
        const started = performance.now();
        const trace = (state: OperationStatus, detail?: OperationStageUpdateV2['detail']) => context.signals.emit(OPERATION_LOG_STAGE_V2,
          { id, relatedId: input.preparationId, phase: 'canvas-validation', state, elapsedMs: performance.now() - started, detail: { step: 'validate', route: 'model', ...detail } } satisfies OperationStageUpdateV2);
        trace('running');
        try {
        if (key === 'canvasControl.agentPlan@1' && input.placements !== undefined) throw new Error('相对摆放需要画布计划接口 v2');
        const prepared = await prepareAgentPlan(context, input, agentSession(input), execution(), signal);
        snapshots.set(input.preparationId, prepared.snapshot);
        localResults.set(input.preparationId, prepared.local);
        while (localResults.size > 8) localResults.delete(localResults.keys().next().value!);
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
        trace('completed', { actions: actionCounts(prepared.local.plan.actions), reason: prepared.local.plan.actions.length ? 'model-plan' : 'no-change' });
        return { text: prepared.text };
        } catch (error) { trace(signal?.aborted ? 'cancelled' : 'failed', { reason: controlFailureReason(error) }); throw error; }
      } });
      const naturalPlan = async (input: CanvasControlAdmission, chosen = new Map<string, string>(), signal?: AbortSignal, interpreted?: NaturalCanvasOperation, creationCommand = input.prompt, creationOnly = false) => {
        const operation = interpreted ?? localInterpretations.get(input.preparationId) ?? naturalCanvasOperation(input.prompt);
        if (!operation) return undefined;
        const trace = (state: OperationStatus, detail: OperationStageUpdateV2['detail']) => context.signals.emit(OPERATION_LOG_STAGE_V2, {
          id: input.preparationId, relatedId: input.preparationId, phase: 'canvas-targets', state,
          detail: { ...localOperationDetail(operation), ...detail },
        } satisfies OperationStageUpdateV2);
        trace('running', { step: 'targets' });
        let previous: NaturalControlState = { ...(lastNatural.get(input.sessionId) ?? { ids: [] }),
          reservedCreationTitles: reservedCreationTitles(input.preparationId), creationOnly };
        const precedingArrangement = operation.kind === 'arrange-followup'
          ? [...reviews.values()].findLast(draft => draft.review.sessionId === input.sessionId &&
            (operation.group || draft.arrangement) && draft.review.status !== 'dismissed') : undefined;
        const pendingArrangement = precedingArrangement?.review.status === 'pending' && precedingArrangement.arrangement &&
          precedingArrangement.snapshot.expiresAt >= Date.now() && !precedingArrangement.review.error ? precedingArrangement : undefined;
        if (precedingArrangement?.review.status === 'applied' && precedingArrangement.arrangement && precedingArrangement.after) {
          const ids = [...precedingArrangement.snapshot.writable];
          const live = await readTaskMarkers(context, ids, signal);
          if (ids.every(id => live.markers[id] === precedingArrangement.after?.[id])) previous = { ...previous, lastArrangement: precedingArrangement.arrangement };
        }
        if (operation.kind === 'placement-gap') {
          const last = lastPlacementBySession.get(input.sessionId);
          const placement = last?.placement;
          if (last?.review.status === 'applied' && last.after && placement) {
            const ids = [...placement.movingIds, placement.anchorId];
            const live = await readTaskMarkers(context, ids, signal);
            if (ids.every(id => live.markers[id] === last.after?.[id])) previous = { ...previous, lastPlacement: placement };
          }
        }
        let result: NaturalControlResult;
        if (operation.kind === 'content') {
          result = await resolveNaturalOperation(context, input, { ...operation, kind: 'find' }, previous, chosen, signal);
          if (result.focus?.length && !result.choice) {
            trace('completed', { step: 'targets', matched: result.focus.length, reason: 'model-plan' });
            return { handled: false as const, sourceIds: result.focus };
          }
        } else if (operation.kind === 'theme' || operation.kind === 'preset' || operation.kind === 'background') {
          result = { plan: { version: 1, actions: [] }, setting: operation };
        } else if (operation.kind === 'arrange-followup' && pendingArrangement?.arrangement) {
          const last = pendingArrangement.arrangement;
          if (operation.group) {
            result = await resolveNaturalOperation(context, input, operation, { ...previous, lastArrangement: last }, chosen, signal);
            if (result.arrangement) result.replacesArrangement = pendingArrangement.review.id;
          } else {
            const arrangement = updateArrangement(last, operation);
            result = { plan: { version: 1, actions: [] }, pendingArrangement: { id: pendingArrangement.review.id, arrangement } };
          }
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
        if (creationOnly && (result.targets?.length || result.plan.actions.some(action => !['create-node', 'create-group', 'create-connection'].includes(action.type)))) {
          throw new Error('大批量新建组合只能引用本轮新建对象，不能混入已有对象修改。');
        }
        const snapshot = await captureControlSnapshot(context, { ...input, sourceIds: result.targets ?? [] }, 'selection', signal, undefined, true);
        const createsDirectly = operation.kind === 'create' || operation.kind === 'connect' || operation.kind === 'connect-many' ||
          operation.kind === 'set-body' || operation.kind === 'append' ||
          (operation.kind === 'batch' && result.plan.actions.every(action => action.type === 'create-node' || action.type === 'create-connection' || action.type === 'create-group'));
        snapshot.execution = createsDirectly && canvasRequestDisposition(input.prompt) === 'normal' ? execution() : 'review';
        validateControlScope(result.plan, snapshot);
        if (operation.kind === 'create' && !operation.names.length && !input.sourceIds?.length && creationCommand.length <= 600 &&
          result.plan.actions.length === 1 && result.plan.actions[0]?.type === 'create-node') result.repeatableCreation = creationCommand;
        snapshots.set(input.preparationId, snapshot);
        localResults.set(input.preparationId, { ...result, chosen });
        while (localResults.size > 8) localResults.delete(localResults.keys().next().value!);
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
        return { handled: true as const, text: JSON.stringify(result.plan), ...(result.unresolvedTarget ? { unresolvedTarget: true } : {}) };
      };
      context.capabilities.provide({ key: 'canvasControl.localPlan@2', invoke: async (input: CanvasControlAdmission & { instructions: string[]; expectedSelectionCount?: number }, signal) => {
        if (!isAdmission(input) || !Array.isArray(input.instructions) || !input.instructions.length || input.instructions.length > 80 ||
          input.instructions.some(text => typeof text !== 'string' || !text.trim() || text.length > 600) ||
          input.instructions.reduce((total, text) => total + text.length, 0) > 12_000 ||
          input.expectedSelectionCount !== undefined && (!Number.isInteger(input.expectedSelectionCount) ||
            input.expectedSelectionCount < 1 || input.expectedSelectionCount > 80)) {
          throw new Error('本地画布指令参数无效');
        }
        if (input.expectedSelectionCount !== undefined) {
          const selected = await context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal);
          if (selected.ids.length !== input.expectedSelectionCount) throw new Error(
            `你指定了 ${input.expectedSelectionCount} 个对象，当前选中 ${selected.ids.length} 个。请先明确范围，画布尚未修改。`,
          );
        }
        const steps = input.instructions.map(naturalCanvasOperation);
        if (!steps.every(step => step !== undefined)) throw new Error('本地解析尚不能完整执行这组要求，请补充具体目标或参数。');
        const operation: NaturalCanvasOperation = steps.length === 1 ? steps[0]! : { kind: 'batch', names: [], steps };
        const result = await naturalPlan(input, undefined, signal, operation, input.instructions[0]);
        localInterpretations.set(input.preparationId, operation);
        while (localInterpretations.size > 8) localInterpretations.delete(localInterpretations.keys().next().value!);
        const snapshot = snapshots.get(input.preparationId);
        if (snapshot) {
          snapshot.localDirect = true;
          snapshot.execution = canvasRequestDisposition(input.prompt) === 'normal' ? execution() : 'review';
        }
        return result ?? { handled: false };
      } });
      context.capabilities.provide({ key: 'canvasControl.localCreationPlan@1', invoke: async (input: CanvasControlAdmission & { instructions: string[] }, signal) => {
        if (!isAdmission(input) || !Array.isArray(input.instructions) || input.instructions.length < 1 || input.instructions.length > 512 ||
          input.instructions.some(text => typeof text !== 'string' || text.length > 12_000) || input.instructions.join('').length > 100_000) throw new Error('新建组合参数无效');
        const steps = input.instructions.map(naturalCanvasOperation);
        if (!steps.every(step => step && ['create', 'group', 'connect', 'connect-many'].includes(step.kind)) ||
          steps.filter(step => step?.kind === 'create').length > 400) throw new Error('新建组合最多支持 400 个节点及其分组、连线');
        const operation: NaturalCanvasOperation = { kind: 'batch', names: [], steps: steps as NaturalCanvasOperation[] };
        const result = await naturalPlan(input, undefined, signal, operation, input.instructions[0], true);
        const snapshot = snapshots.get(input.preparationId);
        if (snapshot) { snapshot.localDirect = true; snapshot.execution = canvasRequestDisposition(input.prompt) === 'normal' ? execution() : 'review'; }
        return result ?? { handled: false };
      } });
      context.capabilities.provide({ key: 'canvasControl.prepareCompound@1', invoke: async (input: CanvasCompoundRequest, signal) => {
        if (!isNativeRequest(input) || canvasRequestDisposition(input.prompt) === 'read-only' || !Array.isArray(input.steps) ||
          input.steps.length < 2 || input.steps.length > 16) throw new Error('组合画布请求无效');
        const markers: string[] = [];
        const targets: CanvasCompoundTarget[] = [];
        const selected = input.selectedIds ?? (await context.capabilities.request<{ ids: string[] }>('selection.read@1', undefined, signal)).ids;
        const steps = input.steps.map<NaturalCanvasOperation>(step => {
          if ('instruction' in step && typeof step.instruction === 'string' && step.instruction.length <= 600) {
            const operation = naturalCanvasOperation(step.instruction);
            if (operation && !['content', 'batch', 'find', 'select', 'filter', 'relations', 'narrow'].includes(operation.kind)) return operation;
          } else if ('target' in step && typeof step.target === 'string' && step.target.trim() && step.target.length <= 120 && typeof step.replace === 'boolean') {
            const marker = createId('compound-text');
            markers.push(marker);
            return { kind: 'content', names: [step.target], replaceBody: step.replace ? true : undefined };
          }
          throw new Error('组合画布步骤不受支持，请拆开确认。');
        });
        if (!markers.length || markers.length === steps.length) throw new Error('组合计划缺少正文或画布操作');
        const result = await resolveNaturalBatch(steps, { ids: [], frozenSelection: selected }, async (step, previous) => {
          if (step.kind !== 'content') return resolveNaturalOperation(context, input, step, previous, new Map(), signal);
          const bound = await resolveNaturalOperation(context, input, { kind: 'find', names: step.names }, previous, new Map(), signal);
          const id = bound.focus?.length === 1 ? bound.focus[0] : undefined;
          if (bound.choice || !id) return { plan: { version: 2, actions: [], answer: `请明确「${step.names[0]}」对应的正文节点。` } };
          const node = (await context.capabilities.request<import('../../protocols/content.ts').ContentSummary[]>('content.summariesById@1', { nodeIds: [id] }, signal))[0];
          const marker = markers[targets.length]!;
          targets.push({ title: node?.title ?? step.names[0]!, ...(step.replaceBody && node ? { sourceId: id, sourceLength: node.length } : {}),
            replace: step.replaceBody === true });
          return { plan: { version: 2, actions: [{ type: 'update-node', id, ...(step.replaceBody || !node ? { text: marker } : { append: marker }) }] },
            targets: [id], next: { ids: [id] } };
        });
        if (result.choice) return { clarification: `「${result.choice.name}」有多个匹配，请用 @ 指定对象，画布尚未修改。` };
        if (!result.plan.actions.length || targets.length !== markers.length) {
          return { clarification: result.plan.answer ?? '组合任务缺少明确的目标，画布尚未修改。' };
        }
        if (markers.some(marker => !result.plan.actions.some(action => (action.type === 'update-node' || action.type === 'create-node') &&
          (action.text === marker || action.append === marker)))) throw new Error('组合正文目标在步骤之间发生冲突');
        const refs = new Set(result.plan.actions.flatMap(action => 'ref' in action ? [action.ref] : []));
        const snapshot = await captureControlSnapshot(context, { ...input, sourceIds: (result.targets ?? []).filter(id => !refs.has(id)) },
          'selection', signal, undefined, true);
        snapshot.execution = execution();
        snapshot.localDirect = true;
        const deletes = new Set(result.plan.actions.flatMap(action => action.type === 'delete' ? action.ids : []));
        if (deletes.size) {
          const owners = await readControlOwners(context, signal);
          const related = owners.graph?.connections.filter(edge => deletes.has(edge.from.nodeId) || deletes.has(edge.to.nodeId)) ?? [];
          if (related.length > 80) throw new Error('删除会影响超过 80 条连线，请单独预览删除范围。');
          snapshot.graph.connections = [...new Map([...snapshot.graph.connections, ...related].map(edge => [edge.id, edge])).values()];
          const { groups, graph } = owners;
          if (graph && groups) snapshot.deletionImpact = new Map([...deletes].map(id => [id, deletionImpact(new Set([id]), groups, graph)]));
        }
        validateControlScope(result.plan, snapshot);
        await planControlApplication(context, snapshot, result.plan, signal);
        snapshots.set(input.preparationId, snapshot);
        compoundDrafts.set(input.preparationId, { plan: result.plan, markers });
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
        while (compoundDrafts.size > 8) compoundDrafts.delete(compoundDrafts.keys().next().value!);
        return { targets };
      } });
      context.capabilities.provide({ key: 'canvasControl.completeCompound@1', invoke: (input: CanvasControlAdmission & { texts: string[] }) => {
        const snapshot = snapshots.get(input.preparationId);
        const draft = compoundDrafts.get(input.preparationId);
        if (!isAdmission(input) || !snapshot || !draft || snapshot.prompt !== input.prompt || snapshot.sessionId !== input.sessionId ||
          snapshot.expiresAt < Date.now() || !Array.isArray(input.texts) || input.texts.length !== draft.markers.length ||
          input.texts.some(text => typeof text !== 'string' || !text.trim()) ||
          input.texts.reduce((total, text) => total + text.length, 0) > 100_000) throw new Error('组合计划已过期或正文结果无效');
        const inserts = new Map(draft.markers.map((marker, index) => [marker, input.texts[index]!]));
        const plan: CanvasControlPlan = { ...draft.plan, actions: draft.plan.actions.map(action => {
          if (action.type !== 'create-node' && action.type !== 'update-node') return action;
          if (action.text !== undefined && inserts.has(action.text)) return { ...action, text: inserts.get(action.text)! };
          if (action.append !== undefined && inserts.has(action.append)) return { ...action, append: inserts.get(action.append)! };
          return action;
        }) };
        validateControlScope(plan, snapshot);
        compoundDrafts.delete(input.preparationId);
        localResults.set(input.preparationId, { plan });
        while (localResults.size > 8) localResults.delete(localResults.keys().next().value!);
        return { text: JSON.stringify(plan) };
      } });
      context.capabilities.provide({ key: 'canvasControl.bindContent@1', invoke: async (input: CanvasControlAdmission, signal) => {
        if (!isAdmission(input)) throw new Error('画布控制请求无效');
        const operation = naturalCanvasOperation(input.prompt);
        if (operation?.kind !== 'content') return { ids: [], needsChoice: false };
        const result = await resolveNaturalOperation(context, input, { ...operation, kind: 'find' }, lastNatural.get(input.sessionId) ?? { ids: [] }, new Map(), signal);
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
      context.capabilities.provide({ key: 'canvasControl.receipt@1', invoke: async (input: { sessionId: string; preparationId?: string; goal?: string }, signal) => {
        if (!isRecord(input) || typeof input.sessionId !== 'string' || input.sessionId.length > 200 ||
          (input.preparationId !== undefined && (typeof input.preparationId !== 'string' || input.preparationId.length > 200)) ||
          (input.goal !== undefined && (input.preparationId !== undefined || typeof input.goal !== 'string' || input.goal.length > 2_000))) throw new Error('画布回执请求无效');
        const receipt = input.preparationId === undefined
          ? [...receipts.values()].findLast(item => item.sessionId === input.sessionId && (input.goal === undefined || item.prompt === input.goal))
          : receipts.get(input.preparationId);
        if (receipt?.sessionId !== input.sessionId) return undefined;
        const { preparationId, message, directPlanId } = receipt;
        const draft = receipt.reviewId ? reviews.get(receipt.reviewId) : undefined;
        const status = draft ? await readControlReviewStatus(context, draft, signal) : receipt.status;
        return { preparationId, message, status, ...(status === 'pending' && directPlanId ? { directPlanId } : {}),
          ...(status === 'applied' && receipt.repeatableCreation ? { repeatableCreation: receipt.repeatableCreation } : {}) } satisfies CanvasControlReceipt;
      } });
      for (const key of ['canvasControl.context@2', 'canvasControl.context@3'] as const) context.capabilities.provide({ key, invoke: async (input: CanvasControlAdmission & { purpose?: import('../../protocols/canvas-control.ts').CanvasControlPurpose }, signal) => {
        if (!isAdmission(input) || (input.purpose !== undefined && !['appearance', 'move', 'creation', 'structure', 'content', 'general'].includes(input.purpose))) throw new Error('画布控制请求无效');
        const discovery = await discoverControlTargets(context, input, [...reviews.values()], signal);
        const requestedScope = canvasRequestsAllNodes(input.prompt) ? 'canvas' : scope();
        const previous = /它们|这些|刚才(?:的|那批|创建)/u.test(input.prompt) ? lastNatural.get(input.sessionId)?.ids ?? [] : [];
        const hasNamedObjects = Boolean(input.sourceIds?.length || discovery.names.length);
        const usesSelection = asksForCanvasContinuation(input.prompt) || /选中|选区|当前卡片|这几张|这两张/u.test(canvasCommandText(input.prompt));
        const snapshot = await captureControlSnapshot(context, { ...input, sourceIds: [...new Set([...(input.sourceIds ?? []), ...previous])] },
          requestedScope, signal, discovery, key === 'canvasControl.context@3' && hasNamedObjects && !usesSelection);
        snapshot.execution = execution();
        context.signals.emit(OPERATION_LOG_STAGE_V2, { id: input.preparationId, relatedId: input.preparationId, phase: 'canvas-targets', state: 'completed',
          detail: { step: 'targets', route: 'model', scope: requestedScope === 'canvas' ? 'canvas' : discovery.names.length ? 'named' : 'selection',
            matched: snapshot.nodes.length, reason: snapshot.nodes.length ? 'model-plan' : 'empty-targets' } } satisfies OperationStageUpdateV2);
        snapshots.set(input.preparationId, snapshot);
        while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
        const result = controlContextV2(snapshot, input.purpose);
        if (key === 'canvasControl.context@3') result.targetIds = [...new Set([...(result.targetIds ?? []), ...(snapshot.namedTargetIds ?? [])])];
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
          const original = localInterpretations.get(current.input.preparationId);
          const plan = await naturalPlan(admission, chosen, undefined, original);
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
      context.commands.register({ type: 'canvasControl.offerWorkspace@1',
        validate: (input): input is CanvasControlAdmission & { plan: import('../../protocols/workspace-actions.ts').WorkspacePlan; selectedIds: string[]; descriptions: string[] } =>
          isNativeRequest(input) && isRecord(input) && isRecord(input.plan) && Array.isArray(input.selectedIds) &&
          Array.isArray(input.descriptions) && input.descriptions.length > 0 && input.descriptions.length <= 24 && input.descriptions.every(value => typeof value === 'string' && value.length <= 1200),
        handle: async input => {
          const plan = structuredClone(input.plan);
          const capturedRevision = plan.constraints?.documentRevision;
          if (capturedRevision !== undefined && (await context.queries.ask<{ revision: number }>('system.document.revision')).revision !== capturedRevision) {
            throw new Error('模型解析期间文档已变化，请重新解析计划');
          }
          const validation = await context.queries.ask<import('../../protocols/workspace-actions.ts').WorkspacePlanValidation>('workspace.plan.validate@1', plan);
          const id = createId('model-workspace-plan');
          const selectedIds = [...input.selectedIds];
          const sourceIds = [...input.sourceIds ?? []];
          // Membership operations never read or replace the node body. A
          // concurrent answer may update it without changing this intent.
          const markerScope = plan.steps.every(step => step.action === 'group.add' || step.action === 'group.remove') ? 'membership' : 'document';
          const expected = await readTaskMarkers(context, sourceIds, undefined, markerScope);
          let receipt: import('../../protocols/workspace-actions.ts').WorkspacePlanReceipt | undefined;
          const native = { label: `模型解析的 ${validation.steps.length} 项操作`, ids: sourceIds, review: true,
            pendingResult: () => receipt?.status === 'waiting', apply: async () => {
            if (!receipt) {
              const current = await context.capabilities.request<{ ids: string[] }>('selection.read@1');
              if (current.ids.length !== selectedIds.length || current.ids.some((value, index) => value !== selectedIds[index])) throw new Error('发送后选区已变化，请重新解析计划');
              const live = await readTaskMarkers(context, sourceIds, undefined, markerScope);
              const changed = sourceIds.find(id => live.markers[id] !== expected.markers[id]);
              if (changed) throw new Error(`计划引用的对象已变化：${live.labels[changed] ?? expected.labels[changed] ?? '指定对象'}（${taskMarkerChanges(expected.markers[changed]!, live.markers[changed]!)}），请重新解析`);
            }
            const { revision } = await context.queries.ask<{ revision: number }>('system.document.revision');
            const result = receipt?.status === 'waiting' ? await context.commands.invoke('workspace.plan.resume@1', { id: plan.id, apply: [] })
              : await context.commands.invoke('workspace.plan.run@1', { ...plan, constraints: { ...plan.constraints, documentRevision: revision } });
            receipt = result;
            if (result.status === 'failed' || result.status === 'partial') throw new Error(result.steps.find(step => step.status === 'failed')?.message ?? '计划未完整执行');
            return result.status === 'completed' ? `已完成 ${result.steps.filter(step => step.status === 'completed').length} 项经确认的工作区操作。` :
              '计划仍等待对象选择、文件授权或文档预览确认，请完成当前界面中的步骤。';
          } };
          const snapshot: ControlSnapshot = { ...input, expiresAt: Date.now() + 10 * 60_000, writable: new Set(), nodes: [], groups: [],
            graph: { version: 1, connections: [], junctions: [] }, available: { groups: false, connections: false }, origin: { x: 0, y: 0 } };
          keepReview({ snapshot, native, review: { id, sessionId: input.sessionId, createdAt: Date.now(), status: 'pending', actions: [], titles: {},
            nativeLabel: native.label, workspaceSteps: input.descriptions } });
          const message = `模型已解析 ${validation.steps.length} 项操作，尚未执行。请在画布控制中核对目标和参数，再应用整份计划。`;
          rememberReceipt(input, message, 'pending', { reviewId: id });
          logPlan(id, 'pending'); publish();
          return { result: { message }, transaction: showControl() };
        } });
      context.commands.register({ type: 'canvasControl.native@1', validate: isNativeRequest, handle: async (input, envelope) => {
        if (envelope.sourcePlugin !== 'ai-assistant') throw new Error('画布指令需从当前助手会话发送。');
        if (canvasRequestDisposition(input.prompt) !== 'normal' && nativeCanvasIntent(input.prompt)?.kind !== 'connection-inspect') throw new Error('本轮要求先查看，不能直接执行画布指令。');
        const previous = existingReceipt(input);
        if (previous) return { result: { message: previous.message } };
        const intent = nativeCanvasIntent(input.prompt);
        if (!intent) throw new Error('未识别到可本地执行的画布指令。');
        const native = await prepareNativeCanvasAction(context, input, intent, scope());
        const needsReview = native.review || ((native.ids.length > 0 || intent.kind === 'paste' || intent.kind === 'preferences') && execution() === 'review');
        const message = needsReview ? `已准备「${native.label}」，请在画布控制中确认。` : await native.apply();
        if (needsReview) {
          const snapshot: ControlSnapshot = { ...input, expiresAt: Date.now() + 10 * 60_000,
            writable: new Set(native.ids), nodes: [], groups: [], graph: { version: 1, connections: [], junctions: [] },
            available: { groups: false, connections: false }, origin: { x: 0, y: 0 } };
          const id = createId('canvas-plan');
          const review: CanvasControlReview = { id, sessionId: input.sessionId, createdAt: Date.now(), status: 'pending', actions: [], titles: {}, nativeLabel: native.label };
          keepReview({ review, snapshot, native });
          rememberReceipt(input, message, 'pending', { reviewId: id });
          logPlan(id, 'pending');
          openSurface(); publish();
        } else rememberReceipt(input, message, 'applied');
        return { result: { message }, ...(needsReview ? { transaction: showControl() } : {}) };
      } });
      context.queries.register({
        type: 'canvasControl.reviewReceipt@1', validate: isPlanId,
        handle: async ({ id }: { id: string }) => {
          const draft = reviews.get(id);
          if (!draft) return undefined;
          return { status: await readControlReviewStatus(context, draft), createdIds: draft.createdIds ?? [],
            created: draft.created ?? {}, verification: draft.review.verification, error: draft.review.error };
        },
      });
      context.commands.register<WorkspaceCanvasPreview, { reviewId: string; message: string }>({
        type: 'canvasControl.workspacePreview@1',
        validate: (input): input is WorkspaceCanvasPreview => isRecord(input) && isRecord(input.plan) &&
          Object.keys(input).every(key => ['plan', 'expectedRevision', 'sourceIds'].includes(key)) &&
          typeof input.expectedRevision === 'number' && Number.isSafeInteger(input.expectedRevision) &&
          (input.sourceIds === undefined || Array.isArray(input.sourceIds) && input.sourceIds.length <= 80 &&
            input.sourceIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)),
        handle: async ({ plan: rawPlan, expectedRevision, sourceIds = [] }) => {
          const revision = await context.queries.ask<{ revision: number }>('system.document.revision');
          if (revision.revision !== expectedRevision) throw new Error('工作区操作计划引用的书籍修订已过期');
          const plan = parseCanvasControlPlan(JSON.stringify(rawPlan));
          if (!plan.actions.length) throw new Error('工作区操作计划没有文档修改');
          const refs = new Set(plan.actions.flatMap(action => 'ref' in action ? [action.ref] : []));
          const targetIds = new Set<string>(sourceIds);
          for (const action of plan.actions) {
            if ('id' in action) targetIds.add(action.id);
            if ('ids' in action) action.ids.forEach(id => targetIds.add(id));
            if ('members' in action) action.members?.forEach(id => { if (!refs.has(id)) targetIds.add(id); });
            if ('from' in action && action.from && !refs.has(action.from)) targetIds.add(action.from);
            if ('to' in action && action.to && !refs.has(action.to)) targetIds.add(action.to);
          }
          const catalogs = await context.capabilities.requestAll<{ entities: Array<{ id: string }> }>('selection.entities@1');
          const visibleIds = new Set(catalogs.flatMap(catalog => catalog.entities.map(entity => entity.id)));
          if ([...targetIds].some(id => !visibleIds.has(id))) throw new Error('工作区计划只能引用公开画布对象');
          const input = {
            preparationId: createId('workspace-document'), sessionId: 'local-workspace',
            prompt: '先预览本地工作区操作', sourceIds: [...targetIds],
          };
          const snapshot = await captureControlSnapshot(context, input, 'selection', undefined, undefined, true);
          snapshot.execution = 'review';
          validateControlScope(plan, snapshot);
          snapshots.set(input.preparationId, snapshot);
          try {
            const result = await context.commands.invoke('canvasControl.offer@1', { ...input, text: JSON.stringify(plan), complete: true });
            const id = existingReceipt(input)?.reviewId;
            if (!id) throw new Error('工作区文档操作没有可用的预览');
            return { result: { reviewId: id, message: result.message } };
          } finally {
            snapshots.delete(input.preparationId);
          }
        },
      });
      context.commands.register({ type: 'canvasControl.offer@1', validate: (input): input is CanvasControlOffer => isAdmission(input) && typeof (input as CanvasControlOffer).text === 'string' && typeof (input as CanvasControlOffer).complete === 'boolean', handle: async input => {
        const disposition = canvasRequestDisposition(input.prompt);
        if (disposition === 'read-only') throw new Error('本轮只查看画布，不能提交修改计划。');
        const previousReceipt = existingReceipt(input);
        if (previousReceipt) return { result: { message: previousReceipt.message,
          ...(previousReceipt.directPlanId ? { directPlanId: previousReceipt.directPlanId } : {}) } };
        const snapshot = snapshots.get(input.preparationId);
        if (!snapshot || snapshot.expiresAt < Date.now() || snapshot.sessionId !== input.sessionId || snapshot.prompt !== input.prompt) throw new Error('本轮画布控制范围已失效，请重新发送要求');
        if (!input.complete) throw new Error('画布操作计划被平台截断，请缩小任务后重新生成');
        const local = localResults.get(input.preparationId);
        if (disposition === 'preview' && local?.setting) throw new Error('此设置需要明确要求后才能修改。');
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
          if (local.setting?.kind === 'preset') {
            const id = local.setting.id;
            await context.commands.invoke('palette.applyPreset@1', { id });
            return { result: rememberReceipt(input, `已切换为${PALETTE_PRESET_LABELS[id]}主题，完整配色已应用。`, 'applied') };
          }
          if (local.setting?.kind === 'theme') {
            await context.commands.invoke('palette.setPreferences', { themeId: local.setting.theme });
            return { result: rememberReceipt(input, `已切换为${local.setting.theme === 'dark' ? '深色' : '浅色'}主题。`, 'applied') };
          }
          if (local.setting?.kind === 'background') {
            const targets = await context.capabilities.requestAll<AppearanceReadContribution>('appearance.read@1', { mode: 'global', selectedIds: [] });
            const target = targets.flatMap(item => item.targets).find(item => item.kind === 'canvas-background');
            if (!target?.entities[0]) throw new Error('当前画布背景不可用');
            if (target.color === local.setting.color) return { result: { message: '画布已使用这个背景颜色。' } };
            if (background) clearBackground();
            background = { id: input.preparationId, color: local.setting.color, previous: target.color, entity: target.entities[0] };
            logBackground(background.id, 'pending');
            context.signals.emit('appearance.color.preview', { kind: 'canvas-background', color: background.color, entityIds: ['canvas'] });
            openSurface(); publish();
            return { result: rememberReceipt(input, '已准备画布背景颜色，请在画布控制中预览并应用。', 'pending'), transaction: showControl() };
          }
          if (local.pendingLine) {
            const { id, line: style } = local.pendingLine;
            const pending = reviews.get(id);
            const line = lastNatural.get(input.sessionId)?.pendingLine === id && pending?.review.status === 'pending' &&
              pending.snapshot.expiresAt >= Date.now() && pending.review.actions.length === 1 ? pending.review.actions[0] : undefined;
            if (!line || (line.type !== 'create-connection' && line.type !== 'update-connection')) return { result: { message: '上一条连线预览已失效，请重新指定端点。' } };
            line.line = style;
            openSurface(); publish();
            return { result: rememberReceipt(input, `已把待应用的连线预览改为${line.line === 'dashed' ? '虚线' : '实线'}。`, 'pending', { reviewId: id }), transaction: showControl() };
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
            return { result: rememberReceipt(input, '已调整待应用计划中的颜色。', 'pending', { reviewId: pending.review.id }), transaction: showControl() };
          }
          if (local.pendingArrangement) {
            const { id, arrangement } = local.pendingArrangement;
            const pending = reviews.get(id);
            if (!pending?.arrangement || pending.review.sessionId !== input.sessionId || pending.review.status !== 'pending' ||
              pending.snapshot.expiresAt < Date.now()) throw new Error('上一份排列预览已失效，请重新选择。');
            const actions = arrangeControlNodes(pending.snapshot.nodes, arrangement);
            validateControlScope({ version: 1, actions }, pending.snapshot);
            pending.arrangement = arrangement;
            pending.review.actions = actions;
            openSurface(); publish();
            return { result: rememberReceipt(input, `已将待应用的排列改为 ${arrangement.columns} 列，间距 ${arrangement.gap}。`, 'pending', { reviewId: id }), transaction: showControl() };
          }
        }
        if (!plan.actions.length && !local?.replacement) return { result: { message: plan.answer?.trim() || '本次没有需要应用的画布操作。' }, ...(local?.navigation ? { transaction: showControl() } : {}) };
        const id = createId('canvas-plan');
        const titles = Object.fromEntries([...snapshot.nodes.map(node => [node.id, node.title]), ...snapshot.groups.map(group => [group.id, group.title]), ...snapshot.graph.connections.map(edge => [edge.id, edge.label || '连线']), ...plan.actions.flatMap(action => 'ref' in action ? [[action.ref, 'title' in action ? action.title : action.label || '连线']] : [])]);
        if (local) for (const edge of snapshot.graph.connections) {
          titles[edge.id] = `${titles[edge.from.nodeId] ?? edge.from.nodeId} → ${titles[edge.to.nodeId] ?? edge.to.nodeId}`;
        }
        const review: CanvasControlReview = { id, sessionId: input.sessionId, createdAt: Date.now(), status: 'pending', actions: plan.actions, titles, planVersion: plan.version };
        const deletes = new Set(plan.actions.flatMap(action => action.type === 'delete' ? action.ids : []));
        if (deletes.size) review.affectedConnections = snapshot.graph.connections
          .filter(edge => !deletes.has(edge.id) && (deletes.has(edge.from.nodeId) || deletes.has(edge.to.nodeId)))
          .map(edge => edge.label || `${titles[edge.from.nodeId] ?? '关联节点'} → ${titles[edge.to.nodeId] ?? '关联节点'}`);
        if (local?.replacement) {
          const { hits, replacement } = local.replacement;
          review.replacement = { count: hits.length, nodeCount: new Set(hits.map(hit => hit.nodeId)).size,
            from: hits[0]!.matchedText, to: replacement, examples: hits.slice(0, 5).map(hit => `${hit.title} · ${hit.preview}`) };
        }
        const stored = { review, snapshot, replacement: local?.replacement, placement: local?.placement, arrangement: local?.arrangement };
        if (local?.replacesArrangement) {
          const previous = reviews.get(local.replacesArrangement);
          if (!previous || previous.review.sessionId !== input.sessionId || previous.review.status !== 'pending' ||
            previous.snapshot.expiresAt < Date.now()) throw new Error('原排列预览已变化，请重新指定群组和排列方式。');
          previous.review.status = 'dismissed';
          logPlan(previous.review.id, 'dismissed');
        }
        keepReview(stored);
        if (stored.placement) {
          lastPlacementBySession.delete(input.sessionId);
          lastPlacementBySession.set(input.sessionId, stored);
          if (lastPlacementBySession.size > 32) lastPlacementBySession.delete(lastPlacementBySession.keys().next().value!);
        }
        if (local && plan.actions.length === 1 && (plan.actions[0]?.type === 'create-connection' || plan.actions[0]?.type === 'update-connection')) remember(input.sessionId, { pendingLine: id });
        const receiptLinks = { reviewId: id, repeatableCreation: local?.repeatableCreation };
        if (snapshot.execution === 'direct' && execution() === 'direct' && disposition === 'normal' &&
          !/先(?:预览|看)|不要直接|只应用|(?:总结|概括|归纳|对比|比较|分析).*(?:写进|写入|填入)|缺.{1,10}的(?:卡片?|节点).*补|拆(?:分)?成|合并成/u.test(input.prompt) && canGenerateDirectly(review, snapshot)) {
          logPlan(id, 'waiting');
          publish();
          return { result: rememberReceipt(input, `已准备 ${plan.actions.length} 项操作，将直接生成到画布，无需点击应用。完成后可一次撤销。`, 'pending', { ...receiptLinks, directPlanId: id }) };
        }
        logPlan(id, 'pending');
        openSurface(); publish();
        return { result: rememberReceipt(input, review.replacement ? `已找到 ${review.replacement.nodeCount} 个节点中的 ${review.replacement.count} 处正文。请检查替换预览。` : `已生成 ${plan.actions.length} 项画布操作计划。请在“画布控制”中检查，点击底部固定的“应用整份计划”。`, 'pending', receiptLinks),
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
      const applyReview = async (id: string, items?: number[]) => {
        const original = reviews.get(id);
        if (!original || original.snapshot.expiresAt < Date.now()) {
          if (original) logPlan(id, 'expired');
          throw new Error('操作计划已经过期，请重新生成');
        }
        if (original.review.status !== 'pending' || applying.has(id)) throw new Error('这份操作计划已处理');
        if (original.native) {
          if (items && (items.length !== 1 || items[0] !== 1)) throw new Error('这份计划只包含一项操作。');
          logPlan(id, 'running');
          try {
            const ids = original.native.ids;
            if (ids.length) original.before = (await readTaskMarkers(context, ids)).markers;
            const message = await original.native.apply();
            if (original.native.pendingResult?.()) {
              const receipt = receipts.get(original.snapshot.preparationId);
              if (receipt) { receipt.message = message; receipt.status = 'pending'; }
              logPlan(id, 'waiting'); publish();
              return { result: { createdIds: [] } };
            }
            original.review.status = 'applied';
            original.review.error = undefined;
            if (ids.length) original.after = await readTaskMarkers(context, ids).then(read => read.markers).catch(() => undefined);
            const receipt = receipts.get(original.snapshot.preparationId);
            if (receipt) receipt.message = message;
            logPlan(id, 'applied'); publish();
            return { result: { createdIds: [] } };
          } catch (error) {
            original.review.error = error instanceof Error ? error.message : String(error);
            logPlan(id, 'failed'); publish(); throw error;
          }
        }
        const draft = items ? selectReviewItems(original, items) : original;
        const token = createId('control-commit');
        applying.set(id, { token, draft });
        logPlan(id, 'running');
        try {
          const changedIds = [...new Set([...draft.snapshot.writable, ...draft.review.actions.flatMap(action => 'id' in action ? [action.id] : [])])];
          draft.before = (await readTaskMarkers(context, changedIds)).markers;
          const result = await context.commands.invoke('canvasControl.commit@1', { id, token });
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
            id, relatedId: draft.snapshot.preparationId, phase: 'canvas-verification',
            state: draft.review.verification.status === 'verified' ? 'completed' : 'failed',
            detail: { step: 'verify', reason: draft.review.verification.status === 'verified' ? 'verified' :
              draft.review.verification.status === 'mismatch' ? 'verification-mismatch' : 'verification-unavailable',
              checked: draft.review.verification.checked, mismatchCount: draft.review.verification.mismatches.length },
          } satisfies OperationStageUpdateV2);
          draft.review.status = 'applied'; reviews.set(id, draft);
          if (lastPlacementBySession.get(draft.review.sessionId) === original && draft !== original) {
            if (draft.placement) lastPlacementBySession.set(draft.review.sessionId, draft);
            else lastPlacementBySession.delete(draft.review.sessionId);
          }
          logPlan(id, 'applied'); publish();
          return { result };
        } catch (error) {
          original.review.error = error instanceof Error ? error.message : String(error); logPlan(id, 'failed'); publish(); throw error;
        } finally { applying.delete(id); }
      };
      context.commands.register({ type: 'canvasControl.apply@1', validate: isPlanId, handle: input => applyReview(input.id) });
      const editableReview = (id: string) => {
        const draft = reviews.get(id);
        if (!draft || draft.snapshot.expiresAt < Date.now()) throw new Error('操作计划已经过期，请重新生成');
        if (draft.review.status !== 'pending' || applying.has(id) || generating.has(id)) throw new Error('这份操作计划暂不可修改');
        if (draft.native || draft.replacement) throw new Error('这份计划没有可修改的新建标题');
        return draft;
      };
      const changedTitles = (draft: StoredControlReview) => {
        draft.review.error = undefined;
        draft.review.verification = undefined;
        for (const action of draft.review.actions) if ((action.type === 'create-node' || action.type === 'create-group')) {
          draft.review.titles[action.ref] = action.title;
        }
        for (const receipt of receipts.values()) if (receipt.reviewId === draft.review.id) receipt.status = 'pending';
        publish();
      };
      context.commands.register({ type: 'canvasControl.updateTitle@1',
        validate: (input): input is { id: string; item: number; title: string } => isRecord(input) && typeof input.id === 'string' &&
          Object.keys(input).every(key => ['id', 'item', 'title'].includes(key)) && Number.isInteger(input.item) &&
          Number(input.item) > 0 && typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 300,
        handle: input => {
          const draft = editableReview(input.id);
          const action = draft.review.actions[input.item - 1];
          if (action?.type !== 'create-node' && action?.type !== 'create-group') throw new Error('只能修改预览中新建对象的标题');
          action.title = input.title.trim();
          changedTitles(draft);
          return {};
        } });
      context.commands.register({ type: 'canvasControl.resolveTitles@1', validate: isPlanId, handle: async input => {
        const draft = editableReview(input.id);
        const reserved = reservedCreationTitles(draft.snapshot.preparationId);
        const titles = new Map<number, string>();
        for (const [index, action] of draft.review.actions.entries()) if (action.type === 'create-node') {
          const plan = await context.capabilities.request<{ resolvedTitle: string }>('content.createPlan@1', { title: action.title, reservedTitles: reserved });
          titles.set(index, plan.resolvedTitle);
          reserved.push(plan.resolvedTitle);
        }
        if (editableReview(input.id) !== draft) throw new Error('操作计划已变化，请重试');
        for (const [index, title] of titles) (draft.review.actions[index] as { title: string }).title = title;
        changedTitles(draft);
        return {};
      } });
      context.commands.register({ type: 'canvasControl.revisePending@1',
        validate: (value): value is { sessionId: string; change: 'cancel' | 'keep-nodes' } => isRecord(value) &&
          typeof value.sessionId === 'string' && (value.change === 'cancel' || value.change === 'keep-nodes'),
        handle: ({ sessionId, change }) => {
          const candidates = [...reviews.values()].filter(draft => draft.review.sessionId === sessionId &&
            draft.review.status === 'pending' && !generating.has(draft.review.id) && draft.snapshot.expiresAt >= Date.now());
          if (candidates.length !== 1) return { result: { message: candidates.length
            ? '有多份待应用计划，请在画布控制中选定要调整的那份。' : '当前对话没有待应用的画布计划。' } };
          const draft = candidates[0]!;
          if (change === 'keep-nodes') {
            if (draft.native || !draft.review.actions.some(action => action.type === 'delete')) {
              return { result: { message: '待应用计划中没有可单独移除的删除步骤。' } };
            }
            const actions = draft.review.actions.filter(action => action.type !== 'delete');
            if (actions.length) {
              validateControlScope({ version: draft.review.planVersion ?? 2, actions }, draft.snapshot);
              draft.review.actions = actions;
              draft.review.affectedConnections = undefined;
              draft.snapshot.deletionImpact = undefined;
              draft.review.error = undefined;
              publish();
              return { result: { message: '已从预览移除删除步骤，其余操作仍待应用。' } };
            }
          }
          draft.review.status = 'dismissed';
          logPlan(draft.review.id, 'dismissed');
          publish();
          return { result: { message: '已取消待应用计划。' } };
        } });
      for (const type of ['canvasControl.applyItems@1', 'canvasControl.applyItems@2'] as const) context.commands.register({ type,
        validate: (input): input is ({ id: string } | { sessionId: string }) & { items: number[] } => isItemSelection(input, type.endsWith('@2') ? 512 : 100), handle: input => {
        const candidates = 'id' in input ? [input.id] : [...reviews.values()].filter(draft =>
          draft.review.sessionId === input.sessionId && draft.review.status === 'pending' && draft.snapshot.expiresAt >= Date.now()).map(draft => draft.review.id);
        if (candidates.length !== 1) throw new Error(candidates.length ? '这段对话有多份待应用计划，请在画布控制中选定一份。' : '这段对话没有可应用的预览。');
        return applyReview(candidates[0]!, input.items);
      } });
      context.commands.register({ type: 'canvasControl.commit@1', validate: (input): input is { id: string; token: string } => isPlanId(input) && typeof (input as { token?: unknown }).token === 'string', handle: async input => {
        const active = applying.get(input.id);
        if (!active || active.token !== input.token || active.draft.review.status !== 'pending') throw new Error('画布控制提交授权已失效');
        const { draft } = active;
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
        snapshots.clear(); reviews.clear(); lastPlacementBySession.clear(); localResults.clear(); compoundDrafts.clear(); localInterpretations.clear(); agentSessions.clear(); receipts.clear(); lastNatural.clear(); navigation = undefined;
        if (background) clearBackground(); else publish();
      });
      context.events.subscribe('history.changed', publish);
      context.events.subscribe<{ operationLogBackgroundId?: string }>('canvasControl.background.applied@1', message => {
        if (background?.id === message.payload.operationLogBackgroundId) clearBackground('applied');
      });
      context.events.subscribe('canvas.appearance.changed', () => { if (background) clearBackground(); });
      context.ui.contribute({ id: 'canvas-control.panel', slot: 'overlay.floating', kind: 'view', label: '画布控制', component: panel });
      context.ui.action({ id: 'canvas-control.open-action', label: '画布控制', command: 'canvasControl.open@1', category: 'AI', keywords: ['操作', '节点', '群组', '连线', '控制'], priority: 40,
        localTool: { version: 1, effect: 'workspace', resultMode: 'returned', inputSchema: { type: 'null' } },
      });
      context.ui.shortcut({ id: 'canvas-control.open-shortcut', label: '画布控制', command: 'canvasControl.open@1', category: 'AI' });
    },
  };
}
function isAdmission(input: unknown): input is CanvasControlAdmission {
  return isRecord(input) && typeof input.preparationId === 'string' && input.preparationId.length <= 200 && typeof input.sessionId === 'string' && input.sessionId.length <= 200 && typeof input.prompt === 'string' && input.prompt.length <= 100_000 &&
    (input.sourceIds === undefined || (Array.isArray(input.sourceIds) && input.sourceIds.length <= 80 && input.sourceIds.every(id => typeof id === 'string' && id.length <= 200)));
}
function isNativeRequest(input: unknown): input is CanvasControlNativeRequest {
  if (!isAdmission(input)) return false;
  const ids = (input as CanvasControlNativeRequest).selectedIds;
  return ids === undefined || Array.isArray(ids) && ids.length <= 10_000 && ids.every(id => typeof id === 'string' && id.length <= 200) && new Set(ids).size === ids.length;
}
function isPlanId(input: unknown): input is { id: string } { return isRecord(input) && typeof input.id === 'string'; }
function canGenerateDirectly(review: CanvasControlReview, snapshot: ControlSnapshot): boolean {
  return review.actions.every(action => {
    if (action.type === 'create-node' || action.type === 'create-group' || action.type === 'create-connection') return true;
    if (snapshot.localDirect && 'id' in action && snapshot.writable.has(action.id)) {
      if (action.type === 'update-group' || action.type === 'update-connection') return true;
      if (action.type === 'update-node' && action.text === undefined && action.append === undefined && !action.edit) return true;
    }
    if (action.type !== 'update-node' || !snapshot.writable.has(action.id)) return false;
    const node = snapshot.nodes.find(item => item.id === action.id);
    if (!node || node.length !== 0 || !Object.keys(action).every(key => ['type', 'id', 'text', 'append', 'edit'].includes(key))) return false;
    if (action.edit) return action.edit.start === 0 && action.edit.deleteCount === 0 && action.edit.expectedRevision === node.revision && Boolean(action.edit.insert.trim());
    return Boolean((action.text ?? action.append)?.trim());
  });
}

function isItemSelection(input: unknown, maximum = 100): input is ({ id: string } | { sessionId: string }) & { items: number[] } {
  return isRecord(input) && (isPlanId(input) !== (typeof input.sessionId === 'string' && input.sessionId.length > 0 && input.sessionId.length <= 200)) &&
    Array.isArray(input.items) && input.items.length > 0 && input.items.length <= maximum &&
    input.items.every(item => Number.isInteger(item) && item >= 1 && item <= maximum) && new Set(input.items).size === input.items.length;
}

function selectReviewItems(original: StoredControlReview, items: number[]): StoredControlReview {
  const { review, snapshot } = original;
  if (original.replacement && review.replacement) {
    if (items.some(item => item > review.replacement!.examples.length)) throw new Error('请按预览中显示的替换项编号选择。');
    const indexes = [...items].sort((a, b) => a - b).map(item => item - 1);
    const hits = indexes.map(index => original.replacement!.hits[index]!);
    const ids = new Set(hits.map(hit => hit.nodeId));
    return { ...original, replacement: { ...original.replacement, hits },
      snapshot: { ...snapshot, writable: new Set([...snapshot.writable].filter(id => ids.has(id))) },
      review: { ...review, replacement: { ...review.replacement, count: hits.length, nodeCount: ids.size,
        examples: indexes.map(index => review.replacement!.examples[index]!) } } };
  }
  if (items.some(item => item > review.actions.length)) throw new Error('选中的项超出当前预览范围。');
  const selected = new Set(items.map(item => item - 1));
  const actions = review.actions.filter((_, index) => selected.has(index));
  if (actions.length === review.actions.length) return original;
  const removedRefs = new Set(review.actions.flatMap((action, index) => !selected.has(index) && 'ref' in action ? [action.ref] : []));
  if (actions.some(action => ('members' in action && action.members?.some(id => removedRefs.has(id))) ||
    ('from' in action && action.from && removedRefs.has(action.from)) ||
    ('to' in action && action.to && removedRefs.has(action.to)))) throw new Error('选中项依赖未选中的新对象，请一并勾选。');
  const placement = original.placement?.movingIds.every(id => actions.some(action => action.type === 'update-node' && action.id === id &&
    (action.x !== undefined || action.y !== undefined))) ? original.placement : undefined;
  if (placement || actions.some(action => action.type !== 'update-node' && action.type !== 'create-node')) {
    return { ...original, placement, review: { ...review, actions } };
  }
  const ids = new Set(actions.flatMap(action => action.type === 'update-node' ? [action.id] : []));
  return { ...original, placement, review: { ...review, actions }, snapshot: { ...snapshot,
    nodes: snapshot.nodes.filter(node => ids.has(node.id)), groups: [], graph: { ...snapshot.graph, connections: [] },
    namedTargetIds: snapshot.namedTargetIds?.filter(id => ids.has(id)),
    writable: new Set([...snapshot.writable].filter(id => ids.has(id))),
  } };
}
