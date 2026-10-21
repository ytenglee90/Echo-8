import {
  isRecord,
  type EventDeclaration,
  type PatchOperation,
  type PluginContext,
  type PluginDefinition,
  type TaskHandle,
} from '../../core/contracts.ts';
import type {
  ContentCreatePlanRequest,
  ContentDeltaPlanRequest,
  ContentMutationPlan,
  ContentRenamePlan,
  ContentRenamePlanRequest,
  ContentSummariesRequest,
  ContentSummary,
} from '../../protocols/content.ts';
import {
  EXTERNAL_PROJECT_DIRECTORY_CAPABILITY,
  type FileDirectoryTarget,
} from '../../protocols/files.ts';
import {
  NOVELFORGE_PROTOCOL_VERSION,
  NOVELFORGE_REQUEST_KIND,
  type NovelForgeArtifact,
  type NovelForgeBinding,
  type NovelForgeBindingState,
  type NovelForgeChangeReceipt,
  type NovelForgeChangeRequest,
  type NovelForgeConnectorConfiguration,
  type NovelForgeConnectorViewState,
  type NovelForgeLocalNodeState,
  type NovelForgePanelState,
  type NovelForgePreparedSync,
  type NovelForgeQueuedProposal,
  type NovelForgeStatusSignal,
} from '../../protocols/novelforge.ts';
import {
  connectorFetch,
  installConnectorCapability,
  normalizeConnectorConfiguration,
  NOVELFORGE_CONNECTOR_PREFERENCE_KEY,
  NOVELFORGE_CONNECTOR_PROTOCOL,
  NOVELFORGE_RUNTIME_PROTOCOL,
  readConnectorJson,
  readConnectorProjects,
  readConnectorSnapshot,
} from './connector.ts';
import {
  digestJson,
  digestNovelForgeText,
  readNovelForgeExchange,
  readNovelForgeReceipt,
  writeNovelForgeRequest,
} from './exchange.ts';
import {
  NOVELFORGE_BINDING_NAMESPACE,
  NOVELFORGE_UI_NAMESPACE,
  novelForgeManifest,
} from './manifest.ts';

interface ContentReadResult {
  nodeId: string;
  start: number;
  text: string;
  totalLength: number;
  revision: number;
}

interface ConnectedWorkspaceState {
  connected: boolean;
  directoryName?: string;
  mode?: 'connector' | 'directory';
  selectedProjectId?: string;
  project?: NovelForgePanelState['project'];
  snapshotDigest?: string;
}

const READ_WINDOW = 256 * 1024;

