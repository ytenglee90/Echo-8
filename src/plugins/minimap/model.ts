import type { PluginDefinition } from '../../core/contracts.ts';
import type { MinimapState } from '../../protocols/minimap.ts';
import { defineManifest } from '../manifest.ts';

export function createMinimapPlugin(view?: unknown, toggle?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('minimap', '画布小地图', {
      namespaces: ['minimap'], namespaceDomains: { minimap: 'workspace' },
      requiresCapabilities: ['content.catalog@2', 'canvas.camera@1', 'canvas.viewport@1'],
      providesCapabilities: ['minimap.state@1'],
      optionalCapabilities: ['canvas.appearance@1', 'canvas.overview@1'],
      commands: ['minimap.toggle', 'minimap.open', 'minimap.close'],
      dispatches: ['canvas.focusEntity', 'selection.set', 'interaction.begin', 'interaction.end'],
      signals: ['canvas.pan.requested', 'canvas.camera.preview', 'canvas.viewport.preview',
        'canvas.appearance.invalidated', 'appearance.color.preview', 'content.catalog.invalidated', 'canvas.overview.invalidated'],
      ui: ['minimap.view', 'minimap.toggle-button'],
      actions: ['minimap.toggle-action'], shortcuts: ['minimap.toggle-shortcut'],
      permissions: ['store.own.read', 'store.own.write', 'ui.canvas.contribute', 'ui.top.contribute',
        'ui.action.register', 'ui.shortcut.register'],
    }),
    start(context) {
      const isOpen = () => context.store.readValue<boolean>('minimap', 'open') ?? false;
      for (const type of ['minimap.toggle', 'minimap.open', 'minimap.close']) {
        context.commands.register({ type, handle: () => ({ transaction: {
          label: '切换画布小地图', history: false,
          patches: [{ op: 'set', domain: 'workspace', namespace: 'minimap', key: 'open',
            value: type === 'minimap.toggle' ? !isOpen() : type === 'minimap.open' }],
        } }) });
      }
      context.capabilities.provide<undefined, MinimapState>({
        key: 'minimap.state@1', invoke: () => ({ open: isOpen() }),
      });
      context.ui.contribute({ id: 'minimap.view', slot: 'canvas.navigation', kind: 'view',
        label: '画布小地图', component: view });
      context.ui.contribute({ id: 'minimap.toggle-button', slot: 'top.primary', kind: 'view',
        group: 'status', priority: 6, label: '打开或关闭小地图', component: toggle });
      context.ui.action({ id: 'minimap.toggle-action', label: '打开或关闭小地图',
        command: 'minimap.toggle', category: '画布', keywords: ['导航', '全貌', 'minimap'], priority: 70 });
      context.ui.shortcut({ id: 'minimap.toggle-shortcut', label: '打开或关闭小地图',
        command: 'minimap.toggle', category: '画布' });
    },
  };
}
