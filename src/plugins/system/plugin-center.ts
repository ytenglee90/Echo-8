import type { PluginDefinition } from '../../core/contracts.ts';
import { defineManifest } from '../manifest.ts';
import { PluginCenterPanel } from './PluginCenterPanel.tsx';

const PLUGIN_CENTER_NAMESPACE = 'pluginCenterUI';

export const pluginCenterPlugin: PluginDefinition = {
  manifest: defineManifest('plugin-center', '插件中心', {
    namespaces: [PLUGIN_CENTER_NAMESPACE],
    namespaceDomains: { [PLUGIN_CENTER_NAMESPACE]: 'workspace' },
    commands: ['pluginCenter.open', 'pluginCenter.close'],
    dispatches: ['plugin.start', 'plugin.pause', 'plugin.stop', 'plugin.uninstall', 'pluginCenter.close'],
    queries: ['pluginCenter.state'],
    asks: ['system.plugins', 'pluginCenter.state'],
    ui: ['plugin-center.panel'],
    actions: ['plugin-center.open-action'],
    shortcuts: ['plugin-center.open-shortcut', 'plugin-center.close-shortcut'],
    permissions: [
      'store.own.read', 'store.own.write', 'ui.right.contribute',
      'ui.action.register', 'ui.shortcut.register', 'plugins.lifecycle.manage',
    ],
  }),
  start(context) {
    const isOpen = () => context.store.readValue<boolean>(PLUGIN_CENTER_NAMESPACE, 'open') ?? false;
    const setOpen = (open: boolean) => ({
      transaction: {
        label: open ? '打开插件中心' : '关闭插件中心',
        history: false,
        patches: [{
          op: 'set' as const,
          domain: 'workspace' as const,
          namespace: PLUGIN_CENTER_NAMESPACE,
          key: 'open',
          value: open,
        }],
      },
    });
    context.commands.register({
      type: 'pluginCenter.open',
      handle: () => {
        context.ui.activateSurface('right.primary', 'plugin-center.panel', 'pluginCenter.close');
        return setOpen(true);
      },
    });
    context.commands.register({
      type: 'pluginCenter.close',
      handle: () => {
        context.ui.deactivateSurface('right.primary', 'plugin-center.panel');
        return setOpen(false);
      },
    });
    context.queries.register({ type: 'pluginCenter.state', handle: () => ({ open: isOpen() }) });
    context.ui.contribute({
      id: 'plugin-center.panel',
      slot: 'right.primary',
      kind: 'view',
      label: '插件中心',
      component: PluginCenterPanel,
    });
    context.ui.action({
      id: 'plugin-center.open-action',
      label: '打开插件中心',
      command: 'pluginCenter.open',
      category: '系统',
      keywords: ['插件', '模块', '热插拔', 'plugin'],
      priority: 79,
    });
    context.ui.shortcut({
      id: 'plugin-center.open-shortcut',
      chord: 'mod+alt+p',
      command: 'pluginCenter.open',
      label: '打开插件中心',
    });
    context.ui.shortcut({
      id: 'plugin-center.close-shortcut',
      command: 'pluginCenter.close',
      label: '关闭插件中心',
      category: '系统',
    });
    if (isOpen()) context.ui.activateSurface('right.primary', 'plugin-center.panel', 'pluginCenter.close');
  },
};
