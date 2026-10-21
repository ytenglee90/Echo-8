import { isRecord, type PluginDefinition, type TaskHandle } from '../../core/contracts.ts';
import type { TextAssetReadResult } from '../../protocols/assets.ts';
import type { PersonalTextAssetRecord } from '../../protocols/personal-assets.ts';
import type {
  ContentCatalogDelta,
  ContentCreatePlanRequest,
  ContentDeltaPlanRequest,
  ContentMutationPlan,
  ContentPlacementPlanRequest,
  ContentSummary,
} from '../../protocols/content.ts';
import { EDITOR_OPEN_REQUESTED_EVENT } from '../../protocols/editor.ts';
import type { EntityDeletePlan } from '../../protocols/selection.ts';
import {
  DEFAULT_TEXT_ASSIST_SETTINGS,
  type TextAssistAnalysis,
  type TextAssistAnalyzeRequest,
  type TextAssistLanguageModel,
  type TextAssistResourceBinding,
  type TextAssistResourceIssue,
  type TextAssistResourceRole,
  type TextAssistResourceStatus,
  type TextAssistEnsureResourcesRequest,
  type TextAssistSettings,
} from '../../protocols/text-assist.ts';
import { defineManifest } from '../manifest.ts';
import {
  analyzeTextAssistance,
  buildTextAssistCatalog,
  DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL,
  type TextAssistCatalog,
} from './analysis.ts';
import {
  compileTextAssistResources,
  mergeMissingDefaultRules,
  type TextAssistCompileResult,
  type TextAssistResourceTexts,
} from './resource-format.ts';
import { TEXT_ASSIST_RESOURCE_ROLES, TEXT_ASSIST_RESOURCE_SEEDS } from './resource-seeds.ts';
import { TEXT_ASSIST_COMPILE_JOB } from './worker-jobs.ts';

const MAX_ANALYSIS_WINDOW = 96 * 1024;
const MAX_RESOURCE_LENGTH = 16 * 1024 * 1024;
const READ_CHUNK_LENGTH = 256 * 1024;
const TEXT_ASSIST_NAMESPACE = 'textAssist';
const TEXT_ASSIST_RESOURCE_NAMESPACE = 'textAssistResource';
const TEXT_ASSIST_PREFERENCE_KEY = 'settings@1';
const TEXT_ASSIST_RULE_ASSET_KEY = 'rules@1';
const TEXT_ASSIST_RULE_FILE_NAME = 'Echo-8-text-assist-rules.txt';
const DEFAULT_RULE_VERSION = 4;
const LEGACY_RESOURCE_KEYS = ['common', 'personal', 'canvas'] as const;

interface MergeDefaultRulesPayload {
  automatic?: boolean;
}

interface ContentReadSlice {
  nodeId: string;
  start: number;
  text: string;
  totalLength: number;
  revision: number;
}

interface CompiledResources extends TextAssistCompileResult {
  revisions: Partial<Record<TextAssistResourceRole, number>>;
}

