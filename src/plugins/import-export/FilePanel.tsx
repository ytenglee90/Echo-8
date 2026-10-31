'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type {
  FileArtifact,
  FileOperationStatus,
  FileRuntimeState,
  RecoveryPointSummary,
  RecoveryPreview,
} from '../../protocols/files.ts';
import {
  AUTOSAVE_DISABLED_INTERVAL_MS,
  AUTOSAVE_INTERVAL_OPTIONS,
  AUTOSAVE_REALTIME_INTERVAL_MS,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  PROJECT_FILE_EXTENSION,
  PROJECT_OPEN_ACCEPT,
  type PersistenceSnapshot,
  type FileSaveTarget,
} from '../../protocols/files.ts';
import { PRODUCT_NAME } from '../../product.ts';
import { Icon, IconButton } from '../../ui/Icon.tsx';
import { ProcessingLabel } from '../../ui/ProcessingIndicator.tsx';
import {
  chooseNativeTextExport,
  chooseNativeTextExportDirectory,
  chooseNativeProjectOpen,
} from '../../services/native-save.ts';

export function FilePanel({ client }: { client: ViewClient }) {
  const fileVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion('fileUI'),
    () => 0,
  );
  const documentRevision = useSyncExternalStore(client.subscribeState, client.getDocumentVersion, () => 0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<FileOperationStatus>();
  const [persistence, setPersistence] = useState<PersistenceSnapshot>();
  const [recoveryPoints, setRecoveryPoints] = useState<RecoveryPointSummary[]>([]);
  const [confirmRestore, setConfirmRestore] = useState<string>();
  const [recoveryPreview, setRecoveryPreview] = useState<RecoveryPreview>();
  const [settingsError, setSettingsError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [savedDocumentRevision, setSavedDocumentRevision] = useState<number>();
  const [fileState, setFileState] = useState<FileRuntimeState>();

  useEffect(() => {
    let current = true;
    void client.request<{ open: boolean }>('file.state@1').then((state) => current && setOpen(state.open));
    return () => {
      current = false;
    };
  }, [client, fileVersion]);

  useEffect(() => {
    let current = true;
    if (!open) return () => {
      current = false;
    };
    void Promise.all([
      client.ask<PersistenceSnapshot>('system.persistence'),
      client.ask<RecoveryPointSummary[]>('system.recovery.list'),
    ]).then(([nextPersistence, nextRecovery]) => {
      if (!current) return;
      setPersistence(nextPersistence);
      setRecoveryPoints(nextRecovery);
    });
    return () => {
      current = false;
    };
  }, [client, open, reloadToken]);

  useEffect(
    () => client.subscribeSignal<FileOperationStatus>('file.status', (message) => {
      setStatus(message.payload);
      if (message.payload.state !== 'running') setReloadToken((value) => value + 1);
    }),
    [client],
  );

  useEffect(() => {
    let current = true;
    const refresh = () => void client.request<FileRuntimeState>('file.state@1')
      .then((state) => {
        if (!current) return;
        setFileState(state);
        setSavedDocumentRevision(state.savedDocumentRevision);
      })
      .catch(() => undefined);
    refresh();
    const unsubscribe = client.subscribeSignal('file.save-state.changed', refresh);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [client]);

  useEffect(
    () => client.subscribeSignal('file.recovery.changed', () => {
      setConfirmRestore(undefined);
      setRecoveryPreview(undefined);
      setReloadToken((value) => value + 1);
    }),
    [client],
  );

  if (!open) return null;

  const busy = status?.state === 'running';
  const close = () => void client.dispatch('file.closePanel');
  const exportCurrent = () => {
    void (async () => {
      try {
        const choice = await chooseNativeTextExport(`${PRODUCT_NAME}-当前节点`);
        await client.dispatch(
          choice.format === 'docx' ? 'file.exportWord' : 'file.exportText',
          { scope: 'current', destination: choice.destination },
        );
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setStatus({
          operation: 'text-export',
          state: 'error',
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    })();
  };
  const saveProject = () => {
    void client.dispatch('file.saveProject').catch((reason) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setStatus({
          operation: 'project-save',
          state: 'error',
          message: reason instanceof Error ? reason.message : String(reason),
        });
    });
  };
  const saveProjectAs = () => {
    void client.dispatch('file.saveProjectAs').catch((reason) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setStatus({
        operation: 'project-save',
        state: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    });
  };
  const exportCanvas = () => {
    void (async () => {
      try {
        const directory = await chooseNativeTextExportDirectory();
        await client.dispatch('file.exportText', { scope: 'canvas', directory });
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setStatus({
          operation: 'text-export',
          state: 'error',
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    })();
  };
  const requestOpen = () => {
    if (savedDocumentRevision !== undefined && savedDocumentRevision === documentRevision) {
      void client.dispatch('file.requestOpenProject').catch(() => undefined);
      void (async () => {
        try {
          const destination = await chooseNativeProjectOpen();
          if (destination) {
            const file = await destination.getFile();
            await client.dispatch('file.openProject', { file, destination });
            return;
          }
          inputRef.current?.click();
        } catch (reason) {
          if (reason instanceof DOMException && reason.name === 'AbortError') return;
          setStatus({
            operation: 'project-open',
            state: 'error',
            message: reason instanceof Error ? reason.message : String(reason),
          });
        }
      })();
      return;
    }
    void client.dispatch('file.requestOpenProject').catch((reason) => setStatus({
        operation: 'project-open',
        state: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      }));
  };

  return (
    <section className="file-panel" aria-label="书籍与恢复">
      <div className="file-heading">
        <div>
          <span className="eyebrow">本地文件与数据保险</span>
          <h2>书籍与恢复</h2>
        </div>
        <IconButton icon="close" label="关闭书籍与恢复面板" onClick={close} />
      </div>

      <div className="file-section">
        <div className="file-section-title">
          <strong className="file-project-kind"><Icon name="echo-file" size={16} />{PRODUCT_NAME} 书籍</strong>
          <span>{PROJECT_FILE_EXTENSION} · 压缩当前快照与校验和</span>
        </div>
        <div className="file-actions">
          <IconButton
            icon="save"
            label={fileState?.cloudProjectActive ? '保存到云端' : '保存书籍'}
            className="primary-icon-button"
            disabled={busy}
            onClick={saveProject}
          />
          <IconButton icon="save-as" label="另存本地副本" disabled={busy} onClick={saveProjectAs} />
          <IconButton icon="folder-open" label="打开书籍" disabled={busy} onClick={requestOpen} />
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept={PROJECT_OPEN_ACCEPT}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void client.dispatch('file.openProject', { file });
            }}
          />
        </div>
        <p className="file-note">{fileState?.cloudProjectActive
          ? '“保存”直接同步当前云端书籍，不再要求选择本地地址；“另存”只导出一份本地 .echo8 副本，不改变云端保存目标。'
          : '默认保存当前书籍快照，不携带撤销历史、恢复日志、个人主题、编辑器宽度或 API KEY；打开后从新的撤销历史开始。'}</p>
      </div>

      <div className="file-section">
        <div className="file-section-title">
          <strong>纯文本导出</strong>
          <span>分块读取，不加载全部正文到编辑器</span>
        </div>
        <div className="file-actions">
          <IconButton icon="download" label="导出当前节点" disabled={busy} onClick={exportCurrent} />
          <IconButton icon="download" label="将全画布节点分别导出为 TXT" disabled={busy} onClick={exportCanvas} />
        </div>
        <p className="file-note">当前节点先导出标题段，再导出正文段；全画布先选择保存文件夹，每个节点生成一份以标题命名的 TXT。</p>
      </div>

      <div className="file-section">
        <div className="file-section-title">
          <strong>保存与恢复</strong>
          <span>{!persistence || persistence.state === 'saving' || persistence.state === 'pending'
            ? <ProcessingLabel size={9}>{persistenceLabel(
                persistence,
                fileState?.hasProjectDestination === true,
                fileState?.cloudProjectActive === true,
              )}</ProcessingLabel>
            : persistenceLabel(
                persistence,
                fileState?.hasProjectDestination === true,
                fileState?.cloudProjectActive === true,
              )}</span>
        </div>
        <div className="persistence-detail">
          <span>待合并日志 {persistence?.journalEntries ?? 0} 条</span>
          <span>恢复点 {persistence?.recoveryPoints ?? recoveryPoints.length} 个</span>
          <span>{persistence?.checkpointAt ? `完整检查点 ${formatTime(persistence.checkpointAt)}` : '尚无完整检查点'}</span>
        </div>
        <label className="autosave-interval-control">
          <span>自动保存当前目标</span>
          <select
            aria-label="自动保存当前目标的间隔"
            value={persistence?.autosaveIntervalMs ?? DEFAULT_AUTOSAVE_INTERVAL_MS}
            disabled={!persistence}
            onChange={(event) => {
              const intervalMs = Number(event.target.value);
              setSettingsError('');
              void client.dispatch('system.persistence.setAutosaveInterval', { intervalMs })
                .then(setPersistence)
                .catch((reason) => setSettingsError(reason instanceof Error ? reason.message : String(reason)));
            }}
          >
            {AUTOSAVE_INTERVAL_OPTIONS.map((intervalMs) => (
              <option value={intervalMs} key={intervalMs}>{formatAutosaveInterval(intervalMs)}</option>
            ))}
          </select>
        </label>
        <p className="file-note autosave-interval-note">{
          persistence?.autosaveIntervalMs === AUTOSAVE_DISABLED_INTERVAL_MS
            ? fileState?.cloudProjectActive
              ? '自动保存已关闭；本机恢复仍持续记录，云端书籍只在手动保存、切换书籍或退出当前绑定时刷新。'
              : fileState?.hasProjectDestination
                ? '自动保存已关闭；本机恢复仍持续记录，当前书籍文件只在手动保存时覆盖。'
                : '自动保存已关闭；后台仍更新本机浏览器恢复副本，但不会生成或覆盖 .echo8 文件。'
            : fileState?.cloudProjectActive
              ? '浏览器会持续更新本机恢复副本，并按上方间隔把编辑保存到当前云端书籍。'
              : fileState?.hasProjectDestination
                ? '浏览器会持续更新本机恢复副本，并按上方间隔覆盖当前书籍文件。'
                : '当前尚未选择书籍保存位置：后台只更新本机浏览器恢复副本（IndexedDB），不会生成 .echo8 文件、不会写入任何文件夹；要长期保留，请点击“保存书籍”。'
        }</p>
        {settingsError && <p className="autosave-settings-error" role="alert">{settingsError}</p>}
        <IconButton icon="snapshot" label="创建手动恢复点" className="icon-button recovery-create" disabled={busy} onClick={() => void client.dispatch('file.createRecoveryPoint')} />
        <div className="recovery-list">
          {recoveryPoints.map((point) => (
            <div className="recovery-row" key={point.id}>
              <div>
                <strong>{point.label}</strong>
                <span>{formatTime(point.createdAt)} · {point.recordCount} 条记录</span>
              </div>
              <IconButton
                icon={confirmRestore === point.id ? 'check' : 'restore'}
                label={confirmRestore === point.id ? '确认恢复' : '预览并恢复'}
                className={confirmRestore === point.id ? 'primary-icon-button' : 'icon-button'}
                disabled={busy}
                onClick={() => {
                  if (confirmRestore !== point.id) {
                    setConfirmRestore(point.id);
                    setRecoveryPreview(undefined);
                    void client.ask<RecoveryPreview>('system.recovery.preview', { id: point.id })
                      .then(setRecoveryPreview)
                      .catch(() => setConfirmRestore(undefined));
                    return;
                  }
                  setConfirmRestore(undefined);
                  void client.dispatch('file.restoreRecovery', { id: point.id });
                }}
              />
              {confirmRestore === point.id && recoveryPreview?.id === point.id && (
                <div className="recovery-preview" role="status">
                  <strong>恢复前预览</strong>
                  <span>文档修订 {recoveryPreview.currentDocumentRevision} → {recoveryPreview.targetDocumentRevision}</span>
                  <span>记录 {recoveryPreview.currentRecordCount} → {recoveryPreview.targetRecordCount}</span>
                  <span>命名空间 {recoveryPreview.currentNamespaceCount} → {recoveryPreview.targetNamespaceCount}</span>
                  <span>目标历史：撤销 {recoveryPreview.targetUndoEntries} / 重做 {recoveryPreview.targetRedoEntries}</span>
                  <small>确认后仍会先自动创建“恢复操作前”保险点。</small>
                </div>
              )}
            </div>
          ))}
          {recoveryPoints.length === 0 && <p className="file-empty">还没有手动恢复点。自动保存仍在后台记录事务日志。</p>}
        </div>
      </div>

      {status && (
        <div className={`file-status ${status.state}`} aria-live="polite">
          <div>
            <strong>{status.state === 'running'
              ? <ProcessingLabel size={10}>{status.message}</ProcessingLabel>
              : status.message}</strong>
            <span>{status.progress === undefined ? '' : `${Math.round(status.progress * 100)}%`}</span>
          </div>
          {status.state === 'running' && <progress max={1} value={status.progress ?? 0} />}
        </div>
      )}
    </section>
  );
}

export function ArtifactDownloadHost({ client }: { client: ViewClient }) {
  const [saveLocationRequired, setSaveLocationRequired] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<FileRuntimeState['pendingOpen']>();
  const inputRef = useRef<HTMLInputElement>(null);
  const authorizationRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void client.request<FileRuntimeState>('file.state@1').then((state) => {
      if (!current) return;
      setSaveLocationRequired(state.saveLocationRequired);
      setPendingOpen(state.pendingOpen);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [client]);
  useEffect(
    () => client.subscribeSignal<FileArtifact>('file.artifact.ready', (message) => {
      downloadArtifact(message.payload);
    }),
    [client],
  );
  useEffect(
    () => client.subscribeSignal<{ saveLocationRequired?: boolean }>('file.save-location.required', (message) => {
      setSaveLocationRequired(message.payload.saveLocationRequired === true);
    }),
    [client],
  );
  useEffect(
    () => client.subscribeSignal<{ saveLocationRequired?: boolean }>('file.save-state.changed', (message) => {
      if (!message.payload.saveLocationRequired) setSaveLocationRequired(false);
    }),
    [client],
  );
  useEffect(
    () => client.subscribeSignal<{
      pending: boolean;
      kind?: NonNullable<FileRuntimeState['pendingOpen']>['kind'];
      phase?: NonNullable<FileRuntimeState['pendingOpen']>['phase'];
      fileName?: string;
    }>(
      'file.open-confirmation.changed',
      (message) => setPendingOpen(message.payload.pending && message.payload.kind && message.payload.phase ? {
        kind: message.payload.kind,
        phase: message.payload.phase,
        fileName: message.payload.fileName,
      } : undefined),
    ),
    [client],
  );
  const choosePendingBook = () => {
    authorizationRef.current = crypto.randomUUID();
    void (async () => {
      try {
        const destination = await chooseNativeProjectOpen();
        if (destination) {
          const file = await destination.getFile();
          openSelectedPendingBook(file, authorizationRef.current, destination);
          authorizationRef.current = undefined;
          return;
        }
        inputRef.current?.click();
      } catch (reason) {
        authorizationRef.current = undefined;
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        client.emit('file.status', {
          operation: 'project-open', state: 'error',
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    })();
  };
  const openSelectedPendingBook = (
    file: File,
    requestedAuthorizationId: string | undefined,
    destination?: FileSaveTarget,
  ) => {
    const authorizationId = requestedAuthorizationId ?? crypto.randomUUID();
    void client.dispatch(
      'file.proceedPendingOpen',
      { authorizationId },
    ).then((proceed) => client.dispatch('file.openProject', {
      file,
      destination,
      authorizationId: proceed.authorizationId,
    })).catch((reason) => {
      client.emit('file.status', {
        operation: 'project-open', state: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    });
  };
  const picker = (
    <input
      ref={inputRef}
      className="sr-only"
      type="file"
      accept={PROJECT_OPEN_ACCEPT}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        const authorizationId = authorizationRef.current;
        authorizationRef.current = undefined;
        if (file) openSelectedPendingBook(file, authorizationId);
      }}
    />
  );
  if (!saveLocationRequired && !pendingOpen) return null;
  if (pendingOpen) {
    const isPicker = pendingOpen.kind === 'picker';
    const ready = pendingOpen.phase === 'ready-to-choose';
    return (
      <aside className="file-save-location-notice" role="status" aria-live="polite">
        {picker}
        <span>
          <strong>{ready ? '选择要打开的书籍' : '当前书籍还有未保存修改'}</strong>
          <small>{ready
            ? '点击文件夹按钮，打开系统文件选择器。'
            : isPicker
              ? '可以先保存当前书籍，也可以不保存并继续选择其他书籍。'
              : `可以先保存当前书籍，也可以不保存并直接打开“${pendingOpen.fileName ?? '拖入的书籍'}”。`}</small>
        </span>
        <span className="file-save-location-actions">
          {!ready && (
            <IconButton
              icon="save"
              label={isPicker ? '保存当前书籍' : '保存当前书籍并打开拖入的书籍'}
              className="primary-icon-button"
              onClick={() => void client.dispatch('file.saveAndOpenPending').catch((reason) => {
                if (reason instanceof DOMException && reason.name === 'AbortError') return;
                client.emit('file.status', {
                  operation: 'project-open', state: 'error',
                  message: reason instanceof Error ? reason.message : String(reason),
                });
              })}
            />
          )}
          <IconButton
            icon="folder-open"
            label={ready ? '选择书籍文件' : isPicker ? '不保存，继续选择书籍' : '不保存，打开拖入的书籍'}
            onClick={isPicker ? choosePendingBook : () => void client.dispatch('file.proceedPendingOpen')}
          />
        </span>
      </aside>
    );
  }
  return (
    <aside className="file-save-location-notice" role="status" aria-live="polite">
      <span><strong>自动保存需要先保存书籍</strong><small>浏览器要求你亲自确认保存位置；确认一次后会按设置时间覆盖保存。</small></span>
      <IconButton
        icon="save"
        label="选择书籍保存位置"
        className="primary-icon-button"
        onClick={() => void client.dispatch('file.saveProject').catch(() => undefined)}
      />
    </aside>
  );
}

function downloadArtifact(artifact: FileArtifact): void {
  const url = URL.createObjectURL(artifact.blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.filename;
    anchor.rel = 'noopener';
    anchor.click();
    queueMicrotask(() => URL.revokeObjectURL(url));
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function persistenceLabel(
  status: PersistenceSnapshot | undefined,
  hasProjectDestination: boolean,
  cloudProjectActive: boolean,
): string {
  if (!status) return '正在读取状态';
  if (status.state === 'memory-only') return '浏览器不支持持久存储';
  const automaticSaveDisabled = status.autosaveIntervalMs === AUTOSAVE_DISABLED_INTERVAL_MS;
  if (cloudProjectActive) {
    if (status.state === 'error') return '本机恢复更新异常';
    if (status.state === 'saving') return '正在更新本机恢复副本';
    if (status.state === 'pending') return '等待更新本机恢复副本';
    if (status.state === 'saved') return automaticSaveDisabled
      ? '本机恢复正常 · 云端手动保存'
      : '本机恢复正常 · 云端自动保存';
    return '等待首次修改';
  }
  if (status.state === 'error') return hasProjectDestination ? '自动保存异常' : '本机恢复更新异常';
  if (status.state === 'saving') return hasProjectDestination ? '正在自动保存书籍' : '正在更新本机恢复副本';
  if (status.state === 'pending') return hasProjectDestination ? '等待自动保存书籍' : '等待更新本机恢复副本';
  if (status.state === 'saved') return hasProjectDestination
    ? automaticSaveDisabled ? '本机恢复正常 · 书籍手动保存' : '自动保存书籍正常'
    : '本机恢复副本已更新（未保存书籍）';
  return '等待首次修改';
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function formatAutosaveInterval(intervalMs: number): string {
  if (intervalMs === AUTOSAVE_DISABLED_INTERVAL_MS) return '关闭';
  if (intervalMs === AUTOSAVE_REALTIME_INTERVAL_MS) return '实时';
  if (intervalMs < 60_000) return `${intervalMs / 1000} 秒`;
  return `${intervalMs / 60_000} 分钟`;
}
