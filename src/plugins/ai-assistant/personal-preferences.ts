import { createId, isRecord, type PluginContext, type TaskHandle } from '../../core/contracts.ts';
import { UI_SURFACE_REVEALED_EVENT, uiSurfaceRevealed } from '../../protocols/ui.ts';
import {
  isAssistantPreferences, preferencePhrase, type AssistantPreferenceAccount, type AssistantPreferenceAction,
  type AssistantPreferenceEntry, type AssistantPreferenceSnapshot, type AssistantPreferenceState, type AssistantPreferences, type AssistantInstruction,
} from '../../protocols/assistant-preferences.ts';
import type { WorkspaceActionIndex } from '../../protocols/workspace-actions.ts';
import { assistantInstructionCatalog, preferenceActionLabel, preferenceInstruction } from '../../services/assistant-instructions.ts';
import type { CanvasControlTaskState } from '../../protocols/canvas-control.ts';
import { canvasRequestDisposition, naturalCanvasOperation } from '../../services/ai-task-route.ts';
import { isLocalDiscussion } from './local-instruction-parser.ts';
import { isAbortError } from './runtime-errors.ts';
import { AI_UI_NAMESPACE } from './assistant-workspace.ts';

export const PERSONAL_PREFERENCES_CHANGED = 'ai.personal.changed@1';
const PANEL = 'ai.personal.settings';

export const PREFERENCE_ACTION_LABELS: Record<string, string> = { group: '给选中节点编组', horizontal: '横排选中节点', vertical: '竖排选中节点' };
export const isPreferenceCandidate = (entry: AssistantPreferenceEntry) => entry.kind === 'phrase' ? entry.status === 'candidate' :
  entry.origin === 'feedback' && !entry.enabled;
const instructions: Record<AssistantPreferenceAction, string> = {
  group: '把选中的节点分组', horizontal: '把选中节点横排', vertical: '把选中节点垂直排列',
};

export interface PersonalTurn {
  instruction?: string;
  expectedSelectionCount?: number;
  reply?: string;
  update?: { account: AssistantPreferenceAccount; expectedRevision: number; preferences: AssistantPreferences };
}