export function createTextAssistPlugin(associationNotice?: unknown): PluginDefinition {
  return {
  manifest: defineManifest('text-assist', '文本纠错、引用与补全', {
    version: '0.6.0',
    namespaces: [TEXT_ASSIST_NAMESPACE, TEXT_ASSIST_RESOURCE_NAMESPACE],
    namespaceDomains: {
      [TEXT_ASSIST_NAMESPACE]: 'workspace',
      [TEXT_ASSIST_RESOURCE_NAMESPACE]: 'document',
    },
    requiresCapabilities: [
      'content.catalog@2',
      'content.createPlan@1',
      'content.deltaPlan@1',
      'content.placementPlan@1',
      'content.read@1',
      'content.summariesById@1',
      'entity.deletePlan@1',
      'assets.readText@1',
    ],
    providesCapabilities: [
      'text.assist.analyze@2',
      'text.assist.settings@1',
      'text.assist.resources@2',
      'text.assist.resources@3',
    ],
    commands: [
      'textAssist.toggleCorrection',
      'textAssist.toggleCompletion',
      'textAssist.restoreSettings',
      'textAssist.ensureResources',
      'textAssist.mergeDefaultRules',
      'textAssist.openRules',
      'textAssist.loadRulesFile',
    ],
    dispatches: [
      'textAssist.restoreSettings',
      'textAssist.ensureResources',
      'textAssist.mergeDefaultRules',
      'system.preferences.set',
      'system.personalAssets.set',
    ],
    events: [
      'text.assist.settings.changed',
      'text.assist.resources.changed',
      'node.created',
      'content.changed',
      'nodes.deleted',
      'history.changed',
      'document.replaced',
    ],
    asks: ['system.preferences.get', 'system.personalAssets.get'],
    signals: [
      'content.catalog.invalidated',
      'text.assist.invalidated',
      'text.assist.settings.changed',
      'text.assist.resources.status',
      EDITOR_OPEN_REQUESTED_EVENT,
    ],
    ui: associationNotice ? ['text-assist.association-notice'] : [],
    actions: [
      'text-assist.toggle-correction-action',
      'text-assist.toggle-completion-action',
      'text-assist.open-rules-action',
      'text-assist.load-rules-file-action',
    ],
    shortcuts: [
      'text-assist.toggle-correction-shortcut',
      'text-assist.toggle-completion-shortcut',
      'text-assist.open-rules-shortcut',
      'text-assist.load-rules-file-shortcut',
    ],
    workerJobs: [TEXT_ASSIST_COMPILE_JOB],
    permissions: [
      'store.own.read',
      'store.own.write',
      'tasks.schedule',
      'workers.run',
      'preferences.manage',
      'personal.assets.manage',
      'ui.action.register',
      'ui.shortcut.register',
      ...(associationNotice ? ['ui.canvas.contribute' as const] : []),
    ],
  }),

  async start(context) {
    let catalogVersion: number | undefined;
    let summaries = new Map<string, ContentSummary>();
    let languageModel: TextAssistLanguageModel = DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL;
    let catalog: TextAssistCatalog = buildTextAssistCatalog([]);
    let catalogDirty = true;
    let resourcesDirty = true;
    let resourceTask: TaskHandle<CompiledResources> | undefined;
    let retryResourcesAfter = 0;
    let usingLastValid = false;
    let resourceIssues: TextAssistResourceIssue[] = [];
    let resourceRevisions: Partial<Record<TextAssistResourceRole, number>> = {};
    let defaultRuleText = '';
    let ruleAssociation: TextAssistResourceStatus['association'] = { state: 'unassociated' };

    const acceptDefaultRuleText = (
      text: string,
      association: TextAssistResourceStatus['association'],
    ) => {
      const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
      if (!normalized.includes('[固定纠错]') || !normalized.includes('[检查]') || normalized.length < 200) {
        throw new Error('选择的文件不是有效的 Echo-8 纠错补全规则');
      }
      defaultRuleText = normalized;
      ruleAssociation = association;
      return normalized;
    };
    const loadDefaultRuleText = async () => {
      if (defaultRuleText) return defaultRuleText;
      try {
        const retained = await context.queries.ask<PersonalTextAssetRecord | undefined>('system.personalAssets.get', {
          key: TEXT_ASSIST_RULE_ASSET_KEY,
        });
        if (retained) {
          return acceptDefaultRuleText(retained.text, {
            state: 'stored',
            fileName: retained.fileName,
          });
        }
      } catch {
        // Browsers without IndexedDB support can still use the packaged resource.
      }
      try {
        const resource = await context.capabilities.request<TextAssetReadResult>('assets.readText@1', {
          path: TEXT_ASSIST_RULE_FILE_NAME,
          maxBytes: MAX_RESOURCE_LENGTH,
        });
        return acceptDefaultRuleText(resource.text, {
          state: 'same-origin',
          fileName: resource.path,
        });
      } catch {
        ruleAssociation = { state: 'unassociated' };
        throw new Error(`尚未导入 ${TEXT_ASSIST_RULE_FILE_NAME}；请在命令面板选择“从 TXT 更新纠错规则”`);
      }
    };

    const readSettings = () => normalizeSettings(
      context.store.readValue(TEXT_ASSIST_NAMESPACE, 'settings'),
    );
    const readRawBindings = () => context.store.readNamespace<Record<string, unknown>>(TEXT_ASSIST_RESOURCE_NAMESPACE);
    const readBindings = () => normalizeBindings(readRawBindings());
    const resourceNodeIds = () => Object.values(readBindings()).map((binding) => binding.nodeId);
    const currentResourceStatus = (): TextAssistResourceStatus => ({
      ready: TEXT_ASSIST_RESOURCE_ROLES.every((role) => Boolean(readBindings()[role])) &&
        !resourcesDirty && !usingLastValid,
      dirty: resourcesDirty,
      usingLastValid,
      association: { ...ruleAssociation },
      bindings: structuredClone(readBindings()),
      revisions: { ...resourceRevisions },
      ignoredTermCount: languageModel.ignoredTerms.length,
      correctionCount: languageModel.corrections.length,
      issues: resourceIssues.map((issue) => ({ ...issue })),
    });
    const emitResourceStatus = () => context.signals.emit('text.assist.resources.status', currentResourceStatus());
    const settingsTransaction = (label: string, settings: TextAssistSettings) => ({
      result: settings,
      transaction: {
        label,
        history: false,
        patches: [{
          op: 'set' as const,
          domain: 'workspace' as const,
          namespace: TEXT_ASSIST_NAMESPACE,
          key: 'settings',
          value: settings,
        }],
        events: [{ type: 'text.assist.settings.changed', payload: settings }],
      },
    });

    const markResourcesDirty = () => {
      resourcesDirty = true;
      catalogDirty = true;
      retryResourcesAfter = 0;
      resourceTask?.cancel();
      resourceTask = undefined;
      emitResourceStatus();
      context.signals.emit('text.assist.invalidated');
    };

    const refreshSummaries = async (signal?: AbortSignal) => {
      const delta = await context.capabilities.request<ContentCatalogDelta>(
        'content.catalog@2',
        catalogVersion === undefined ? undefined : { sinceVersion: catalogVersion },
        signal,
      );
      if (delta.reset) summaries = new Map(delta.summaries.map((summary) => [summary.id, summary]));
      else {
        for (const id of delta.removedIds) summaries.delete(id);
        for (const summary of delta.summaries) summaries.set(summary.id, summary);
      }
      catalogVersion = delta.version;
      return summaries;
    };

    const runResourceCompilation = (bindings: Record<TextAssistResourceRole, TextAssistResourceBinding>) => {
      const task = context.tasks.schedule<CompiledResources>({
        category: 'text-assist-resources',
        label: '正在重建纠错规则',
        delayMs: 120,
        noticeAfterMs: 1_000,
        priority: 6,
        timeoutMs: 60_000,
        estimatedCost: 3,
        run: async (signal, report) => {
          const texts = {} as TextAssistResourceTexts;
          const revisions: Partial<Record<TextAssistResourceRole, number>> = {};
          for (let index = 0; index < TEXT_ASSIST_RESOURCE_ROLES.length; index += 1) {
            const role = TEXT_ASSIST_RESOURCE_ROLES[index];
            const resource = await readResourceText(context, bindings[role], signal);
            const runtimeDefaults = defaultRuleText
              ? mergeMissingDefaultRules(resource.text, defaultRuleText)
              : { appendText: '', added: 0 };
            texts[role] = resource.text + runtimeDefaults.appendText;
            revisions[role] = resource.revision;
            report(0.1 + ((index + 1) / TEXT_ASSIST_RESOURCE_ROLES.length) * 0.45);
          }
          const compiled = context.workers.available()
            ? await compileWithWorkerFallback(context, texts, signal)
            : compileTextAssistResources(texts);
          report(1);
          return { ...compiled, revisions };
        },
      });
      resourceTask = task;
      return task;
    };

    const ensureLanguageModel = async (signal?: AbortSignal): Promise<TextAssistLanguageModel> => {
      if (!resourcesDirty) return languageModel;
      if (Date.now() < retryResourcesAfter) return languageModel;
      const bindings = readBindings();
      const missing = TEXT_ASSIST_RESOURCE_ROLES.filter((role) => !bindings[role]);
      if (missing.length > 0) {
        usingLastValid = true;
        resourceIssues = missing.map((role) => ({
          role,
          line: 0,
          message: '纠错规则资源缺失；系统会自动重建，也可以从 TXT 更新规则',
        }));
        retryResourcesAfter = Date.now() + 5_000;
        emitResourceStatus();
        return languageModel;
      }
      let task: TaskHandle<CompiledResources> | undefined;
      try {
        task = resourceTask ?? runResourceCompilation(bindings as Record<TextAssistResourceRole, TextAssistResourceBinding>);
        const compiled = await waitForSharedTask(task, signal);
        if (task && resourceTask === task) resourceTask = undefined;
        languageModel = compiled.model;
        resourceIssues = compiled.issues;
        resourceRevisions = compiled.revisions;
        resourcesDirty = false;
        usingLastValid = false;
        catalogDirty = true;
        emitResourceStatus();
        if (compiled.issues.length > 0) {
          context.diagnostics.warn(
            `纠错规则有 ${compiled.issues.length} 行无法识别，已忽略这些行`,
            compiled.issues.slice(0, 20),
          );
        }
        return languageModel;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (resourceTask === task) resourceTask = undefined;
        usingLastValid = true;
        retryResourcesAfter = Date.now() + 5_000;
        resourceIssues = [resourceIssue(error)];
        context.diagnostics.warn('纠错规则无法重建，继续使用上一次有效版本', error);
        emitResourceStatus();
        return languageModel;
      }
    };

    const refreshCatalog = async (signal?: AbortSignal) => {
      if (!catalogDirty && catalogVersion !== undefined &&
        (!resourcesDirty || Date.now() < retryResourcesAfter)) return catalog;
      const currentLanguage = await ensureLanguageModel(signal);
      await refreshSummaries(signal);
      catalog = buildTextAssistCatalog([...summaries.values()], currentLanguage, resourceNodeIds());
      catalogDirty = false;
      return catalog;
    };

    context.commands.register<undefined, TextAssistSettings>({
      type: 'textAssist.toggleCorrection',
      handle: () => {
        const current = readSettings();
        return settingsTransaction('切换文本纠错', {
          ...current,
          correctionEnabled: !current.correctionEnabled,
        });
      },
    });
    context.commands.register<undefined, TextAssistSettings>({
      type: 'textAssist.toggleCompletion',
      handle: () => {
        const current = readSettings();
        return settingsTransaction('切换文字补全', {
          ...current,
          completionEnabled: !current.completionEnabled,
        });
      },
    });
    context.commands.register<TextAssistSettings, TextAssistSettings>({
      type: 'textAssist.restoreSettings',
      validate: isTextAssistSettings,
      handle: (settings) => settingsTransaction('恢复文本辅助设置', settings),
    });
    context.commands.register({
      type: 'textAssist.ensureResources',
      validate: isEnsureResourcesPayload,
      handle: async (payload = {}) => {
        const automatic = payload.automatic === true;
        const bindings = readBindings();
        const rawBindings = readRawBindings();
        const boundIds = [...new Set(Object.values(bindings).map((binding) => binding.nodeId))];
        const boundSummaries = boundIds.length > 0
          ? await context.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: boundIds })
          : [];
        const liveIds = new Set(boundSummaries.map((summary) => summary.id));
        const missing = TEXT_ASSIST_RESOURCE_ROLES.filter((role) => !bindings[role] || !liveIds.has(bindings[role].nodeId));
        const placementPlans: Array<{ role: TextAssistResourceRole; plan: ContentMutationPlan }> = [];
        for (const role of TEXT_ASSIST_RESOURCE_ROLES) {
          const binding = bindings[role];
          if (!binding || !liveIds.has(binding.nodeId)) continue;
          const plan = await context.capabilities.request<ContentMutationPlan>('content.placementPlan@1', {
            nodeId: binding.nodeId,
            placement: 'system',
          } satisfies ContentPlacementPlanRequest);
          placementPlans.push({ role, plan });
        }
        const obsoleteKeys = LEGACY_RESOURCE_KEYS.filter((key) => rawBindings[key] !== undefined);
        const hasRetiredRecord = rawBindings.retiredLexicons !== undefined;
        const retiredRecord = rawBindings.retiredLexicons;
        const obsoleteNodeIds = [...new Set([
          ...obsoleteKeys.map((key) => rawBindings[key])
            .filter(isRecord)
            .map((value) => value.nodeId)
            .filter((value): value is string => typeof value === 'string'),
          ...(isRecord(retiredRecord) && Array.isArray(retiredRecord.nodeIds)
            ? retiredRecord.nodeIds.filter((value): value is string => typeof value === 'string')
            : []),
        ])];
        const rulesNeedsUpgrade = bindings.rules &&
          (!isRecord(rawBindings.rules) || rawBindings.rules.schemaVersion !== 3);
        const placementChanged = placementPlans.some(({ plan }) => plan.patches.length > 0);
        if (missing.length === 0 && obsoleteKeys.length === 0 && !hasRetiredRecord &&
          !rulesNeedsUpgrade && !placementChanged) {
          return { result: { created: [], missing } };
        }
        const now = Date.now();
        const bundledRules = missing.includes('rules') ? await loadDefaultRuleText() : defaultRuleText;
        const reservedTitles: string[] = [];
        const plans: Array<{ role: TextAssistResourceRole; plan: ContentMutationPlan }> = [];
        for (const role of missing) {
          const seed = TEXT_ASSIST_RESOURCE_SEEDS.find((candidate) => candidate.role === role)!;
          const plan = await context.capabilities.request<ContentMutationPlan>('content.createPlan@1', {
            title: seed.title,
            body: role === 'rules' ? bundledRules : '',
            x: seed.x,
            y: seed.y,
            automaticContext: false,
            placement: 'system',
            reservedTitles,
          } satisfies ContentCreatePlanRequest);
          reservedTitles.push(plan.resolvedTitle ?? seed.title);
          plans.push({ role, plan });
        }
        const created = plans.map(({ role, plan }) => ({ role, nodeId: plan.nodeId }));
        const deletePlans = obsoleteNodeIds.length > 0
          ? await context.capabilities.requestAll<EntityDeletePlan>('entity.deletePlan@1', { ids: obsoleteNodeIds })
          : [];
        return {
          result: { created, missing: [] },
          transaction: {
            label: automatic ? '初始化纠错补全规则' : '修复纠错补全规则',
            history: !automatic,
            patches: [
              ...deletePlans.flatMap((plan) => plan.patches),
              ...placementPlans.flatMap(({ plan }) => plan.patches),
              ...plans.flatMap(({ plan }) => plan.patches),
              ...obsoleteKeys.map((key) => ({
                op: 'delete' as const,
                domain: 'document' as const,
                namespace: TEXT_ASSIST_RESOURCE_NAMESPACE,
                key,
                schemaOwner: 'text-assist',
              })),
              ...(rawBindings.retiredLexicons !== undefined ? [{
                op: 'delete' as const,
                domain: 'document' as const,
                namespace: TEXT_ASSIST_RESOURCE_NAMESPACE,
                key: 'retiredLexicons',
                schemaOwner: 'text-assist',
              }] : []),
              ...(rulesNeedsUpgrade && bindings.rules && !created.some((item) => item.role === 'rules') ? [{
                op: 'set' as const,
                domain: 'document' as const,
                namespace: TEXT_ASSIST_RESOURCE_NAMESPACE,
                key: 'rules',
                value: { ...bindings.rules, schemaVersion: 3 as const, updatedAt: now },
                schemaOwner: 'text-assist',
              }] : []),
              ...created.map(({ role, nodeId }) => ({
                op: 'set' as const,
                domain: 'document' as const,
                namespace: TEXT_ASSIST_RESOURCE_NAMESPACE,
                key: role,
                value: {
                  schemaVersion: 3,
                  role,
                  nodeId,
                  createdAt: bindings[role]?.createdAt ?? now,
                  updatedAt: now,
                  defaultRuleVersion: DEFAULT_RULE_VERSION,
                } satisfies TextAssistResourceBinding,
                schemaOwner: 'text-assist',
              })),
            ],
            events: [
              ...deletePlans.flatMap((plan) => plan.events ?? []),
              ...(obsoleteNodeIds.length > 0 ? [{ type: 'entity.deleted', payload: { ids: obsoleteNodeIds } }] : []),
              ...placementPlans.flatMap(({ plan }) => plan.events ?? []),
              ...plans.flatMap(({ plan }) => plan.events ?? []),
              {
                type: 'text.assist.resources.changed',
                payload: {
                  roles: [...new Set([
                    ...created.map((item) => item.role),
                    ...placementPlans.filter(({ plan }) => plan.patches.length > 0).map(({ role }) => role),
                  ])],
                },
              },
            ],
          },
        };
      },
    });
    context.commands.register({
      type: 'textAssist.openRules',
      handle: () => {
        const binding = readBindings().rules;
        if (!binding) throw new Error('纠错规则尚未准备好，请稍后重试或从 TXT 更新规则');
        context.signals.emit(EDITOR_OPEN_REQUESTED_EVENT, {
          id: binding.nodeId,
          reason: 'text-assist-rules',
        });
        return { result: { id: binding.nodeId, queued: true } };
      },
    });
    context.commands.register({
      type: 'textAssist.loadRulesFile',
      handle: async () => {
        const picked = await pickTextAssistRulesFile();
        const normalized = acceptDefaultRuleText(picked.text, { state: 'stored', fileName: picked.name });
        await context.commands.invoke('system.personalAssets.set', {
          key: TEXT_ASSIST_RULE_ASSET_KEY,
          asset: {
            schemaVersion: 1,
            text: normalized,
            fileName: picked.name,
            updatedAt: Date.now(),
          } satisfies PersonalTextAssetRecord,
        });
        markResourcesDirty();
        const ensured = await context.commands.invoke('textAssist.ensureResources', { automatic: false });
        const binding = readBindings().rules;
        if (!binding) throw new Error('纠错补全规则无法初始化');
        const current = await readResourceText(context, binding);
        if (current.text === normalized) {
          emitResourceStatus();
          return { result: { loaded: true, name: picked.name, ensured } };
        }
        const plan = await context.capabilities.request<ContentMutationPlan>('content.deltaPlan@1', {
          nodeId: binding.nodeId,
          start: 0,
          deleteCount: current.text.length,
          insert: normalized,
          expectedRevision: current.revision,
        } satisfies ContentDeltaPlanRequest);
        return {
          result: { loaded: true, name: picked.name, ensured },
          transaction: {
            label: '从 TXT 更新纠错规则',
            history: false,
            patches: plan.patches,
            events: [
              ...(plan.events ?? []),
              { type: 'text.assist.resources.changed', payload: { roles: ['rules'] } },
            ],
          },
        };
      },
    });
    context.commands.register<MergeDefaultRulesPayload | undefined, { added: number }>({
      type: 'textAssist.mergeDefaultRules',
      validate: isMergeDefaultRulesPayload,
      handle: async (payload = {}) => {
        const automatic = payload.automatic === true;
        const binding = readBindings().rules;
        if (!binding) throw new Error('纠错规则尚未准备好，请稍后重试或从 TXT 更新规则');
        if (automatic && binding.defaultRuleVersion >= DEFAULT_RULE_VERSION) {
          return { result: { added: 0 } };
        }
        const resource = await readResourceText(context, binding);
        const merged = mergeMissingDefaultRules(resource.text, await loadDefaultRuleText());
        if (!merged.appendText && binding.defaultRuleVersion >= DEFAULT_RULE_VERSION) {
          return { result: { added: 0 } };
        }
        const plan = merged.appendText
          ? await context.capabilities.request<ContentMutationPlan>('content.deltaPlan@1', {
              nodeId: binding.nodeId,
              start: resource.text.length,
              deleteCount: 0,
              insert: merged.appendText,
              expectedRevision: resource.revision,
            } satisfies ContentDeltaPlanRequest)
          : undefined;
        return {
          result: { added: merged.added },
          transaction: {
            label: automatic ? '更新内置纠错规则' : '补充内置纠错规则',
            history: !automatic,
            patches: [
              ...(plan?.patches ?? []),
              {
                op: 'set' as const,
                domain: 'document' as const,
                namespace: TEXT_ASSIST_RESOURCE_NAMESPACE,
                key: 'rules',
                value: {
                  ...binding,
                  schemaVersion: 3 as const,
                  updatedAt: Date.now(),
                  defaultRuleVersion: DEFAULT_RULE_VERSION,
                } satisfies TextAssistResourceBinding,
                schemaOwner: 'text-assist',
              },
            ],
            events: [
              ...(plan?.events ?? []),
              { type: 'text.assist.resources.changed', payload: { roles: ['rules'] } },
            ],
          },
        };
      },
    });

    context.events.subscribe<TextAssistSettings>('text.assist.settings.changed', () => {
      const settings = readSettings();
      context.signals.emit('text.assist.settings.changed', settings);
      context.signals.emit('text.assist.invalidated');
      void context.commands.dispatch('system.preferences.set', {
        key: TEXT_ASSIST_PREFERENCE_KEY,
        value: settings,
      }).catch((error) => {
        context.diagnostics.warn('文本辅助个人设置暂时无法保存', error);
      });
    });
    const rebuildResourcesInBackground = () => {
      void ensureLanguageModel().catch((error) => {
        context.diagnostics.warn('纠错规则后台重建失败，将在输入时重试', error);
      });
    };
    context.events.subscribe('text.assist.resources.changed', () => {
      markResourcesDirty();
      rebuildResourcesInBackground();
    });
    context.events.subscribe<{ nodeId: string }>('content.changed', (message) => {
      if (resourceNodeIds().includes(message.payload.nodeId)) {
        markResourcesDirty();
        rebuildResourcesInBackground();
      }
    });
    context.events.subscribe<{ ids: string[] }>('nodes.deleted', (message) => {
      const deleted = new Set(Array.isArray(message.payload.ids) ? message.payload.ids : []);
      if (resourceNodeIds().some((id) => deleted.has(id))) markResourcesDirty();
    });
    context.events.subscribe('history.changed', markResourcesDirty);
    context.events.subscribe('document.replaced', () => {
      catalogVersion = undefined;
      summaries = new Map();
      markResourcesDirty();
      void ensureAndUpgradeResources(context).catch((error) => {
        context.diagnostics.warn('打开画布后无法初始化纠错规则', error);
      });
    });
    context.signals.subscribe('content.catalog.invalidated', () => {
      catalogDirty = true;
      context.signals.emit('text.assist.invalidated');
    });

    context.capabilities.provide<undefined, TextAssistSettings>({
      key: 'text.assist.settings@1',
      invoke: readSettings,
    });
    context.capabilities.provide<undefined, TextAssistResourceStatus>({
      key: 'text.assist.resources@2',
      invoke: currentResourceStatus,
    });
    context.capabilities.provide<undefined, TextAssistResourceStatus>({
      key: 'text.assist.resources@3',
      invoke: currentResourceStatus,
    });
    context.capabilities.provide<TextAssistAnalyzeRequest, TextAssistAnalysis>({
      key: 'text.assist.analyze@2',
      invoke: async (request, signal) => {
        validateRequest(request);
        const currentCatalog = await refreshCatalog(signal);
        const task = context.tasks.schedule<TextAssistAnalysis>({
          category: 'text-assist',
          label: '正在检查当前文字',
          delayMs: 110,
          noticeAfterMs: 1_200,
          priority: 18,
          timeoutMs: 15_000,
          estimatedCost: Math.max(1, Math.ceil(request.text.length / 16_384)),
          run: async (taskSignal, report) => {
            report(0.1);
            const result = analyzeTextAssistance(request, currentCatalog, taskSignal, readSettings());
            report(1);
            return result;
          },
        });
        return await waitForTask(task, signal);
      },
    });

    if (associationNotice) {
      context.ui.contribute({
        id: 'text-assist.association-notice',
        slot: 'canvas.selection',
        kind: 'view',
        label: '纠错规则文件关联状态',
        component: associationNotice,
        priority: 95,
      });
    }

    context.ui.action({
      id: 'text-assist.toggle-correction-action',
      label: '开启或关闭文本纠错',
      command: 'textAssist.toggleCorrection',
      category: '文本编辑',
      keywords: ['纠错', '错字', '拼写', '校对'],
      priority: 44,
    });
    context.ui.action({
      id: 'text-assist.toggle-completion-action',
      label: '开启或关闭文字补全',
      command: 'textAssist.toggleCompletion',
      category: '文本编辑',
      keywords: ['补全', '联想', '候选', '自动完成'],
      priority: 43,
    });
    context.ui.action({
      id: 'text-assist.open-rules-action',
      label: '打开纠错补全规则',
      command: 'textAssist.openRules',
      category: '文本编辑',
      keywords: ['纠错规则', '补全规则', '编辑规则', '系统文档'],
      priority: 41,
    });
    context.ui.action({
      id: 'text-assist.load-rules-file-action',
      label: '从 TXT 更新纠错规则',
      command: 'textAssist.loadRulesFile',
      category: '文本编辑',
      keywords: ['规则文件', 'TXT', '导入', '更新', '纠错规则'],
      priority: 40,
    });
    context.ui.shortcut({
      id: 'text-assist.toggle-correction-shortcut',
      command: 'textAssist.toggleCorrection',
      label: '开启或关闭文本纠错',
      category: '文本编辑',
      allowInEditable: true,
    });
    context.ui.shortcut({
      id: 'text-assist.toggle-completion-shortcut',
      command: 'textAssist.toggleCompletion',
      label: '开启或关闭文字补全',
      category: '文本编辑',
      allowInEditable: true,
    });
    context.ui.shortcut({
      id: 'text-assist.open-rules-shortcut',
      command: 'textAssist.openRules',
      label: '打开纠错补全规则',
      category: '文本编辑',
    });
    context.ui.shortcut({
      id: 'text-assist.load-rules-file-shortcut',
      command: 'textAssist.loadRulesFile',
      label: '从 TXT 更新纠错规则',
      category: '文本编辑',
    });

    try {
      const stored = await context.queries.ask<unknown>('system.preferences.get', {
        key: TEXT_ASSIST_PREFERENCE_KEY,
      });
      if (stored !== undefined) {
        await context.commands.dispatch('textAssist.restoreSettings', normalizeSettings(stored));
      } else {
        await context.commands.dispatch('system.preferences.set', {
          key: TEXT_ASSIST_PREFERENCE_KEY,
          value: readSettings(),
        });
      }
    } catch (error) {
      context.diagnostics.warn('文本辅助个人设置无法读取，已使用默认设置', error);
    }

    try {
      await loadDefaultRuleText();
    } catch (error) {
      context.diagnostics.warn('同目录纠错规则 TXT 暂时无法自动读取', error);
    }

    try {
      await ensureAndUpgradeResources(context);
      rebuildResourcesInBackground();
    } catch (error) {
      context.diagnostics.warn('无法初始化纠错补全规则', error);
    }
    },
  };
}

