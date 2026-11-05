import { isRecord, type MessageEnvelope, type PluginDefinition } from '../../core/contracts.ts';
import type { TransactionCommitRecord } from '../../protocols/state.ts';
import type { PersonalTextAssetRecord } from '../../protocols/personal-assets.ts';
import type {} from '../../protocols/cloud-sync.ts';
import { UI_SURFACE_REVEALED_EVENT, uiSurfaceRevealed } from '../../protocols/ui.ts';
import {
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  PROJECT_FORMAT_VERSION,
  PROJECT_KIND,
  type PersistenceSnapshot,
  type ProjectOpenPayload,
  type ProjectSource,
} from '../../protocols/files.ts';
import {
  CLOUD_STORAGE_USAGE_WORKER_VERSION,
  type CloudBootstrap,
  type CloudControlStatus,
  type CloudDataAccess,
  type CloudOperation,
  type CloudProjectDeleteConfirmation,
  type CloudProjectSummary,
  type CloudStorageUsage,
  type CloudSyncState,
} from '../../cloud/contracts.ts';
import { defineManifest } from '../manifest.ts';
import { BookTransport } from './book-transport.ts';
import { saveLegacyBook, hydrateRemoteDocument } from './legacy-transport.ts';
import type { ShortcutOverride } from '../../core/contracts.ts';
import type {} from '../../protocols/shortcut-sync.ts';
import { planShortcutSync, shortcutFingerprint, type ShortcutAccountState, type RemoteShortcuts } from './shortcut-sync.ts';
import { addPendingBookChange, type PendingBookChange } from './pending-book.ts';
import { registerPersistencePreferenceSync } from './persistence-preferences-sync.ts';
export { externalizeCloudCommit, hydrateRemoteDocument } from './legacy-transport.ts';

const LOCAL_STATE_KEY = 'cloud-session';
const QUEUE_ASSET_KEY = 'cloud-pending-commits';
const CHECKPOINT_INTERVAL_MS = 30_000;
const LEASE_RENEW_MS = 45_000;

interface LocalCloudState {
  deviceId: string;
  installationId?: string;
  projectId?: string;
  projectName?: string;
  headRevision: number;
  checkpointAt?: number;
}

interface TransactionCommittedPayload {
  record?: TransactionCommitRecord;
  documentRevision?: number;
}

