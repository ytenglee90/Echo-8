import { isRecord, type MessageEnvelope, type PluginDefinition, type TaskHandle } from '../../core/contracts.ts';
import type {
  ContentCreatePlanRequest,
  ContentMutationPlan,
  ContentSummary,
} from '../../protocols/content.ts';
import type {
  DocumentRevisionSnapshot,
  FileDirectoryTarget,
  FileOperationStatus,
  FileRuntimeState,
  FileSaveTarget,
  LibraryProjectOpenPayload,
  ProjectOpenPayload,
  ProjectSource,
} from '../../protocols/files.ts';
import type { CloudSyncState } from '../../cloud/contracts.ts';
import {
  EXTERNAL_PROJECT_DIRECTORY_CAPABILITY,
  PROJECT_FILE_EXTENSION,
  PROJECT_RELATED_DIRECTORY_CAPABILITY,
} from '../../protocols/files.ts';
import { PRODUCT_NAME } from '../../product.ts';
import { defineManifest } from '../manifest.ts';
import { parseProject, serializeProject } from './codec.ts';
import {
  chooseNativeDirectoryNearProject,
  chooseNativeExternalProjectDirectory,
  chooseNativeProjectOpen,
  chooseNativeProjectSave,
} from '../../ui/native-save.ts';
import { FileWriteCoordinator } from './file-write-coordinator.ts';
import {
  assertNotAborted,
  dateStamp,
  deliverArtifact,
  emitProgress,
  exportCanvasTextFiles,
  exportCurrentText,
  exportFilename,
  exportWord,
  formatBytes,
  isAbortError,
  isBlobLike,
  isCommitImportedDocumentsPayload,
  isExportTextPayload,
  isExportWordPayload,
  isFileSaveTarget,
  isImportDocumentsPayload,
  nextTaskTurn,
  parseImportedDocument,
  removeDirectoryEntry,
  renameDestination,
  reserveTextFile,
  scheduleOperation,
  textFilenameCandidate,
  writeProjectDestination,
  type CommitImportedDocumentsPayload,
  type ExportTextPayload,
  type ExportWordPayload,
  type ImportDocumentsPayload,
  type ImportedDocumentInput,
  type OpenProjectPayload,
  type SaveAndOpenPendingPayload,
  type SaveProjectPayload,
  type TextExportBinding,
} from './file-operations.ts';