export const textAssistPlugin = createTextAssistPlugin();

async function readResourceText(
  context: Parameters<PluginDefinition['start']>[0],
  binding: TextAssistResourceBinding,
  signal?: AbortSignal,
): Promise<{ text: string; revision: number }> {
  let offset = 0;
  let expectedRevision: number | undefined;
  let totalLength: number | undefined;
  const parts: string[] = [];
  do {
    throwIfAborted(signal);
    let slice: ContentReadSlice;
    try {
      slice = await context.capabilities.request<ContentReadSlice>('content.read@1', {
        nodeId: binding.nodeId,
        start: offset,
        length: READ_CHUNK_LENGTH,
      }, signal);
    } catch (error) {
      throw new TextAssistResourceReadError(binding.role, error instanceof Error ? error.message : String(error));
    }
    if (slice.totalLength > MAX_RESOURCE_LENGTH) {
      throw new TextAssistResourceReadError(binding.role, '资源节点超过 16 MiB 安全上限');
    }
    if (expectedRevision !== undefined && slice.revision !== expectedRevision) {
      throw new TextAssistResourceReadError(binding.role, '读取期间内容发生变化，将稍后重试');
    }
    expectedRevision = slice.revision;
    totalLength = slice.totalLength;
    parts.push(slice.text);
    offset += slice.text.length;
    if (slice.text.length === 0 && offset < totalLength) {
      throw new TextAssistResourceReadError(binding.role, '资源节点读取没有继续前进');
    }
  } while (offset < (totalLength ?? 0));
  return { text: parts.join(''), revision: expectedRevision ?? 0 };
}

