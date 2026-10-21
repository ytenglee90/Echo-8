'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { CloudProjectSummary, CloudSyncState } from '../../cloud/contracts.ts';
import { Icon, IconButton } from '../../ui/Icon.tsx';

const INITIAL: CloudSyncState = {
  phase: 'connecting', configured: false, authenticated: false, accounts: [], installations: [],
  headRevision: 0, pendingCommits: 0, upgradeAvailable: false, panelOpen: false,
};

export function CloudSyncPanel({ client }: { client: ViewClient }) {
  const [state, setState] = useState(INITIAL);
  const [projects, setProjects] = useState<CloudProjectSummary[]>([]);
  const [busy, setBusy] = useState('');
  const [localError, setLocalError] = useState('');
  const [editingProjectId, setEditingProjectId] = useState<string>();
  const [editingProjectName, setEditingProjectName] = useState('');
  const cancelRename = useRef(false);
  const upgradeInstallation = state.installations.find(
    (item) => item.id === state.activeInstallationId && item.status === 'ready' && item.upgradeAvailable,
  ) ?? state.installations.find((item) => item.status === 'ready' && item.upgradeAvailable);
  const isLocalFile = globalThis.location.protocol === 'file:';

  const refresh = useCallback(async () => {
    const [next, nextProjects] = await Promise.all([
      client.ask<CloudSyncState>('cloudSync.state'),
      client.ask<CloudProjectSummary[]>('cloudSync.projects'),
    ]);
    setState(next);
    setProjects(nextProjects);
  }, [client]);

  useEffect(() => {
    let current = true;
    const update = () => void refresh().catch(() => undefined);
    const timer = setTimeout(() => {
      void refresh().then(() => undefined, () => current && setLocalError('无法读取云同步状态'));
    }, 0);
    const unsubscribe = client.subscribeSignal('cloudSync.updated', update);
    return () => { current = false; clearTimeout(timer); unsubscribe(); };
  }, [client, refresh]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setLocalError('');
    try {
      await action();
      await refresh();
      return true;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy('');
    }
  };

  const startRename = (project: CloudProjectSummary) => {
    setLocalError('');
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
      setLocalError('书籍名称不能为空');
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
    setLocalError('');
    void client.dispatch('cloudSync.requestDeleteProject', { projectId: project.id })
      .catch((reason) => setLocalError(reason instanceof Error ? reason.message : String(reason)));
  };

  if (!state.panelOpen) return null;

  return (
    <section className="cloud-sync-panel" aria-label="Cloudflare 云同步">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">BYOC · 用户自有云</span>
          <h2>跨设备继续编辑</h2>
        </div>
        <IconButton icon="close" label="关闭云同步" onClick={() => void client.dispatch('cloudSync.close')} />
      </div>

      <div className={`cloud-sync-summary phase-${state.phase}`} role="status">
        <i aria-hidden="true" />
        <div>
          <strong>{phaseLabel(state)}</strong>
          <span>{summaryLine(state)}</span>
        </div>
      </div>

      {(localError || state.error) && <p className="cloud-sync-error">{localError || state.error}</p>}

      {!state.configured && (
        <div className="cloud-sync-empty">
          <strong>{isLocalFile ? '单文件模式没有账户服务' : '部署端还没有配置 OAuth'}</strong>
          <p>{isLocalFile
            ? '同步入口已保留；请通过配套的 HTTP(S) 部署地址打开此应用后登录。当前本地画布和 .echo8 文件仍可正常使用。'
            : '应用本身可以正常本地使用。按部署文档绑定控制 D1 并设置 5 个密钥后，这里会自动启用。'}</p>
        </div>
      )}

      {state.configured && !state.authenticated && (
        <div className="cloud-sync-onboarding">
          <p>登录 Cloudflare 后，画布正文会存进你自己的 D1；本站只保存登录和安装信息。</p>
          <button
            className="cloud-primary-button"
            type="button"
            onClick={() => globalThis.location.assign('/api/cloud/oauth/start?returnTo=/')}
          >连接我的 Cloudflare</button>
        </div>
      )}

      {state.authenticated && state.installations.every((item) => item.status !== 'ready') && (
        <div className="cloud-sync-section">
          <h3>选择存储账户</h3>
          <p>只会在所选账户创建一个 Worker 和一个 D1 数据库，不需要绑定付款方式。</p>
          <div className="cloud-account-list">
            {state.accounts.map((account) => {
              const installation = state.installations.find((item) => item.accountId === account.id);
              return (
                <button
                  type="button"
                  key={account.id}
                  disabled={Boolean(busy)}
                  onClick={() => void run(`install:${account.id}`, () => client.dispatch('cloudSync.install', { accountId: account.id }))}
                >
                  <span><strong>{account.name}</strong><small>{account.id.slice(0, 12)}…</small></span>
                  <b>{busy === `install:${account.id}` ? '正在安装…' : installation?.status === 'error' ? '重试安装' : '安装'}</b>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {state.authenticated && state.installations.some((item) => item.status === 'ready') && (
        <>
          {upgradeInstallation && (
            <div className="cloud-sync-warning">
              <strong>个人数据服务有新版本</strong>
              <p>
                当前版本 {upgradeInstallation.workerVersion}，最新版本 {upgradeInstallation.latestWorkerVersion}。
                升级会原地更新 Worker 和 D1 表结构，不会新建数据库或删除画布。
              </p>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void run('upgrade', () => client.dispatch('cloudSync.upgrade', {
                  installationId: upgradeInstallation.id,
                }))}
              >{busy === 'upgrade' ? '正在升级…' : '一键升级'}</button>
            </div>
          )}
          <div className="cloud-sync-section">
            <div className="cloud-section-heading">
              <h3>云端书籍</h3>
              <button type="button" disabled={Boolean(busy)} onClick={() => void run('refresh', () => client.dispatch('cloudSync.listProjects'))}>刷新</button>
            </div>
            <div className="cloud-project-list">
              {projects.map((project) => {
                const editing = editingProjectId === project.id;
                return (
                  <div
                    className={`cloud-project-row${project.id === state.activeProjectId ? ' active' : ''}`}
                    key={project.id}
                  >
                    <span className="cloud-project-copy">
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
                          className="cloud-project-name"
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
                      <small>云版本 {project.headRevision} · {formatTime(project.updatedAt)}</small>
                    </span>
                    <span className="cloud-project-actions">
                      <button
                        className="cloud-project-open"
                        type="button"
                        disabled={Boolean(busy) || editing}
                        onClick={() => void run(`open:${project.id}`, () => client.dispatch('cloudSync.openProject', { projectId: project.id }))}
                      >{busy === `open:${project.id}` ? '打开中…' : project.id === state.activeProjectId ? '当前' : '打开'}</button>
                      <button
                        className="cloud-project-delete"
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
              {projects.length === 0 && (
                <p className="cloud-list-empty">返回书库新建空白书籍；第一次保存时会自动建立云端书籍。</p>
              )}
            </div>
          </div>

          {state.phase === 'read-only' && (
            <div className="cloud-sync-warning">
              <strong>另一台设备持有编辑权</strong>
              <p>当前可安全查看。接管后，原设备的下一次写入会停止。</p>
              <button type="button" disabled={Boolean(busy)} onClick={() => void run('takeover', () => client.dispatch('cloudSync.takeover'))}>接管编辑权</button>
            </div>
          )}

          {state.phase === 'conflict' && (
            <div className="cloud-sync-warning danger">
              <strong>本机与云端都有新修改</strong>
              <p>系统不会覆盖本机内容。继续前会建立本机恢复点，然后载入云端版本。</p>
              <button type="button" disabled={Boolean(busy)} onClick={() => void run('remote', () => client.dispatch('cloudSync.acceptRemote'))}>保存恢复点并载入云端</button>
            </div>
          )}

          <div className="cloud-sync-actions">
            <button type="button" disabled={Boolean(busy) || !state.activeProjectId || state.phase === 'read-only'} onClick={() => void run('sync', () => client.dispatch('cloudSync.syncNow'))}>立即同步</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void run('logout', () => client.dispatch('cloudSync.logout'))}>退出账户</button>
          </div>
        </>
      )}

      <div className="cloud-sync-section cloud-sync-data-boundary">
        <h3>跨设备数据范围</h3>
        <p><strong>随书同步：</strong>画布内容、纠错与补全规则、书内插件数据。</p>
        <p><strong>保留本机：</strong>本地语义模型与索引、本地与远程语义设置、远程语义和 AI 的 API KEY。换设备后可导入个人配置，并重新下载本地模型。</p>
      </div>
      <p className="cloud-sync-footnote">编辑数据从浏览器直接发送到你账户里的 Worker，不经过本站正文数据库。</p>
    </section>
  );
}

function phaseLabel(state: CloudSyncState): string {
  const labels: Record<CloudSyncState['phase'], string> = {
    disabled: '云同步尚未配置', 'signed-out': '尚未连接账户', 'needs-installation': '等待安装个人存储',
    connecting: '正在连接', ready: '已连接并可编辑', syncing: '正在上传修改', 'read-only': '只读模式',
    offline: '离线保存中', conflict: '需要处理版本冲突', error: '云同步异常',
  };
  return labels[state.phase];
}

function summaryLine(state: CloudSyncState): string {
  if (state.activeProjectName) {
    return `${state.activeProjectName} · 云版本 ${state.headRevision}${state.pendingCommits ? ` · 待上传 ${state.pendingCommits}` : ''}`;
  }
  return state.authenticated ? '账户已登录' : '本地画布仍可正常使用';
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