const FILE_NAMESPACE = 'fileUI';
export function createImportExportPlugin(
  panel?: unknown,
  artifactHost?: unknown,
): PluginDefinition {
  let activeTask: TaskHandle<unknown> | undefined;
  let autosaveTask: TaskHandle<unknown> | undefined;
  let autosavePending = false;
  let fileWrites = new FileWriteCoordinator();
  let projectDestination: FileSaveTarget | undefined;
  let lastProjectSavedRevision: number | undefined;
  let saveLocationRequired = false;
  let cloudProjectActive = false;
  let pendingOpenFile: (Blob & { name?: string }) | undefined;
  let pendingOpenDestination: FileSaveTarget | undefined;
  let pendingOpen: FileRuntimeState['pendingOpen'];
  let openAuthorization: { id: string; expiresAt: number } | undefined;
  let pendingOpenedDocumentRevision: number | undefined;
  const textExportBindings = new Map<string, TextExportBinding>();
  return {
    manifest: defineManifest('import-export', '书籍与恢复', {
      optionalDependencies: ['cloud-sync'],
      namespaces: [FILE_NAMESPACE],
      namespaceDomains: { [FILE_NAMESPACE]: 'workspace' },
      optionalCapabilities: [
        'content.summaries@1',
        'content.read@1',
        'content.formatting@2',
        'content.createPlan@1',
        'selection.read@1',
        'editor.activeNode@1',
      ],
      providesCapabilities: [
        'file.state@1',
        'file.textExportState@1',
        PROJECT_RELATED_DIRECTORY_CAPABILITY,
        EXTERNAL_PROJECT_DIRECTORY_CAPABILITY,
      ],
      commands: [
        'file.openPanel',
        'file.closePanel',
        'file.saveProject',
        'file.saveProjectAs',
        'file.chooseOpenProject',
        'file.openProjectFromLibrary',
        'file.requestOpenProject',
        'file.openProject',
        'file.saveAndOpenPending',
        'file.proceedPendingOpen',
        'file.cancelPendingOpen',
        'file.importDocuments',
        'file.commitImportedDocuments',
        'file.exportCurrentText',
        'file.exportCurrentWord',
        'file.exportCanvasText',
        'file.exportText',
        'file.exportWord',
        'file.createRecoveryPoint',
        'file.restoreRecovery',
      ],
      dispatches: [
        'system.document.replace',
        'system.persistence.checkpoint',
        'system.persistence.setAutosaveInterval',
        'system.recovery.restore',
        'file.commitImportedDocuments',
        'cloudSync.syncNow',
        'cloudSync.disconnectProject',
        'cloudSync.saveCurrentAsProject',
      ],
      events: ['document.replaced', 'node.renamed'],
      asks: [
        'system.project.source', 'system.document.revision', 'system.persistence',
        'system.recovery.list', 'system.recovery.preview', 'cloudSync.state',
      ],
      signals: [
        'file.status', 'file.artifact.ready', 'file.recovery.changed',
        'file.save-state.changed', 'file.save-location.required', 'file.text-export-state.changed',
        'file.open-confirmation.changed',
        'system.persistence.automaticCheckpoint.completed', 'cloudSync.updated',
      ],
      ui: ['file.panel', 'file.artifact-host'],
      actions: [
        'file.save-action',
        'file.save-as-action',
        'file.choose-open-action',
        'file.open-action',
      ],
      shortcuts: [
        'file.choose-open-shortcut',
        'file.open-panel-shortcut',
        'file.close-shortcut',
        'file.save-shortcut',
        'file.save-as-shortcut',
        'file.export-current-text-shortcut',
        'file.export-current-word-shortcut',
        'file.export-canvas-text-shortcut',
        'file.create-recovery-shortcut',
      ],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.right.contribute',
        'ui.overlay.contribute',
        'ui.action.register',
        'ui.shortcut.register',
        'tasks.schedule',
        'persistence.manage',
      ],
    }),

    start(context) {
      activeTask = undefined;
      autosaveTask = undefined;
      autosavePending = false;
      fileWrites = new FileWriteCoordinator();
      projectDestination = undefined;
      lastProjectSavedRevision = undefined;
      saveLocationRequired = false;
      cloudProjectActive = false;
      pendingOpenFile = undefined;
      pendingOpenDestination = undefined;
      pendingOpen = undefined;
      openAuthorization = undefined;
      pendingOpenedDocumentRevision = undefined;
      textExportBindings.clear();
      const isOpen = () => context.store.readValue<boolean>(FILE_NAMESPACE, 'open') ?? false;
      const fileState = (): FileRuntimeState => ({
        open: isOpen(),
        savedDocumentRevision: lastProjectSavedRevision,
        hasProjectDestination: Boolean(projectDestination),
        cloudProjectActive,
        saveLocationRequired,
        pendingOpenName: pendingOpenFile?.name,
        pendingOpen: pendingOpen ? { ...pendingOpen } : undefined,
      });
      const publishPendingOpen = () => {
        if (pendingOpen) {
          context.ui.activateSurface('overlay.floating', 'file.artifact-host', 'file.cancelPendingOpen');
        } else {
          context.ui.deactivateSurface('overlay.floating', 'file.artifact-host');
        }
        context.signals.emit('file.open-confirmation.changed', {
          pending: Boolean(pendingOpen),
          ...(pendingOpen ?? {}),
        });
      };
      const clearPendingOpen = () => {
        pendingOpenFile = undefined;
        pendingOpenDestination = undefined;
        pendingOpen = undefined;
        publishPendingOpen();
      };
      const applyCloudState = (next: CloudSyncState) => {
        const wasActive = cloudProjectActive;
        cloudProjectActive = Boolean(next.activeProjectId);
        if (cloudProjectActive && saveLocationRequired) {
          saveLocationRequired = false;
          context.signals.emit('file.save-location.required', fileState());
        }
        if (wasActive !== cloudProjectActive) context.signals.emit('file.save-state.changed', fileState());
        if (cloudProjectActive && next.phase === 'ready' && next.pendingCommits === 0) {
          void context.queries.ask<DocumentRevisionSnapshot>('system.document.revision').then((snapshot) => {
            if (!cloudProjectActive) return;
            lastProjectSavedRevision = snapshot.revision;
            context.signals.emit('file.save-state.changed', fileState());
          }).catch(() => undefined);
        }
      };
      const readCloudState = async (): Promise<CloudSyncState | undefined> => {
        try {
          const next = await context.queries.ask<CloudSyncState>('cloudSync.state');
          applyCloudState(next);
          return next;
        } catch {
          return undefined;
        }
      };
      const saveActiveCloudProject = async (parent: MessageEnvelope): Promise<CloudSyncState | undefined> => {
        const before = await readCloudState();
        if (!before?.activeProjectId) return undefined;
        if (before.phase === 'read-only') throw new Error('当前云端书籍为只读，请先接管编辑权');
        if (before.phase === 'conflict') throw new Error('云端书籍存在版本冲突，请先在云同步面板处理');
        const next = await context.commands.invoke('cloudSync.syncNow');
        applyCloudState(next);
        if (next.phase !== 'ready' || next.pendingCommits > 0) {
          throw new Error(next.error || '云端暂未完成同步，本机恢复副本仍然保留');
        }
        const snapshot = await context.queries.ask<DocumentRevisionSnapshot>('system.document.revision');
        lastProjectSavedRevision = snapshot.revision;
        saveLocationRequired = false;
        context.signals.emit('file.save-state.changed', fileState());
        context.signals.emit('file.status', {
          operation: 'project-save', state: 'ready', message: '书籍已保存到云端', progress: 1,
        } satisfies FileOperationStatus, parent);
        return next;
      };
      const saveNewCloudProject = async (parent: MessageEnvelope): Promise<CloudSyncState | undefined> => {
        const before = await readCloudState();
        if (!before || before.activeProjectId || !before.authenticated ||
          !before.installations.some((item) => item.status === 'ready')) return undefined;
        await context.commands.invoke('cloudSync.saveCurrentAsProject');
        const next = await readCloudState();
        if (!next?.activeProjectId || next.phase !== 'ready' || next.pendingCommits > 0) {
          throw new Error(next?.error || '云端书籍尚未完成首次保存，本机恢复副本仍然保留');
        }
        const snapshot = await context.queries.ask<DocumentRevisionSnapshot>('system.document.revision');
        lastProjectSavedRevision = snapshot.revision;
        saveLocationRequired = false;
        context.signals.emit('file.save-state.changed', fileState());
        context.signals.emit('file.status', {
          operation: 'project-save', state: 'ready', message: '新书籍已保存到云端', progress: 1,
        } satisfies FileOperationStatus, parent);
        return next;
      };
      const disconnectActiveCloudProject = async () => {
        const current = await readCloudState();
        if (!current?.activeProjectId) return;
        await context.commands.invoke('cloudSync.disconnectProject');
        cloudProjectActive = false;
      };
      const currentCanvasIsDirty = async () => {
        const current = await context.queries.ask<DocumentRevisionSnapshot>('system.document.revision');
        return lastProjectSavedRevision === undefined || lastProjectSavedRevision !== current.revision;
      };
      const createOpenAuthorization = (requestedId?: string) => {
        const id = requestedId ?? crypto.randomUUID();
        openAuthorization = { id, expiresAt: Date.now() + 2 * 60_000 };
        return id;
      };
      const consumeOpenAuthorization = (id: string | undefined) => {
        if (!id || !openAuthorization || openAuthorization.id !== id || openAuthorization.expiresAt < Date.now()) {
          return false;
        }
        openAuthorization = undefined;
        return true;
      };
      const scheduleProjectOpen = (
        file: Blob & { name?: string },
        options: {
          saveCurrent: boolean;
          saveCurrentTo?: FileSaveTarget;
          openedProjectDestination?: FileSaveTarget;
        },
      ) => scheduleOperation(
        context,
        'project-open',
        options.saveCurrent ? '正在保存当前书籍并打开新书籍' : `正在校验 ${file.name ?? '书籍文件'}`,
        async (signal) => {
          await nextTaskTurn();
          if (options.saveCurrent) {
            const source = await context.queries.ask<ProjectSource>('system.project.source');
            const saveProgress = (progress: number) => emitProgress(
              context,
              'project-open',
              '正在保存当前书籍',
              progress * 0.45,
            );
            if (options.saveCurrentTo) {
              await writeProjectDestination(source, options.saveCurrentTo, signal, saveProgress, fileWrites);
            } else {
              const blob = await serializeProject(source, signal, saveProgress);
              await deliverArtifact(context, {
                filename: `${PRODUCT_NAME}-${dateStamp()}${PROJECT_FILE_EXTENSION}`,
                mimeType: blob.type,
                blob,
              }, undefined, signal, fileWrites);
            }
            lastProjectSavedRevision = source.document.revision;
            saveLocationRequired = false;
            context.signals.emit('file.save-state.changed', fileState());
          }
          const project = await parseProject(file, signal, (progress) => emitProgress(
            context,
            'project-open',
            '正在读取并校验新书籍文件',
            (options.saveCurrent ? 0.45 : 0) + progress * (options.saveCurrent ? 0.55 : 1),
          ));
          pendingOpenedDocumentRevision = project.manifest.documentRevision + 1;
          try {
            await context.commands.dispatch('system.document.replace', {
              ...project,
              origin: 'file',
            } satisfies ProjectOpenPayload);
          } catch (error) {
            pendingOpenedDocumentRevision = undefined;
            throw error;
          }
          // `document.replaced` clears the previous target. Rebind the opened
          // native handle afterwards so it belongs to the new active book.
          projectDestination = options.openedProjectDestination;
          clearPendingOpen();
          context.signals.emit('file.save-state.changed', fileState());
          return `已打开 ${file.name ?? '书籍文件'}`;
        },
        (task) => {
          activeTask?.cancel();
          activeTask = task;
        },
      );
      const setOpen = (open: boolean) => ({
        transaction: {
          label: open ? '打开文件面板' : '关闭文件面板',
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: FILE_NAMESPACE,
            key: 'open',
            value: open,
          }],
        },
      });

      context.commands.register({
        type: 'file.openPanel',
        handle: () => {
          context.ui.activateSurface('right.primary', 'file.panel', 'file.closePanel');
          return setOpen(true);
        },
      });
      context.commands.register({
        type: 'file.closePanel',
        handle: () => {
          context.ui.deactivateSurface('right.primary', 'file.panel');
          return setOpen(false);
        },
      });
      context.commands.register<SaveProjectPayload>({
        type: 'file.saveProject',
        validate: (payload): payload is SaveProjectPayload =>
          payload === undefined ||
          (isRecord(payload) &&
            (payload.destination === undefined || isFileSaveTarget(payload.destination)) &&
            (payload.mode === undefined || payload.mode === 'current' || payload.mode === 'copy')),
        handle: async (payload = {}, envelope) => {
          if (payload.mode !== 'copy' && payload.destination === undefined) {
            const cloud = await saveActiveCloudProject(envelope);
            if (cloud) return { result: cloud };
            if (!projectDestination) {
              const created = await saveNewCloudProject(envelope);
              if (created) return { result: created };
            }
          }
          // "保存" means update the opened book when a native handle exists;
          // only an unbound/downloaded book needs a first save-location choice.
          const destination = payload.destination ?? projectDestination ?? await chooseNativeProjectSave();
          return {
          result: scheduleOperation(context, 'project-save', '正在整理书籍文件', async (signal) => {
            await nextTaskTurn();
            // Project export already reads one immutable source snapshot. Do not
            // hold a file task while awaiting a second scheduler-owned checkpoint:
            // on a large canvas that creates a cost-budget dependency cycle and
            // can also starve unrelated AI generations.
            const source = await context.queries.ask<ProjectSource>('system.project.source');
            const report = (progress: number) => emitProgress(
              context, 'project-save', '正在按块整理书籍文件', progress,
            );
            const bytes = destination
              ? await writeProjectDestination(source, destination, signal, report, fileWrites)
              : await serializeProject(source, signal, report).then(async (blob) => {
                  await deliverArtifact(context, {
                    filename: `${PRODUCT_NAME}-${dateStamp()}${PROJECT_FILE_EXTENSION}`,
                    mimeType: blob.type,
                    blob,
                  }, undefined, signal, fileWrites);
                  return blob.size;
                });
            if (payload.mode !== 'copy') {
              if (destination) projectDestination = destination;
              lastProjectSavedRevision = source.document.revision;
              saveLocationRequired = false;
            }
            context.signals.emit('file.save-state.changed', fileState());
            return `${payload.mode === 'copy' ? '本地副本已另存' : '书籍已保存'}（${formatBytes(bytes)}）`;
          }, (task) => {
            activeTask?.cancel();
            activeTask = task;
          }),
        };
        },
      });

      context.commands.register({
        type: 'file.saveProjectAs',
        handle: async () => {
          const destination = await chooseNativeProjectSave();
          return {
            result: await context.commands.invoke('file.saveProject', {
              destination,
              mode: 'copy',
            }),
          };
        },
      });

      context.commands.register({
        type: 'file.chooseOpenProject',
        handle: async () => {
          const request = await context.commands.invoke('file.requestOpenProject');
          if (!request.openPicker) return { result: request };
          try {
            const destination = await chooseNativeProjectOpen();
            if (destination) {
              const file = await destination.getFile();
              await context.commands.invoke('file.openProject', { file, destination });
              return { result: { openPicker: false } };
            }
            pendingOpen = { kind: 'picker', phase: 'ready-to-choose' };
            publishPendingOpen();
            return { result: { openPicker: false } };
          } catch (reason) {
            if (reason instanceof DOMException && reason.name === 'AbortError') {
              return { result: { openPicker: false } };
            }
            throw reason;
          }
        },
      });

      context.commands.register({
        type: 'file.requestOpenProject',
        handle: async () => {
          if (!await currentCanvasIsDirty()) {
            clearPendingOpen();
            return { result: { openPicker: true } };
          }
          pendingOpenFile = undefined;
          pendingOpenDestination = undefined;
          pendingOpen = { kind: 'picker', phase: 'needs-decision' };
          publishPendingOpen();
          return { result: { openPicker: false } };
        },
      });

      context.commands.register<LibraryProjectOpenPayload>({
        type: 'file.openProjectFromLibrary',
        validate: (payload): payload is LibraryProjectOpenPayload =>
          isRecord(payload) && isBlobLike(payload.file) &&
          (payload.destination === undefined || isFileSaveTarget(payload.destination)),
        handle: async (payload) => {
          clearPendingOpen();
          await disconnectActiveCloudProject();
          return {
            result: scheduleProjectOpen(payload.file, {
              saveCurrent: false,
              openedProjectDestination: payload.destination,
            }),
          };
        },
      });

      context.commands.register<OpenProjectPayload>({
        type: 'file.openProject',
        validate: (payload): payload is OpenProjectPayload =>
          isRecord(payload) && isBlobLike(payload.file) &&
          (payload.destination === undefined || isFileSaveTarget(payload.destination)) &&
          (payload.authorizationId === undefined || typeof payload.authorizationId === 'string'),
        handle: async (payload) => {
          if (!consumeOpenAuthorization(payload.authorizationId) && await currentCanvasIsDirty()) {
            pendingOpenFile = payload.file;
            pendingOpenDestination = payload.destination;
            pendingOpen = {
              kind: 'file',
              phase: 'needs-decision',
              fileName: payload.file.name,
            };
            publishPendingOpen();
            return { result: { pending: true, fileName: payload.file.name } };
          }
          clearPendingOpen();
          await disconnectActiveCloudProject();
          return {
            result: scheduleProjectOpen(payload.file, {
              saveCurrent: false,
              openedProjectDestination: payload.destination,
            }),
          };
        },
      });
      context.commands.register<SaveAndOpenPendingPayload>({
        type: 'file.saveAndOpenPending',
        validate: (payload): payload is SaveAndOpenPendingPayload =>
          payload === undefined || (isRecord(payload) &&
            (payload.destination === undefined || isFileSaveTarget(payload.destination))),
        handle: async (payload = {}, envelope) => {
          const intent = pendingOpen;
          if (!intent) throw new Error('没有等待处理的打开请求');
          if (payload.destination === undefined && await saveActiveCloudProject(envelope)) {
            if (intent.kind === 'file') {
              const file = pendingOpenFile;
              if (!file) throw new Error('等待打开的书籍文件已经失效');
              const openedProjectDestination = pendingOpenDestination;
              clearPendingOpen();
              await disconnectActiveCloudProject();
              return {
                result: scheduleProjectOpen(file, { saveCurrent: false, openedProjectDestination }),
              };
            }
            pendingOpen = { kind: 'picker', phase: 'ready-to-choose' };
            publishPendingOpen();
            return { result: { openPicker: false } };
          }
          const destination = payload.destination ?? projectDestination ?? await chooseNativeProjectSave();
          if (intent.kind === 'file') {
            const file = pendingOpenFile;
            if (!file) throw new Error('等待打开的书籍文件已经失效');
            return {
              result: scheduleProjectOpen(file, {
                saveCurrent: true,
                saveCurrentTo: destination,
                openedProjectDestination: pendingOpenDestination,
              }),
            };
          }
          return {
            result: scheduleOperation(context, 'project-save', '正在保存当前书籍', async (signal) => {
              await nextTaskTurn();
              const source = await context.queries.ask<ProjectSource>('system.project.source');
              const report = (progress: number) => emitProgress(
                context, 'project-save', '正在保存当前书籍', progress,
              );
              if (destination) {
                await writeProjectDestination(source, destination, signal, report, fileWrites);
                projectDestination = destination;
              } else {
                const blob = await serializeProject(source, signal, report);
                await deliverArtifact(context, {
                  filename: `${PRODUCT_NAME}-${dateStamp()}${PROJECT_FILE_EXTENSION}`,
                  mimeType: blob.type,
                  blob,
                }, undefined, signal, fileWrites);
              }
              lastProjectSavedRevision = source.document.revision;
              saveLocationRequired = false;
              pendingOpen = { kind: 'picker', phase: 'ready-to-choose' };
              context.signals.emit('file.save-state.changed', fileState());
              publishPendingOpen();
              return '当前书籍已保存，请继续选择要打开的书籍';
            }, (task) => {
              activeTask?.cancel();
              activeTask = task;
            }),
          };
        },
      });
      context.commands.register({
        type: 'file.proceedPendingOpen',
        validate: (payload): payload is { authorizationId?: string } | undefined =>
          payload === undefined || (isRecord(payload) &&
            (payload.authorizationId === undefined || typeof payload.authorizationId === 'string')),
        handle: async (payload) => {
          const intent = pendingOpen;
          if (!intent) throw new Error('没有等待处理的打开请求');
          if (intent.kind === 'file') {
            const file = pendingOpenFile;
            if (!file) throw new Error('等待打开的书籍文件已经失效');
            const openedProjectDestination = pendingOpenDestination;
            clearPendingOpen();
            await disconnectActiveCloudProject();
            scheduleProjectOpen(file, { saveCurrent: false, openedProjectDestination });
            return {
              result: {
                openPicker: false,
                openedDroppedFile: true,
              },
            };
          }
          if (intent.phase === 'ready-to-choose' && await currentCanvasIsDirty()) {
            pendingOpen = { kind: 'picker', phase: 'needs-decision' };
            publishPendingOpen();
            return { result: { openPicker: false } };
          }
          const authorizationId = createOpenAuthorization(payload?.authorizationId);
          clearPendingOpen();
          return { result: { openPicker: true, authorizationId } };
        },
      });
      context.commands.register({
        type: 'file.cancelPendingOpen',
        handle: () => {
          const cancelled = Boolean(pendingOpen);
          if (cancelled) clearPendingOpen();
          return { result: { cancelled } };
        },
      });

      context.commands.register<ImportDocumentsPayload>({
        type: 'file.importDocuments',
        validate: isImportDocumentsPayload,
        handle: (payload) => ({
          result: scheduleOperation(context, 'document-import', '正在读取拖入的文本文件', async (signal) => {
            await nextTaskTurn();
            const documents: ImportedDocumentInput[] = [];
            for (let index = 0; index < payload.files.length; index += 1) {
              const file = payload.files[index];
              assertNotAborted(signal);
              const parsed = await parseImportedDocument(file, signal);
              documents.push({
                ...parsed,
                x: payload.x + (index % 3) * 320,
                y: payload.y + Math.floor(index / 3) * 230,
              });
              emitProgress(
                context,
                'document-import',
                `正在读取 ${file.name ?? `文件 ${index + 1}`}`,
                (index + 1) / (payload.files.length + 1),
              );
              await nextTaskTurn();
            }
            await context.commands.dispatch('file.commitImportedDocuments', { documents });
            emitProgress(context, 'document-import', '文本节点已经创建', 1);
            return `已导入 ${documents.length} 个文本节点`;
          }, (task) => {
            activeTask?.cancel();
            activeTask = task;
          }),
        }),
      });

      context.commands.register<CommitImportedDocumentsPayload, { ids: string[] }>({
        type: 'file.commitImportedDocuments',
        validate: isCommitImportedDocumentsPayload,
        handle: async (payload) => {
          const plans: ContentMutationPlan[] = [];
          const reservedTitles: string[] = [];
          for (const document of payload.documents) {
            const plan = await context.capabilities.request<ContentMutationPlan>(
              'content.createPlan@1',
              { ...document, reservedTitles } satisfies ContentCreatePlanRequest,
            );
            plans.push(plan);
            if (plan.resolvedTitle) reservedTitles.push(plan.resolvedTitle);
          }
          return {
            result: { ids: plans.map((plan) => plan.nodeId) },
            transaction: {
              label: plans.length > 1 ? `导入 ${plans.length} 个文本文件` : '导入文本文件',
              patches: plans.flatMap((plan) => plan.patches),
              events: plans.flatMap((plan) => plan.events ?? []),
            },
          };
        },
      });

      context.commands.register<ExportTextPayload>({
        type: 'file.exportText',
        validate: isExportTextPayload,
        handle: (payload) => {
          if (payload.scope === 'canvas') {
            return {
              result: scheduleOperation(context, 'text-export', '正在逐个导出画布节点', async (signal) => {
                await nextTaskTurn();
                const result = await exportCanvasTextFiles(
                  context,
                  payload.directory,
                  signal,
                  (progress) => emitProgress(
                    context,
                    'text-export',
                    '正在逐个导出画布节点',
                    progress,
                  ),
                  fileWrites,
                  textExportBindings,
                );
                for (const [nodeId, binding] of result.bindings) {
                  textExportBindings.set(nodeId, binding);
                  context.signals.emit('file.text-export-state.changed', { nodeId });
                }
                return `已导出 ${result.count} 个 TXT（${formatBytes(result.totalBytes)}）`;
              }, (task) => {
                activeTask?.cancel();
                activeTask = task;
              }),
            };
          }
          return {
            result: scheduleOperation(context, 'text-export', '正在按块导出正文', async (signal) => {
              await nextTaskTurn();
              const exported = await exportCurrentText(
                context,
                signal,
                (progress) => emitProgress(context, 'text-export', '正在按块导出正文', progress),
                payload.nodeId,
              );
              await deliverArtifact(context, exported.artifact, payload.destination, signal, fileWrites);
              if (payload.destination) {
                textExportBindings.set(exported.node.id, {
                  destination: payload.destination,
                  filename: payload.destination.name || exported.artifact.filename,
                  format: 'txt',
                  revision: exported.node.revision,
                  exportedTitle: exported.node.title,
                  filenameTitle: exported.node.title,
                  renameRequired: false,
                });
                context.signals.emit('file.text-export-state.changed', { nodeId: exported.node.id });
              }
              return `TXT 已生成（${formatBytes(exported.artifact.blob.size)}）`;
            }, (task) => {
              activeTask?.cancel();
              activeTask = task;
            }),
          };
        },
      });

      context.commands.register<ExportWordPayload>({
        type: 'file.exportWord',
        validate: isExportWordPayload,
        handle: (payload) => ({
          result: scheduleOperation(context, 'word-export', '正在生成 Word 文档', async (signal) => {
            await nextTaskTurn();
            const exported = await exportWord(context, signal, (progress) => emitProgress(
              context,
              'word-export',
              '正在生成 Word 文档',
              progress,
            ), payload.nodeId);
            await deliverArtifact(context, exported.artifact, payload.destination, signal, fileWrites);
            if (payload.destination) {
              textExportBindings.set(exported.node.id, {
                destination: payload.destination,
                filename: payload.destination.name || exported.artifact.filename,
                format: 'docx',
                revision: exported.node.revision,
                exportedTitle: exported.node.title,
                filenameTitle: exported.node.title,
                renameRequired: false,
              });
              context.signals.emit('file.text-export-state.changed', { nodeId: exported.node.id });
            }
            return `Word 已生成（${formatBytes(exported.artifact.blob.size)}）`;
          }, (task) => {
            activeTask?.cancel();
            activeTask = task;
          }),
        }),
      });

      context.commands.register({
        type: 'file.exportCurrentText',
        handle: async () => ({
          result: await context.commands.invoke('file.exportText', { scope: 'current' }),
        }),
      });
      context.commands.register({
        type: 'file.exportCurrentWord',
        handle: async () => ({
          result: await context.commands.invoke('file.exportWord', { scope: 'current' }),
        }),
      });
      context.commands.register({
        type: 'file.exportCanvasText',
        handle: async () => ({
          result: await context.commands.invoke('file.exportText', { scope: 'canvas' }),
        }),
      });

      context.commands.register({
        type: 'file.createRecoveryPoint',
        handle: () => ({
          result: scheduleOperation(context, 'recovery', '正在创建恢复点', async () => {
            await nextTaskTurn();
            await context.commands.dispatch('system.persistence.checkpoint', {
              label: `手动恢复点 ${new Date().toLocaleString('zh-CN')}`,
            });
            context.signals.emit('file.recovery.changed');
            return '恢复点已创建';
          }, (task) => {
            activeTask?.cancel();
            activeTask = task;
          }),
        }),
      });

      context.commands.register<{ id: string }>({
        type: 'file.restoreRecovery',
        validate: (payload): payload is { id: string } => isRecord(payload) && typeof payload.id === 'string',
        handle: (payload) => ({
          result: scheduleOperation(context, 'recovery', '正在恢复画布', async () => {
            await nextTaskTurn();
            await context.commands.dispatch('system.recovery.restore', { id: payload.id });
            context.signals.emit('file.recovery.changed');
            return '恢复点已载入';
          }, (task) => {
            activeTask?.cancel();
            activeTask = task;
          }),
        }),
      });

      context.events.subscribe('document.replaced', () => {
        autosaveTask?.cancel();
        autosaveTask = undefined;
        autosavePending = false;
        textExportBindings.clear();
        projectDestination = undefined;
        lastProjectSavedRevision = pendingOpenedDocumentRevision;
        pendingOpenedDocumentRevision = undefined;
        saveLocationRequired = false;
        context.signals.emit('file.recovery.changed');
        context.signals.emit('file.save-state.changed', fileState());
        context.signals.emit('file.text-export-state.changed', { all: true });
      });
      context.signals.subscribe<CloudSyncState>('cloudSync.updated', (message) => applyCloudState(message.payload));
      void readCloudState();
      context.events.subscribe<{ id: string }>('node.renamed', (message) => {
        const binding = textExportBindings.get(message.payload.id);
        if (!binding) return;
        textExportBindings.set(message.payload.id, { ...binding, renameRequired: true });
        context.signals.emit('file.text-export-state.changed', { nodeId: message.payload.id });
      });
      const scheduleAutomaticOutputs = () => {
        if (autosaveTask) {
          autosavePending = true;
          return;
        }
        autosavePending = false;
        if (!projectDestination && !cloudProjectActive) {
          saveLocationRequired = true;
          context.signals.emit('file.save-location.required', fileState());
          context.signals.emit('file.save-state.changed', fileState());
        }
        if (!projectDestination && textExportBindings.size === 0) return;
        const destination = projectDestination;
        const boundExports = [...textExportBindings.entries()];
        const task = context.tasks.schedule<string>({
          category: 'file-project-autosave',
          label: boundExports.length > 0 ? '正在自动保存书籍并导出文本' : '正在自动保存书籍',
          priority: 44,
          timeoutMs: 5 * 60_000,
          noticeAfterMs: 0,
          estimatedCost: 8,
          run: async (signal, report) => {
            report(0.08);
            let projectBytes = 0;
            if (destination) {
              const source = await context.queries.ask<ProjectSource>('system.project.source');
              projectBytes = await writeProjectDestination(
                source,
                destination,
                signal,
                (progress) => report(0.08 + progress * 0.55),
                fileWrites,
              );
              lastProjectSavedRevision = source.document.revision;
              saveLocationRequired = false;
              context.signals.emit('file.save-state.changed', fileState());
            }
            let exportedCount = 0;
            let renamedCount = 0;
            let renamePendingCount = 0;
            if (boundExports.length > 0) {
              const summaries = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
              const byId = new Map(summaries.map((node) => [node.id, node]));
              for (let index = 0; index < boundExports.length; index += 1) {
                const [nodeId, binding] = boundExports[index];
                if (textExportBindings.get(nodeId) !== binding) continue;
                const node = byId.get(nodeId);
                if (!node) {
                  textExportBindings.delete(nodeId);
                  continue;
                }
                const contentChanged = node.revision !== binding.revision || node.title !== binding.exportedTitle;
                const filenameChanged = node.title !== binding.filenameTitle;
                if (!contentChanged && !filenameChanged && !binding.obsoleteFilenames?.length) continue;
                if (binding.directory && binding.format === 'txt') {
                  const obsolete = new Set(binding.obsoleteFilenames ?? []);
                  for (const filename of [...obsolete]) {
                    if (await removeDirectoryEntry(binding.directory, filename)) obsolete.delete(filename);
                  }
                  let nextDestination = binding.destination;
                  let nextFilename = binding.filename;
                  const preferredFilename = textFilenameCandidate(node.title, 1);
                  const actualFilenameChanged = filenameChanged &&
                    preferredFilename.toLocaleLowerCase('zh-CN') !== binding.filename.toLocaleLowerCase('zh-CN');
                  if (actualFilenameChanged) {
                    const reservedNames = new Set(boundExports
                      .filter(([otherId, other]) => otherId !== nodeId && other.directory === binding.directory)
                      .map(([, other]) => other.filename.toLocaleLowerCase('zh-CN')));
                    const output = await reserveTextFile(binding.directory, node.title, reservedNames);
                    const exported = await exportCurrentText(context, signal, () => undefined, nodeId);
                    await deliverArtifact(
                      context,
                      { ...exported.artifact, filename: output.filename },
                      output.destination,
                      signal,
                      fileWrites,
                    );
                    nextDestination = output.destination;
                    nextFilename = output.filename;
                    obsolete.add(binding.filename);
                    exportedCount += 1;
                    for (const filename of [...obsolete]) {
                      if (await removeDirectoryEntry(binding.directory, filename)) obsolete.delete(filename);
                    }
                  } else if (contentChanged) {
                    const exported = await exportCurrentText(context, signal, () => undefined, nodeId);
                    await deliverArtifact(
                      context,
                      { ...exported.artifact, filename: binding.filename },
                      binding.destination,
                      signal,
                      fileWrites,
                    );
                    exportedCount += 1;
                  }
                  if (textExportBindings.get(nodeId) !== binding) continue;
                  const renameRequired = obsolete.size > 0;
                  textExportBindings.set(nodeId, {
                    ...binding,
                    destination: nextDestination,
                    filename: nextFilename,
                    revision: node.revision,
                    exportedTitle: node.title,
                    filenameTitle: node.title,
                    renameRequired,
                    ...(renameRequired ? { obsoleteFilenames: [...obsolete] } : { obsoleteFilenames: undefined }),
                  });
                  context.signals.emit('file.text-export-state.changed', { nodeId });
                  if (filenameChanged && !renameRequired) renamedCount += 1;
                  if (renameRequired) renamePendingCount += 1;
                  report(0.65 + (index + 1) / boundExports.length * 0.35);
                  continue;
                }
                let renamed = !filenameChanged;
                if (contentChanged) {
                  const exported = binding.format === 'docx'
                    ? await exportWord(context, signal, () => undefined, nodeId)
                    : await exportCurrentText(context, signal, () => undefined, nodeId);
                  renamed = await deliverArtifact(
                    context,
                    exported.artifact,
                    binding.destination,
                    signal,
                    fileWrites,
                    filenameChanged ? exported.artifact.filename : undefined,
                  );
                  exportedCount += 1;
                } else if (filenameChanged) {
                  renamed = await renameDestination(
                    binding.destination,
                    exportFilename(node.title, binding.format),
                    signal,
                    fileWrites,
                  );
                }
                if (textExportBindings.get(nodeId) !== binding) continue;
                const renameRequired = filenameChanged && !renamed;
                textExportBindings.set(nodeId, {
                  ...binding,
                  filename: renamed ? exportFilename(node.title, binding.format) : binding.filename,
                  revision: node.revision,
                  exportedTitle: node.title,
                  filenameTitle: renamed ? node.title : binding.filenameTitle,
                  renameRequired,
                });
                context.signals.emit('file.text-export-state.changed', { nodeId });
                if (filenameChanged && renamed) renamedCount += 1;
                if (renameRequired) renamePendingCount += 1;
                report(0.65 + (index + 1) / boundExports.length * 0.35);
              }
            }
            report(1);
            const canvasMessage = destination ? `书籍 ${formatBytes(projectBytes)}` : '书籍本地存档';
            const suffix = renamePendingCount > 0
              ? `；${renamePendingCount} 个导出文件名需点击导出后重新选择位置`
              : renamedCount > 0 ? `，并同步 ${renamedCount} 个导出文件名` : '';
            return exportedCount > 0
              ? `${canvasMessage}已自动保存，并覆盖导出 ${exportedCount} 个文本${suffix}`
              : `${canvasMessage}已自动保存${suffix}`;
          },
        });
        autosaveTask = task;
        void task.result.catch((error) => {
          if (!isAbortError(error)) context.signals.emit('file.status', {
            operation: 'project-save', state: 'error',
            message: error instanceof Error ? error.message : String(error),
          } satisfies FileOperationStatus);
        }).finally(() => {
          if (autosaveTask !== task) return;
          autosaveTask = undefined;
          if (autosavePending) scheduleAutomaticOutputs();
        });
      };
      context.signals.subscribe<{ documentRevision: number }>(
        'system.persistence.automaticCheckpoint.completed',
        scheduleAutomaticOutputs,
      );
      context.capabilities.provide({ key: 'file.state@1', invoke: fileState });
      context.capabilities.provide<undefined, FileDirectoryTarget | undefined>({
        key: PROJECT_RELATED_DIRECTORY_CAPABILITY,
        invoke: () => chooseNativeDirectoryNearProject(projectDestination),
      });
      context.capabilities.provide<undefined, FileDirectoryTarget | undefined>({
        key: EXTERNAL_PROJECT_DIRECTORY_CAPABILITY,
        invoke: () => chooseNativeExternalProjectDirectory(),
      });
      context.capabilities.provide<{ nodeId: string }>({
        key: 'file.textExportState@1',
        invoke: ({ nodeId }) => {
          const binding = textExportBindings.get(nodeId);
          return binding
            ? {
                exported: true,
                revision: binding.revision,
                format: binding.format,
                renameRequired: binding.renameRequired,
              }
            : { exported: false };
        },
      });

      context.ui.contribute({
        id: 'file.panel',
        slot: 'right.primary',
        kind: 'view',
        label: '书籍与恢复',
        component: panel,
        priority: -10,
      });
      context.ui.contribute({
        id: 'file.artifact-host',
        slot: 'overlay.floating',
        kind: 'view',
        label: '文件下载通道',
        component: artifactHost,
        priority: -1000,
      });
      if (isOpen()) context.ui.activateSurface('right.primary', 'file.panel', 'file.closePanel');
      context.ui.shortcut({
        id: 'file.choose-open-shortcut',
        chord: 'mod+o',
        command: 'file.chooseOpenProject',
        label: '打开书籍',
      });
      context.ui.shortcut({
        id: 'file.open-panel-shortcut',
        command: 'file.openPanel',
        label: '打开书籍与恢复面板',
      });
      context.ui.shortcut({
        id: 'file.close-shortcut',
        command: 'file.closePanel',
        label: '关闭书籍与恢复面板',
        category: '文件',
      });
      context.ui.shortcut({
        id: 'file.save-shortcut',
        chord: 'mod+s',
        command: 'file.saveProject',
        label: '保存书籍',
        category: '文件',
        allowInEditable: true,
      });
      context.ui.shortcut({
        id: 'file.save-as-shortcut',
        command: 'file.saveProjectAs',
        label: '另存本地副本',
        category: '文件',
      });
      context.ui.shortcut({
        id: 'file.export-current-text-shortcut',
        command: 'file.exportCurrentText',
        label: '导出当前文本节点为 TXT',
        category: '文件',
      });
      context.ui.shortcut({
        id: 'file.export-current-word-shortcut',
        command: 'file.exportCurrentWord',
        label: '导出当前文本节点为 Word',
        category: '文件',
      });
      context.ui.shortcut({
        id: 'file.export-canvas-text-shortcut',
        command: 'file.exportCanvasText',
        label: '导出全画布文本为 TXT',
        category: '文件',
      });
      context.ui.shortcut({
        id: 'file.create-recovery-shortcut',
        command: 'file.createRecoveryPoint',
        label: '创建手动恢复点',
        category: '文件',
      });
      context.ui.action({
        id: 'file.save-action',
        label: '保存书籍',
        command: 'file.saveProject',
        category: '文件',
        keywords: ['保存', '云端', '同步', 'save'],
        priority: -300,
      });
      context.ui.action({
        id: 'file.save-as-action',
        label: '另存本地副本',
        command: 'file.saveProjectAs',
        category: '文件',
        keywords: ['另存', '副本', '下载', 'export', 'save as'],
        priority: -200,
      });
      context.ui.action({
        id: 'file.choose-open-action',
        label: '打开书籍',
        command: 'file.chooseOpenProject',
        category: '文件',
        keywords: ['打开', '本地', '文件', 'open'],
        priority: -100,
      });
      context.ui.action({
        id: 'file.open-action',
        label: '书籍与恢复设置',
        command: 'file.openPanel',
        category: '文件',
        keywords: ['书籍', '恢复', '自动保存', '导出', '设置', 'file'],
        priority: 50,
      });
    },

    stop() {
      activeTask?.cancel();
      autosaveTask?.cancel();
      activeTask = undefined;
      autosaveTask = undefined;
      autosavePending = false;
      projectDestination = undefined;
      pendingOpenFile = undefined;
      pendingOpenDestination = undefined;
      pendingOpen = undefined;
      openAuthorization = undefined;
      pendingOpenedDocumentRevision = undefined;
      textExportBindings.clear();
    },
  };
}