async function pickTextAssistRulesFile(): Promise<{
  name: string;
  text: string;
}> {
  const picker = (globalThis.window as Window & {
    showOpenFilePicker?: (options: {
      multiple?: boolean;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<Array<{ name: string; getFile(): Promise<File> }>>;
  } | undefined)?.showOpenFilePicker;
  if (picker) {
    const [handle] = await picker({
      multiple: false,
      types: [{ description: 'Echo-8 纠错补全规则', accept: { 'text/plain': ['.txt'] } }],
    });
    if (!handle) throw new Error('没有选择纠错规则文件');
    return { name: handle.name, text: await (await handle.getFile()).text() };
  }
  const file = await new Promise<File>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,text/plain';
    input.onchange = () => input.files?.[0] ? resolve(input.files[0]) : reject(new Error('没有选择纠错规则文件'));
    input.click();
  });
  return { name: file.name, text: await file.text() };
}

async function compileWithWorkerFallback(
  context: Parameters<PluginDefinition['start']>[0],
  texts: TextAssistResourceTexts,
  signal?: AbortSignal,
): Promise<TextAssistCompileResult> {
  try {
    return await context.workers.run<TextAssistCompileResult>(TEXT_ASSIST_COMPILE_JOB, texts, signal);
  } catch (error) {
    throwIfAborted(signal);
    context.diagnostics.warn('后台纠错规则编译不可用，已临时切换到兼容模式', error);
    return compileTextAssistResources(texts);
  }
}

