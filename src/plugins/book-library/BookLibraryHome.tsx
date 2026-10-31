'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type {
  CloudInstallationSummary,
  CloudProjectSummary,
  CloudSyncState,
} from '../../cloud/contracts.ts';
import {
  AUTOSAVE_DISABLED_INTERVAL_MS,
  PROJECT_OPEN_ACCEPT,
  type FileSaveTarget,
} from '../../protocols/files.ts';
import { chooseNativeProjectOpen } from '../../services/native-save.ts';
import { Icon } from '../../ui/Icon.tsx';
import { BrandLoadingMark, ProcessingIndicator } from '../../ui/ProcessingIndicator.tsx';

const INITIAL: CloudSyncState = {
  phase: 'connecting', configured: false, authenticated: false, accounts: [], installations: [],
  headRevision: 0, pendingCommits: 0, upgradeAvailable: false, panelOpen: false,
};

export function BookLibraryHome({ client }: { client: ViewClient }) {
  const [open, setOpen] = useState(true);
  const [cloud, setCloud] = useState(INITIAL);
  const [projects, setProjects] = useState<CloudProjectSummary[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editingProjectId, setEditingProjectId] = useState<string>();
  const [editingProjectName, setEditingProjectName] = useState('');
  const cancelRename = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const listedInstallation = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const [nextCloud, nextProjects] = await Promise.all([
      client.ask<CloudSyncState>('cloudSync.state'),
      client.ask<CloudProjectSummary[]>('cloudSync.projects'),
    ]);
    setCloud(nextCloud);
    setProjects(nextProjects);
    return nextCloud;
  }, [client]);

  useEffect(() => {
    let current = true;
    const updateCloud = () => void refresh().catch(() => undefined);
    const updateOpen = (message: { payload: { open?: unknown } }) => {
      if (current && typeof message.payload.open === 'boolean') setOpen(message.payload.open);
    };
    const cloudSubscription = client.subscribeSignal('cloudSync.updated', updateCloud);
    const librarySubscription = client.subscribeSignal('bookLibrary.updated', updateOpen);
    const timer = setTimeout(() => {
      void refresh().then((next) => {
        if (!current) return;
        const installation = readyInstallation(next);
        if (!installation || listedInstallation.current === installation.id) return;
        listedInstallation.current = installation.id;
        void client.dispatch('cloudSync.listProjects').catch((reason) => {
          if (current) setError(errorMessage(reason));
        });
      }, () => current && setError('暂时无法读取书库状态'));
    }, 0);
    return () => {
      current = false;
      clearTimeout(timer);
      cloudSubscription();
      librarySubscription();
    };
  }, [client, refresh]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await action();
      await refresh();
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy('');
    }
  };

  const openSelectedLocalBook = (
    file: File,
    destination?: FileSaveTarget,
  ) => run('open-local', () => client.dispatch('file.openProjectFromLibrary', { file, destination }));

  const startRename = (project: CloudProjectSummary) => {
    setError('');
    cancelRename.current = false;
    setEditingProjectId(project.id);
    setEditingProjectName(project.name);
  };

  const finishRename = async (project: CloudProjectSummary) => {
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    const name = editingProjectName.trim();
    if (!name) {
      setError('书籍名称不能为空');
      return;
    }
    if (name === project.name) {
      setEditingProjectId(undefined);
      return;
    }
    const renamed = await run(`rename:${project.id}`, () => client.dispatch('cloudSync.renameProject', {
      projectId: project.id,
      name,
    }));
    if (renamed) setEditingProjectId(undefined);
  };

  const requestDelete = (project: CloudProjectSummary) => {
    setError('');
    void client.dispatch('cloudSync.requestDeleteProject', { projectId: project.id })
      .catch((reason) => setError(errorMessage(reason)));
  };

  const openLocalPicker = async () => {
    setError('');
    try {
      const destination = await chooseNativeProjectOpen();
      if (destination) {
        const file = await destination.getFile();
        await openSelectedLocalBook(file, destination);
      } else {
        fileInput.current?.click();
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setError(errorMessage(reason));
    }
  };

  if (!open) return null;
  const installation = readyInstallation(cloud);
  const upgrade = upgradeInstallation(cloud);
  const accountLabel = accountDisplayName(
    cloud.user?.email || cloud.user?.name || installation?.accountName,
  );
  const storage = storageStatus(cloud, installation);
  const access = accessStatus(cloud);
  const isLocalFile = globalThis.location.protocol === 'file:';
  const processing = Boolean(busy) || cloud.phase === 'connecting' || cloud.phase === 'syncing';
  const openingBook = busy === 'open-local' || busy.startsWith('open:');

  return (
    <section
      className="book-library-home"
      aria-label="Echo-8 书库"
      aria-busy={processing || undefined}
      autoFocus
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || busy) return;
        event.preventDefault();
        void client.dispatch('bookLibrary.enterCanvas');
      }}
    >
      <header className="book-library-header">
        <div className="book-library-brand">
          <span className="book-library-mark" aria-hidden="true">
            <Icon name="echo-8" motion={processing ? 'processing' : 'none'} />
          </span>
          <strong>Echo-8</strong>
        </div>
        <div className="book-library-account">
          {cloud.authenticated ? (
            <>
              <span className="book-library-avatar" aria-hidden="true">{accountInitial(accountLabel)}</span>
              <span className="book-library-account-copy">
                <strong>{accountLabel || 'Cloudflare 账户'}</strong>
                <small className="book-library-account-storage" title={storage.title}>{storage.label}</small>
                <small className="book-library-account-access">{access}</small>
              </span>
              <button type="button" disabled={Boolean(busy)} onClick={() => void run('logout', () => client.dispatch('cloudSync.logout'))}>
                {busy === 'logout' && <ProcessingIndicator size={9} />}退出
              </button>
            </>
          ) : (
            <>
              <span className="book-library-avatar muted" aria-hidden="true"><Icon name="globe" /></span>
              {cloud.configured && (
                <button type="button" onClick={() => globalThis.location.assign('/api/cloud/oauth/start?returnTo=/')}>登录</button>
              )}
            </>
          )}
        </div>
      </header>

      <main className="book-library-content">
        {error && <div className="book-library-error" role="alert">{error}</div>}

        <div className="book-library-layout">
          <section className="book-library-quick-start" aria-labelledby="local-books-title">
            <h2 className="sr-only" id="local-books-title">本地书籍</h2>
            <div className="book-library-local-actions" aria-label="快速开始">
              <button
                type="button"
                className="book-library-action-card primary"
                aria-label="新建空白书籍"
                title="新建空白书籍"
                disabled={Boolean(busy)}
                onClick={() => void run('new-local', () => client.dispatch('bookLibrary.createLocal'))}
              >
                {busy === 'new-local' ? <ProcessingIndicator size={18} /> : <Icon name="add" />}
                <strong>{busy === 'new-local' ? '正在新建…' : '新建'}</strong>
              </button>
              <button
                type="button"
                className="book-library-action-card"
                aria-label="打开本地书籍"
                title="打开本地书籍"
                disabled={Boolean(busy)}
                onClick={() => void openLocalPicker()}
              >
                {busy === 'open-local' ? <ProcessingIndicator size={18} /> : <Icon name="folder-open" />}
                <strong>{busy === 'open-local' ? '正在准备…' : '打开'}</strong>
              </button>
            </div>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept={PROJECT_OPEN_ACCEPT}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void openSelectedLocalBook(file);
              }}
            />
          </section>

          <section className="book-library-section cloud-books" aria-labelledby="cloud-books-title">
            <h2 className="sr-only" id="cloud-books-title">云端书籍</h2>
            <div className="book-library-cloud-tools">
              {installation && (
                <button
                  className="book-library-refresh"
                  type="button"
                  aria-label="刷新云端书籍"
                  title="刷新云端书籍"
                  disabled={Boolean(busy)}
                  onClick={() => void run('refresh', () => client.dispatch('cloudSync.listProjects'))}
                >{busy === 'refresh' ? <ProcessingIndicator size={11} /> : <Icon name="reset" />}</button>
              )}
            </div>

            {!cloud.configured && (
              <LibraryNotice title={isLocalFile ? '单文件模式已保留云同步入口' : '当前部署未配置账户登录'}>
                {isLocalFile
                  ? '直接以 file:// 打开时没有账户服务；通过配套的 HTTP(S) 部署地址打开即可登录并同步。你仍可以新建或打开本地书籍。'
                  : '你仍可以新建或打开本地书籍。'}
              </LibraryNotice>
            )}
            {cloud.configured && !cloud.authenticated && (
              <LibraryNotice title="登录后选择自己的书籍">
                <p>书籍正文保存在你自己的 Cloudflare D1，不放在网站主人的正文数据库。</p>
                <button type="button" onClick={() => globalThis.location.assign('/api/cloud/oauth/start?returnTo=/')}>登录 Cloudflare</button>
              </LibraryNotice>
            )}
            {cloud.authenticated && !installation && (
              <div className="book-library-install">
                <strong>先选择一个账户安装个人存储</strong>
                <p>只创建一个 Worker 和一个 D1，不需要信用卡。</p>
                {cloud.accounts.map((account) => (
                  <button
                    type="button"
                    key={account.id}
                    disabled={Boolean(busy)}
                    onClick={() => void run(`install:${account.id}`, () => client.dispatch('cloudSync.install', { accountId: account.id }))}
                  >
                    <span><strong>{account.name}</strong><small>{account.id.slice(0, 12)}…</small></span>
                    <b>{busy === `install:${account.id}` && <ProcessingIndicator size={9} />}{busy === `install:${account.id}` ? '正在安装…' : '安装'}</b>
                  </button>
                ))}
              </div>
            )}
            {installation && (
              <>
                {upgrade && (
                  <div className="book-library-upgrade">
                    <span><strong>个人数据服务可升级</strong><small>版本 {upgrade.workerVersion} → {upgrade.latestWorkerVersion}</small></span>
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => void run('upgrade', () => client.dispatch('cloudSync.upgrade', { installationId: upgrade.id }))}
                    >{busy === 'upgrade' && <ProcessingIndicator size={9} />}{busy === 'upgrade' ? '升级中…' : '一键升级'}</button>
                  </div>
                )}
                <div className="book-library-project-list">
                  {projects.map((project) => {
                    const editing = editingProjectId === project.id;
                    const projectBusy = busy === `open:${project.id}` || busy === `rename:${project.id}`;
                    return (
                      <div
                        className={`book-library-project-row${project.id === cloud.activeProjectId ? ' active' : ''}`}
                        key={project.id}
                        onClick={(event) => {
                          const target = event.target;
                          if (target instanceof Element && target.closest('button, input')) return;
                          void openProject(project);
                        }}
                      >
                        <span className="book-library-project-icon">
                          {projectBusy ? <ProcessingIndicator size={12} /> : <Icon name="echo-file" />}
                        </span>
                        <span className="book-library-project-copy">
                          {editing ? (
                            <input
                              aria-label={`修改书籍名称：${project.name}`}
                              autoFocus
                              disabled={busy === `rename:${project.id}`}
                              maxLength={120}
                              value={editingProjectName}
                              onBlur={() => void finishRename(project)}
                              onChange={(event) => setEditingProjectName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur();
                                if (event.key === 'Escape') {
                                  event.preventDefault();
                                  cancelRename.current = true;
                                  setEditingProjectId(undefined);
                                }
                              }}
                            />
                          ) : (
                            <button
                              className="book-library-project-name"
                              type="button"
                              aria-label={`重命名书籍：${project.name}`}
                              title="双击修改名称"
                              disabled={Boolean(busy)}
                              onDoubleClick={() => startRename(project)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === 'F2') startRename(project);
                              }}
                            >{project.name}</button>
                          )}
                          <small>{projectStatus(project, cloud)} · {formatTime(project.updatedAt)}</small>
                        </span>
                        <span className="book-library-project-actions">
                          <button
                            className="book-library-project-open"
                            type="button"
                            aria-label={`${project.id === cloud.activeProjectId ? '继续' : '打开'}书籍：${project.name}`}
                            title={project.id === cloud.activeProjectId ? '继续当前书籍' : '打开书籍'}
                            disabled={Boolean(busy) || editing}
                            onClick={() => void openProject(project)}
                          ><Icon name={project.id === cloud.activeProjectId ? 'play' : 'folder-open'} /></button>
                          <button
                            className="book-library-project-delete"
                            type="button"
                            aria-label={`删除书籍：${project.name}`}
                            title={`删除书籍：${project.name}`}
                            disabled={Boolean(busy) || editing}
                            onClick={() => requestDelete(project)}
                          ><Icon name="trash" /></button>
                        </span>
                      </div>
                    );
                  })}
                  {projects.length === 0 && cloud.phase !== 'connecting' && (
                    <p className="book-library-empty">还没有云端书籍。新建空白书籍并保存后会加入这里。</p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      {openingBook && (
        <div
          className="book-library-opening"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label="正在打开书籍"
        >
          <BrandLoadingMark size={64} />
          <strong>正在打开书籍</strong>
          <span>加载内容 · 校验数据 · 进入画布</span>
        </div>
      )}

    </section>
  );

  function openProject(project: CloudProjectSummary): Promise<void> {
    return run(`open:${project.id}`, () => client.dispatch('cloudSync.openProject', {
      projectId: project.id,
    })).then((ok) => {
      if (ok) return client.dispatch('bookLibrary.enterCanvas').then(() => undefined);
    });
  }
}

