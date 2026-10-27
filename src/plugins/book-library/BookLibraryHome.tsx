'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type {
  CloudInstallationSummary,
  CloudProjectSummary,
  CloudSyncState,
} from '../../cloud/contracts.ts';
import { PROJECT_OPEN_ACCEPT, type FileSaveTarget } from '../../protocols/files.ts';
import { chooseNativeProjectOpen } from '../../ui/native-save.ts';
import { Icon } from '../../ui/Icon.tsx';

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
  const accountLabel = cloud.user?.name || cloud.user?.email || installation?.accountName;
  const isLocalFile = globalThis.location.protocol === 'file:';

  return (
    <section className="book-library-home" aria-label="Echo-8 书库">
      <header className="book-library-header">
        <div className="book-library-brand">
          <span className="book-library-mark" aria-hidden="true"><i /><i /><i /></span>
          <strong>Echo-8</strong>
        </div>
        <div className="book-library-account">
          {cloud.authenticated ? (
            <>
              <span className="book-library-avatar" aria-hidden="true">{accountInitial(accountLabel)}</span>
              <span><strong>{accountLabel || 'Cloudflare 账户'}</strong></span>
              <button type="button" disabled={Boolean(busy)} onClick={() => void run('logout', () => client.dispatch('cloudSync.logout'))}>退出</button>
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
        <div className="book-library-intro">
          <h1>今天想打开哪一本？</h1>
        </div>

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
                <Icon name="add" />
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
                <Icon name="folder-open" />
                <strong>{busy === 'open-local' ? '正在准备…' : '打开'}</strong>
              </button>
              <button
                className="book-library-action-card continue"
                type="button"
                aria-label="继续当前浏览器中的画布"
                title="继续当前浏览器中的画布"
                disabled={Boolean(busy)}
                onClick={() => void client.dispatch('bookLibrary.enterCanvas')}
              >
                <Icon name="play" />
                <strong>继续</strong>
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
            <div className="book-library-section-heading">
              <div><h2 id="cloud-books-title">云端书籍</h2><span>{projects.length > 0 ? `${projects.length} 本` : '跨设备'}</span></div>
              {installation && (
                <button
                  className="book-library-refresh"
                  type="button"
                  aria-label="刷新云端书籍"
                  title="刷新云端书籍"
                  disabled={Boolean(busy)}
                  onClick={() => void run('refresh', () => client.dispatch('cloudSync.listProjects'))}
                ><Icon name="reset" /></button>
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
                    <b>{busy === `install:${account.id}` ? '正在安装…' : '安装'}</b>
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
                    >{busy === 'upgrade' ? '升级中…' : '一键升级'}</button>
                  </div>
                )}
                <div className="book-library-project-list">
                  {projects.map((project) => {
                    const editing = editingProjectId === project.id;
                    return (
                      <div
                        className={`book-library-project-row${project.id === cloud.activeProjectId ? ' active' : ''}`}
                        key={project.id}
                      >
                        <span className="book-library-project-icon"><Icon name="echo-file" /></span>
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
                          <small>{project.headRevision === 0 ? '新书籍' : `云版本 ${project.headRevision}`} · {formatTime(project.updatedAt)}</small>
                        </span>
                        <span className="book-library-project-actions">
                          <button
                            className="book-library-project-open"
                            type="button"
                            disabled={Boolean(busy) || editing}
                            onClick={() => void run(`open:${project.id}`, () => client.dispatch('cloudSync.openProject', { projectId: project.id })).then((ok) => {
                              if (ok) void client.dispatch('bookLibrary.enterCanvas');
                            })}
                          >{busy === `open:${project.id}` ? '打开中…' : project.id === cloud.activeProjectId ? '继续' : '打开'}</button>
                          <button
                            className="book-library-project-delete"
                            type="button"
                            aria-label={`删除书籍：${project.name}`}
                            title={`删除书籍：${project.name}`}
                            disabled={Boolean(busy) || editing}
                            onClick={() => requestDelete(project)}
                          ><Icon name="trash" /><span>删除</span></button>
                        </span>
                      </div>
                    );
                  })}
                  {projects.length === 0 && cloud.phase !== 'connecting' && (
                    <p className="book-library-empty">还没有云端书籍。新建空白书籍并开始编辑，第一次保存时会自动加入这里。</p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </main>

    </section>
  );
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

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