class TextAssistResourceReadError extends Error {
  readonly role: TextAssistResourceRole;

  constructor(role: TextAssistResourceRole, message: string) {
    super(message);
    this.name = 'TextAssistResourceReadError';
    this.role = role;
  }
}

function resourceIssue(error: unknown): TextAssistResourceIssue {
  if (error instanceof TextAssistResourceReadError) return { role: error.role, line: 0, message: error.message };
  return { role: 'rules', line: 0, message: error instanceof Error ? error.message : String(error) };
}

function normalizeBindings(value: Record<string, unknown>): Partial<Record<TextAssistResourceRole, TextAssistResourceBinding>> {
  const result: Partial<Record<TextAssistResourceRole, TextAssistResourceBinding>> = {};
  for (const role of TEXT_ASSIST_RESOURCE_ROLES) {
    const binding = value[role];
    if (!isRecord(binding) || ![1, 2, 3].includes(binding.schemaVersion as number) || binding.role !== role ||
      typeof binding.nodeId !== 'string' || !Number.isFinite(binding.createdAt) || !Number.isFinite(binding.updatedAt)) continue;
    result[role] = {
      ...binding,
      schemaVersion: 3,
      defaultRuleVersion: Number.isInteger(binding.defaultRuleVersion) && (binding.defaultRuleVersion as number) >= 0
        ? binding.defaultRuleVersion as number
        : 0,
    } as TextAssistResourceBinding;
  }
  return result;
}