export function registerPersonalPreferences(context: PluginContext, panel?: unknown) {
  let state: AssistantPreferenceState = { busy: false };
  let task: TaskHandle<AssistantPreferenceSnapshot> | undefined;
  let scopeRequest = 0;
  let stopped = false;
  let instructionCatalog: AssistantInstruction[] | undefined;
  const readInstructions = async () => {
    const index = await context.queries.ask<WorkspaceActionIndex>('workspace.actions@1');
    const instructions = assistantInstructionCatalog(index);
    if (!stopped) instructionCatalog = instructions;
    return { version: 1 as const, instructions };
  };
  let lastGap: { gap: number; count: number } | undefined;
  const observed = new Set<string>();
  const show = () => context.signals.emit(PERSONAL_PREFERENCES_CHANGED, state);
  const sameAccount = (a?: AssistantPreferenceAccount, b?: AssistantPreferenceAccount) =>
    a?.userId === b?.userId && a?.installationId === b?.installationId && a?.available === b?.available && a?.extended === b?.extended;

  function schedule(account: AssistantPreferenceAccount, write?: { expectedRevision: number; preferences: AssistantPreferences }) {
    task?.cancel();
    state = { ...state, busy: true, error: undefined };
    const current = context.tasks.schedule<AssistantPreferenceSnapshot>({
      category: 'ai-account-preferences', label: write ? '保存 AI 个人偏好' : '读取 AI 个人偏好',
      priority: 12, timeoutMs: 20_000, estimatedCost: 1,
      run: signal => context.capabilities.request<AssistantPreferenceSnapshot>(account.extended ? 'account.assistantPreferences@2' : 'account.assistantPreferences@1', { account, write }, signal),
    });
    task = current;
    show();
    void current.result.then(snapshot => {
      if (task !== current || !sameAccount(account, state.account)) return;
      state = { ...state, busy: false, snapshot };
      task = undefined;
      show();
    }, error => {
      if (task !== current || !sameAccount(account, state.account)) return;
      task = undefined;
      state = { ...state, busy: false, ...(isAbortError(error) ? {} : { error: error instanceof Error ? error.message : String(error) }) };
      show();
    });
  }

  async function refresh(force = false) {
    const request = ++scopeRequest;
    const account = await context.queries.ask<AssistantPreferenceAccount | undefined>('account.assistantPreferenceScope@1')
      .catch(() => undefined);
    if (request !== scopeRequest || stopped) return;
    if (!sameAccount(account, state.account)) {
      task?.cancel();
      task = undefined;
      state = { account, busy: false };
      lastGap = undefined;
      observed.clear();
      show();
    } else if (account?.bookId !== state.account?.bookId) {
      state = { ...state, account };
      lastGap = undefined;
      observed.clear();
      show();
    }
    if (account?.available && !state.busy && (force || !state.snapshot && !state.error)) schedule(account);
  }

  context.queries.register({ type: 'ai.personal.state@1', handle: () => state });
  context.queries.register({ type: 'ai.instructions@1', handle: readInstructions });
  context.commands.register({ type: 'ai.personal.open@1', handle: () => {
    context.ui.activateSurface('right.primary', PANEL, 'ai.personal.close@1');
    void refresh(true);
    void readInstructions().catch(error => context.diagnostics.warn('指令目录暂不可用', error));
    return { transaction: { label: '打开个人用语与偏好', history: false,
      patches: [{ op: 'set', domain: 'workspace', namespace: AI_UI_NAMESPACE, key: 'personalPreferencesOpen', value: true }],
      events: [{ type: UI_SURFACE_REVEALED_EVENT, payload: uiSurfaceRevealed('right.primary', 'ai-assistant', PANEL) }] } };
  } });
  context.commands.register({ type: 'ai.personal.close@1', handle: () => {
    context.ui.deactivateSurface('right.primary', PANEL);
    return { transaction: { label: '关闭个人用语与偏好', history: false,
      patches: [{ op: 'set', domain: 'workspace', namespace: AI_UI_NAMESPACE, key: 'personalPreferencesOpen', value: false }] } };
  } });
  context.commands.register({ type: 'ai.personal.refresh@1', handle: () => { void refresh(true); return { result: undefined }; } });
  context.commands.register({ type: 'ai.personal.update@1',
    validate: (value): value is { account: AssistantPreferenceAccount; expectedRevision: number; preferences: AssistantPreferences } =>
      isRecord(value) && isRecord(value.account) && typeof value.account.userId === 'string' &&
      typeof value.expectedRevision === 'number' && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 &&
      isAssistantPreferences(value.preferences),
    handle: value => {
      if (!state.account?.available || !sameAccount(value.account, state.account) || state.snapshot?.revision !== value.expectedRevision || state.busy) {
        throw new Error('账户设置正在更新或已有变化，请重新载入后再试');
      }
      if (!value.preferences.learning) lastGap = undefined;
      schedule(state.account, { expectedRevision: value.expectedRevision, preferences: value.preferences });
      return { result: undefined };
    },
  });
  context.commands.register({ type: 'ai.personal.export@1', validate: (value): value is { ids?: string[] } => isRecord(value) &&
    (value.ids === undefined || Array.isArray(value.ids) && value.ids.length <= 300 && value.ids.every(id => typeof id === 'string')),
    handle: ({ ids }) => {
      const current = state.snapshot?.preferences;
      if (!current) throw new Error('请先载入账户偏好');
      const selected = ids && new Set(ids);
      const entries = current.entries.filter(entry => (!selected || selected.has(entry.id)) && !isPreferenceCandidate(entry));
      return { result: { text: JSON.stringify({ ...current, entries }, null, 2) } };
    },
  });
  if (panel) context.ui.contribute({ id: PANEL, slot: 'right.primary', kind: 'view', label: '指令与偏好', component: panel,
    settings: { version: 1, label: '指令与偏好', icon: 'sparkles', order: 46, openCommand: 'ai.personal.open@1' }, priority: 80 });
  context.signals.subscribe('cloudSync.updated', () => { void refresh(); });
  context.resources.track('other', () => { stopped = true; scopeRequest++; task?.cancel(); task = undefined; });
  void refresh();

  return {
    async observeApplied(prompt: string, sessionId: string, preparationId: string, reviewId?: string): Promise<void> {
      const { account, snapshot } = state;
      const prefs = snapshot?.preferences;
      if (!account?.available || !snapshot || !prefs?.learning || state.busy || observed.has(preparationId) ||
        prefs.entries.length >= 300 || prefs.entries.some(entry => entry.kind === 'gap' && (entry.layout ?? 'horizontal') === 'horizontal' && entry.bookId === account.bookId)) return;
      const operation = naturalCanvasOperation(prompt);
      if (operation?.kind !== 'arrange' || operation.layout !== 'horizontal' || operation.gap === undefined ||
        !Number.isInteger(operation.gap) || operation.gap < 0 || operation.gap > 2_000) return;
      if (reviewId) {
        const taskState = await context.capabilities.request<CanvasControlTaskState>('canvasControl.taskState@1', { sessionId });
        if (!taskState.plans.some(plan => plan.id === reviewId && plan.status === 'applied' &&
          plan.verification?.status === 'verified' && plan.actionCount >= 2)) return;
      }
      if (stopped || state.account !== account || state.snapshot !== snapshot || state.busy || observed.has(preparationId)) return;
      observed.add(preparationId);
      if (observed.size > 40) observed.delete(observed.values().next().value!);
      const gap = operation.gap;
      lastGap = { gap, count: lastGap?.gap === gap ? lastGap.count + 1 : 1 };
      if (lastGap.count < 3) return;
      lastGap = undefined;
      const entry: AssistantPreferenceEntry = { id: createId('ai-gap'), kind: 'gap', gap, enabled: false, origin: 'feedback', bookId: account.bookId };
      await context.commands.dispatch('ai.personal.update@1', { account, expectedRevision: snapshot.revision,
        preferences: { ...prefs, entries: putPreferenceEntry(prefs.entries, entry) } });
    },
    async plan(prompt: string, _sessionId: string, previousPrompt?: string): Promise<PersonalTurn | undefined> {
      const { account, snapshot } = state;
      const prefs = snapshot?.preferences;
      const gap = /^(?:以后|今后)\s*(?:(本书|这本书)\s*)?横排(?:时)?(?:的)?默认间距(?:设为|用|为|是)?\s*(\d{1,4})(?:\s*(?:px|像素))?[。！!]?$/u.exec(prompt.trim());
      const toggle = /^(开启|启用|打开|关闭|停用)(自动学习|反馈学习|个人用语与偏好)[。！!]?$/u.exec(prompt.trim());
      const forget = /^(?:忘掉(?:个人用语|个人偏好)?|删除(?:个人用语|个人偏好))\s*[「『“"]([^」』”"\r\n]{1,80})[」』”"][。！!]?$/u.exec(prompt.trim());
      if (toggle || forget || gap) {
        if (!account?.available || !snapshot || !prefs) return { reply: '请先连接账户并载入个人用语与偏好。' };
        if (gap) {
          if (Number(gap[2]) > 2_000) return { reply: '默认间距可设为 0 到 2000。' };
          if (gap[1] && !account.bookId) return { reply: '请先打开要保存这条偏好的云端书籍。' };
          const entries = putPreferenceEntry(prefs.entries, { kind: 'gap', id: createId('ai-gap'), enabled: true, origin: 'explicit',
            gap: Number(gap[2]), bookId: gap[1] ? account.bookId : undefined });
          return { reply: '已提交保存默认间距，可在设置中心查看保存状态。', update: { account, expectedRevision: snapshot.revision, preferences: { ...prefs, entries } } };
        }
        if (toggle) {
          const key = toggle[2] === '个人用语与偏好' ? 'enabled' : 'learning';
          const next = { ...prefs, [key]: !/关闭|停用/u.test(toggle[1]!) };
          return { reply: '已提交更新，可在设置中心查看保存状态。', update: { account, expectedRevision: snapshot.revision, preferences: next } };
        }
        const matches = prefs.entries.filter(entry => entry.kind === 'phrase' &&
          (!entry.bookId || entry.bookId === account.bookId) && preferencePhrase(entry.phrase) === preferencePhrase(forget![1]!));
        const scoped = matches.some(entry => entry.bookId) ? matches.filter(entry => entry.bookId) : matches;
        if (!scoped.length) return { reply: '没有找到这条个人用语。' };
        return { reply: '已提交删除，可在设置中心查看保存状态。', update: { account, expectedRevision: snapshot.revision,
          preferences: { ...prefs, entries: prefs.entries.filter(entry => !scoped.includes(entry)) } } };
      }
      const explicit = readPreferenceFeedback(prompt);
      if (explicit) {
        if (!account?.available || !snapshot || !prefs) return explicit.longTerm ? { reply: '请先连接账户并载入个人用语与偏好。' } : undefined;
        const isCorrection = previousPrompt && preferencePhrase(previousPrompt) === preferencePhrase(explicit.phrase);
        const remembered = explicit.longTerm || prefs.learning && isCorrection;
        const entry: AssistantPreferenceEntry = { id: createId('ai-phrase'), kind: 'phrase', phrase: explicit.phrase,
          action: explicit.action, enabled: true, origin: explicit.longTerm ? 'explicit' : 'feedback', status: explicit.longTerm ? 'active' : 'candidate', evidence: 1 };
        const entries = remembered ? putPreferenceEntry(prefs.entries, entry) : undefined;
        return {
          reply: explicit.longTerm ? '已提交保存个人用语，可在设置中心查看保存状态。' :
            entries ? '已理解这次纠正，并提交为候选用语。确认后才会用于以后的请求。' : '已理解这次纠正。',
          ...(!explicit.longTerm && isCorrection && !resolvePreference(previousPrompt, prefs, account.bookId) ?
            { instruction: instructions[explicit.action] } : {}),
          ...(entries ? { update: { account, expectedRevision: snapshot.revision, preferences: { ...prefs, entries } } } : {}),
        };
      }
      if (prefs?.enabled && prefs.entries.some(entry => entry.kind === 'phrase' && preferencePhrase(entry.phrase) === preferencePhrase(prompt))) {
        await readInstructions().catch(() => { instructionCatalog = []; });
        if (stopped || state.account !== account || state.snapshot !== snapshot) return undefined;
      }
      return prefs?.enabled ? resolvePreference(prompt, prefs, account?.bookId, instructionCatalog) : undefined;
    },
  };
}

