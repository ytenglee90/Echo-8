'use client';

import type { ReactNode } from 'react';
import { IconButton } from './Icon.tsx';

export function SettingsPageHeader({ title, description, closeLabel, onClose, actions }: {
  title: string;
  description: string;
  closeLabel: string;
  onClose: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="settings-page-header">
      <div><h2>{title}</h2><p>{description}</p></div>
      <div className="settings-page-actions">
        {actions}
        <IconButton icon="close" label={closeLabel} onClick={onClose} />
      </div>
    </header>
  );
}