function normalizeSettings(value: unknown): TextAssistSettings {
  if (!isRecord(value)) return { ...DEFAULT_TEXT_ASSIST_SETTINGS };
  return {
    correctionEnabled: typeof value.correctionEnabled === 'boolean'
      ? value.correctionEnabled
      : DEFAULT_TEXT_ASSIST_SETTINGS.correctionEnabled,
    completionEnabled: typeof value.completionEnabled === 'boolean'
      ? value.completionEnabled
      : DEFAULT_TEXT_ASSIST_SETTINGS.completionEnabled,
  };
}

function isTextAssistSettings(value: unknown): value is TextAssistSettings {
  return isRecord(value) && typeof value.correctionEnabled === 'boolean' &&
    typeof value.completionEnabled === 'boolean';
}

function isEnsureResourcesPayload(value: unknown): value is TextAssistEnsureResourcesRequest | undefined {
  return value === undefined || (isRecord(value) &&
    (value.automatic === undefined || typeof value.automatic === 'boolean'));
}

function isMergeDefaultRulesPayload(value: unknown): value is MergeDefaultRulesPayload | undefined {
  return value === undefined || (isRecord(value) &&
    (value.automatic === undefined || typeof value.automatic === 'boolean'));
}

async function ensureAndUpgradeResources(
  context: Parameters<PluginDefinition['start']>[0],
): Promise<void> {
  const ensured = await context.commands.dispatch(
    'textAssist.ensureResources',
    { automatic: true },
  );
  if (ensured.created.some((item) => item.role === 'rules')) return;
  await context.commands.dispatch('textAssist.mergeDefaultRules', { automatic: true });
}

function validateRequest(request: TextAssistAnalyzeRequest): void {
  if (!request || typeof request.nodeId !== 'string' || typeof request.text !== 'string' ||
    !Number.isInteger(request.revision) || !Number.isInteger(request.windowStart) ||
    !Number.isInteger(request.cursor) || request.windowStart < 0 || request.cursor < request.windowStart ||
    request.cursor > request.windowStart + request.text.length || request.text.length > MAX_ANALYSIS_WINDOW) {
    throw new Error('文本辅助分析请求不正确');
  }
}

async function waitForTask<TResult>(task: TaskHandle<TResult>, signal?: AbortSignal): Promise<TResult> {
  const cancel = () => task.cancel();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await task.result;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

async function waitForSharedTask<TResult>(task: TaskHandle<TResult>, signal?: AbortSignal): Promise<TResult> {
  if (!signal) return task.result;
  if (signal.aborted) throw signal.reason ?? new DOMException('Task cancelled', 'AbortError');
  return await new Promise<TResult>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Task cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void task.result.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Task cancelled', 'AbortError');
}
