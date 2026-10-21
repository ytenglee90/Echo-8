import { defineManifest } from '../manifest.ts';

export const DIAGNOSTIC_CENTER_NAMESPACE = 'diagnosticCenter';

export const diagnosticCenterManifest = defineManifest('diagnostic-center', '诊断中心', {
  namespaces: [DIAGNOSTIC_CENTER_NAMESPACE],
  namespaceDomains: { [DIAGNOSTIC_CENTER_NAMESPACE]: 'workspace' },
  optionalCapabilities: ['search.index.status@1'],
  commands: ['diagnostics.open', 'diagnostics.close'],
  queries: ['diagnostics.state'],
  asks: ['diagnostics.state', 'system.runtime'],
  ui: ['diagnostic-center.panel'],
  actions: ['diagnostic-center.open-action'],
  shortcuts: ['diagnostic-center.open-shortcut', 'diagnostic-center.close-shortcut'],
  permissions: [
    'store.own.read', 'store.own.write', 'ui.right.contribute',
    'ui.action.register', 'ui.shortcut.register',
  ],
});
