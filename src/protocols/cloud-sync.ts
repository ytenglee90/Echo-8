import type {
  CloudInstallationSummary,
  CloudProjectSummary,
  CloudSyncState,
} from '../cloud/contracts.ts';
import type { CommandContract } from './commands.ts';

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'cloudSync.open': CommandContract<undefined, { open: boolean }>;
    'cloudSync.close': CommandContract<undefined, { open: boolean }>;
    'cloudSync.refresh': CommandContract<undefined, CloudSyncState>;
    'cloudSync.listProjects': CommandContract<undefined, CloudProjectSummary[]>;
    'cloudSync.install': CommandContract<
      { accountId: string },
      { installation: CloudInstallationSummary }
    >;
    'cloudSync.upgrade': CommandContract<
      { installationId: string },
      { installation: CloudInstallationSummary }
    >;
    'cloudSync.openProject': CommandContract<
      { projectId?: string; takeover?: boolean; discardLocal?: boolean } | undefined,
      CloudSyncState
    >;
    'cloudSync.createProject': CommandContract<{ name: string }, CloudProjectSummary>;
    'cloudSync.renameProject': CommandContract<
      { projectId: string; name: string },
      CloudProjectSummary
    >;
    'cloudSync.requestDeleteProject': CommandContract<
      { projectId: string },
      { open: boolean }
    >;
    'cloudSync.cancelDeleteProject': CommandContract<undefined, { cancelled: boolean }>;
    'cloudSync.confirmDeleteProject': CommandContract<
      { projectId: string },
      { deleted: boolean; detachedCurrent: boolean }
    >;
    'cloudSync.saveCurrentAsProject': CommandContract<
      { name?: string } | undefined,
      CloudProjectSummary
    >;
    'cloudSync.disconnectProject': CommandContract<undefined, CloudSyncState>;
    'cloudSync.syncNow': CommandContract<undefined, CloudSyncState>;
    'cloudSync.takeover': CommandContract<undefined, CloudSyncState>;
    'cloudSync.acceptRemote': CommandContract<undefined, CloudSyncState>;
    'cloudSync.logout': CommandContract<undefined, { loggedOut: boolean }>;
  }
}

export {};