function LibraryNotice({ title, children }: { title: string; children: ReactNode }) {
  return <div className="book-library-notice"><Icon name="globe" /><div><strong>{title}</strong>{children}</div></div>;
}

function readyInstallation(state: CloudSyncState): CloudInstallationSummary | undefined {
  return state.installations.find((item) => item.id === state.activeInstallationId && item.status === 'ready') ??
    state.installations.find((item) => item.status === 'ready');
}

function upgradeInstallation(state: CloudSyncState): CloudInstallationSummary | undefined {
  return state.installations.find((item) => item.status === 'ready' && item.upgradeAvailable);
}

function accountInitial(value: string | undefined): string {
  return value?.trim().charAt(0).toLocaleUpperCase() || 'C';
}

function accountDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/[’']s Account$/iu, '').trim();
  return normalized || undefined;
}

function storageStatus(
  state: CloudSyncState,
  installation: CloudInstallationSummary | undefined,
): { label: string; title: string } {
  if (!installation) return { label: '容量：尚未安装个人存储', title: '选择 Cloudflare 账户并安装后显示容量' };
  if (!state.storageUsage) {
    const detail = state.storageUsageError || '正在读取';
    return { label: `容量：${detail}`, title: detail };
  }
  const usage = state.storageUsage;
  if (usage.capacityBytes === undefined || usage.remainingBytes === undefined) {
    return {
      label: `D1 已用 ${formatBytes(usage.usedBytes)} · 总容量未知`,
      title: '当前存储模式无法从数据 Worker 得到完整对象容量',
    };
  }
  return {
    label: `已用 ${formatBytes(usage.usedBytes)} / 剩余 ${formatBytes(usage.remainingBytes)}`,
    title: `剩余容量按 Cloudflare D1 免费版单数据库 ${formatBytes(usage.capacityBytes)} 上限估算；付费账户实际上限可能更高`,
  };
}

