'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type {
  NovelForgeBinding,
  NovelForgePanelState,
  NovelForgeStatusSignal,
} from '../../protocols/novelforge.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { NOVELFORGE_BINDING_NAMESPACE, NOVELFORGE_UI_NAMESPACE } from './manifest.ts';

const EMPTY_COUNTS: NovelForgePanelState['counts'] = {
  synced: 0,
  'local-draft': 0,
  'proposal-queued': 0,
  conflict: 0,
  orphaned: 0,
};

export function NovelForgePanel({ client }: { client: ViewClient }) {
  const ownVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion(NOVELFORGE_BINDING_NAMESPACE) +
      client.getOwnStateVersion(NOVELFORGE_UI_NAMESPACE),
    () => 0,
  );
  const [state, setState] = useState<NovelForgePanelState>({
    open: false,
    connected: false,
    bindings: [],
    counts: EMPTY_COUNTS,
    connector: {
      configured: false,
      online: false,
      endpoint: 'http://127.0.0.1:32147',
      projects: [],
    },
  });
  const [status, setStatus] = useState<NovelForgeStatusSignal>();
  const [busy, setBusy] = useState('');
  const [clearArmed, setClearArmed] = useState(false);
  const [connectorEndpoint, setConnectorEndpoint] = useState('http://127.0.0.1:32147');
  const [pairingToken, setPairingToken] = useState('');
  const [projectId, setProjectId] = useState('');
  const applyPanelState = useCallback((next: NovelForgePanelState) => {
    setState(next);
    setConnectorEndpoint(next.connector.endpoint);
    setProjectId((current) => next.connector.selectedProjectId ?? (
      next.connector.projects.some((project) => project.project_id === current)
        ? current
        : next.connector.projects[0]?.project_id ?? ''
    ));
  }, []);

  useEffect(() => {
    let current = true;
    void client.ask<NovelForgePanelState>('novelforge.state').then((next) => {
      if (current) applyPanelState(next);
    });
    return () => { current = false; };
  }, [applyPanelState, client, ownVersion]);

  useEffect(() => client.subscribeSignal<NovelForgeStatusSignal>('novelforge.status', (message) => {
    setStatus(message.payload);
    if (message.payload.state !== 'running') setBusy('');
    void client.ask<NovelForgePanelState>('novelforge.state').then(applyPanelState);
  }), [applyPanelState, client]);

  const attention = useMemo(() => state.bindings.filter((binding) =>
    binding.syncState !== 'synced'
  ).slice(0, 120), [state.bindings]);

  if (!state.open) return null;

  const run = async (label: string, command: string, payload?: unknown) => {
    setBusy(label);
    setStatus(undefined);
    try {
      await client.dispatch(command, payload);
      applyPanelState(await client.ask<NovelForgePanelState>('novelforge.state'));
      return true;
    } catch (error) {
      setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) });
      setBusy('');
      return false;
    }
  };

  return (
    <section className="novelforge-panel" role="region" aria-label="NovelForge 小说工程">
      <div className="panel-heading">
        <div><span className="eyebrow">网址 ↔ 本机 Runtime · 安全连接 v2</span><h2>NovelForge</h2></div>
        <IconButton icon="close" label="关闭 NovelForge" onClick={() => void client.dispatch('novelforge.close')} />
      </div>
      <p className="panel-copy">
        画布只读取 Runtime 投影并写入改动提案，不会直接修改 SQLite、审批、质量门或 Seal。
      </p>

      <section className="novelforge-section">
        <h3>本机连接器</h3>
        {typeof location !== 'undefined' && location.protocol === 'file:' && (
          <p className="novelforge-status error">离线 HTML 不能安全连接本机服务；请打开部署后的画布网址。</p>
        )}
        {!state.connector.configured ? (
          <div className="novelforge-connector-setup">
            <label className="ai-field"><span>本机地址</span>
              <input value={connectorEndpoint} onChange={(event) => setConnectorEndpoint(event.target.value)} />
            </label>
            <label className="ai-field"><span>一次性配置用配对令牌</span>
              <input type="password" value={pairingToken} autoComplete="off"
                placeholder="从安装完成信息中复制一次"
                onChange={(event) => setPairingToken(event.target.value)} />
            </label>
            <button className="primary-button" disabled={!pairingToken.trim() || Boolean(busy)} onClick={() => {
              void run('正在保存并连接', 'novelforge.connector.configure', {
                endpoint: connectorEndpoint,
                pairingToken,
              }).then((connected) => { if (connected) setPairingToken(''); });
            }}>保存并连接（只需一次）</button>
          </div>
        ) : (
          <>
            <dl className="novelforge-project-grid">
              <div><dt>地址</dt><dd>{state.connector.endpoint}</dd></div>
              <div><dt>状态</dt><dd>{state.connector.online ? '已自动连接' : '暂时离线'}</dd></div>
            </dl>
            {state.connector.message && <p className="novelforge-footnote">{state.connector.message}</p>}
            <div className="novelforge-actions">
              <button className="toolbar-button" disabled={Boolean(busy)}
                onClick={() => void run('正在重连', 'novelforge.connector.probe')}>重新检测</button>
              <button className="toolbar-button" disabled={Boolean(busy)}
                onClick={() => void run('正在清除配对', 'novelforge.connector.clear')}>清除配对</button>
            </div>
          </>
        )}
        {state.connector.online && (
          <div className="novelforge-connector-project">
            <label className="ai-field"><span>本机小说项目</span>
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {state.connector.projects.length === 0 && <option value="">当前还没有项目</option>}
                {state.connector.projects.map((project) => (
                  <option key={project.project_id} value={project.project_id}>
                    {project.title} · {project.chapter_count} 章
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={!projectId || Boolean(busy)}
              onClick={() => void run('正在连接项目', 'novelforge.connector.selectProject', { projectId })}>
              连接并同步
            </button>
          </div>
        )}
      </section>

      <div className="novelforge-actions">
        <button
          className="toolbar-button"
          disabled={!state.connected || Boolean(busy)}
          onClick={() => void run('同步中', 'novelforge.sync')}
        >同步权威投影</button>
        <button
          className="toolbar-button"
          disabled={!state.connected || state.counts['local-draft'] + state.counts.conflict === 0 || Boolean(busy)}
          onClick={() => void run('写入提案', 'novelforge.queueDirtyProposals')}
        >提交本地改动提案</button>
      </div>

      {status && <p className={`novelforge-status ${status.state}`}>{status.message}</p>}
      {!status && busy && <p className="novelforge-status running">{busy}…</p>}

      <section className="novelforge-section">
        <h3>连接状态</h3>
        <dl className="novelforge-project-grid">
          <div><dt>连接</dt><dd>{state.connected ? state.directoryName ?? '已连接' : '未选择项目'}</dd></div>
          <div><dt>项目</dt><dd>{state.project?.title ?? '尚未同步'}</dd></div>
          <div><dt>阶段</dt><dd>{state.project?.stage ?? '—'}</dd></div>
          <div><dt>流程状态</dt><dd>{state.project?.workflow_status ?? '—'}</dd></div>
          <div><dt>总章数</dt><dd>{state.project?.chapter_count ?? '—'}</dd></div>
          <div><dt>映射节点</dt><dd>{state.bindings.length}</dd></div>
        </dl>
        {state.snapshotDigest && <code className="novelforge-digest" title={state.snapshotDigest}>
          快照 {shortDigest(state.snapshotDigest)}
        </code>}
      </section>

      <section className="novelforge-section">
        <h3>同步状态</h3>
        <div className="novelforge-counts">
          <StateCount label="已同步" value={state.counts.synced} tone="good" />
          <StateCount label="本地草稿" value={state.counts['local-draft']} tone="warn" />
          <StateCount label="提案已排队" value={state.counts['proposal-queued']} />
          <StateCount label="冲突" value={state.counts.conflict} tone="danger" />
          <StateCount label="Runtime 已移除" value={state.counts.orphaned} />
        </div>
      </section>

      <section className="novelforge-section">
        <h3>需要处理</h3>
        {attention.length === 0 ? <p className="novelforge-empty">当前没有本地草稿、冲突或待回执条目。</p> : (
          <div className="novelforge-binding-list">
            {attention.map((binding) => <BindingRow key={binding.entryId} binding={binding} />)}
          </div>
        )}
        {state.bindings.filter((binding) => binding.syncState !== 'synced').length > attention.length && (
          <p className="novelforge-footnote">这里只显示前 {attention.length} 条；其余映射仍保留并参与同步。</p>
        )}
      </section>

      <section className="novelforge-section">
        <h3>怎么工作</h3>
        <ol className="novelforge-steps">
          <li>选中项目后，画布自动从本机 Runtime 读取权威投影。</li>
          <li>画布编辑会成为本地草稿；点击提交后只生成待审查提案。</li>
          <li>Codex/Runtime 仍负责审查、审批、质量门和 Seal；画布不能绕过它们。</li>
        </ol>
        <details>
          <summary>兼容模式：手动选择 exchange 目录</summary>
          <p className="novelforge-footnote">仅在连接器不可用时使用；它仍需要手动执行 canvas-export / canvas-process。</p>
          <button className="toolbar-button" disabled={Boolean(busy)}
            onClick={() => void run('连接中', 'novelforge.connect')}>连接 exchange 目录</button>
        </details>
      </section>

      <section className="novelforge-section novelforge-boundary-actions">
        <button
          className="toolbar-button"
          disabled={!state.connected || Boolean(busy)}
          onClick={() => void run('断开中', 'novelforge.disconnect')}
        >断开项目（保留映射与配对）</button>
        <button
          className={clearArmed ? 'danger-button' : 'toolbar-button'}
          disabled={state.bindings.length === 0 || Boolean(busy)}
          onClick={() => {
            if (!clearArmed) {
              setClearArmed(true);
              return;
            }
            setClearArmed(false);
            void run('清除映射', 'novelforge.clearBindings');
          }}
        >{clearArmed ? '再次点击确认清除映射' : '清除映射（保留节点）'}</button>
      </section>
    </section>
  );
}

function StateCount({ label, value, tone = '' }: { label: string; value: number; tone?: string }) {
  return <div className={tone}><span>{label}</span><strong>{value}</strong></div>;
}

function BindingRow({ binding }: { binding: NovelForgeBinding }) {
  return (
    <div className={binding.syncState}>
      <div>
        <strong>{binding.canvasTitle}</strong>
        <span>{binding.artifactType}{binding.chapter ? ` · 第 ${binding.chapter} 章` : ''}</span>
      </div>
      <i>{stateLabel(binding.syncState)}</i>
      {binding.conflictReason && <small>{binding.conflictReason}</small>}
      {binding.proposalId && <code title={binding.proposalId}>{binding.proposalId}</code>}
    </div>
  );
}

function stateLabel(state: NovelForgeBinding['syncState']): string {
  return ({
    synced: '已同步',
    'local-draft': '本地草稿',
    'proposal-queued': '等待 Runtime',
    conflict: '冲突',
    orphaned: '已移除',
  })[state];
}

function shortDigest(digest: string): string {
  return `${digest.slice(0, 15)}…${digest.slice(-8)}`;
}
