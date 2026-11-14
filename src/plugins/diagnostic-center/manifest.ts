import { defineManifest } from '../manifest.ts';
import { OPERATION_LOG_CHANGED, OPERATION_LOG_QUERY } from '../../protocols/operation-log.ts';

export const DIAGNOSTIC_CENTER_NAMESPACE = 'diagnosticCenter';

export const diagnosticCenterManifest = defineManifest('diagnostic-center', '诊断中心', {
  category: 'diagnostic',
  namespaces: [DIAGNOSTIC_CENTER_NAMESPACE],
  namespaceDomains: { [DIAGNOSTIC_CENTER_NAMESPACE]: 'workspace' },
  sessionOnlyWorkspace: { [DIAGNOSTIC_CENTER_NAMESPACE]: true },
  optionalCapabilities: ['search.index.status@1'],
  commands: ['diagnostics.open', 'diagnostics.close', 'diagnostics.operationLog.open@1'],
  queries: ['diagnostics.state'],
  asks: ['diagnostics.state', 'system.runtime', OPERATION_LOG_QUERY],
  signals: [OPERATION_LOG_CHANGED],
  actions: ['diagnostic-center.operation-log'],
  ui: ['diagnostic-center.panel'],
  shortcuts: ['diagnostic-center.open-shortcut', 'diagnostic-center.close-shortcut', 'diagnostic-center.operation-log-shortcut'],
  permissions: [
    'store.own.read', 'store.own.write', 'ui.right.contribute',
    'ui.shortcut.register', 'ui.action.register',
  ],
});