function accessStatus(state: CloudSyncState): string {
  if (!state.activeProjectId) {
    return state.phase === 'connecting' ? '权限：正在确认' : '权限：未打开云端书籍';
  }
  if (state.phase === 'read-only') return '权限：只读（可接管）';
  if (state.phase === 'ready' || state.phase === 'syncing') return '权限：可编辑';
  if (state.phase === 'offline') return '权限：本机可编辑（离线）';
  if (state.phase === 'conflict') return '权限：暂停同步（需处理冲突）';
  if (state.phase === 'connecting') return '权限：正在确认';
  return '权限：暂不可用';
}

function formatBytes(value: number): string {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = safe;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  const maximumFractionDigits = amount < 10 && unit > 0 ? 1 : 0;
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(amount)} ${units[unit]}`;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function projectStatus(project: CloudProjectSummary, state: CloudSyncState): string {
  if (project.id !== state.activeProjectId) return '未打开';
  if (state.phase === 'syncing' || state.phase === 'connecting') return '当前书籍 · 保存中';
  if (state.pendingCommits > 0) return state.autosaveIntervalMs === AUTOSAVE_DISABLED_INTERVAL_MS
    ? '当前书籍 · 等待手动保存'
    : '当前书籍 · 等待自动保存';
  if (state.phase === 'read-only') return '当前书籍 · 只读';
  if (state.phase === 'conflict' || state.phase === 'error') return '当前书籍 · 需要处理';
  if (state.phase === 'offline') return '当前书籍 · 等待同步';
  return '当前书籍 · 已同步';
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