export function createNovelForgePlugin(panel?: unknown): PluginDefinition {
  let directory: FileDirectoryTarget | undefined;
  let releaseDirectory: (() => void) | undefined;
  let activeSync: TaskHandle<unknown> | undefined;
  let activeQueue: TaskHandle<unknown> | undefined;
  let connectorConfiguration: NovelForgeConnectorConfiguration | undefined;
  let connectorOnline = false;
  let connectorMessage: string | undefined;
  let connectorProtocol: string | undefined;
  let connectorProjects: NovelForgePanelState['connector']['projects'] = [];

  return {
    manifest: novelForgeManifest,

    start(context) {
      directory = undefined;
      releaseDirectory = undefined;
      activeSync = undefined;
      activeQueue = undefined;
      connectorConfiguration = undefined;
      connectorOnline = false;
      connectorMessage = undefined;
      connectorProtocol = undefined;
      connectorProjects = [];

      const emitStatus = (state: NovelForgeStatusSignal['state'], message: string) => {
        context.signals.emit('novelforge.status', { state, message } satisfies NovelForgeStatusSignal);
      };
      const isOpen = () => context.store.readValue<boolean>(NOVELFORGE_UI_NAMESPACE, 'open') ?? false;
      const workspaceState = () => context.store.readValue<ConnectedWorkspaceState>(
        NOVELFORGE_UI_NAMESPACE,
        'connection',
      ) ?? { connected: false };
      const bindings = () => context.store.readNamespace<Record<string, NovelForgeBinding>>(
        NOVELFORGE_BINDING_NAMESPACE,
      );
      const setOpen = (open: boolean) => ({
        transaction: {
          label: open ? '打开 NovelForge' : '关闭 NovelForge',
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: NOVELFORGE_UI_NAMESPACE,
            key: 'open',
            value: open,
          }],
        },
      });
      const trackDirectory = (next: FileDirectoryTarget) => {
        releaseDirectory?.();
        directory = next;
        releaseDirectory = context.resources.track('file', () => {
          if (directory === next) directory = undefined;
        });
      };
      const disconnectRuntime = () => {
        releaseDirectory?.();
        releaseDirectory = undefined;
        directory = undefined;
      };
      const connectorState = (): NovelForgeConnectorViewState => ({
        configured: Boolean(connectorConfiguration),
        online: connectorOnline,
        endpoint: connectorConfiguration?.endpoint ?? 'http://127.0.0.1:32147',
        ...(connectorProtocol ? { protocol: connectorProtocol } : {}),
        ...(connectorMessage ? { message: connectorMessage } : {}),
        projects: connectorProjects,
        ...(workspaceState().selectedProjectId ? { selectedProjectId: workspaceState().selectedProjectId } : {}),
      });
      const setConnectorConfiguration = (configuration: NovelForgeConnectorConfiguration | undefined) => {
        connectorConfiguration = configuration;
        connectorOnline = false;
        connectorProtocol = undefined;
        connectorMessage = configuration ? '等待连接本机服务' : undefined;
        connectorProjects = [];
        context.network.configureOrigins(configuration ? [configuration.endpoint] : []);
      };

      installConnectorCapability(context, () => connectorConfiguration);

      context.commands.register({
        type: 'novelforge.open',
        handle: () => {
          context.ui.activateSurface('right.primary', 'novelforge.panel', 'novelforge.close');
          return setOpen(true);
        },
      });
      context.commands.register({
        type: 'novelforge.close',
        handle: () => {
          context.ui.deactivateSurface('right.primary', 'novelforge.panel');
          return setOpen(false);
        },
      });
      context.commands.register({
        type: 'novelforge.connect',
        handle: async () => {
          const selected = await context.capabilities.request<FileDirectoryTarget | undefined>(
            EXTERNAL_PROJECT_DIRECTORY_CAPABILITY,
          );
          if (!selected) return { result: { connected: false } };
          if (!selected.getDirectoryHandle) {
            throw new Error('当前浏览器目录授权不支持 NovelForge 的子目录协议');
          }
          trackDirectory(selected);
          context.commands.defer('novelforge.sync');
          return {
            result: { connected: true },
            transaction: {
              label: '连接 NovelForge 交换目录',
              history: false,
              patches: [{
                op: 'set' as const,
                domain: 'workspace' as const,
                namespace: NOVELFORGE_UI_NAMESPACE,
                key: 'connection',
                value: { connected: true, mode: 'directory', directoryName: selected.name },
              }],
            },
          };
        },
      });
      context.commands.register<NovelForgeConnectorConfiguration, { configured: boolean }>({
        type: 'novelforge.connector.configure',
        validate: (value): value is NovelForgeConnectorConfiguration => {
          try { normalizeConnectorConfiguration(value); return true; } catch { return false; }
        },
        handle: (value) => {
          if (typeof location !== 'undefined' && location.protocol === 'file:') {
            throw new Error('离线单文件没有可信网页来源；请打开部署后的 HTTP(S) 画布网址完成配对');
          }
          const configuration = normalizeConnectorConfiguration(value);
          setConnectorConfiguration(configuration);
          context.commands.defer('system.preferences.set', {
            key: NOVELFORGE_CONNECTOR_PREFERENCE_KEY,
            value: configuration,
          });
          context.commands.defer('novelforge.connector.probe');
          return { result: { configured: true } };
        },
      });
      context.commands.register({
        type: 'novelforge.connector.clear',
        handle: () => {
          activeSync?.cancel();
          activeQueue?.cancel();
          const currentConnection = workspaceState();
          setConnectorConfiguration(undefined);
          context.commands.defer('system.preferences.set', {
            key: NOVELFORGE_CONNECTOR_PREFERENCE_KEY,
            value: null,
          });
          emitStatus('ready', '已清除本机连接器配对；小说和映射未删除');
          if (currentConnection.connected && currentConnection.mode === 'directory') {
            return { result: { cleared: true } };
          }
          return {
            result: { cleared: true },
            transaction: {
              label: '清除 NovelForge 本机配对',
              history: false,
              patches: [{
                op: 'set' as const,
                domain: 'workspace' as const,
                namespace: NOVELFORGE_UI_NAMESPACE,
                key: 'connection',
                value: { connected: false },
              }],
            },
          };
        },
      });
      context.commands.register({
        type: 'novelforge.connector.probe',
        handle: async () => {
          const configuration = connectorConfiguration;
          if (!configuration) throw new Error('请先填写本机连接器地址和配对令牌');
          try {
            const health = await readConnectorJson(await connectorFetch(
              context, configuration, '/v1/connector/health', {},
            ));
            if (!isRecord(health) || health.protocol !== NOVELFORGE_CONNECTOR_PROTOCOL || health.status !== 'READY') {
              throw new Error('本机连接器协议不兼容或尚未就绪');
            }
            const projects = await readConnectorProjects(await connectorFetch(
              context, configuration, '/v1/runtime/projects', { limit: 500 },
            ));
            connectorOnline = true;
            connectorProtocol = String(health.protocol);
            connectorMessage = `已连接；发现 ${projects.length} 个本机项目`;
            connectorProjects = projects;
            emitStatus('ready', connectorMessage);
            return { result: { online: true } };
          } catch (error) {
            connectorOnline = false;
            connectorMessage = safeMessage(error);
            connectorProjects = [];
            emitStatus('error', connectorMessage);
            throw error;
          }
        },
      });
      context.commands.register<{ projectId: string }, { projectId: string }>({
        type: 'novelforge.connector.selectProject',
        validate: (value): value is { projectId: string } => isRecord(value) && typeof value.projectId === 'string',
        handle: ({ projectId }) => {
          if (!connectorOnline || !connectorProjects.some((project) => project.project_id === projectId)) {
            throw new Error('请先连接本机服务并选择有效的 NovelForge 项目');
          }
          disconnectRuntime();
          context.commands.defer('novelforge.sync');
          return {
            result: { projectId },
            transaction: {
              label: '连接 NovelForge 本机项目',
              history: false,
              patches: [{
                op: 'set' as const,
                domain: 'workspace' as const,
                namespace: NOVELFORGE_UI_NAMESPACE,
                key: 'connection',
                value: {
                  connected: true,
                  mode: 'connector',
                  selectedProjectId: projectId,
                  directoryName: '本机 Runtime',
                },
              }],
            },
          };
        },
      });
      context.commands.register({
        type: 'novelforge.disconnect',
        handle: () => {
          activeSync?.cancel();
          activeQueue?.cancel();
          disconnectRuntime();
          return {
            transaction: {
              label: '断开 NovelForge 项目',
              history: false,
              patches: [{
                op: 'set' as const,
                domain: 'workspace' as const,
                namespace: NOVELFORGE_UI_NAMESPACE,
                key: 'connection',
                value: { connected: false },
              }],
            },
          };
        },
      });
      context.commands.register({
        type: 'novelforge.sync',
        handle: () => {
          const selected = directory;
          const connection = workspaceState();
          const connectorProjectId = connection.mode === 'connector' ? connection.selectedProjectId : undefined;
          const connector = connectorConfiguration;
          if (!selected && (!connector || !connectorProjectId)) {
            throw new Error('请先连接一个 NovelForge 本机项目或 exchange 目录');
          }
          activeSync?.cancel();
          const bindingSnapshot = bindings();
          const task = context.tasks.schedule({
            category: 'novelforge-sync',
            label: '同步 NovelForge 权威投影',
            noticeAfterMs: 600,
            priority: 70,
            timeoutMs: 10 * 60_000,
            estimatedCost: 1,
            run: async (signal, report) => {
              emitStatus('running', '正在校验 NovelForge manifest 与工件…');
              const pendingReceiptIds = [...new Set(
                Object.values(bindingSnapshot)
                  .map((binding) => binding.pendingRequestId)
                  .filter(Boolean) as string[],
              )];
              const exchange = connector && connectorProjectId
                ? await readConnectorSnapshot(
                  (body) => connectorFetch(context, connector, '/v1/runtime/snapshot', body, signal),
                  connectorProjectId,
                  pendingReceiptIds,
                )
                : { ...await readNovelForgeExchange(selected!, signal), receipts: [] as NovelForgeChangeReceipt[] };
              report(0.45);
              const localNodes: NovelForgeLocalNodeState[] = [];
              const bindingValues = Object.values(bindingSnapshot);
              for (let index = 0; index < bindingValues.length; index += 1) {
                const binding = bindingValues[index];
                const local = await readLocalNode(context, binding.entryId, binding.canvasNodeId, signal)
                  .catch(() => undefined);
                if (local) localNodes.push(local);
                report(0.45 + (index + 1) / Math.max(1, bindingValues.length) * 0.35);
              }
              const receipts: NovelForgeChangeReceipt[] = [...exchange.receipts];
              if (selected) {
                for (const requestId of pendingReceiptIds) {
                  const receipt = await readNovelForgeReceipt(selected, requestId, signal);
                  if (receipt) receipts.push(receipt);
                }
              }
              await context.commands.dispatch('novelforge.commitSync', {
                manifest: exchange.manifest,
                artifacts: exchange.artifacts,
                localNodes,
                receipts,
                directoryName: selected?.name ?? '本机 Runtime',
              });
              report(1);
              return exchange.manifest.snapshot_digest;
            },
          });
          activeSync = task;
          void task.result.then(
            () => emitStatus('ready', 'NovelForge 权威投影已同步'),
            (error) => emitStatus('error', safeMessage(error)),
          ).finally(() => {
            if (activeSync === task) activeSync = undefined;
          });
          return { result: { taskId: task.id } };
        },
      });
      context.commands.register<NovelForgePreparedSync, { created: number; updated: number; conflicts: number }>({
        type: 'novelforge.commitSync',
        validate: isPreparedSync,
        handle: async (payload) => {
          const existingBindings = bindings();
          const currentConnection = workspaceState();
          if (currentConnection.project &&
            currentConnection.project.project_id !== payload.manifest.project.project_id &&
            Object.keys(existingBindings).length > 0) {
            throw new Error('当前画布仍绑定另一部 NovelForge 项目；请先“清除映射（保留节点）”');
          }
          const artifacts = new Map(payload.artifacts.map((artifact) => [artifact.entry_id, artifact]));
          const localNodes = new Map(payload.localNodes.map((node) => [node.entryId, node]));
          const receipts = new Map(payload.receipts.map((receipt) => [receipt.request_id, receipt]));
          const patches: PatchOperation[] = [];
          const events: EventDeclaration[] = [];
          const reservedTitles: string[] = [];
          let created = 0;
          let updated = 0;
          let conflicts = 0;

          const currentNodeIds = payload.localNodes.map((node) => node.nodeId);
          const summaries = currentNodeIds.length === 0 ? [] : await context.capabilities.request<ContentSummary[]>(
            'content.summariesById@1',
            { nodeIds: currentNodeIds } satisfies ContentSummariesRequest,
          );
          const currentSummaries = new Map(summaries.map((summary) => [summary.id, summary]));
          for (const local of payload.localNodes) {
            const summary = currentSummaries.get(local.nodeId);
            if (!summary || summary.revision !== local.contentRevision ||
              (summary.nodeRevision ?? summary.revision) !== local.nodeRevision) {
              throw new Error('同步准备后画布节点又发生变化，请重试同步');
            }
          }

          for (const entry of payload.manifest.entries) {
            const artifact = artifacts.get(entry.entry_id);
            if (!artifact) throw new Error(`缺少 NovelForge artifact: ${entry.entry_id}`);
            const existing = existingBindings[entry.entry_id];
            const local = localNodes.get(entry.entry_id);
            const receipt = existing?.pendingRequestId
              ? receipts.get(existing.pendingRequestId)
              : undefined;
            if (!existing || !local) {
              const plan = await context.capabilities.request<ContentMutationPlan>(
                'content.createPlan@1',
                {
                  title: artifact.title,
                  body: artifact.body,
                  x: artifact.x,
                  y: artifact.y,
                  automaticContext: false,
                  reservedTitles,
                } satisfies ContentCreatePlanRequest,
              );
              if (plan.resolvedTitle) reservedTitles.push(plan.resolvedTitle);
              patches.push(...plan.patches, bindingPatch(entry.entry_id, await bindingFromPlan(
                payload, artifact, plan, plan.resolvedTitle ?? artifact.title,
              )));
              events.push(...(plan.events ?? []));
              created += 1;
              continue;
            }

            const localDirty = local.canvasDigest !== existing.lastSyncedCanvasDigest;
            const runtimeChanged = artifact.content_digest !== existing.contentDigest ||
              artifact.authority_digest !== existing.authorityDigest ||
              artifact.artifact_revision !== existing.artifactRevision;
            const acceptedReceipt = receipt?.status === 'COMMITTED' &&
              receipt.result_digest === artifact.authority_digest &&
              receipt.candidate_digest === existing.pendingCandidateDigest &&
              local.nodeRevision === existing.pendingCanvasNodeRevision;

            if (localDirty && runtimeChanged && !acceptedReceipt) {
              patches.push(bindingPatch(entry.entry_id, bindingFromArtifact(existing, payload, artifact, {
                canvasTitle: local.title,
                lastSyncedCanvasDigest: existing.lastSyncedCanvasDigest,
                lastSyncedContentRevision: local.contentRevision,
                lastSyncedNodeRevision: local.nodeRevision,
                syncState: 'conflict',
                conflictReason: receipt?.conflict_reason ?? 'Runtime 与画布均已修改，未覆盖任何一方',
                receipt,
              })));
              conflicts += 1;
              continue;
            }
            if (localDirty && !runtimeChanged) {
              patches.push(bindingPatch(entry.entry_id, bindingFromArtifact(existing, payload, artifact, {
                canvasTitle: local.title,
                lastSyncedCanvasDigest: existing.lastSyncedCanvasDigest,
                lastSyncedContentRevision: local.contentRevision,
                lastSyncedNodeRevision: local.nodeRevision,
                syncState: receiptToState(receipt, 'local-draft'),
                conflictReason: receipt?.conflict_reason,
                receipt,
              })));
              continue;
            }
            if (acceptedReceipt) {
              patches.push(bindingPatch(entry.entry_id, bindingFromArtifact(existing, payload, artifact, {
                canvasTitle: local.title,
                lastSyncedCanvasDigest: local.canvasDigest,
                lastSyncedContentRevision: local.contentRevision,
                lastSyncedNodeRevision: local.nodeRevision,
                syncState: 'synced',
                receipt,
                clearPending: true,
              })));
              updated += 1;
              continue;
            }
            if (!runtimeChanged) {
              const nextState = receiptToState(receipt, existing.syncState);
              patches.push(bindingPatch(entry.entry_id, bindingFromArtifact(existing, payload, artifact, {
                canvasTitle: local.title,
                lastSyncedCanvasDigest: local.canvasDigest,
                lastSyncedContentRevision: local.contentRevision,
                lastSyncedNodeRevision: local.nodeRevision,
                syncState: nextState,
                conflictReason: receipt?.conflict_reason,
                receipt,
              })));
              continue;
            }

            let contentRevision = local.contentRevision;
            let nodeRevision = local.nodeRevision;
            let canvasTitle = local.title;
            if (local.bodyDigest !== await digestJson(artifact.body)) {
              const plan = await context.capabilities.request<ContentMutationPlan>(
                'content.deltaPlan@1',
                {
                  nodeId: local.nodeId,
                  start: 0,
                  deleteCount: local.totalLength,
                  insert: artifact.body,
                  expectedRevision: local.contentRevision,
                } satisfies ContentDeltaPlanRequest,
              );
              patches.push(...plan.patches);
              events.push(...(plan.events ?? []));
              contentRevision = plan.revision;
              nodeRevision += 1;
            }
            if (local.title !== artifact.title) {
              const plan = await context.capabilities.request<ContentRenamePlan>(
                'content.renamePlan@1',
                {
                  nodeId: local.nodeId,
                  title: artifact.title,
                  expectedNodeRevision: local.nodeRevision,
                  reservedTitles,
                } satisfies ContentRenamePlanRequest,
              );
              patches.push(...plan.patches);
              events.push(...(plan.events ?? []));
              canvasTitle = plan.resolvedTitle;
              nodeRevision = plan.nodeRevision;
              reservedTitles.push(canvasTitle);
            }
            patches.push(bindingPatch(entry.entry_id, bindingFromArtifact(existing, payload, artifact, {
              canvasTitle,
              lastSyncedCanvasDigest: await digestNovelForgeText(canvasTitle, artifact.body),
              lastSyncedContentRevision: contentRevision,
              lastSyncedNodeRevision: nodeRevision,
              syncState: 'synced',
              clearPending: receipt?.status === 'COMMITTED',
              receipt,
            })));
            updated += 1;
          }

          const manifestIds = new Set(payload.manifest.entries.map((entry) => entry.entry_id));
          for (const binding of Object.values(existingBindings)) {
            if (manifestIds.has(binding.entryId)) continue;
            patches.push(bindingPatch(binding.entryId, {
              ...binding,
              syncState: 'orphaned',
              conflictReason: 'Runtime 当前 manifest 已不再发布此条目；画布节点已保留',
              lastSyncedVersion: payload.manifest.snapshot_digest,
            }));
          }
          context.commands.defer('novelforge.updateConnectionState', {
            connected: true,
            directoryName: payload.directoryName,
            ...(currentConnection.mode ? { mode: currentConnection.mode } : {}),
            ...(currentConnection.selectedProjectId
              ? { selectedProjectId: currentConnection.selectedProjectId }
              : {}),
            project: payload.manifest.project,
            snapshotDigest: payload.manifest.snapshot_digest,
          } satisfies ConnectedWorkspaceState);
          return {
            result: { created, updated, conflicts },
            transaction: {
              label: `同步 NovelForge（新建 ${created}，更新 ${updated}）`,
              patches,
              events,
            },
          };
        },
      });
      context.commands.register<ConnectedWorkspaceState>({
        type: 'novelforge.updateConnectionState',
        validate: isConnectedWorkspaceState,
        handle: (connection) => ({
          transaction: {
            label: '更新 NovelForge 连接状态',
            history: false,
            patches: [{
              op: 'set',
              domain: 'workspace',
              namespace: NOVELFORGE_UI_NAMESPACE,
              key: 'connection',
              value: connection,
            }],
          },
        }),
      });
      context.commands.register<{ nodeId: string }>({
        type: 'novelforge.markDirty',
        validate: (value): value is { nodeId: string } => isRecord(value) && typeof value.nodeId === 'string',
        handle: async ({ nodeId }) => {
          const binding = Object.values(bindings()).find((candidate) => candidate.canvasNodeId === nodeId);
          if (!binding) return { result: undefined };
          const summaries = await context.capabilities.request<ContentSummary[]>(
            'content.summariesById@1',
            { nodeIds: [nodeId] } satisfies ContentSummariesRequest,
          );
          const summary = summaries[0];
          if (!summary) return { result: undefined };
          if (summary.revision === binding.lastSyncedContentRevision &&
            (summary.nodeRevision ?? summary.revision) === binding.lastSyncedNodeRevision) {
            return { result: undefined };
          }
          const nextState: NovelForgeBindingState = binding.syncState === 'conflict'
            ? 'conflict'
            : 'local-draft';
          return {
            transaction: {
              label: '标记 NovelForge 本地草稿',
              history: false,
              patches: [bindingPatch(binding.entryId, {
                ...binding,
                syncState: nextState,
                pendingRequestId: undefined,
                pendingCandidateDigest: undefined,
                pendingCanvasNodeRevision: undefined,
                proposalId: undefined,
              })],
            },
          };
        },
      });
      context.commands.register({
        type: 'novelforge.queueDirtyProposals',
        handle: () => {
          const selected = directory;
          const connection = workspaceState();
          const connectorProjectId = connection.mode === 'connector' ? connection.selectedProjectId : undefined;
          const connector = connectorConfiguration;
          if (!selected && (!connector || !connectorProjectId)) {
            throw new Error('请先连接一个 NovelForge 本机项目或 exchange 目录');
          }
          activeQueue?.cancel();
          const candidates = Object.values(bindings()).filter((binding) =>
            ['local-draft', 'conflict'].includes(binding.syncState) && binding.editableMode !== 'READ_ONLY'
          );
          const task = context.tasks.schedule({
            category: 'novelforge-proposals',
            label: '写入 NovelForge 改动提案',
            noticeAfterMs: 600,
            priority: 75,
            timeoutMs: 10 * 60_000,
            estimatedCost: 1,
            run: async (signal, report) => {
              emitStatus('running', `正在准备 ${candidates.length} 个改动提案…`);
              const queued: NovelForgeQueuedProposal[] = [];
              const requests: NovelForgeChangeRequest[] = [];
              for (let index = 0; index < candidates.length; index += 1) {
                const binding = candidates[index];
                const local = await readLocalNodeWithBody(context, binding.entryId, binding.canvasNodeId, signal);
                const candidateTitle = local.title === binding.canvasTitle
                  ? binding.runtimeTitle
                  : local.title;
                const candidateDigest = await digestNovelForgeText(candidateTitle, local.body);
                const identityDigest = await digestJson({
                  projectId: binding.projectId,
                  entryId: binding.entryId,
                  baseDigest: binding.authorityDigest,
                  candidateDigest,
                });
                const requestId = `CANVAS-REQ-${identityDigest.slice(7, 39)}`;
                const request: NovelForgeChangeRequest = {
                  kind: NOVELFORGE_REQUEST_KIND,
                  protocol_version: NOVELFORGE_PROTOCOL_VERSION,
                  request_id: requestId,
                  project_id: binding.projectId,
                  entry_id: binding.entryId,
                  artifact_type: binding.artifactType,
                  artifact_id: binding.artifactId,
                  base_revision: binding.artifactRevision,
                  base_digest: binding.authorityDigest,
                  base_content_digest: binding.contentDigest,
                  canvas_node_id: binding.canvasNodeId,
                  canvas_node_revision: local.nodeRevision,
                  candidate_title: candidateTitle,
                  candidate_body: local.body,
                  candidate_digest: candidateDigest,
                  created_at: new Date().toISOString(),
                };
                if (selected) await writeNovelForgeRequest(selected, requestId, request, signal);
                else requests.push(request);
                queued.push({
                  entryId: binding.entryId,
                  requestId,
                  candidateDigest,
                  canvasNodeRevision: local.nodeRevision,
                });
                report((index + 1) / Math.max(1, candidates.length) * 0.9);
              }
              if (connector && connectorProjectId) {
                for (let offset = 0; offset < requests.length; offset += 50) {
                  const result = await readConnectorJson(await connectorFetch(
                    context,
                    connector,
                    '/v1/runtime/proposals',
                    { project_id: connectorProjectId, requests: requests.slice(offset, offset + 50) },
                    signal,
                  ));
                  if (!isRecord(result) || result.protocol !== NOVELFORGE_RUNTIME_PROTOCOL) {
                    throw new Error('本机 Runtime 返回了不兼容的提案回执');
                  }
                }
              }
              await context.commands.dispatch('novelforge.commitQueuedProposals', { queued });
              report(1);
              return queued.length;
            },
          });
          activeQueue = task;
          void task.result.then(
            (count) => emitStatus('ready', selected
              ? `已写入 ${count} 个提案；请让本地 Runtime 执行 canvas-process`
              : `已送达 ${count} 个提案；Runtime 已生成待审查记录，不会自动审批或提交`),
            (error) => emitStatus('error', safeMessage(error)),
          ).finally(() => {
            if (activeQueue === task) activeQueue = undefined;
          });
          return { result: { taskId: task.id } };
        },
      });
      context.commands.register<{ queued: NovelForgeQueuedProposal[] }, { queued: number }>({
        type: 'novelforge.commitQueuedProposals',
        validate: isQueuedProposalPayload,
        handle: ({ queued }) => {
          const current = bindings();
          const patches = queued.flatMap((item) => {
            const binding = current[item.entryId];
            if (!binding || binding.canvasNodeId.length === 0) return [];
            return [bindingPatch(item.entryId, {
              ...binding,
              syncState: 'proposal-queued',
              pendingRequestId: item.requestId,
              pendingCandidateDigest: item.candidateDigest,
              pendingCanvasNodeRevision: item.canvasNodeRevision,
              conflictReason: undefined,
            })];
          });
          return {
            result: { queued: patches.length },
            transaction: {
              label: `登记 ${patches.length} 个 NovelForge 改动提案`,
              history: false,
              patches,
            },
          };
        },
      });
      context.commands.register({
        type: 'novelforge.clearBindings',
        handle: () => {
          const current = bindings();
          const patches: PatchOperation[] = Object.keys(current).map((entryId) => ({
            op: 'delete',
            domain: 'document',
            namespace: NOVELFORGE_BINDING_NAMESPACE,
            key: entryId,
          }));
          context.commands.defer('novelforge.updateConnectionState', {
            connected: Boolean(directory) || workspaceState().mode === 'connector',
            ...(directory ? { mode: 'directory' as const, directoryName: directory.name } : {}),
            ...(workspaceState().mode === 'connector' ? {
              mode: 'connector' as const,
              directoryName: '本机 Runtime',
              selectedProjectId: workspaceState().selectedProjectId,
            } : {}),
          } satisfies ConnectedWorkspaceState);
          return {
            result: { cleared: Object.keys(current).length },
            transaction: {
              label: '清除 NovelForge 映射（保留画布节点）',
              patches,
            },
          };
        },
      });

      context.queries.register({
        type: 'novelforge.state',
        handle: () => {
          const connection = workspaceState();
          const bindingValues = Object.values(bindings()).sort((left, right) =>
            (left.chapter ?? Number.MAX_SAFE_INTEGER) - (right.chapter ?? Number.MAX_SAFE_INTEGER) ||
            left.entryId.localeCompare(right.entryId)
          );
          const counts: Record<NovelForgeBindingState, number> = {
            synced: 0,
            'local-draft': 0,
            'proposal-queued': 0,
            conflict: 0,
            orphaned: 0,
          };
          for (const binding of bindingValues) counts[binding.syncState] += 1;
          return {
            open: isOpen(),
            connected: Boolean(directory) || connection.mode === 'connector' && Boolean(connection.selectedProjectId),
            directoryName: directory?.name ?? connection.directoryName,
            project: connection.project,
            snapshotDigest: connection.snapshotDigest,
            bindings: bindingValues,
            counts,
            connectionMode: directory ? 'directory' : connection.mode,
            connector: connectorState(),
          } satisfies NovelForgePanelState;
        },
      });

      context.events.subscribe<{ nodeId?: string; id?: string }>('content.changed', (event) => {
        const nodeId = event.payload.nodeId;
        if (nodeId) void context.commands.dispatch('novelforge.markDirty', { nodeId }).catch((error) => {
          context.diagnostics.warn('NovelForge 无法登记正文改动', safeMessage(error));
        });
      });
      context.events.subscribe<{ id?: string }>('node.renamed', (event) => {
        if (event.payload.id) {
          void context.commands.dispatch('novelforge.markDirty', { nodeId: event.payload.id }).catch((error) => {
            context.diagnostics.warn('NovelForge 无法登记标题改动', safeMessage(error));
          });
        }
      });
      context.events.subscribe('document.replaced', () => {
        activeSync?.cancel();
        activeQueue?.cancel();
        disconnectRuntime();
        void context.commands.dispatch('novelforge.disconnect').catch((error) => {
          context.diagnostics.warn('NovelForge 无法完成断开操作', safeMessage(error));
        });
      });

      context.ui.contribute({
        id: 'novelforge.panel',
        slot: 'right.primary',
        kind: 'view',
        label: 'NovelForge 小说工程',
        component: panel,
        priority: 78,
      });
      if (isOpen()) context.ui.activateSurface('right.primary', 'novelforge.panel', 'novelforge.close');
      context.ui.action({
        id: 'novelforge.open-action',
        label: '打开 NovelForge 小说工程',
        command: 'novelforge.open',
        category: '小说工程',
        keywords: ['NovelForge', '小说', '时间轴', '素材卡', '正文'],
        priority: 78,
      });
      context.ui.shortcut({
        id: 'novelforge.open-shortcut',
        chord: 'mod+alt+n',
        command: 'novelforge.open',
        label: '打开 NovelForge 小说工程',
      });
      context.ui.shortcut({
        id: 'novelforge.close-shortcut',
        command: 'novelforge.close',
        label: '关闭 NovelForge 小说工程',
        category: '小说工程',
      });
      void context.queries.ask<unknown>('system.preferences.get', {
        key: NOVELFORGE_CONNECTOR_PREFERENCE_KEY,
      }).then((value) => {
        if (value === undefined || value === null) return;
        try {
          const configuration = normalizeConnectorConfiguration(value);
          setConnectorConfiguration(configuration);
        } catch (error) {
          connectorMessage = '已保存的本机连接器配置无效，请重新配对';
          context.diagnostics.warn(connectorMessage, error);
          emitStatus('error', connectorMessage);
          return;
        }
        return context.commands.dispatch('novelforge.connector.probe').catch((error) => {
          context.diagnostics.warn('NovelForge 本机连接器暂时不可用', error);
        });
      }).catch((error) => {
        connectorMessage = '无法读取本机连接器个人配置';
        context.diagnostics.warn(connectorMessage, error);
        emitStatus('error', connectorMessage);
      });
    },

    stop() {
      activeSync?.cancel();
      activeQueue?.cancel();
      releaseDirectory?.();
      directory = undefined;
      releaseDirectory = undefined;
      connectorConfiguration = undefined;
      connectorOnline = false;
      connectorProjects = [];
    },
  };
}

