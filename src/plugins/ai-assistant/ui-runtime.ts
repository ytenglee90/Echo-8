import type { PluginContext } from '../../core/contracts.ts';

/** Keeps the AI plugin's declarative UI surface separate from business orchestration. */
export function registerAIAssistantUI(
  context: PluginContext,
  panel?: unknown,
  toolbar?: unknown,
  memoryDeleteDialog?: unknown,
): void {
  context.ui.contribute({
    id: 'ai.open-button',
    slot: 'top.primary',
    kind: 'view',
    label: 'AI',
    group: 'assist',
    tooltip: '检索画布上下文并回答；明确编辑节点时提供可撤销的写回审查',
    component: toolbar,
    priority: 10,
  });
  context.ui.contribute({
    id: 'ai.panel',
    slot: 'overlay.floating',
    kind: 'view',
    label: 'AI 助手',
    component: panel,
    priority: -12,
  });
  context.ui.contribute({
    id: 'ai.memory.deleteConfirm',
    slot: 'overlay.modal',
    kind: 'view',
    label: '确认删除 AI 记忆',
    component: memoryDeleteDialog,
    priority: 14,
  });
  context.ui.action({
    id: 'ai.open-action',
    label: '打开 AI 助手',
    command: 'ai.open',
    category: 'AI',
    keywords: ['润色', '扩写', '总结', '大纲', '提取', 'assistant'],
    priority: 25,
  });
  context.ui.action({
    id: 'ai.open-new-assistant-action',
    label: '新开独立 AI 助手',
    command: 'ai.assistant.openNew',
    category: 'AI',
    keywords: ['新助手', '多助手', '并行', '新会话', 'assistant'],
    priority: 24,
  });
  context.ui.action({
    id: 'ai.open-provider-settings-action',
    label: '配置 AI 模型连接与密钥',
    command: 'ai.openProviderSettings',
    category: 'AI',
    keywords: ['模型', '平台', '接口', '密钥', 'KEY', 'endpoint', 'API'],
    priority: 24,
  });
  context.ui.action({
    id: 'ai.save-session-action',
    label: '保存或更新当前 AI 对话存档',
    command: 'ai.session.save',
    category: 'AI',
    keywords: ['保存对话', '存档', '记忆', '索引', 'memory'],
    priority: 23,
  });
  context.ui.shortcut({
    id: 'ai.open-shortcut',
    chord: 'mod+shift+a',
    command: 'ai.open',
    label: '打开 AI 助手',
  });
  context.ui.shortcut({
    id: 'ai.open-new-assistant-shortcut',
    command: 'ai.assistant.openNew',
    label: '新开独立 AI 助手',
    category: 'AI',
  });
  context.ui.shortcut({
    id: 'ai.open-provider-settings-shortcut',
    chord: 'mod+alt+m',
    command: 'ai.openProviderSettings',
    label: '配置 AI 模型连接与密钥',
  });
  context.ui.shortcut({
    id: 'ai.close-shortcut',
    command: 'ai.close',
    label: '关闭 AI 助手',
    category: 'AI',
  });
  context.ui.shortcut({
    id: 'ai.save-session-shortcut',
    command: 'ai.session.save',
    label: '保存或更新当前 AI 对话存档',
    category: 'AI',
    allowInEditable: true,
  });
}