export function createCloudSyncPlugin(
  statusView?: unknown,
  panelView?: unknown,
  deleteDialogView?: unknown,
): PluginDefinition {
  let state: CloudSyncState = emptyState();
  let projects: CloudProjectSummary[] = [];
  let local: LocalCloudState = { deviceId: '', headRevision: 0 };
  let pending: PendingBookChange[] = [];
  let pendingDeletion: CloudProjectDeleteConfirmation | undefined;
  let deletingProjectId: string | undefined;
  let access: CloudDataAccess | undefined;
  let leaseId: string | undefined;
  let cancelRenewalTimer: (() => void) | undefined;
  let stopped = false;
  let syncTail: Promise<void> = Promise.resolve();
  let stopRuntime = () => {};

  return {
    manifest: defineManifest('cloud-sync', 'Cloudflare 云同步', {
      category: 'provider',
      commands: [
        'cloudSync.open', 'cloudSync.close', 'cloudSync.refresh', 'cloudSync.install', 'cloudSync.upgrade', 'cloudSync.syncShortcuts', 'cloudSync.resolveShortcuts',
        'cloudSync.syncPersistencePreferences', 'cloudSync.resolvePersistencePreferences',
        'cloudSync.listProjects', 'cloudSync.openProject', 'cloudSync.createProject',
        'cloudSync.renameProject', 'cloudSync.requestDeleteProject',
        'cloudSync.cancelDeleteProject', 'cloudSync.confirmDeleteProject',
        'cloudSync.saveCurrentAsProject',
        'cloudSync.disconnectProject', 'cloudSync.syncNow',
        'cloudSync.takeover', 'cloudSync.acceptRemote', 'cloudSync.logout',
      ],
      dispatches: [
        'system.preferences.set', 'system.personalAssets.set', 'system.document.replace',
        'system.document.new', 'system.persistence.checkpoint', 'bookLibrary.show', 'shortcuts.applyAccountSettings',
        'cloudSync.syncShortcuts',
        'cloudSync.syncPersistencePreferences', 'system.persistence.applyPreferences@1',
        'system.persistence.confirmBackup',
      ],
      events: ['transaction.committed', 'document.replaced', 'shortcuts.changed'],
      queries: ['cloudSync.state', 'cloudSync.projects', 'cloudSync.deleteConfirmation'],
      asks: [
        'system.preferences.get', 'system.personalAssets.get', 'system.project.source', 'system.project.catalog', 'system.document.revision',
        'system.persistence', 'cloudSync.state', 'cloudSync.projects', 'cloudSync.deleteConfirmation', 'shortcuts.state',
        'system.persistence.preferences@1',
      ],
      signals: [
        'cloudSync.updated', 'cloudSync.deleteConfirmation.changed',
        'system.persistence.automaticSave.requested', 'system.persistence.autosaveInterval.changed',
        'system.persistence.preferences.changed',
      ],
      ui: ['cloud-sync.status', 'cloud-sync.panel', 'cloud-sync.delete-dialog'],
      actions: ['cloud-sync.open-action', 'cloud-sync.now-action'],
      shortcuts: ['cloud-sync.open-shortcut', 'cloud-sync.now-shortcut'],
      permissions: [
        'ui.top.contribute', 'ui.right.contribute', 'ui.modal.contribute',
        'ui.action.register', 'ui.shortcut.register',
        'preferences.manage', 'personal.assets.manage', 'persistence.manage', 'tasks.schedule',
        'network.origin.manage', 'network.cloud.sync',
      ],
    }),

    async start(context) {
      stopped = false;
      state = emptyState();
      projects = [];
      pending = [];
      pendingDeletion = undefined;
      deletingProjectId = undefined;
      access = undefined;
      leaseId = undefined;
      const controlOrigin = resolveControlOrigin(globalThis.document?.baseURI);
      const allowedOrigins = new Set<string>(controlOrigin ? [controlOrigin] : []);
      const configureOrigins = (url?: string) => {
        if (url) allowedOrigins.add(new URL(url).origin);
        context.network.configureOrigins([...allowedOrigins]);
      };
      configureOrigins();

      const emit = () => context.signals.emit('cloudSync.updated', state);
      const update = (value: Partial<CloudSyncState>) => {
        state = { ...state, ...value };
        emit();
      };
      const publishDeleteConfirmation = () => {
        context.signals.emit(
          'cloudSync.deleteConfirmation.changed',
          pendingDeletion ? structuredClone(pendingDeletion) : undefined,
        );
      };
      const closeDeleteConfirmation = () => {
        pendingDeletion = undefined;
        context.ui.deactivateSurface('overlay.modal', 'cloud-sync.delete-dialog');
        publishDeleteConfirmation();
      };
      const controlRequest = <T>(path: string, init: RequestInit = {}) => requestJson<T>(
        context.network.sync,
        resolveControlUrl(path, controlOrigin),
        init,
      );
      const getAccess = async (force = false): Promise<CloudDataAccess> => {
        if (!local.installationId) throw new Error('尚未选择云存储安装');
        if (!force && access && access.expiresAt > Date.now() + 60_000) return access;
        const installation=state.installations.find(item=>item.id===local.installationId);
        if(installation?.upgradeAvailable&&installation.latestWorkerVersion>=5&&installation.workerVersion<5){
          try {
            const upgraded=await controlRequest<{installation:import('../../cloud/contracts.ts').CloudInstallationSummary}>('/api/cloud/upgrade',jsonInit({installationId:installation.id}));
            update({installations:state.installations.map(item=>item.id===installation.id?upgraded.installation:item),upgradeAvailable:false});
          } catch(error) { context.diagnostics.warn('云存储升级暂未完成，原数据仍保留',error); }
        }
        access = await controlRequest<CloudDataAccess>('/api/cloud/token', jsonInit({
          installationId: local.installationId,
        }));
        configureOrigins(access.workerUrl);
        return access;
      };
      const dataRequest = async <T>(path: string, init: RequestInit = {}, retry = true): Promise<T> => {
        const current = await getAccess();
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${current.token}`);
        try {
          return await requestJson<T>(context.network.sync, new URL(path, current.workerUrl).toString(), {
            ...init,
            headers,
          });
        } catch (error) {
          if (retry && isHttpStatus(error, 401)) {
            access = undefined;
            return dataRequest<T>(path, init, false);
          }
          throw error;
        }
      };
      const refreshStorageUsage = async () => {
        const installation = state.installations.find(
          (item) => item.id === local.installationId && item.status === 'ready',
        ) ?? state.installations.find((item) => item.status === 'ready');
        if (!installation) {
          update({ storageUsage: undefined, storageUsageError: undefined });
          return;
        }
        if (installation.workerVersion < CLOUD_STORAGE_USAGE_WORKER_VERSION) {
          update({
            storageUsage: undefined,
            storageUsageError: '升级个人数据服务后可显示容量',
          });
          return;
        }
        try {
          if(state.storageUsage&&Date.now()-state.storageUsage.measuredAt<60_000)return;
          const result = await dataRequest<{ storage: CloudStorageUsage; maintenance?:CloudSyncState['maintenance'] }>('/v1/storage', { method: 'GET' });
          update({ storageUsage: result.storage, storageUsageError: undefined, maintenance:result.maintenance });
        } catch (error) {
          context.diagnostics.warn('个人云存储容量读取失败', error);
          update({ storageUsage: undefined, storageUsageError: '容量暂不可用' });
        }
      };

      const persistLocal = async (parent?: MessageEnvelope) => {
        const call = parent ? context.commands.invoke : context.commands.dispatch;
        await call('system.preferences.set', { key: LOCAL_STATE_KEY, value: local });
        const asset: PersonalTextAssetRecord = {
          schemaVersion: 1,
          text: JSON.stringify(hasBookStorage() ? {formatVersion:2,dirty:pending.length>0,projectId:local.projectId,
            documentRevision:(await context.queries.ask<{revision:number}>('system.document.revision')).revision} : pending),
          fileName: 'cloud-pending-commits.json',
          updatedAt: Date.now(),
        };
        await call('system.personalAssets.set', { key: QUEUE_ASSET_KEY, asset });
      };

      const books = new BookTransport(dataRequest);
      let syncQueued = false;
      let retryAt = 0;
      let failures = 0;
      let cancelRetry: (() => void) | undefined;
      let activeInvocation: MessageEnvelope | undefined;
      let recoveryAvailable = true;
      let accountSettings: ShortcutAccountState | undefined;
      let applyingShortcuts = false;
      let cancelShortcutSync: (() => void) | undefined;
      let shortcutSyncing = false;
      const stopPreferenceSync = registerPersistencePreferenceSync(context, { state: () => state, request: dataRequest, update });
      stopRuntime=()=>{cancelRetry?.();cancelShortcutSync?.();stopPreferenceSync();books.clear();};
      const hasBookStorage = () => state.installations.some(item => item.id === local.installationId && item.workerVersion >= 5);
      context.commands.register({
        type:'cloudSync.resolveShortcuts',
        validate:(payload):payload is {choice:'local'|'account'}=>isRecord(payload)&&(payload.choice==='local'||payload.choice==='account'),
        handle:async payload=>{
          if(!state.user||!hasBookStorage())throw new Error('请先连接账号');
          const remote=await dataRequest<RemoteShortcuts>('/v2/shortcuts');
          if(payload.choice==='account'){
            applyingShortcuts=true;
            try{await context.commands.invoke('shortcuts.applyAccountSettings',{overrides:remote.overrides});}
            finally{applyingShortcuts=false;}
            accountSettings={userId:state.user.id,revision:remote.revision,baseline:JSON.stringify([]),dirty:false};
          }else{
            const current=await context.queries.ask<{overrides:ShortcutOverride[]}>('shortcuts.state');
            const saved=await dataRequest<{revision:number}>('/v2/shortcuts',jsonInit({expectedRevision:remote.revision,overrides:current.overrides},'PUT'));
            accountSettings={userId:state.user.id,revision:saved.revision,baseline:shortcutFingerprint(current.overrides),dirty:false};
          }
          if(payload.choice==='account')accountSettings!.baseline=shortcutFingerprint(remote.overrides);
          await context.commands.invoke('system.preferences.set',{key:'account-shortcuts@1',value:accountSettings});
          update({shortcutsSyncedAt:Date.now(),shortcutsError:undefined});
          return {result:{synced:true}};
        },
      });
      context.commands.register({
        type:'cloudSync.syncShortcuts',
        handle:async()=>{
          if(shortcutSyncing||!state.user||!hasBookStorage())return {result:{synced:false}};
          shortcutSyncing=true;
          try{
            const localSettings=await context.queries.ask<{overrides:ShortcutOverride[]}>('shortcuts.state');
            accountSettings??=await context.queries.ask<ShortcutAccountState|undefined>('system.preferences.get',{key:'account-shortcuts@1'});
            const remote=await dataRequest<RemoteShortcuts>('/v2/shortcuts');
            const decision=planShortcutSync(state.user.id,localSettings.overrides,remote,accountSettings);
            if(decision.action==='conflict'){
              update({shortcutsError:'另一台设备也修改了快捷键，本机配置已保留。请选择使用本机或账号快捷键。'});
              accountSettings=decision.state;
              await context.commands.invoke('system.preferences.set',{key:'account-shortcuts@1',value:accountSettings});
              return {result:{synced:false}};
            }
            if(decision.action==='download'){
              applyingShortcuts=true;
              try{await context.commands.invoke('shortcuts.applyAccountSettings',{overrides:remote.overrides});}
              finally{applyingShortcuts=false;}
            }else if(decision.action==='upload'){
              const result=await dataRequest<{revision:number}>('/v2/shortcuts',jsonInit({expectedRevision:remote.revision,overrides:localSettings.overrides},'PUT'));
              decision.state.revision=result.revision;
            }
            accountSettings={...decision.state,dirty:false};
            await context.commands.invoke('system.preferences.set',{key:'account-shortcuts@1',value:accountSettings});
            update({shortcutsSyncedAt:Date.now(),shortcutsError:undefined});
            return {result:{synced:true}};
          }catch(error){update({shortcutsError:errorMessage(error)});return {result:{synced:false}};}
          finally{shortcutSyncing=false;}
        },
      });
      context.events.subscribe('shortcuts.changed',()=>{
        if(applyingShortcuts||!state.user||!hasBookStorage())return;
        if(accountSettings)accountSettings={...accountSettings,dirty:true};
        cancelShortcutSync?.();cancelShortcutSync=context.resources.timeout(()=>{
          cancelShortcutSync=undefined;context.commands.dispatch('cloudSync.syncShortcuts').catch(()=>undefined);
        },1_000);
      });
      const runSync = async (forceCheckpoint = false, parent?: MessageEnvelope, includePending = true) => {
        if (!local.projectId || !leaseId || !['ready','syncing','offline'].includes(state.phase) || deletingProjectId === local.projectId) return;
        if (!forceCheckpoint && Date.now() < retryAt) return;
        if (!includePending || (!pending.length && !forceCheckpoint)) {
          try {
            const response = await dataRequest<{lease:{id:string;expiresAt:number}}>('/v1/projects/'+encodeURIComponent(local.projectId)+'/lease',jsonInit({deviceId:local.deviceId}));
            leaseId=response.lease.id;update({leaseExpiresAt:response.lease.expiresAt});
          } catch (error) { if(isHttpStatus(error,409)||isHttpStatus(error,423)){leaseId=undefined;update({phase:'read-only',error:'编辑权已转移，本地修改仍保留'});} }
          return;
        }
        const projectId=local.projectId, currentLease=leaseId;
        const captured=[...pending];
        update({phase:'syncing',error:undefined,retryAt:undefined});
        try {
          let accepted:number;
          let acknowledgedIds:string[]|undefined;
          let savedRevision:number|undefined;
          if(hasBookStorage()) {
            const result=await books.save({projectId,baseRevision:local.headRevision,deviceId:local.deviceId,leaseId:currentLease,commits:captured,
              source:()=>context.queries.ask<ProjectSource>('system.project.source'),catalog:()=>context.queries.ask<ProjectSource['plugins']>('system.project.catalog')});
            if(stopped||local.projectId!==projectId)return;
            accepted=captured.length;local.headRevision=result.revision;local.checkpointAt=Date.now();
            acknowledgedIds=result.acceptedIds;
            savedRevision=result.documentRevision;
            update({lastUploadBytes:result.uploadedBytes,storageUsage:result.storage??state.storageUsage});
          } else {
            const result=await saveLegacyBook({request:dataRequest,source:()=>context.queries.ask<ProjectSource>('system.project.source'),projectId,deviceId:local.deviceId,leaseId:currentLease,baseRevision:local.headRevision,commits:captured,
              forceCheckpoint:forceCheckpoint||!local.checkpointAt||Date.now()-local.checkpointAt>=CHECKPOINT_INTERVAL_MS});
            if(stopped||local.projectId!==projectId)return;
            accepted=result.accepted;local.headRevision=result.headRevision;if(result.captured)local.checkpointAt=Date.now();
            update({leaseExpiresAt:result.lease.expiresAt,storageUsage:result.storage??state.storageUsage});
          }
          const acknowledged=new Set(acknowledgedIds??captured.slice(0,accepted).map(item=>item.id));
          pending=pending.filter(item=>!acknowledged.has(item.id));
          failures=0;retryAt=0;cancelRetry?.();cancelRetry=undefined;
          update({phase:'ready',headRevision:local.headRevision,pendingCommits:pending.length,lastSyncedAt:Date.now(),error:undefined,errorKind:undefined,retryAt:undefined});
          // A foreground save may join a background save. Use the active formal
          // invocation for preference writes instead of queueing behind itself.
          const invocation=activeInvocation??parent;
          if(invocation)await persistLocal(invocation);
          else void persistLocal().catch(error=>context.diagnostics.warn('云保存状态待重新同步',error));
          if(savedRevision!==undefined){
            const call=invocation?context.commands.invoke:context.commands.dispatch;
            if(invocation)await call('system.persistence.confirmBackup',{documentRevision:savedRevision}).catch(()=>undefined);
            else void call('system.persistence.confirmBackup',{documentRevision:savedRevision}).catch(()=>undefined);
          }
        } catch(error) {
          if(stopped||local.projectId!==projectId)return;
          const status=error instanceof CloudHttpError?error.status:0;
          const kind=status===409?'conflict':status===423?'lease':status===401||status===403?'authorization':status===426?'upgrade':status===507?'capacity':status===429?'rate-limit':status>=500?'service':'network';
          if(kind==='conflict')update({phase:'conflict',error:'云端版本已变化，本机修改仍保留在恢复副本中',errorKind:kind});
          else if(kind==='lease'){leaseId=undefined;update({phase:'read-only',error:'编辑权已经转移，本地修改仍保留',errorKind:kind});}
          else {
            failures++;const delay=kind==='capacity'||kind==='authorization'||kind==='upgrade'?5*60_000:Math.min(5*60_000,Math.max(2_000,2**Math.min(failures,8)*1_000));
            retryAt=Date.now()+Math.max(delay,error instanceof CloudHttpError?error.retryAfterMs:0);
            update({phase:'offline',pendingCommits:pending.length,error:errorMessage(error),errorKind:kind,retryAt});
            cancelRetry?.();cancelRetry=context.resources.timeout(()=>{cancelRetry=undefined;if(!stopped&&pending.length)void enqueueSync(false);},retryAt-Date.now());
          }
        }
      };
      const enqueueSync = (
        forceCheckpoint = false,
        parent?: MessageEnvelope,
        includePending = true,
      ) => {
        if(syncQueued)return syncTail;
        syncQueued=true;
        syncTail=syncTail.catch(()=>undefined).then(async()=>{
          try { await runSync(forceCheckpoint,parent,includePending); } finally { syncQueued=false; }
        });
        return syncTail;
      };
      const disconnectProject = async (parent?: MessageEnvelope) => {
        const projectId = local.projectId;
        const currentLeaseId = leaseId;
        if (projectId && currentLeaseId) {
          activeInvocation=parent;
          try { await enqueueSync(true, parent); if(pending.length&&state.phase==='ready')await enqueueSync(true,parent); }
          finally { activeInvocation=undefined; }
          if (pending.length > 0 || !['ready', 'read-only'].includes(state.phase)) {
            throw new Error(state.error || '当前书籍尚未安全同步，请稍后重试');
          }
          try {
            await dataRequest(`/v1/projects/${encodeURIComponent(projectId)}/lease`, {
              ...jsonInit({ deviceId: local.deviceId, leaseId: currentLeaseId }),
              method: 'DELETE',
            });
          } catch (error) {
            context.diagnostics.warn('云书籍编辑权释放失败，将等待租约自动到期', error);
          }
        }
        leaseId = undefined;
        books.clear();
        local = {
          ...local,
          projectId: undefined,
          projectName: undefined,
          headRevision: 0,
          checkpointAt: undefined,
        };
        const ready = state.installations.some((item) => item.status === 'ready');
        update({
          phase: !state.authenticated ? 'signed-out' : ready ? 'ready' : 'needs-installation',
          activeProjectId: undefined,
          activeProjectName: undefined,
          headRevision: 0,
          pendingCommits: pending.length,
          leaseExpiresAt: undefined,
          otherDeviceId: undefined,
          error: undefined,
        });
        await persistLocal(parent);
      };

      const loadRemote = async (bootstrap: CloudBootstrap) => {
        if (!bootstrap.checkpoint && bootstrap.operations.length === 0) return;
        const document = hydrateRemoteDocument(bootstrap);
        const payload: ProjectOpenPayload = {
          manifest: {
            type: 'manifest',
            kind: PROJECT_KIND,
            formatVersion: PROJECT_FORMAT_VERSION,
            coreVersion: '0.1.0',
            savedAt: Date.now(),
            documentRevision: document.revision,
            historyMode: 'none',
            plugins: bootstrap.checkpoint?.plugins ?? [],
          },
          document,
          history: { undo: [], redo: [] },
          origin: 'cloud',
        };
        await context.commands.invoke('system.document.replace', payload);
      };

      const openProject = async (
        projectId: string | undefined,
        takeover: boolean,
        discardLocal: boolean,
        parent: MessageEnvelope,
      ) => {
        await getAccess();
        context.commands.defer('cloudSync.syncShortcuts');
        const listed = await dataRequest<{ projects: CloudProjectSummary[] }>('/v1/projects');
        projects = listed.projects;
        let project = projectId ? projects.find((item) => item.id === projectId) : undefined;
        if (!project) project = projects.find((item) => item.id === local.projectId) ?? projects[0];
        if (!project) {
          const created = await dataRequest<{ project: CloudProjectSummary }>('/v1/projects', jsonInit({ name: '我的画布' }));
          project = created.project;
          projects = [project];
        }
        const previousProjectId = local.projectId;
        if (previousProjectId && previousProjectId !== project.id) await disconnectProject(parent);
        update({ phase: 'connecting', error: undefined });
        local = { ...local, projectId: project.id, projectName: project.name };
        let leaseOwned = false;
        try {
          const leaseResult = await dataRequest<{ lease: { id: string; expiresAt: number } }>(
            `/v1/projects/${encodeURIComponent(project.id)}/lease`,
            jsonInit({ deviceId: local.deviceId, takeover }),
          );
          leaseId = leaseResult.lease.id;
          leaseOwned = true;
          update({ leaseExpiresAt: leaseResult.lease.expiresAt, otherDeviceId: undefined });
        } catch (error) {
          if (!isHttpStatus(error, 409)) throw error;
          const detail = errorDetail(error) as { lease?: { deviceId?: string; expiresAt?: number } } | undefined;
          leaseId = undefined;
          update({
            phase: 'read-only',
            otherDeviceId: detail?.lease?.deviceId,
            leaseExpiresAt: detail?.lease?.expiresAt,
            error: '另一台设备正在编辑；你可以只读查看或明确接管',
          });
        }
        const bootstrap = (hasBookStorage() ? await books.bootstrap(project.id) : undefined) ?? await completeBootstrap(
          await dataRequest<CloudBootstrap>(`/v1/projects/${encodeURIComponent(project.id)}/bootstrap`), dataRequest,
        );
        const sameUnsyncedLocal = previousProjectId === project.id && pending.length > 0;
        if(sameUnsyncedLocal&&!recoveryAvailable){
          update({phase:'conflict',activeProjectId:project.id,activeProjectName:project.name,error:'本机有未上传草稿，请先从本地恢复副本恢复；云端书籍未被覆盖'});
          return;
        }
        if (sameUnsyncedLocal && bootstrap.project.headRevision === local.headRevision && leaseOwned) {
          update({
            phase: 'ready', activeProjectId: project.id, activeProjectName: project.name,
            headRevision: local.headRevision, pendingCommits: pending.length,
          });
          await persistLocal(parent);
          await enqueueSync(true, parent);
          return;
        }
        if (sameUnsyncedLocal && !discardLocal) {
          update({
            phase: 'conflict', activeProjectId: project.id, activeProjectName: project.name,
            headRevision: bootstrap.project.headRevision,
            error: '本机有未上传修改，而云端版本已经变化。修改仍安全保留，请选择保留恢复点后载入云端。',
          });
          return;
        }
        if (sameUnsyncedLocal && discardLocal) {
          await context.commands.invoke('system.persistence.checkpoint', { label: '云冲突：载入云端前的本机副本' });
          pending = [];
        }
        await loadRemote(bootstrap);
        local.headRevision = bootstrap.project.headRevision;
        local.checkpointAt = Date.now();
        update({
          phase: leaseOwned ? 'ready' : 'read-only',
          activeInstallationId: local.installationId,
          activeProjectId: project.id,
          activeProjectName: project.name,
          headRevision: local.headRevision,
          pendingCommits: pending.length,
          lastSyncedAt: Date.now(),
        });
        await persistLocal(parent);
        if (leaseOwned && !bootstrap.checkpoint && bootstrap.operations.length === 0) await enqueueSync(true, parent);
      };

      context.queries.register({ type: 'cloudSync.state', handle: () => structuredClone(state) });
      context.queries.register({ type: 'cloudSync.projects', handle: () => structuredClone(projects) });
      context.queries.register({
        type: 'cloudSync.deleteConfirmation',
        handle: () => pendingDeletion ? structuredClone(pendingDeletion) : undefined,
      });
      context.commands.register({
        type: 'cloudSync.open',
        handle: () => {
          context.ui.activateSurface('right.primary', 'cloud-sync.panel', 'cloudSync.close');
          update({ panelOpen: true });
          return {
            result: { open: true },
            transaction: {
              label: '打开云同步面板',
              history: false,
              patches: [],
              events: [{
                type: UI_SURFACE_REVEALED_EVENT,
                payload: uiSurfaceRevealed('right.primary', 'cloud-sync', 'cloud-sync.panel'),
              }],
            },
          };
        },
      });
      context.commands.register({
        type: 'cloudSync.close',
        handle: () => {
          context.ui.deactivateSurface('right.primary', 'cloud-sync.panel');
          update({ panelOpen: false });
          return { result: { open: false } };
        },
      });
      context.commands.register({
        type: 'cloudSync.refresh',
        handle: async () => {
          await refreshControlStatus(controlRequest, update);
          return { result: structuredClone(state) };
        },
      });
      context.commands.register({
        type: 'cloudSync.listProjects',
        handle: async (_payload, envelope) => {
          await refreshControlStatus(controlRequest, update);
          const installation = state.installations.find(
            (item) => item.id === local.installationId && item.status === 'ready',
          ) ?? state.installations.find((item) => item.status === 'ready');
          if (!installation) {
            projects = [];
            emit();
            return { result: [] };
          }
          local.installationId = installation.id;
          access = undefined;
          const listed = await dataRequest<{ projects: CloudProjectSummary[] }>('/v1/projects');
          projects = listed.projects;
          update({ activeInstallationId: installation.id, error: undefined });
          context.commands.defer('cloudSync.syncShortcuts');
          context.commands.defer('cloudSync.syncPersistencePreferences');
          await refreshStorageUsage();
          await persistLocal(envelope);
          return { result: structuredClone(projects) };
        },
      });
      context.commands.register<{ accountId: string }>({
        type: 'cloudSync.install',
        validate: (payload): payload is { accountId: string } => isRecord(payload) && typeof payload.accountId === 'string',
        handle: async (payload, envelope) => {
          update({ phase: 'connecting', error: undefined });
          try {
            const result = await controlRequest<{ installation: CloudControlStatus['installations'][number] }>(
              '/api/cloud/install', jsonInit(payload),
            );
            local.installationId = result.installation.id;
            access = undefined;
            await refreshControlStatus(controlRequest, update);
            await persistLocal(envelope);
            context.commands.defer('cloudSync.listProjects');
            return { result };
          } catch (error) {
            update({ phase: 'error', error: errorMessage(error) });
            throw error;
          }
        },
      });
      context.commands.register<{ installationId: string }>({
        type: 'cloudSync.upgrade',
        validate: (payload): payload is { installationId: string } =>
          isRecord(payload) && typeof payload.installationId === 'string',
        handle: async (payload) => {
          update({ phase: 'connecting', error: undefined });
          try {
            const result = await controlRequest<{ installation: CloudControlStatus['installations'][number] }>(
              '/api/cloud/upgrade', jsonInit(payload),
            );
            access = undefined;
            await refreshControlStatus(controlRequest, update);
            context.commands.defer('cloudSync.listProjects');
            return { result };
          } catch (error) {
            update({ phase: 'error', error: errorMessage(error) });
            throw error;
          }
        },
      });
      context.commands.register<{ projectId?: string; takeover?: boolean; discardLocal?: boolean }>({
        type: 'cloudSync.openProject',
        validate: (payload): payload is { projectId?: string; takeover?: boolean; discardLocal?: boolean } =>
          payload === undefined || isRecord(payload),
        handle: async (payload = {}, envelope) => {
          try {
            const installation = state.installations.find((item) => item.id === local.installationId && item.status === 'ready') ??
              state.installations.find((item) => item.status === 'ready');
            if (!installation) throw new Error('请先在自己的 Cloudflare 账户中安装数据服务');
            local.installationId = installation.id;
            await openProject(payload.projectId, payload.takeover === true, payload.discardLocal === true, envelope);
            return { result: structuredClone(state) };
          } catch (error) {
            if (state.phase !== 'conflict' && state.phase !== 'read-only') update({ phase: 'error', error: errorMessage(error) });
            throw error;
          }
        },
      });
      context.commands.register<{ name: string }>({
        type: 'cloudSync.createProject',
        validate: (payload): payload is { name: string } => isRecord(payload) && typeof payload.name === 'string',
        handle: async (payload, envelope) => {
          const created = await dataRequest<{ project: CloudProjectSummary }>('/v1/projects', jsonInit({ name: payload.name }));
          projects = [created.project, ...projects];
          await disconnectProject(envelope);
          await context.commands.invoke('system.document.new');
          await openProject(created.project.id, false, false, envelope);
          return { result: created.project };
        },
      });
      context.commands.register<{ projectId: string; name: string }>({
        type: 'cloudSync.renameProject',
        validate: (payload): payload is { projectId: string; name: string } =>
          isRecord(payload) && typeof payload.projectId === 'string' && typeof payload.name === 'string',
        handle: async (payload, envelope) => {
          const name = payload.name.trim().slice(0, 120);
          if (!name) throw new Error('书籍名称不能为空');
          const renamed = await dataRequest<{ project: CloudProjectSummary }>(
            `/v1/projects/${encodeURIComponent(payload.projectId)}`,
            jsonInit({ name }, 'PATCH'),
          );
          projects = projects.map((project) => project.id === renamed.project.id ? renamed.project : project);
          if (local.projectId === renamed.project.id) {
            local = { ...local, projectName: renamed.project.name };
            update({ activeProjectName: renamed.project.name, error: undefined });
            await persistLocal(envelope);
          } else {
            emit();
          }
          return { result: renamed.project };
        },
      });
      context.commands.register<{ projectId: string }>({
        type: 'cloudSync.requestDeleteProject',
        validate: isProjectIdPayload,
        handle: (payload) => {
          const project = projects.find((item) => item.id === payload.projectId);
          if (!project) throw new Error('书籍已经不存在，请刷新书库');
          pendingDeletion = {
            projectId: project.id,
            name: project.name,
            active: local.projectId === project.id,
          };
          context.ui.activateSurface(
            'overlay.modal',
            'cloud-sync.delete-dialog',
            'cloudSync.cancelDeleteProject',
          );
          publishDeleteConfirmation();
          return { result: { open: true } };
        },
      });
      context.commands.register({
        type: 'cloudSync.cancelDeleteProject',
        handle: () => {
          if (!pendingDeletion) return { result: { cancelled: false } };
          closeDeleteConfirmation();
          return { result: { cancelled: true } };
        },
      });
      context.commands.register<{ projectId: string }>({
        type: 'cloudSync.confirmDeleteProject',
        validate: isProjectIdPayload,
        handle: async (payload, envelope) => {
          if (!pendingDeletion || pendingDeletion.projectId !== payload.projectId) {
            throw new Error('删除确认已经失效，请重新选择书籍');
          }
          const target = pendingDeletion;
          const detachedCurrent = local.projectId === target.projectId;
          deletingProjectId = target.projectId;
          try {
            await syncTail;
            if (detachedCurrent) {
              await context.commands.invoke('system.persistence.checkpoint', {
                label: `删除云端书籍前：${target.name}`,
              });
            }
            try {
              const result = await dataRequest<{ deleted: boolean }>(
                `/v1/projects/${encodeURIComponent(target.projectId)}`,
                jsonInit({}, 'DELETE'),
              );
              if (result.deleted !== true) throw new Error('云端未确认删除结果');
            } catch (error) {
              if (!isHttpStatus(error, 404)) throw error;
            }

            projects = projects.filter((project) => project.id !== target.projectId);
            if (detachedCurrent) {
              pending = [];
              leaseId = undefined;
              local = {
                ...local,
                projectId: undefined,
                projectName: undefined,
                headRevision: 0,
                checkpointAt: undefined,
              };
              const ready = state.installations.some((item) => item.status === 'ready');
              update({
                phase: !state.authenticated ? 'signed-out' : ready ? 'ready' : 'needs-installation',
                activeProjectId: undefined,
                activeProjectName: undefined,
                headRevision: 0,
                pendingCommits: 0,
                lastSyncedAt: undefined,
                leaseExpiresAt: undefined,
                otherDeviceId: undefined,
                error: undefined,
              });
              try {
                await persistLocal(envelope);
              } catch (error) {
                context.diagnostics.error('云端书籍已删除，但本机绑定状态保存失败', error);
                update({ error: '书籍已从云端删除，但本机状态未能持久化' });
              }
            } else {
              emit();
            }
            closeDeleteConfirmation();
            return { result: { deleted: true, detachedCurrent } };
          } finally {
            deletingProjectId = undefined;
          }
        },
      });
      context.commands.register<{ name?: string } | undefined>({
        type: 'cloudSync.saveCurrentAsProject',
        validate: (payload): payload is { name?: string } | undefined =>
          payload === undefined || (isRecord(payload) && (payload.name === undefined || typeof payload.name === 'string')),
        handle: async (payload, envelope) => {
          if (state.activeProjectId || local.projectId) throw new Error('当前书籍已经连接云端');
          const created = await dataRequest<{ project: CloudProjectSummary }>('/v1/projects', jsonInit({
            name: payload?.name?.trim() || defaultCloudProjectName(),
          }));
          projects = [created.project, ...projects];
          await openProject(created.project.id, false, false, envelope);
          return { result: created.project };
        },
      });
      context.commands.register({
        type: 'cloudSync.disconnectProject',
        handle: async (_payload, envelope) => {
          await disconnectProject(envelope);
          return { result: structuredClone(state) };
        },
      });
      context.commands.register({
        type: 'cloudSync.syncNow',
        handle: async (_payload, envelope) => {
          activeInvocation=envelope;
          try { await enqueueSync(true, envelope); if(pending.length&&state.phase==='ready')await enqueueSync(true,envelope); } finally { activeInvocation=undefined; }
          return { result: structuredClone(state) };
        },
      });
      context.commands.register({
        type: 'cloudSync.takeover',
        handle: async (_payload, envelope) => {
          await openProject(local.projectId, true, false, envelope);
          return { result: structuredClone(state) };
        },
      });
      context.commands.register({
        type: 'cloudSync.acceptRemote',
        handle: async (_payload, envelope) => {
          await openProject(local.projectId, false, true, envelope);
          return { result: structuredClone(state) };
        },
      });
      context.commands.register({
        type: 'cloudSync.logout',
        handle: async (_payload, envelope) => {
          await controlRequest('/api/cloud/logout', jsonInit({}));
          access = undefined;
          leaseId = undefined;
          projects = [];
          local = { ...local, projectId: undefined, projectName: undefined, headRevision: 0, checkpointAt: undefined };
          update({
            ...emptyState(),
            configured: state.configured,
            autosaveIntervalMs: state.autosaveIntervalMs,
          });
          await persistLocal(envelope);
          return { result: { loggedOut: true } };
        },
      });

      context.events.subscribe<TransactionCommittedPayload>('transaction.committed', (envelope) => {
        const record = envelope.payload.record;
        if (!record || !record.forward.some((patch) => patch.domain === 'document')) return;
        if (!local.projectId || !leaseId || state.phase === 'read-only' || state.phase === 'conflict') return;
        if (!pending.some((item) => item.id === record.id)) {
          if(hasBookStorage())pending=addPendingBookChange(pending,record,envelope.payload.documentRevision);
          else pending.push(structuredClone(record));
        }
        update({
          pendingCommits: pending.length,
          phase: state.phase === 'offline' ? 'offline' : state.phase === 'syncing' ? 'syncing' : 'ready',
        });
        context.resources.timeout(
          () => void persistLocal().catch((error) => context.diagnostics.error('云同步队列保存失败', error)),
          0,
        );
      });
      context.events.subscribe<{origin?:string}>('document.replaced',message=>{
        if(message.payload.origin==='cloud'||!local.projectId||!leaseId)return;
        books.clear();recoveryAvailable=true;
        pending=[{id:`restored-${crypto.randomUUID()}`,label:'恢复本机书籍',timestamp:Date.now(),forward:[],inverse:[],sourceMessageId:'local-recovery',historyAction:'none'}];
        update({pendingCommits:pending.length});
        void persistLocal().catch(error=>context.diagnostics.warn('恢复后的云保存标记暂未写入',error));
      });
      context.signals.subscribe<{ documentRevision: number }>(
        'system.persistence.automaticSave.requested',
        () => {
          if (pending.length > 0) void enqueueSync(false);
        },
      );
      context.signals.subscribe<{ intervalMs: number }>(
        'system.persistence.autosaveInterval.changed',
        (message) => update({ autosaveIntervalMs: message.payload.intervalMs }),
      );

      context.ui.contribute({
        id: 'cloud-sync.status', slot: 'top.primary', kind: 'view', label: 'Cloudflare 云同步',
        group: 'file', component: statusView, priority: 0,
      });
      context.ui.contribute({
        id: 'cloud-sync.panel', slot: 'right.primary', kind: 'view', label: 'Cloudflare 云同步',
        component: panelView,
      });
      context.ui.contribute({
        id: 'cloud-sync.delete-dialog', slot: 'overlay.modal', kind: 'view', label: '确认删除云端书籍',
        component: deleteDialogView,
      });
      context.ui.action({
        id: 'cloud-sync.open-action', label: '打开 Cloudflare 云同步', command: 'cloudSync.open',
        category: '云同步', keywords: ['cloudflare', '跨设备', '账户'], priority: 95,
      });
      context.ui.action({
        id: 'cloud-sync.now-action', label: '立即保存当前云端书籍', command: 'cloudSync.syncNow',
        category: '云同步', keywords: ['保存', '上传', '同步'], priority: 94,
      });
      context.ui.shortcut({
        id: 'cloud-sync.open-shortcut', chord: 'mod+alt+s', command: 'cloudSync.open', label: '打开云同步',
      });
      context.ui.shortcut({
        id: 'cloud-sync.now-shortcut', command: 'cloudSync.syncNow', label: '立即保存当前云端书籍', category: '云同步',
      });

      const saved = await context.queries.ask<LocalCloudState | undefined>('system.preferences.get', { key: LOCAL_STATE_KEY });
      local = normalizeLocalState(saved);
      const queueAsset = await context.queries.ask<PersonalTextAssetRecord | undefined>(
        'system.personalAssets.get', { key: QUEUE_ASSET_KEY },
      );
      pending = parsePendingQueue(queueAsset?.text);
      if(queueAsset?.text&&pending.length){
        try {
          const marker=JSON.parse(queueAsset.text) as {formatVersion?:number;projectId?:string;documentRevision?:number};
          if(marker.formatVersion===2){
            const current=await context.queries.ask<{revision:number}>('system.document.revision');
            recoveryAvailable=marker.projectId===local.projectId&&current.revision>=(marker.documentRevision??0);
          }
        } catch { recoveryAvailable=false; }
      }
      const persistence = await context.queries.ask<PersistenceSnapshot>('system.persistence');
      update({
        pendingCommits: pending.length,
        headRevision: local.headRevision,
        autosaveIntervalMs: persistence.autosaveIntervalMs,
      });
      if (controlOrigin) {
        try {
          await refreshControlStatus(controlRequest, update);
        } catch (error) {
          update({ phase: 'offline', error: errorMessage(error) });
        }
      } else {
        update({ phase: 'disabled', configured: false, error: undefined });
      }

      cancelRenewalTimer = context.resources.interval(() => {
        if (!stopped && leaseId && local.projectId && state.phase === 'ready') {
          void enqueueSync(false, undefined, false);
        }
      }, LEASE_RENEW_MS);
    },

    stop() {
      stopped = true;
      stopRuntime();
      cancelRenewalTimer?.();
      cancelRenewalTimer = undefined;
      leaseId = undefined;
      access = undefined;
      pendingDeletion = undefined;
      deletingProjectId = undefined;
    },
  };

  async function refreshControlStatus(
    request: <T>(path: string, init?: RequestInit) => Promise<T>,
    update: (value: Partial<CloudSyncState>) => void,
  ) {
    const control = await request<CloudControlStatus>('/api/cloud/status', { method: 'GET' });
    const ready = control.installations.some((item) => item.status === 'ready');
    const activeInstallation = control.installations.find((item) => item.id === local.installationId && item.status === 'ready') ??
      control.installations.find((item) => item.status === 'ready');
    update({
      configured: control.configured,
      authenticated: control.authenticated,
      accounts: control.accounts,
      installations: control.installations,
      activeInstallationId: local.installationId,
      upgradeAvailable: activeInstallation?.upgradeAvailable === true,
      user: control.user,
      phase: !control.configured ? 'disabled' : !control.authenticated ? 'signed-out' : ready ? 'ready' : 'needs-installation',
      error: undefined,
    });
  }
}

function emptyState(): CloudSyncState {
  return {
    phase: 'connecting', configured: false, authenticated: false, accounts: [], installations: [],
    headRevision: 0, pendingCommits: 0, autosaveIntervalMs: DEFAULT_AUTOSAVE_INTERVAL_MS,
    upgradeAvailable: false, panelOpen: false,
  };
}

function resolveControlOrigin(baseURI?: string): string | undefined {
  if (!baseURI) return undefined;
  const url = new URL(baseURI);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
}

function resolveControlUrl(path: string, origin?: string): string {
  if (!origin) throw new Error('本地单文件没有云同步控制服务；请通过配套的 HTTP(S) 部署地址使用云同步');
  return new URL(path, origin).toString();
}

function defaultCloudProjectName(): string {
  const stamp = new Date().toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `新书籍 ${stamp}`;
}

function normalizeLocalState(value: LocalCloudState | undefined): LocalCloudState {
  return {
    deviceId: value?.deviceId && /^[a-zA-Z0-9:_-]{6,160}$/.test(value.deviceId)
      ? value.deviceId : `device-${crypto.randomUUID()}`,
    installationId: value?.installationId,
    projectId: value?.projectId,
    projectName: value?.projectName,
    headRevision: Number.isSafeInteger(value?.headRevision) && (value?.headRevision ?? -1) >= 0 ? value!.headRevision : 0,
    checkpointAt: Number.isFinite(value?.checkpointAt) ? value?.checkpointAt : undefined,
  };
}

function parsePendingQueue(value: string | undefined): TransactionCommitRecord[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if(isRecord(parsed)&&parsed.formatVersion===2&&parsed.dirty===true)return [{id:'resume-local-book',label:'本机未上传修改',timestamp:Date.now(),forward:[],inverse:[],sourceMessageId:'local-recovery',historyAction:'none'}];
    return Array.isArray(parsed) ? parsed.filter(isCommitRecord).slice(-2400) : [];
  } catch {
    return [];
  }
}

async function completeBootstrap(
  initial: CloudBootstrap,
  request: <T>(path: string, init?: RequestInit, retry?: boolean) => Promise<T>,
): Promise<CloudBootstrap> {
  const bootstrap = structuredClone(initial);
  const chunks = new Map(bootstrap.chunks.map((chunk) => [chunk.id, chunk]));
  let after = bootstrap.operations.at(-1)?.revision ?? bootstrap.checkpointRevision;
  while (after < bootstrap.project.headRevision) {
    const page = await request<{
      headRevision: number;
      operations: CloudOperation[];
      chunks: Array<{ id: string; value: unknown }>;
    }>(`/v1/projects/${encodeURIComponent(bootstrap.project.id)}/changes?after=${after}`, { method: 'GET' });
    if (!page.operations.length) throw new Error('云端操作序列不完整，已停止载入');
    bootstrap.operations.push(...page.operations);
    for (const chunk of page.chunks) chunks.set(chunk.id, chunk);
    after = page.operations.at(-1)!.revision;
    bootstrap.project.headRevision = page.headRevision;
  }
  bootstrap.chunks = [...chunks.values()];
  return bootstrap;
}

function jsonInit(value: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

async function requestJson<T>(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetcher(url, init);
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    const retry = response.headers.get('retry-after');
    const wait = retry ? (/^\d+$/u.test(retry) ? Number(retry) * 1_000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
    throw new CloudHttpError(response.status, message, body, Number.isFinite(wait) ? wait : 0);
  }
  return body as T;
}

class CloudHttpError extends Error {
  readonly status: number;
  readonly detail?: unknown;
  readonly retryAfterMs: number;

  constructor(status: number, message: string, detail?: unknown, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

function isHttpStatus(error: unknown, status: number): boolean {
  return error instanceof CloudHttpError && error.status === status;
}

function errorDetail(error: unknown): unknown {
  return error instanceof CloudHttpError ? error.detail : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCommitRecord(value: unknown): value is TransactionCommitRecord {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string' &&
    Number.isFinite(value.timestamp) && Array.isArray(value.forward) && Array.isArray(value.inverse);
}

function isProjectIdPayload(value: unknown): value is { projectId: string } {
  return isRecord(value) && typeof value.projectId === 'string' &&
    /^[a-zA-Z0-9:_-]{6,160}$/u.test(value.projectId);
}