function readPreferenceFeedback(prompt: string): { phrase: string; action: AssistantPreferenceAction; longTerm: boolean } | undefined {
  const match = /^(?:我说的|(?:以后|今后)\s*(?:我说|我说的))\s*[「『“"]([^」』”"\r\n]{1,80})[」』”"]\s*(?:就是|是|表示|等于|的意思是|就)\s*(.+?)[。！!]?$/u.exec(prompt.trim());
  if (!match || !preferencePhrase(match[1]!)) return undefined;
  const action: AssistantPreferenceAction | undefined = /^(?:把|将|给)?(?:当前)?(?:选中(?:的)?节点)?(?:编组|分组|编成一组|归成一组)$/u.test(match[2]!)
    ? 'group' : /^(?:把|将)?(?:选中(?:的)?节点)?(?:横排|横向排列)$/u.test(match[2]!) ? 'horizontal'
    : /^(?:把|将)?(?:选中(?:的)?节点)?(?:竖排|垂直排列)$/u.test(match[2]!) ? 'vertical' : undefined;
  return action ? { phrase: match[1]!, action, longTerm: /^(?:以后|今后)/u.test(prompt.trim()) } : undefined;
}

export function putPreferenceEntry(entries: AssistantPreferenceEntry[], entry: AssistantPreferenceEntry): AssistantPreferenceEntry[] {
  const index = entries.findIndex(existing => existing.id === entry.id || existing.bookId === entry.bookId &&
    (existing.kind === 'gap' && entry.kind === 'gap' && (existing.layout ?? 'horizontal') === (entry.layout ?? 'horizontal') || existing.kind === 'phrase' && entry.kind === 'phrase' &&
      existing.status === entry.status && preferencePhrase(existing.phrase) === preferencePhrase(entry.phrase)));
  if (index === -1) return [...entries, entry];
  return entries.map((existing, position) => position === index ? { ...entry, id: existing.id,
    ...(existing.kind === 'phrase' && entry.kind === 'phrase' && entry.status === 'candidate' && existing.action === entry.action
      ? { evidence: Math.min(100, existing.evidence + 1) } : {}) } : existing);
}

