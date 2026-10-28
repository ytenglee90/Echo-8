import type { PluginDefinition } from '../../core/contracts.ts';
import type {} from '../../protocols/book-library.ts';
import type {} from '../../protocols/cloud-sync.ts';
import type {} from '../../protocols/files.ts';
import { defineManifest } from '../manifest.ts';

export function createBookLibraryPlugin(homeView?: unknown): PluginDefinition {
  let open = true;
  return {
    manifest: defineManifest('book-library', '书库主页', {
      dependencies: ['cloud-sync', 'import-export'],
      commands: ['bookLibrary.show', 'bookLibrary.enterCanvas', 'bookLibrary.createLocal'],
      dispatches: [
        'cloudSync.close',
        'cloudSync.disconnectProject',
        'cloudSync.install',
        'cloudSync.listProjects',
        'cloudSync.logout',
        'cloudSync.openProject',
        'cloudSync.renameProject',
        'cloudSync.requestDeleteProject',
        'cloudSync.upgrade',
        'file.cancelPendingOpen',
        'file.openProjectFromLibrary',
        'system.document.new',
      ],
      events: ['document.replaced'],
      signals: ['bookLibrary.updated', 'cloudSync.updated'],
      asks: ['cloudSync.state', 'cloudSync.projects'],
      ui: ['book-library.home'],
      actions: ['book-library.open-action', 'book-library.enter-action'],
      shortcuts: ['book-library.open-shortcut', 'book-library.enter-shortcut'],
      permissions: [
        'ui.welcome.contribute',
        'ui.action.register',
        'ui.shortcut.register',
        'persistence.manage',
      ],
    }),

    start(context) {
      open = true;
      const setOpen = (next: boolean) => {
        open = next;
        context.signals.emit('bookLibrary.updated', { open });
        return { result: { open } };
      };

      context.commands.register({
        type: 'bookLibrary.show',
        handle: async () => {
          await context.commands.invoke('cloudSync.close');
          await context.commands.invoke('file.cancelPendingOpen');
          return setOpen(true);
        },
      });
      context.commands.register({
        type: 'bookLibrary.enterCanvas',
        handle: () => setOpen(false),
      });
      context.commands.register({
        type: 'bookLibrary.createLocal',
        handle: async () => {
          await context.commands.invoke('file.cancelPendingOpen');
          await context.commands.invoke('cloudSync.disconnectProject');
          await context.commands.invoke('system.document.new');
          return setOpen(false);
        },
      });

      context.events.subscribe('document.replaced', () => {
        if (open) setOpen(false);
      });

      context.ui.contribute({
        id: 'book-library.home',
        slot: 'application.welcome',
        kind: 'view',
        label: 'Echo-8 书库',
        component: homeView,
      });
      context.ui.action({
        id: 'book-library.open-action',
        label: '返回首页（书库）',
        command: 'bookLibrary.show',
        category: '文件',
        keywords: ['主页', '首页', '新建', '打开', '切换'],
        priority: -400,
      });
      context.ui.action({
        id: 'book-library.enter-action',
        label: '进入当前画布',
        command: 'bookLibrary.enterCanvas',
        category: '文件',
        keywords: ['关闭书库', '当前画布', '恢复'],
        priority: -399,
      });
      context.ui.shortcut({
        id: 'book-library.open-shortcut',
        command: 'bookLibrary.show',
        label: '返回书库',
        category: '书籍',
      });
      context.ui.shortcut({
        id: 'book-library.enter-shortcut',
        command: 'bookLibrary.enterCanvas',
        label: '进入当前画布',
        category: '书籍',
      });
    },
  };
}
