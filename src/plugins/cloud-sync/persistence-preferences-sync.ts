import { isRecord, type PluginContext } from '../../core/contracts.ts';
import type { CloudSyncState } from '../../cloud/contracts.ts';
import { DEFAULT_AUTOSAVE_INTERVAL_MS } from '../../protocols/files.ts';
import { isPersistencePreferences, type PersistencePreferences } from '../../protocols/persistence-preferences.ts';

interface AccountState { scope: string; revision: number; baseline: string; dirty: boolean }
export interface RemotePersistencePreferences { revision: number; preferences: PersistencePreferences | null }
const KEY = 'account-persistence@1';
const defaults: PersistencePreferences = { schemaVersion: 1, autosaveIntervalMs: DEFAULT_AUTOSAVE_INTERVAL_MS, recoveryRetentionLimit: null };
export const preferenceFingerprint = (value: PersistencePreferences) => JSON.stringify([value.autosaveIntervalMs, value.recoveryRetentionLimit]);

export function planPersistencePreferenceSync(scope: string, local: PersistencePreferences, remote: RemotePersistencePreferences, saved?: AccountState) {
  const current = preferenceFingerprint(local), cloud = preferenceFingerprint(remote.preferences ?? defaults);
  const sameAccount = saved?.scope === scope;
  const changedHere = sameAccount && (saved.dirty || saved.baseline !== current);
  const state = { scope, revision: remote.revision, baseline: cloud, dirty: false };
  if (remote.preferences && current === cloud) return { action: 'equal' as const, state };
  if (changedHere && remote.revision !== saved.revision) return { action: 'conflict' as const, state: { ...saved, dirty: true } };
  if (changedHere || !remote.preferences && (!saved || sameAccount)) return { action: 'upload' as const, state: { ...state, baseline: current } };
  return { action: 'download' as const, state };
}

/** Owns only cloud transport; persistence remains behind public core messages. */
export function registerPersistencePreferenceSync(context: PluginContext, options: {
  state: () => CloudSyncState;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  update: (value: Partial<CloudSyncState>) => void;
}): () => void {
  let saved: AccountState | undefined;
  let loaded = false, applying = false, stopped = false;
  let cancel: (() => void) | undefined;
  const scope = () => {
    const state = options.state();
    return state.authenticated && state.user && state.activeInstallationId
      ? JSON.stringify([state.user.id, state.activeInstallationId]) : undefined;
  };
  const available = () => {
    const state = options.state();
    return state.installations.some(item => item.id === state.activeInstallationId && item.workerVersion >= 6);
  };
  const readRemote = async () => {
    const remote = await options.request<RemotePersistencePreferences>('/v2/preferences');
    if (!Number.isSafeInteger(remote.revision) || remote.revision < 0 ||
      !(remote.preferences === null || isPersistencePreferences(remote.preferences))) throw new Error('账号保存设置格式无效');
    return remote;
  };
  const writeRemote = (preferences: PersistencePreferences, expectedRevision: number) => options.request<{ revision: number }>('/v2/preferences', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision, preferences }),
  });
  const remember = async (next: AccountState) => {
    await context.commands.invoke('system.preferences.set', { key: KEY, value: next });
    saved = next;
  };
  const apply = async (preferences: PersistencePreferences) => {
    applying = true;
    try { await context.commands.invoke('system.persistence.applyPreferences@1', preferences); }
    finally { applying = false; }
  };
  context.commands.register({
    type: 'cloudSync.syncPersistencePreferences',
    handle: async () => {
      const currentScope = scope();
      if (stopped || !currentScope) return { result: { synced: false } };
      if (!available()) {
        options.update({ persistencePreferencesError: '升级个人数据服务后可同步自动保存间隔和自动保留数量。' });
        return { result: { synced: false } };
      }
      try {
        if (!loaded) { saved = await context.queries.ask<AccountState | undefined>('system.preferences.get', { key: KEY }); loaded = true; }
        const local = await context.queries.ask<PersistencePreferences>('system.persistence.preferences@1');
        const remote = await readRemote();
        if (stopped || scope() !== currentScope) return { result: { synced: false } };
        const decision = planPersistencePreferenceSync(currentScope, local, remote, saved);
        if (decision.action === 'conflict') {
          await remember(decision.state);
          options.update({ persistencePreferencesError: '另一台设备也修改了保存设置，请选择使用本机或账号设置。', persistencePreferencesConflict: true });
          return { result: { synced: false } };
        }
        if (decision.action === 'download') await apply(remote.preferences ?? defaults);
        if (decision.action === 'upload') decision.state.revision = (await writeRemote(local, remote.revision)).revision;
        await remember(decision.state);
        options.update({ persistencePreferencesSyncedAt: Date.now(), persistencePreferencesError: undefined, persistencePreferencesConflict: false });
        return { result: { synced: true } };
      } catch (error) {
        options.update({ persistencePreferencesError: error instanceof Error ? error.message : String(error),
          ...(isRecord(error) && error.status === 409 ? { persistencePreferencesConflict: true } : {}) });
        return { result: { synced: false } };
      }
    },
  });
  context.commands.register({
    type: 'cloudSync.resolvePersistencePreferences',
    validate: (payload): payload is { choice: 'local' | 'account' } => isRecord(payload) && (payload.choice === 'local' || payload.choice === 'account'),
    handle: async payload => {
      const currentScope = scope();
      if (!currentScope || !available()) throw new Error('请先连接账号并升级个人数据服务');
      const remote = await readRemote();
      const local = await context.queries.ask<PersistencePreferences>('system.persistence.preferences@1');
      const value = payload.choice === 'account' ? remote.preferences ?? defaults : local;
      if (payload.choice === 'account') await apply(value);
      const revision = payload.choice === 'local' ? (await writeRemote(value, remote.revision)).revision : remote.revision;
      await remember({ scope: currentScope, revision, baseline: preferenceFingerprint(value), dirty: false });
      options.update({ persistencePreferencesSyncedAt: Date.now(), persistencePreferencesError: undefined, persistencePreferencesConflict: false });
      return { result: { synced: true } };
    },
  });
  context.signals.subscribe('system.persistence.preferences.changed', () => {
    if (applying || stopped || !scope()) return;
    if (saved && saved.scope === scope()) saved = { ...saved, dirty: true };
    cancel?.();
    cancel = context.resources.timeout(() => {
      cancel = undefined;
      context.commands.defer('cloudSync.syncPersistencePreferences');
    }, 1_000);
  });
  return () => { stopped = true; cancel?.(); };
}
