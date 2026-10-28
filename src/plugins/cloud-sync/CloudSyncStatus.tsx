'use client';

import { useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { CloudSyncState } from '../../cloud/contracts.ts';
import { Icon } from '../../ui/Icon.tsx';

const INITIAL: CloudSyncState = {
  phase: 'connecting', configured: false, authenticated: false, accounts: [], installations: [],
  headRevision: 0, pendingCommits: 0, upgradeAvailable: false, panelOpen: false,
};

export function CloudSyncStatus({ client }: { client: ViewClient }) {
  const [state, setState] = useState(INITIAL);

  useEffect(() => {
    let current = true;
    const refresh = () => void client.ask<CloudSyncState>('cloudSync.state').then((value) => {
      if (current) setState(value);
    });
    refresh();
    const unsubscribe = client.subscribeSignal('cloudSync.updated', refresh);
    return () => { current = false; unsubscribe(); };
  }, [client]);

  const synced = state.phase === 'ready' && Boolean(state.activeProjectId) && state.pendingCommits === 0;
  const active = state.phase === 'connecting' || state.phase === 'syncing' || state.pendingCommits > 0;

  return (
    <button
      type="button"
      className={`cloud-sync-status ${synced ? 'is-synced' : 'is-unsynced'}${active ? ' is-active' : ''}`}
      onClick={() => void client.dispatch('cloudSync.open')}
      title={statusTitle(state)}
      aria-label={`云同步：${statusLabel(state)}`}
    >
      <Icon name="echo-8" />
    </button>
  );
}

function statusLabel(state: CloudSyncState): string {
  if (state.upgradeAvailable && state.phase === 'ready') return '云端可升级';
  switch (state.phase) {
    case 'disabled': return '云未配置';
    case 'signed-out': return '连接云端';
    case 'needs-installation': return '安装云存储';
    case 'connecting': return '连接中';
    case 'syncing': return '同步中';
    case 'read-only': return '云端只读';
    case 'offline': return '离线保存';
    case 'conflict': return '需要处理';
    case 'error': return '同步异常';
    default: return state.activeProjectName ? `已同步 · ${state.activeProjectName}` : '未连接书籍';
  }
}

function statusTitle(state: CloudSyncState): string {
  const details = [statusLabel(state)];
  if (state.lastSyncedAt) details.push(`最近同步 ${new Date(state.lastSyncedAt).toLocaleTimeString('zh-CN')}`);
  if (state.pendingCommits) details.push(`${state.pendingCommits} 项修改等待上传`);
  if (state.error) details.push(state.error);
  return details.join(' · ');
}
