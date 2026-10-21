import type { PluginDefinition } from '../../core/contracts.ts';
import { defineManifest } from '../manifest.ts';

export const historyControlsPlugin: PluginDefinition = {
  manifest: defineManifest('history-controls', '历史控制', {
    dispatches: ['history.undo', 'history.redo'],
    ui: ['history.undo', 'history.redo'],
    actions: ['history.undo-action', 'history.redo-action'],
    shortcuts: ['history.undo-shortcut', 'history.redo-shortcut', 'history.redo-alternate-shortcut'],
    permissions: ['ui.top.contribute', 'ui.action.register', 'ui.shortcut.register', 'history.manage'],
  }),
  start(context) {
    context.ui.contribute({
      id: 'history.undo',
      slot: 'top.primary',
      kind: 'button',
      label: '撤销',
      icon: 'undo',
      group: 'history',
      tooltip: '撤销上一个正式事务',
      command: 'history.undo',
      priority: 10,
    });
    context.ui.contribute({
      id: 'history.redo',
      slot: 'top.primary',
      kind: 'button',
      label: '重做',
      icon: 'redo',
      group: 'history',
      tooltip: '重做上一个被撤销的事务',
      command: 'history.redo',
      priority: 20,
    });
    context.ui.shortcut({
      id: 'history.undo-shortcut',
      chord: 'mod+z',
      command: 'history.undo',
      label: '撤销',
      allowInEditable: true,
    });
    context.ui.shortcut({
      id: 'history.redo-shortcut',
      chord: 'mod+shift+z',
      command: 'history.redo',
      label: '重做',
      allowInEditable: true,
    });
    context.ui.shortcut({
      id: 'history.redo-alternate-shortcut',
      chord: 'mod+y',
      command: 'history.redo',
      label: '重做（备用组合）',
      allowInEditable: true,
    });
    context.ui.action({
      id: 'history.undo-action',
      label: '撤销',
      command: 'history.undo',
      category: '编辑',
      keywords: ['返回', 'undo'],
      priority: 40,
    });
    context.ui.action({
      id: 'history.redo-action',
      label: '重做',
      command: 'history.redo',
      category: '编辑',
      keywords: ['恢复', 'redo'],
      priority: 41,
    });
  },
};