async function readLocalNode(
  context: PluginContext,
  entryId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<NovelForgeLocalNodeState> {
  const local = await readLocalNodeWithBody(context, entryId, nodeId, signal);
  return {
    entryId,
    nodeId,
    title: local.title,
    bodyDigest: await digestJson(local.body),
    canvasDigest: await digestNovelForgeText(local.title, local.body),
    contentRevision: local.contentRevision,
    nodeRevision: local.nodeRevision,
    totalLength: local.totalLength,
  };
}

async function readLocalNodeWithBody(
  context: PluginContext,
  entryId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<NovelForgeLocalNodeState & { body: string }> {
  const summaries = await context.capabilities.request<ContentSummary[]>(
    'content.summariesById@1',
    { nodeIds: [nodeId] } satisfies ContentSummariesRequest,
    signal,
  );
  const summary = summaries[0];
  if (!summary) throw new Error(`NovelForge 映射节点不存在: ${nodeId}`);
  let body = '';
  let offset = 0;
  const revision = summary.revision;
  const totalLength = summary.length;
  while (offset < totalLength || offset === 0) {
    const range = await context.capabilities.request<ContentReadResult>(
      'content.read@1',
      { nodeId, start: offset, length: READ_WINDOW },
      signal,
    );
    if (range.revision !== revision || range.totalLength !== totalLength) {
      throw new Error('读取过程中画布正文发生变化，请重试');
    }
    body += range.text;
    offset += range.text.length;
    if (offset >= totalLength) break;
    if (range.text.length === 0) throw new Error('NovelForge 节点范围读取没有前进');
  }
  return {
    entryId,
    nodeId,
    title: summary.title,
    body,
    bodyDigest: await digestJson(body),
    canvasDigest: await digestNovelForgeText(summary.title, body),
    contentRevision: revision,
    nodeRevision: summary.nodeRevision ?? summary.revision,
    totalLength,
  };
}

async function bindingFromPlan(
  payload: NovelForgePreparedSync,
  artifact: NovelForgeArtifact,
  plan: ContentMutationPlan,
  canvasTitle: string,
): Promise<NovelForgeBinding> {
  return {
    projectId: payload.manifest.project.project_id,
    entryId: artifact.entry_id,
    artifactId: artifact.artifact_id,
    artifactType: artifact.artifact_type,
    ...(artifact.chapter === null ? {} : { chapter: artifact.chapter }),
    ...(artifact.card_id === null ? {} : { cardId: artifact.card_id }),
    canvasNodeId: plan.nodeId,
    filePath: artifact.file_path,
    artifactRevision: artifact.artifact_revision,
    authorityDigest: artifact.authority_digest,
    contentDigest: artifact.content_digest,
    lastSyncedCanvasDigest: await digestNovelForgeText(canvasTitle, artifact.body),
    lastSyncedContentRevision: plan.revision,
    lastSyncedNodeRevision: 1,
    runtimeTitle: artifact.title,
    canvasTitle,
    lastSyncedVersion: payload.manifest.snapshot_digest,
    x: artifact.x,
    y: artifact.y,
    locked: artifact.locked,
    editableMode: artifact.editable_mode,
    authorityStatus: artifact.authority_status,
    syncState: 'synced',
  };
}

function bindingFromArtifact(
  existing: NovelForgeBinding,
  payload: NovelForgePreparedSync,
  artifact: NovelForgeArtifact,
  update: {
    canvasTitle: string;
    lastSyncedCanvasDigest: string;
    lastSyncedContentRevision: number;
    lastSyncedNodeRevision: number;
    syncState: NovelForgeBindingState;
    conflictReason?: string | null;
    receipt?: NovelForgeChangeReceipt;
    clearPending?: boolean;
  },
): NovelForgeBinding {
  const clearPending = update.clearPending || update.receipt?.status === 'REJECTED';
  return {
    ...existing,
    artifactId: artifact.artifact_id,
    artifactType: artifact.artifact_type,
    ...(artifact.chapter === null ? { chapter: undefined } : { chapter: artifact.chapter }),
    ...(artifact.card_id === null ? { cardId: undefined } : { cardId: artifact.card_id }),
    filePath: artifact.file_path,
    artifactRevision: artifact.artifact_revision,
    authorityDigest: artifact.authority_digest,
    contentDigest: artifact.content_digest,
    lastSyncedCanvasDigest: update.lastSyncedCanvasDigest,
    lastSyncedContentRevision: update.lastSyncedContentRevision,
    lastSyncedNodeRevision: update.lastSyncedNodeRevision,
    runtimeTitle: artifact.title,
    canvasTitle: update.canvasTitle,
    lastSyncedVersion: payload.manifest.snapshot_digest,
    x: artifact.x,
    y: artifact.y,
    locked: artifact.locked,
    editableMode: artifact.editable_mode,
    authorityStatus: artifact.authority_status,
    syncState: update.syncState,
    ...(clearPending ? {
      pendingRequestId: undefined,
      pendingCandidateDigest: undefined,
      pendingCanvasNodeRevision: undefined,
    } : {}),
    ...(update.receipt?.proposal_id ? { proposalId: update.receipt.proposal_id } : {}),
    ...(update.conflictReason ? { conflictReason: update.conflictReason } : { conflictReason: undefined }),
  };
}

function receiptToState(
  receipt: NovelForgeChangeReceipt | undefined,
  fallback: NovelForgeBindingState,
): NovelForgeBindingState {
  if (!receipt) return fallback;
  if (['CONFLICT', 'BLOCKED'].includes(receipt.status)) return 'conflict';
  if (['REVIEW_REQUIRED', 'APPROVAL_REQUIRED'].includes(receipt.status)) return 'proposal-queued';
  if (receipt.status === 'REJECTED') return 'local-draft';
  return fallback;
}

function bindingPatch(entryId: string, value: NovelForgeBinding): PatchOperation {
  return {
    op: 'set',
    domain: 'document',
    namespace: NOVELFORGE_BINDING_NAMESPACE,
    key: entryId,
    value,
  };
}

function isPreparedSync(value: unknown): value is NovelForgePreparedSync {
  return isRecord(value) && isRecord(value.manifest) && Array.isArray(value.artifacts) &&
    Array.isArray(value.localNodes) && Array.isArray(value.receipts) &&
    typeof value.directoryName === 'string';
}

function isQueuedProposalPayload(value: unknown): value is { queued: NovelForgeQueuedProposal[] } {
  return isRecord(value) && Array.isArray(value.queued) && value.queued.every((item) =>
    isRecord(item) && typeof item.entryId === 'string' && typeof item.requestId === 'string' &&
    typeof item.candidateDigest === 'string' && Number.isInteger(item.canvasNodeRevision)
  );
}

function isConnectedWorkspaceState(value: unknown): value is ConnectedWorkspaceState {
  if (!isRecord(value) || typeof value.connected !== 'boolean' ||
    !(value.directoryName === undefined || typeof value.directoryName === 'string') ||
    !(value.mode === undefined || value.mode === 'connector' || value.mode === 'directory') ||
    !(value.selectedProjectId === undefined || typeof value.selectedProjectId === 'string') ||
    !(value.snapshotDigest === undefined || typeof value.snapshotDigest === 'string')) return false;
  if (value.project === undefined) return true;
  return isRecord(value.project) && typeof value.project.project_id === 'string' &&
    typeof value.project.title === 'string' && Number.isInteger(value.project.chapter_count) &&
    typeof value.project.stage === 'string' && typeof value.project.workflow_status === 'string' &&
    typeof value.project.updated_at === 'string';
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
