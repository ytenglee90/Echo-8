'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { RecoveryPreview } from '../../protocols/files.ts';
import type { PersistencePreferences } from '../../protocols/persistence-preferences.ts';
import {
  RECOVERY_RETENTION_OPTIONS,
  type RecoveryCatalog,
  type RecoveryDeleteRequest,
} from '../../protocols/recovery-management.ts';
import { IconButton } from '../../ui/Icon.tsx';

type PendingAction = { kind: 'delete'; request: RecoveryDeleteRequest; count: number } |
  { kind: 'retention'; limit: number | null };

export function RecoveryManager({ client, refreshToken, disabled, onChanged, overview, actions }: {
  client: ViewClient;
  refreshToken: number;
  disabled: boolean;
  onChanged: () => void;
  overview: ReactNode;
  actions: ReactNode;
}) {
  const [catalog, setCatalog] = useState<RecoveryCatalog>();
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingAction>();
  const [preview, setPreview] = useState<RecoveryPreview>();
  const [previewId, setPreviewId] = useState<string>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [preferencesVersion, setPreferencesVersion] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requestVersion = useRef({ value: 0 });
  const knownRetention = useRef<number | null | undefined>(undefined);

  useEffect(() => client.subscribeSignal<PersistencePreferences>('system.persistence.preferences.changed', message => {
    if (knownRetention.current === message.payload.recoveryRetentionLimit) return;
    knownRetention.current = message.payload.recoveryRetentionLimit;
    setPreferencesVersion(value => value + 1);
  }), [client]);

  useEffect(() => {
    let current = true;
    const requestState = requestVersion.current;
    requestState.value++;
    void client.ask<RecoveryCatalog>('system.recovery.catalog@1').then((next) => {
      if (!current) return;
      knownRetention.current = next.retentionLimit;
      setCatalog(next);
      setSelected([]);
      setPending(undefined);
      setPreview(undefined);
      setPreviewId(undefined);
    }).catch((reason) => current && setError(String(reason)));
    return () => { current = false; requestState.value++; };
  }, [client, refreshToken, preferencesVersion]);

  const busy = disabled || working;
  const maintain = async (action: PendingAction) => {
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const result = action.kind === 'delete'
        ? await client.dispatch('system.recovery.delete@1', action.request)
        : await client.dispatch('system.recovery.setRetention@1', { limit: action.limit });
      setPending(undefined);
      setMessage(`已删除 ${result.removedPoints} 个恢复副本，剩余 ${result.remainingPoints} 个。${action.kind === 'retention' ? action.limit === null ? '已关闭数量限制。' : `以后保留最近 ${action.limit} 个。` : ''}`);
      headingRef.current?.focus();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  return <section className="file-section recovery-manager local-data-recovery" aria-label="本机数据与恢复" aria-busy={working}>
    <div className="file-section-title recovery-module-heading">
      <h3 ref={headingRef} tabIndex={-1}>本机数据与恢复</h3>{actions}
    </div>
    <p className="file-note">查看本机占用、清理缓存和管理历史副本。删除副本不可撤销；当前书籍、撤销历史、云端书籍和个人设置会保留。</p>
    {overview}
    <section className="recovery-copies" aria-label="恢复副本管理">
    <h4>恢复副本 <span>{catalog?.totalCount ?? 0} 个</span></h4>
    <label className="autosave-interval-control">
      <span>自动保留数量</span>
      <select aria-label="恢复副本自动保留数量" value={catalog?.retentionLimit ?? 'none'} disabled={busy || !catalog}
        onChange={(event) => {
          const limit = event.target.value === 'none' ? null : Number(event.target.value);
          setPending({ kind: 'retention', limit });
          setMessage('');
        }}>
        <option value="none">不限制（保护独有副本）</option>
        {RECOVERY_RETENTION_OPTIONS.map((limit) => <option value={limit} key={limit}>最近 {limit} 个</option>)}
      </select>
    </label>
    <p className="file-note">启用数量限制后，较早的副本（含手动恢复点）会自动删除。此选择随个人账号同步，换设备后恢复；副本本身仅保存在本机。</p>
    <div className="local-storage-actions recovery-management-actions">
      <button type="button" disabled={busy || !selected.length} onClick={() => setPending({ kind: 'delete', request: { ids: selected }, count: selected.length })}>删除选中副本{selected.length ? `（${selected.length}）` : ''}</button>
      <button type="button" disabled={busy || !catalog?.totalCount} onClick={() => setPending({ kind: 'delete', request: { through: catalog!.listedAt }, count: catalog!.totalCount })}>清空恢复副本</button>
    </div>
    {pending && <div className="recovery-delete-confirmation" role="group" aria-label="确认清理恢复副本">
      <strong>{pending.kind === 'delete' ? `删除 ${pending.count} 个恢复副本？` : pending.limit === null ? '关闭自动保留数量限制？' : `只保留最近 ${pending.limit} 个恢复副本？`}</strong>
      <p>{pending.kind === 'retention' && pending.limit !== null
        ? '确认后会立即删除超出数量的旧副本，之后也按此数量保留。被删除的版本无法找回。'
        : pending.kind === 'delete' ? '只删除历史恢复版本，当前书籍会保留。此操作无法撤销。' : '独有的恢复副本将继续保留，可随时手动清理。'}</p>
      <div className="local-storage-actions">
        <button type="button" className="recovery-danger" disabled={busy} onClick={() => void maintain(pending)}>确认{pending.kind === 'delete' ? '删除' : '更改'}</button>
        <button type="button" disabled={working} onClick={() => setPending(undefined)}>取消</button>
      </div>
    </div>}
    <div className="recovery-list">
      {catalog?.points.map((point) => <div className="recovery-row" key={point.id}>
        <label className="recovery-select">
          <input type="checkbox" aria-label={`选择恢复副本：${point.label}`} checked={selected.includes(point.id)} disabled={busy}
            onChange={(event) => {
              setSelected(event.target.checked ? [...selected, point.id] : selected.filter((id) => id !== point.id));
              setPending(undefined);
            }} />
          <span><strong>{point.label}</strong><small>{formatTime(point.createdAt)} · {point.recordCount} 条记录 · {formatBytes(point.storedBytes)}</small></span>
        </label>
        <div className="recovery-row-actions">
          <IconButton icon={previewId === point.id ? 'check' : 'restore'} label={previewId === point.id ? '确认恢复' : '预览并恢复'}
            disabled={busy || previewId === point.id && preview?.id !== point.id}
            onClick={() => {
              setPending(undefined);
              if (previewId === point.id && preview?.id === point.id) {
                setPreviewId(undefined);
                void client.dispatch('file.restoreRecovery', { id: point.id }).catch((reason) => setError(String(reason)));
                return;
              }
              const version = ++requestVersion.current.value;
              setPreviewId(point.id);
              setPreview(undefined);
              void client.ask<RecoveryPreview>('system.recovery.preview', { id: point.id }).then((next) => {
                if (requestVersion.current.value === version) setPreview(next);
              }).catch((reason) => {
                if (requestVersion.current.value === version) { setPreviewId(undefined); setError(String(reason)); }
              });
            }} />
          <IconButton icon="trash" label={`删除恢复副本：${point.label}`} disabled={busy}
            onClick={() => { setPending({ kind: 'delete', request: { ids: [point.id] }, count: 1 }); setMessage(''); }} />
        </div>
        {previewId === point.id && preview?.id === point.id && <div className="recovery-preview" role="status">
          <strong>恢复前预览</strong>
          <span>文档修订 {preview.currentDocumentRevision} → {preview.targetDocumentRevision}</span>
          <span>记录 {preview.currentRecordCount} → {preview.targetRecordCount}</span>
          <span>命名空间 {preview.currentNamespaceCount} → {preview.targetNamespaceCount}</span>
          <span>目标历史：撤销 {preview.targetUndoEntries} / 重做 {preview.targetRedoEntries}</span>
          <small>确认后仍会先自动创建“恢复操作前”保险点。</small>
        </div>}
      </div>)}
      {catalog?.totalCount === 0 && <p className="file-empty">没有恢复副本。后续操作仍会按需生成新的恢复副本。</p>}
    </div>
    {catalog?.nextCursor && <button type="button" className="toolbar-button" disabled={busy} onClick={() => {
      setWorking(true);
      const version = requestVersion.current.value;
      void client.ask<RecoveryCatalog>('system.recovery.catalog@1', { before: catalog.nextCursor }).then((next) => {
        if (version === requestVersion.current.value) setCatalog({ ...next, listedAt: catalog.listedAt, points: [...catalog.points, ...next.points] });
      }).catch((reason) => setError(String(reason))).finally(() => setWorking(false));
    }}>加载更多恢复副本</button>}
    {message && <p className="file-note" role="status">{message}</p>}
    {error && <p className="autosave-settings-error" role="alert">{error}</p>}
    </section>
  </section>;
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${Math.ceil(bytes / 1000)} KB`;
}
function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
}
