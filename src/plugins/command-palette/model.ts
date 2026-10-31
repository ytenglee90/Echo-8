import type { PluginDefinition } from '../../core/contracts.ts';
import { defineManifest } from '../manifest.ts';

export const COMMAND_PALETTE_NAMESPACE = 'commandPalette';

export function createCommandPalettePlugin(view?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('command-palette', '命令面板', {
      category: 'core',
      namespaces: [COMMAND_PALETTE_NAMESPACE],
      namespaceDomains: { [COMMAND_PALETTE_NAMESPACE]: 'workspace' },
      sessionOnlyWorkspace: { [COMMAND_PALETTE_NAMESPACE]: true },
      commands: ['commandPalette.open', 'commandPalette.close'],
      dispatches: ['system.action.execute'],
      queries: ['commandPalette.state'],
      asks: ['commandPalette.state', 'system.actions', 'system.shortcuts'],
      ui: ['command-palette.open-button', 'command-palette.view'],
      shortcuts: ['command-palette.open-shortcut', 'command-palette.close-shortcut'],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.top.contribute',
        'ui.command-palette.contribute',
        'ui.action.register',
        'ui.action.execute',
        'ui.shortcut.register',
      ],
    }),

    start(context) {
      const setOpen = (open: boolean) => ({
        transaction: {
          label: open ? '打开命令面板' : '关闭命令面板',
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: COMMAND_PALETTE_NAMESPACE,
            key: 'open',
            value: open,
          }],
        },
      });

      context.commands.register({
        type: 'commandPalette.open',
        handle: () => {
          context.ui.activateSurface('command.palette', 'command-palette.view', 'commandPalette.close');
          return setOpen(true);
        },
      });
      context.commands.register({
        type: 'commandPalette.close',
        handle: () => {
          context.ui.deactivateSurface('command.palette', 'command-palette.view');
          return setOpen(false);
        },
      });
      context.queries.register({
        type: 'commandPalette.state',
        handle: () => ({ open: context.store.readValue<boolean>(COMMAND_PALETTE_NAMESPACE, 'open') ?? false }),
      });

      context.ui.contribute({
        id: 'command-palette.open-button',
        slot: 'top.primary',
        kind: 'button',
        label: '命令面板',
        icon: 'command',
        group: 'file',
        tooltip: '搜索并执行命令（Ctrl/⌘ + K）',
        command: 'commandPalette.open',
        priority: 20,
      });
      context.ui.contribute({
        id: 'command-palette.view',
        slot: 'command.palette',
        kind: 'view',
        label: '命令面板',
        component: view,
        priority: 0,
      });
      if (context.store.readValue<boolean>(COMMAND_PALETTE_NAMESPACE, 'open')) {
        context.ui.activateSurface('command.palette', 'command-palette.view', 'commandPalette.close');
      }
      context.ui.shortcut({
        id: 'command-palette.open-shortcut',
        chord: 'mod+k',
        command: 'commandPalette.open',
        label: '打开命令面板',
      });
      context.ui.shortcut({
        id: 'command-palette.close-shortcut',
        command: 'commandPalette.close',
        label: '关闭命令面板',
        category: '系统',
        allowInEditable: true,
      });
    },
  };
}
