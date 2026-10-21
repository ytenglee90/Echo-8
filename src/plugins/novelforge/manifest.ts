import { EXTERNAL_PROJECT_DIRECTORY_CAPABILITY } from '../../protocols/files.ts';
import { NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY } from '../../protocols/novelforge.ts';
import { defineManifest } from '../manifest.ts';

export const NOVELFORGE_BINDING_NAMESPACE = 'novelforgeBindings';
export const NOVELFORGE_UI_NAMESPACE = 'novelforgeUI';

export const novelForgeManifest = defineManifest('novelforge', 'NovelForge 小说工程', {
  namespaces: [NOVELFORGE_BINDING_NAMESPACE, NOVELFORGE_UI_NAMESPACE],
  namespaceDomains: {
    [NOVELFORGE_BINDING_NAMESPACE]: 'document',
    [NOVELFORGE_UI_NAMESPACE]: 'workspace',
  },
  requiresCapabilities: [
    EXTERNAL_PROJECT_DIRECTORY_CAPABILITY,
    'content.createPlan@1',
    'content.deltaPlan@1',
    'content.renamePlan@1',
    'content.summariesById@1',
    'content.read@1',
  ],
  commands: [
    'novelforge.open',
    'novelforge.close',
    'novelforge.connect',
    'novelforge.connector.configure',
    'novelforge.connector.clear',
    'novelforge.connector.probe',
    'novelforge.connector.selectProject',
    'novelforge.disconnect',
    'novelforge.sync',
    'novelforge.commitSync',
    'novelforge.updateConnectionState',
    'novelforge.markDirty',
    'novelforge.queueDirtyProposals',
    'novelforge.commitQueuedProposals',
    'novelforge.clearBindings',
  ],
  dispatches: [
    'novelforge.sync',
    'novelforge.commitSync',
    'novelforge.updateConnectionState',
    'novelforge.commitQueuedProposals',
    'novelforge.connector.probe',
    'system.preferences.set',
  ],
  events: ['content.changed', 'node.renamed', 'document.replaced'],
  signals: ['novelforge.status'],
  queries: ['novelforge.state'],
  asks: ['novelforge.state', 'system.preferences.get'],
  providesCapabilities: [NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY],
  ui: ['novelforge.panel'],
  actions: ['novelforge.open-action'],
  shortcuts: ['novelforge.open-shortcut', 'novelforge.close-shortcut'],
  permissions: [
    'store.own.read',
    'store.own.write',
    'ui.right.contribute',
    'ui.action.register',
    'ui.shortcut.register',
    'tasks.schedule',
    'network.local.connector',
    'network.origin.manage',
    'preferences.manage',
  ],
});
