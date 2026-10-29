import type { MessageEnvelope, PluginDefinition } from '../../core/contracts.ts';
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
  CLOUD_CONTENT_CHUNK_NAMESPACE,
  type CloudBootstrap,
  type CloudCheckpoint,
  type CloudControlStatus,
  type CloudDataAccess,
  type CloudOperation,
  type CloudProjectDeleteConfirmation,
  type CloudProjectSummary,
  type CloudSyncState,
} from '../../cloud/contracts.ts';
import { defineManifest } from '../manifest.ts';

const LOCAL_STATE_KEY = 'cloud-session';
const QUEUE_ASSET_KEY = 'cloud-pending-commits';
const CHUNK_REFERENCE = '__echo8ContentChunkRef';
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
}

export function createCloudSyncPlugin(
  statusView?: unknown,
  panelView?: unknown,
  deleteDialogView?: unknown,
): PluginDefinition {
  let state: CloudSyncState = emptyState();
  let projects: CloudProjectSummary[] = [];
  let local: LocalCloudState = { deviceId: '', headRevision: 0 };
  let pending: TransactionCommitRecord[] = [];
  let pendingDeletion: CloudProjectDeleteConfirmation | undefined;
  let deletingProjectId: string | undefined;
  let access: CloudDataAccess | undefined;
  let leaseId: string | undefined;
  let cancelRenewalTimer: (() => void) | undefined;
  let stopped = false;
  let syncTail: Promise<void> = Promise.resolve();

  return {
    manifest: defineManifest('cloud-sync', 'Cloudflare 云同步', {
      commands: [
        'cloudSync.open', 'cloudSync.close', 'cloudSync.refresh', 'cloudSync.install', 'cloudSync.upgrade',
        'cloudSync.listProjects', 'cloudSync.openProject', 'cloudSync.createProject',
        'cloudSync.renameProject', 'cloudSync.requestDeleteProject',
        'cloudSync.cancelDeleteProject', 'cloudSync.confirmDeleteProject',
        'cloudSync.saveCurrentAsProject',
        'cloudSync.disconnectProject', 'cloudSync.syncNow',
        'cloudSync.takeover', 'cloudSync.acceptRemote', 'cloudSync.logout',
      ],
      dispatches: [
        'system.preferences.set', 'system.personalAssets.set', 'system.document.replace',
        'system.document.new', 'system.persistence.checkpoint', 'bookLibrary.show',
      ],
      events: ['transaction.committed'],
      queries: ['cloudSync.state', 'cloudSync.projects', 'cloudSync.deleteConfirmation'],
      asks: [
        'system.preferences.get', 'system.personalAssets.get', 'system.project.source',
        'system.persistence', 'cloudSync.state', 'cloudSync.projects', 'cloudSync.deleteConfirmation',
      ],
      signals: [
        'cloudSync.updated', 'cloudSync.deleteConfirmation.changed',
        'system.persistence.automaticSave.requested', 'system.persistence.autosaveInterval.changed',
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

      const persistLocal = async (parent?: MessageEnvelope) => {
        const call = parent ? context.commands.invoke : context.commands.dispatch;
        await call('system.preferences.set', { key: LOCAL_STATE_KEY, value: local });
        const asset: PersonalTextAssetRecord = {
          schemaVersion: 1,
          text: JSON.stringify(pending),
          fileName: 'cloud-pending-commits.json',
          updatedAt: Date.now(),
        };
        await call('system.personalAssets.set', { key: QUEUE_ASSET_KEY, asset });
      };

      const captureCheckpoint = async (): Promise<{ checkpoint: CloudCheckpoint; chunks: Array<{ id: string; value: unknown }> }> => {
        const source = await context.queries.ask<ProjectSource>('system.project.source');
        const document = structuredClone(source.document);
        const records = document.namespaces[CLOUD_CONTENT_CHUNK_NAMESPACE] ?? {};
        const chunks = Object.entries(records).map(([id, value]) => ({ id, value }));
        document.namespaces[CLOUD_CONTENT_CHUNK_NAMESPACE] = {};
        return {
          checkpoint: {
            formatVersion: 1,
            savedAt: Date.now(),
            document,
            plugins: source.plugins,
            contentChunkIds: chunks.map((chunk) => chunk.id),
          },
          chunks,
        };
      };

      const runSync = async (
        forceCheckpoint = false,
        parent?: MessageEnvelope,
        includePending = true,
      ) => {
        if (!local.projectId || !leaseId || !['ready', 'syncing', 'offline'].includes(state.phase)) return;
        if (deletingProjectId === local.projectId) return;
        const commits = includePending ? pending.slice(0, 200).map(externalizeCloudCommit) : [];
        const shouldCheckpoint = includePending && (forceCheckpoint || !local.checkpointAt ||
          Date.now() - local.checkpointAt >= CHECKPOINT_INTERVAL_MS);
        const captured = shouldCheckpoint ? await captureCheckpoint() : undefined;
        const commitChunks = commits.flatMap((item) => item.chunks);
        const chunks = dedupeChunks([...(captured?.chunks ?? []), ...commitChunks]);
        if (includePending) update({ phase: 'syncing', error: undefined });
        try {
          for (const batch of chunkBatches(chunks)) {
            await dataRequest(`/v1/projects/${encodeURIComponent(local.projectId)}/chunks`, jsonInit({
              deviceId: local.deviceId,
              leaseId,
              chunks: batch,
            }));
          }
          const result = await dataRequest<{
            accepted: number;
            headRevision: number;
            checkpointRevision: number;
            lease: { expiresAt: number };
          }>(`/v1/projects/${encodeURIComponent(local.projectId)}/sync`, jsonInit({
            deviceId: local.deviceId,
            leaseId,
            baseRevision: local.headRevision,
            commits: commits.map((item) => item.commit),
            checkpoint: captured?.checkpoint,
            chunks: [],
          }));
          if (includePending) pending.splice(0, result.accepted);
          local.headRevision = result.headRevision;
          if (captured) local.checkpointAt = Date.now();
          update({
            phase: 'ready',
            headRevision: result.headRevision,
            pendingCommits: pending.length,
            lastSyncedAt: includePending ? Date.now() : state.lastSyncedAt,
            leaseExpiresAt: result.lease.expiresAt,
            error: undefined,
          });
          await persistLocal(parent);
          if (includePending && pending.length) {
            context.resources.timeout(() => void enqueueSync(false), 0);
          }
        } catch (error) {
          if (isHttpStatus(error, 409)) {
            update({ phase: 'conflict', pendingCommits: pending.length, error: '云端版本已变化；本机修改仍保留在恢复队列中' });
          } else if (isHttpStatus(error, 423)) {
            leaseId = undefined;
            update({ phase: 'read-only', error: '编辑权已经转移到另一台设备' });
          } else {
            update({ phase: 'offline', pendingCommits: pending.length, error: errorMessage(error) });
          }
        }
      };
      const enqueueSync = (
        forceCheckpoint = false,
        parent?: MessageEnvelope,
        includePending = true,
      ) => {
        syncTail = syncTail.then(
          () => runSync(forceCheckpoint, parent, includePending),
          () => runSync(forceCheckpoint, parent, includePending),
        );
        return syncTail;
      };
      const disconnectProject = async (parent?: MessageEnvelope) => {
        const projectId = local.projectId;
        const currentLeaseId = leaseId;
        if (projectId && currentLeaseId) {
          await enqueueSync(true, parent);
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
        const bootstrap = await completeBootstrap(
          await dataRequest<CloudBootstrap>(`/v1/projects/${encodeURIComponent(project.id)}/bootstrap`),
          dataRequest,
        );
        const sameUnsyncedLocal = previousProjectId === project.id && pending.length > 0;
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
          await enqueueSync(true, envelope);
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
        if (!pending.some((item) => item.id === record.id)) pending.push(structuredClone(record));
        update({
          pendingCommits: pending.length,
          phase: state.phase === 'offline' ? 'offline' : state.phase === 'syncing' ? 'syncing' : 'ready',
        });
        context.resources.timeout(
          () => void persistLocal().catch((error) => context.diagnostics.error('云同步队列保存失败', error)),
          0,
        );
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
    return Array.isArray(parsed) ? parsed.filter(isCommitRecord).slice(-2400) : [];
  } catch {
    return [];
  }
}

export function externalizeCloudCommit(commit: TransactionCommitRecord): {
  commit: TransactionCommitRecord;
  chunks: Array<{ id: string; value: unknown }>;
} {
  const chunks: Array<{ id: string; value: unknown }> = [];
  const externalize = (patches: TransactionCommitRecord['forward']) => patches.map((patch) => {
    if (patch.op !== 'set' || patch.domain !== 'document' || patch.namespace !== CLOUD_CONTENT_CHUNK_NAMESPACE) return patch;
    chunks.push({ id: patch.key, value: patch.value });
    return { ...patch, value: { [CHUNK_REFERENCE]: patch.key } };
  });
  return {
    commit: { ...structuredClone(commit), forward: externalize(commit.forward), inverse: externalize(commit.inverse) },
    chunks,
  };
}

export function hydrateRemoteDocument(bootstrap: CloudBootstrap): CloudCheckpoint['document'] {
  const document = structuredClone(bootstrap.checkpoint?.document ?? { revision: 0, namespaces: {} });
  const chunks = new Map(bootstrap.chunks.map((chunk) => [chunk.id, chunk.value]));
  document.namespaces[CLOUD_CONTENT_CHUNK_NAMESPACE] = Object.fromEntries(chunks);
  for (const operation of bootstrap.operations) applyOperation(document, operation, chunks);
  return document;
}

function applyOperation(
  document: CloudCheckpoint['document'],
  operation: CloudOperation,
  chunks: Map<string, unknown>,
) {
  let changed = false;
  for (const patch of operation.commit.forward) {
    if (patch.domain !== 'document') continue;
    const namespace = document.namespaces[patch.namespace] ?? {};
    document.namespaces[patch.namespace] = namespace;
    if (patch.op === 'delete') delete namespace[patch.key];
    else namespace[patch.key] = hydrateChunkReference(patch.value, chunks);
    changed = true;
  }
  if (changed) document.revision += 1;
}

function hydrateChunkReference(value: unknown, chunks: Map<string, unknown>): unknown {
  if (!isRecord(value) || typeof value[CHUNK_REFERENCE] !== 'string') return value;
  const id = value[CHUNK_REFERENCE];
  if (!chunks.has(id)) throw new Error(`云端正文分块缺失：${id}`);
  return structuredClone(chunks.get(id));
}

function dedupeChunks(chunks: Array<{ id: string; value: unknown }>) {
  return [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()];
}

function chunkBatches(chunks: Array<{ id: string; value: unknown }>): Array<Array<{ id: string; value: unknown }>> {
  const batches: Array<Array<{ id: string; value: unknown }>> = [];
  let current: Array<{ id: string; value: unknown }> = [];
  let bytes = 0;
  for (const chunk of chunks) {
    const size = new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
    if (current.length && (current.length >= 32 || bytes + size > 8 * 1024 * 1024)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(chunk);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
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
    throw new CloudHttpError(response.status, message, body);
  }
  return body as T;
}

class CloudHttpError extends Error {
  readonly status: number;
  readonly detail?: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProjectIdPayload(value: unknown): value is { projectId: string } {
  return isRecord(value) && typeof value.projectId === 'string' &&
    /^[a-zA-Z0-9:_-]{6,160}$/u.test(value.projectId);
}
