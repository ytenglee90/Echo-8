'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { CloudProjectSummary, CloudSyncState } from '../../cloud/contracts.ts';
import { AUTOSAVE_DISABLED_INTERVAL_MS } from '../../protocols/files.ts';
import { useInlineRename } from '../../ui/use-inline-rename.ts';
import { Icon, IconButton } from '../../ui/Icon.tsx';
import { SettingsPageHeader } from '../../ui/SettingsPageHeader.tsx';
import { ProcessingIndicator } from '../../ui/ProcessingIndicator.tsx';

const INITIAL: CloudSyncState = {
  phase: 'connecting', configured: false, authenticated: false, accounts: [], installations: [],
  headRevision: 0, pendingCommits: 0, upgradeAvailable: false, panelOpen: false,
};

export function CloudSyncPanel({ client }: { client: ViewClient }) {
  const [state, setState] = useState(INITIAL);
  const [projects, setProjects] = useState<CloudProjectSummary[]>([]);
  const [busy, setBusy] = useState('');
  const [localError, setLocalError] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const upgradeInstallation = state.installations.find(
    (item) => item.id === state.activeInstallationId && item.status === 'ready' && item.upgradeAvailable,
  ) ?? state.installations.find((item) => item.status === 'ready' && item.upgradeAvailable);
  const isLocalFile = globalThis.location.protocol === 'file:';
  const processing = Boolean(busy) || state.phase === 'connecting' || state.phase === 'syncing';

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

  const { editingProjectId, editingProjectName, setEditingProjectName, startRename, finishRename, cancelRename } = useInlineRename(
    (projectId, name) => run(`rename:${projectId}`, () => client.dispatch('cloudSync.renameProject', { projectId, name })),
    setLocalError,
  );

  const requestDelete = (project: CloudProjectSummary) => {
    setLocalError('');
    void client.dispatch('cloudSync.requestDeleteProject', { projectId: project.id })
      .catch((reason) => setLocalError(reason instanceof Error ? reason.message : String(reason)));
  };

  if (!state.panelOpen) return null;

  return (
    <section className="cloud-sync-panel" aria-label="Cloudflare 云同步" aria-busy={processing || undefined}>
      <SettingsPageHeader title="云同步" description="连接自有云，在设备之间同步书籍与个人设置。"
        closeLabel="关闭云同步" onClose={() => void client.dispatch('cloudSync.close')} actions={<>
          {state.authenticated && state.installations.some((item) => item.status === 'ready') && (
            <IconButton
              icon="sync"
              label="立即保存到云端"
              busy={busy === 'sync'}
              disabled={Boolean(busy) || !state.activeProjectId || state.phase === 'read-only'}
              onClick={() => void run('sync', () => client.dispatch('cloudSync.syncNow'))}
            />
          )}
          {state.authenticated && state.reauthorizationRequired && (
            <button type="button" disabled={Boolean(busy)} onClick={() => void run('reconnect', async () => {
              const result = await client.dispatch('cloudSync.prepareReconnect');
              globalThis.location.assign(result.url);
            })}>重新连接</button>
          )}
          {state.authenticated && (
            <IconButton
              icon="logout"
              label="退出账户"
              busy={busy === 'logout'}
              disabled={Boolean(busy)}
              onClick={() => void run('logout', () => client.dispatch('cloudSync.logout'))}
            />
          )}
      </>} />

      <div className={`cloud-sync-summary phase-${state.phase}`} role="status">
        {processing ? <ProcessingIndicator size={11} /> : <i aria-hidden="true" />}
        <div>
          <strong>{phaseLabel(state)}</strong>
          <span>{summaryLine(state)}</span>
        </div>
      </div>

      {(localError || state.error) && <p className="cloud-sync-error">{localError || state.error}</p>}
      {state.retryAt&&state.phase==='offline'&&<p className="file-note">本机恢复副本继续保留；计划于 {formatTime(state.retryAt)} 重试同步。</p>}
      {state.storageUsage?.capacityBytes&&state.storageUsage.usedBytes/state.storageUsage.capacityBytes>=.8&&<p className="cloud-sync-warning" role="status">
        {state.storageUsage.usedBytes/state.storageUsage.capacityBytes>=.95?'云端空间即将用尽':'云端空间已使用超过 80%'}。系统会自动回收无引用旧数据；保存失败时仍保留本地修改。</p>}
      {state.lastSyncedAt&&<p className="file-note">最近保存到云端：{formatTime(state.lastSyncedAt)}{state.lastUploadBytes!==undefined?` · 本次新增传输 ${Math.ceil(state.lastUploadBytes/1_000)} KB`:''}</p>}
      {state.maintenance&&<p className="file-note">最近自动维护：{formatTime(state.maintenance.checkedAt)} · 回收 {state.maintenance.removedRows} 条{state.maintenance.errors?' · 部分维护待重试':''}</p>}
      {state.shortcutsError&&<div className="cloud-sync-warning"><p>快捷键：{state.shortcutsError}</p>
        <button type="button" disabled={Boolean(busy)} onClick={()=>void run('shortcuts',()=>client.dispatch('cloudSync.resolveShortcuts',{choice:'local'}))}>使用本机快捷键</button>
        <button type="button" disabled={Boolean(busy)} onClick={()=>void run('shortcuts',()=>client.dispatch('cloudSync.resolveShortcuts',{choice:'account'}))}>使用账号快捷键</button>
      </div>}
      {state.authenticated && <div className="cloud-sync-section">
        <h3>个人账户配置</h3>
        <p className="file-note">自动保存间隔（实时、定时、关闭）和自动保留数量（含“不限制”）随账号同步，换设备后恢复。恢复副本保存在各设备本地。</p>
        {state.persistencePreferencesSyncedAt && <p className="file-note">保存设置已同步：{formatTime(state.persistencePreferencesSyncedAt)}</p>}
        {state.persistencePreferencesError && <p className="cloud-sync-warning" role="status">{state.persistencePreferencesError}</p>}
        {state.persistencePreferencesConflict ? <div className="local-storage-actions">
          <button type="button" disabled={Boolean(busy)} onClick={() => void run('preferences', () => client.dispatch('cloudSync.resolvePersistencePreferences', { choice: 'local' }))}>使用本机保存设置</button>
          <button type="button" disabled={Boolean(busy)} onClick={() => void run('preferences', () => client.dispatch('cloudSync.resolvePersistencePreferences', { choice: 'account' }))}>使用账号保存设置</button>
        </div> : <button type="button" disabled={Boolean(busy) || !state.activeInstallationId} onClick={() => void run('preferences', () => client.dispatch('cloudSync.syncPersistencePreferences'))}>同步保存设置</button>}
      </div>}

      {!state.configured && (
        <div className="cloud-sync-empty">
          <strong>{isLocalFile ? '单文件模式没有账户服务' : '部署端还没有配置 OAuth'}</strong>
          <p>{isLocalFile
            ? '同步入口已保留；请通过配套的 HTTP(S) 部署地址打开此应用后登录。当前本地画布和 .e8 文件仍可正常使用。'
            : '应用本身可以正常本地使用。按部署文档绑定控制 D1 并设置 5 个密钥后，这里会自动启用。'}</p>
        </div>
      )}

      {state.configured && (!state.authenticated || state.reauthorizationRequired) && (
        <div className="cloud-sync-onboarding">
          <p>{state.reauthorizationRequired ? 'Cloudflare 授权已过期，请重新连接。本机未上传修改会先保存。' : '登录 Cloudflare 后，画布正文会存进你自己的 D1；本站只保存登录和安装信息。'}</p>
          <button
            className="cloud-primary-button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void run('reconnect', async () => {
              const result = await client.dispatch('cloudSync.prepareReconnect');
              globalThis.location.assign(result.url);
            })}
          >{state.reauthorizationRequired ? '重新连接 Cloudflare' : '连接我的 Cloudflare'}</button>
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
                  <b>
                    {busy === `install:${account.id}` && <ProcessingIndicator size={9} />}
                    {busy === `install:${account.id}` ? '正在安装…' : installation?.status === 'error' ? '重试安装' : '安装'}
                  </b>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {state.authenticated && state.installations.some((item) => item.status === 'ready') && (
        <>
          {!state.activeProjectId && !state.reauthorizationRequired && (
            <form className="cloud-sync-section cloud-save-as" aria-label="另存到云端" onSubmit={(event) => {
              event.preventDefault();
              if (processing || !newProjectName.trim()) return;
              void run('save-as-cloud', () => client.dispatch('cloudSync.saveCurrentAsProject', { name: newProjectName.trim() }));
            }}>
              <h3>另存到云端</h3>
              <p>将当前书籍和未保存修改保存为新的云端书籍。之后的保存与自动保存使用云端，本地文件保留。</p>
              <p>书库已有同名书籍时自动加编号，不覆盖原书籍。</p>
              <label>
                <span>云端书籍名称</span>
                <input value={newProjectName} maxLength={120} placeholder="输入云端书籍名称" disabled={processing}
                  onChange={(event) => setNewProjectName(event.target.value)} />
              </label>
              <button className="cloud-primary-button" type="submit" disabled={processing || !newProjectName.trim()}>
                {busy === 'save-as-cloud' && <ProcessingIndicator size={9} />}
                {busy === 'save-as-cloud' ? '正在保存…' : '另存到云端'}
              </button>
            </form>
          )}
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
              >
                {busy === 'upgrade' && <ProcessingIndicator size={9} />}
                {busy === 'upgrade' ? '正在升级…' : '一键升级'}
              </button>
            </div>
          )}
          <div className="cloud-sync-section">
            <div className="cloud-section-heading">
              <h3>云端书籍</h3>
              <IconButton
                icon="reset"
                label="刷新云端书籍"
                busy={busy === 'refresh'}
                className="cloud-section-refresh"
                disabled={Boolean(busy)}
                onClick={() => void run('refresh', () => client.dispatch('cloudSync.listProjects'))}
              />
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
                              cancelRename();
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
                        aria-label={`${project.id === state.activeProjectId ? '当前书籍' : '打开书籍'}：${project.name}`}
                        title={project.id === state.activeProjectId ? '当前书籍' : '打开书籍'}
                        disabled={Boolean(busy) || editing}
                        onClick={() => void run(`open:${project.id}`, () => client.dispatch('cloudSync.openProject', { projectId: project.id }))}
                      >
                        {busy === `open:${project.id}`
                          ? <ProcessingIndicator size={11} />
                          : <Icon name={project.id === state.activeProjectId ? 'check' : 'folder-open'} />}
                      </button>
                      <button
                        className="cloud-project-delete"
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
              {projects.length === 0 && (
                <p className="cloud-list-empty">返回书库新建空白书籍；第一次保存时会自动建立云端书籍。</p>
              )}
            </div>
          </div>

          {state.phase === 'read-only' && (
            <div className="cloud-sync-warning">
              <strong>另一台设备持有编辑权</strong>
              <p>当前可安全查看。接管后，原设备的下一次写入会停止。</p>
              <button type="button" disabled={Boolean(busy)} onClick={() => void run('takeover', () => client.dispatch('cloudSync.takeover'))}>
                {busy === 'takeover' && <ProcessingIndicator size={9} />}
                {busy === 'takeover' ? '正在接管…' : '接管编辑权'}
              </button>
            </div>
          )}

          {state.phase === 'conflict' && (
            <div className="cloud-sync-warning danger">
              <strong>本机与云端都有新修改</strong>
              <p>系统不会覆盖本机内容。继续前会建立本机恢复点，然后载入云端版本。</p>
              <button type="button" disabled={Boolean(busy)} onClick={() => void run('remote', () => client.dispatch('cloudSync.acceptRemote'))}>
                {busy === 'remote' && <ProcessingIndicator size={9} />}
                {busy === 'remote' ? '正在载入云端…' : '保存恢复点并载入云端'}
              </button>
            </div>
          )}

        </>
      )}

      <div className="cloud-sync-section cloud-sync-data-boundary">
        <h3>跨设备数据范围</h3>
        <p><strong>随书同步：</strong>画布内容、纠错与补全规则、书内插件数据。</p>
        <p><strong>账号同步：</strong>自定义快捷键、自动保存间隔、恢复副本自动保留数量。主题预设、收藏颜色、布局、草稿及撤销历史保留本机。</p>
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
  if (state.phase === 'ready' && state.pendingCommits > 0) {
    return state.autosaveIntervalMs === AUTOSAVE_DISABLED_INTERVAL_MS
      ? '自动保存已关闭'
      : '等待自动保存';
  }
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
