'use client';

import type { ReactNode } from 'react';
import { Icon, IconButton } from './Icon.tsx';
import { ProcessingIndicator } from './ProcessingIndicator.tsx';

export interface ConfirmationDialogProps {
  titleId: string;
  descriptionId: string;
  title: string;
  description: ReactNode;
  notice?: ReactNode;
  error?: string;
  busy?: boolean;
  confirmLabel: string;
  busyLabel?: string;
  onCancel(): void;
  onConfirm(): void;
}

/** Shared governed-modal presentation for an explicitly confirmed destructive action. */
export function ConfirmationDialog({
  titleId,
  descriptionId,
  title,
  description,
  notice,
  error,
  busy = false,
  confirmLabel,
  busyLabel = '正在处理…',
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  return (
    <div className="confirmation-dialog-backdrop" onPointerDown={() => { if (!busy) onCancel(); }}>
      <section
        className="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="confirmation-dialog-copy">
            <strong id={titleId}>{title}</strong>
            <p id={descriptionId}>{description}</p>
          </div>
          <IconButton icon="close" label="取消" disabled={busy} onClick={onCancel} />
        </header>
        {notice && <div className="confirmation-dialog-notice">{notice}</div>}
        {error && <p className="confirmation-dialog-error" role="alert">{error}</p>}
        <footer>
          <button type="button" autoFocus disabled={busy} onClick={onCancel}>取消</button>
          <button
            type="button"
            className="confirmation-dialog-confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? <ProcessingIndicator size={12} /> : <Icon name="trash" size={15} />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
