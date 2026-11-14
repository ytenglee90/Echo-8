import type { PluginDefinition } from '../../core/contracts.ts';
import { UI_SURFACE_REVEALED_EVENT, uiSurfaceRevealed } from '../../protocols/ui.ts';
import { DIAGNOSTIC_CENTER_NAMESPACE, diagnosticCenterManifest } from './manifest.ts';

export { DIAGNOSTIC_CENTER_NAMESPACE } from './manifest.ts';

export function createDiagnosticCenterPlugin(panel?: unknown): PluginDefinition {
  return {
    manifest: diagnosticCenterManifest,

    start(context) {
      const setOpen = (open: boolean, operationLog = false) => ({
        transaction: {
          label: open ? '打开诊断中心' : '关闭诊断中心',
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: DIAGNOSTIC_CENTER_NAMESPACE,
            key: 'open',
            value: open,
          }, {
            op: 'set' as const, domain: 'workspace' as const, namespace: DIAGNOSTIC_CENTER_NAMESPACE,
            key: 'operationLog', value: operationLog,
          }],
          events: open ? [{
            type: UI_SURFACE_REVEALED_EVENT,
            payload: uiSurfaceRevealed('right.primary', 'diagnostic-center', 'diagnostic-center.panel'),
          }] : undefined,
        },
      });
      context.commands.register({
        type: 'diagnostics.open',
        handle: () => {
          context.ui.activateSurface('right.primary', 'diagnostic-center.panel', 'diagnostics.close');
          return setOpen(true);
        },
      });
      context.commands.register({
        type: 'diagnostics.operationLog.open@1',
        handle: () => {
          context.ui.activateSurface('right.primary', 'diagnostic-center.panel', 'diagnostics.close');
          return setOpen(true, true);
        },
      });
      context.commands.register({
        type: 'diagnostics.close',
        handle: () => {
          context.ui.deactivateSurface('right.primary', 'diagnostic-center.panel');
          return setOpen(false);
        },
      });
      context.queries.register({
        type: 'diagnostics.state',
        handle: () => ({
          open: context.store.readValue<boolean>(DIAGNOSTIC_CENTER_NAMESPACE, 'open') ?? false,
          operationLog: context.store.readValue<boolean>(DIAGNOSTIC_CENTER_NAMESPACE, 'operationLog') ?? false,
        }),
      });
      context.ui.contribute({
        id: 'diagnostic-center.panel',
        slot: 'right.primary',
        kind: 'view',
        label: '诊断中心',
        component: panel,
        settings: { version: 1, label: '内核与诊断', icon: 'cpu', order: 60, openCommand: 'diagnostics.open' },
        priority: 81,
      });
      if (context.store.readValue<boolean>(DIAGNOSTIC_CENTER_NAMESPACE, 'open')) {
        context.ui.activateSurface('right.primary', 'diagnostic-center.panel', 'diagnostics.close');
      }
      context.ui.shortcut({
        id: 'diagnostic-center.open-shortcut',
        chord: 'mod+alt+d',
        command: 'diagnostics.open',
        label: '查看内核与诊断',
      });
      context.ui.shortcut({
        id: 'diagnostic-center.close-shortcut',
        command: 'diagnostics.close',
        label: '关闭内核与诊断',
        category: '系统',
      });
      context.ui.action({
        id: 'diagnostic-center.operation-log',
        label: '实时操作日志',
        command: 'diagnostics.operationLog.open@1',
        category: '系统',
      });
      context.ui.shortcut({
        id: 'diagnostic-center.operation-log-shortcut',
        command: 'diagnostics.operationLog.open@1',
        label: '实时操作日志',
        category: '系统',
      });
    },
  };
}