export function resolvePreference(prompt: string, prefs: AssistantPreferences, bookId?: string, catalog?: readonly AssistantInstruction[]): PersonalTurn | undefined {
  if (!prefs.enabled || canvasRequestDisposition(prompt) === 'read-only' || isLocalDiscussion(prompt)) return undefined;
  const parsed = naturalCanvasOperation(prompt);
  const available = prefs.entries.filter(entry => entry.enabled && (!entry.bookId || entry.bookId === bookId));
  const scopedFirst = <T extends AssistantPreferenceEntry>(entries: T[]): T | undefined => entries.find(entry => entry.bookId) ?? entries[0];
  if (!parsed) {
    const phrase = scopedFirst(available.filter(entry => entry.kind === 'phrase' && entry.status === 'active' &&
      preferencePhrase(entry.phrase) === preferencePhrase(prompt)));
    if (phrase?.kind === 'phrase') {
      const defaultGap = scopedFirst(available.filter(entry => entry.kind === 'gap' && (entry.layout ?? 'horizontal') === phrase.action));
      const instruction = preferenceInstruction(phrase.action, phrase.gap ?? (defaultGap?.kind === 'gap' ? defaultGap.gap : undefined), catalog);
      return instruction ? { instruction } : { reply: `个人用语对应的「${preferenceActionLabel(phrase.action)}」当前不可用，请在指令与偏好中检查。` };
    }
  }
  if (parsed?.kind === 'arrange' && parsed.gap === undefined &&
      !parsed.exclude?.length && !/间距|间隔/u.test(prompt)) {
    const gap = scopedFirst(available.filter(entry => entry.kind === 'gap' && (entry.layout ?? 'horizontal') === parsed.layout));
    const instruction = prompt.trim().replace(/[。！!]+$/gu, '') + `，间距 ${gap?.gap}`;
    if (gap?.kind === 'gap' && naturalCanvasOperation(instruction)?.kind === 'arrange') {
      return { instruction, expectedSelectionCount: parsed.expectedCount };
    }
  }
  return undefined;
}
