import { CloudSyncPanel } from './CloudSyncPanel.tsx';
import { CloudProjectDeleteDialog } from './CloudProjectDeleteDialog.tsx';
import { CloudSyncStatus } from './CloudSyncStatus.tsx';
import { createCloudSyncPlugin } from './model.ts';

export const cloudSyncPlugin = createCloudSyncPlugin(
  CloudSyncStatus,
  CloudSyncPanel,
  CloudProjectDeleteDialog,
);
