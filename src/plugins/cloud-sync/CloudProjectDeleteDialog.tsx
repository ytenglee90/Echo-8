'use client';

import { useEffect, useState } from 'react';
import type { CloudProjectDeleteConfirmation } from '../../cloud/contracts.ts';
import type { ViewClient } from '../../core/contracts.ts';
import { ConfirmationDialog } from '../../ui/ConfirmationDialog.tsx';

export function CloudProjectDeleteDialog({ client }: { client: ViewClient }) {
  const [pending, setPending] = useState<CloudProjectDeleteConfirmation>();
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let current = true;
    const refresh = () => {
      void client.ask<CloudProjectDeleteConfirmation | undefined>('cloudSync.deleteConfirmation').then(
        (next) => {
          if (!current) return;
          setPending(next);
          if (!next) {
            setDeleting(false);
            setError('');
          }
        },
        (reason) => { if (current) setError(errorMessage(reason)); },
      );
    };
    refresh();
    const unsubscribe = client.subscribeSignal('cloudSync.deleteConfirmation.changed', refresh);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [client]);

  if (!pending) return null;

  const cancel = () => {
    if (deleting) return;
    void client.dispatch('cloudSync.cancelDeleteProject')
      .catch((reason) => setError(errorMessage(reason)));
  };
  const confirm = () => {
    if (deleting) return;
    setDeleting(true);
    setError('');
    void client.dispatch('cloudSync.confirmDeleteProject', { projectId: pending.projectId })
      .catch((reason) => {
        setDeleting(false);
        setError(errorMessage(reason));
      });
  };

  return (
    <ConfirmationDialog
      titleId="cloud-project-delete-title"
      descriptionId="cloud-project-delete-description"
      title="删除这本云端书籍？"
      description={<>“{pending.name}”将从你的云端书库中移除，其他设备也无法再打开。</>}
      notice={pending.active
        ? <>这本书当前正在编辑。删除前会先建立本机恢复副本；当前画布会保留并改为未连接状态，未上传队列不会再发送。</>
        : <>此操作无法在应用内撤销，但不会删除你另存到本机的 .echo8 文件。</>}
      error={error}
      busy={deleting}
      confirmLabel="删除云端书籍"
      busyLabel="正在删除…"
      onCancel={cancel}
      onConfirm={confirm}
    />
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
