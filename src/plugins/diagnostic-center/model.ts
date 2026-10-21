import type { PluginDefinition } from '../../core/contracts.ts';
import { DIAGNOSTIC_CENTER_NAMESPACE, diagnosticCenterManifest } from './manifest.ts';

export { DIAGNOSTIC_CENTER_NAMESPACE } from './manifest.ts';

export function createDiagnosticCenterPlugin(panel?: unknown): PluginDefinition {
  return {
    manifest: diagnosticCenterManifest,

    start(context) {
      const setOpen = (open: boolean) => ({
        transaction: {
          label: open ? '打开诊断中心' : '关闭诊断中心',
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: DIAGNOSTIC_CENTER_NAMESPACE,
            key: 'open',
            value: open,
          }],
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
        }),
      });
      context.ui.contribute({
        id: 'diagnostic-center.panel',
        slot: 'right.primary',
        kind: 'view',
        label: '诊断中心',
        component: panel,
        priority: 81,
      });
      if (context.store.readValue<boolean>(DIAGNOSTIC_CENTER_NAMESPACE, 'open')) {
        context.ui.activateSurface('right.primary', 'diagnostic-center.panel', 'diagnostics.close');
      }
      context.ui.action({
        id: 'diagnostic-center.open-action',
        label: '查看内核与诊断',
        command: 'diagnostics.open',
        category: '系统',
        keywords: ['内核', '诊断', '插件', '内存', '任务', '保存', 'diagnostics'],
        priority: 81,
      });
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
    },
  };
}
