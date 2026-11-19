import type { WorkspaceActionDescriptor, WorkspaceActionIndex } from '../protocols/workspace-actions.ts';
import type { AssistantInstruction } from '../protocols/assistant-preferences.ts';
import { isWorkspaceModelAction } from './workspace-model-actions.ts';

type Definition = Pick<AssistantInstruction, 'id' | 'action' | 'label' | 'category' | 'example' | 'requirement' | 'gap'>;
const selected = '作用于发送时选中的对象。';
const define = (id: string, action: string, label: string, category: string, example: string, requirement = '', gap = false): Definition =>
  ({ id, action, label, category, example, requirement, gap });

/** Only examples actually routed locally are offered as personal aliases. */
export const ASSISTANT_INSTRUCTIONS: readonly Definition[] = [
  define('group', 'group.create', '给选中节点编组', '群组', '把选中的节点分组', '至少选中两个节点。'),
  define('horizontal', 'layout.horizontal', '横排选中节点', '排版', '把选中节点横排', selected, true),
  define('vertical', 'layout.vertical', '竖排选中节点', '排版', '把选中节点垂直排列', selected, true),
  define('grid', 'layout.arrange', '网格排列选中节点', '排版', '把选中的节点排成网格', selected, true),
  define('node.create', 'node.create', '新建空白节点', '节点', '新建一个叫「空白」的节点', '创建一个新节点。'),
  define('connect-solid', 'connection.create', '用实线连接选中节点', '连线', '把选中的节点连起来用实线', '选中两个不同的节点，按选中顺序连接。'),
  define('connect-dashed', 'connection.create', '用虚线连接选中节点', '连线', '把选中的节点连起来用虚线', '选中两个不同的节点，按选中顺序连接。'),
  define('selection.all', 'selection.all', '全选画布对象', '选择', '全选画布'),
  define('selection.clear', 'selection.clear', '取消选择', '选择', '清空选区'),
  define('selection.read', 'selection.read', '查看选中对象', '选择', '现在选中了哪些对象'),
  define('clipboard.copy', 'clipboard.copy', '复制选中对象', '剪贴板', '复制选中的节点', selected),
  define('clipboard.cut', 'clipboard.cut', '剪切选中对象', '剪贴板', '剪切选中的节点', selected + '文档修改遵循确认与撤销规则。'),
  define('clipboard.paste', 'clipboard.paste', '粘贴对象', '剪贴板', '粘贴画布对象', '先复制画布对象。'),
  define('history.undo', 'history.undo', '撤销', '历史', '撤销上一步', '撤销最近一次文档修改。'),
  define('history.redo', 'history.redo', '重做', '历史', '重做上一步'),
  define('history.read', 'history.read', '查看撤销历史状态', '历史', '查询当前撤销历史状态'),
  define('connection.graph', 'connection.graph', '查看连线关系', '连线', '查看当前画布的连线关系'),
  define('group.list', 'group.list', '查看群组与成员', '群组', '列出当前群组和成员'),
  define('statistics.read', 'statistics.read', '查看画布字数统计', '正文与统计', '查看当前画布的文字统计'),
  define('statistics.selection', 'statistics.selection', '查看选区字数', '正文与统计', '选区正文有多少字', selected),
  define('editor.closeAll', 'editor.closeAll', '关闭全部编辑窗格', '编辑器', '关闭全部编辑窗格'),
  define('editor.next', 'editor.next', '切换到下一个编辑窗格', '编辑器', '切换到下一个编辑窗格'),
  define('editor.previous', 'editor.previous', '切换到上一个编辑窗格', '编辑器', '切换到上一个编辑窗格'),
  define('editor.read', 'editor.read', '查看已打开的编辑窗格', '编辑器', '现在打开了哪些编辑窗格'),
  define('editor.immersive.exit', 'editor.immersive.exit', '退出沉浸编辑', '编辑器', '退出沉浸编辑'),
  define('search.open', 'search.open', '打开查找替换', '搜索', '打开查找面板'),
  define('search.close', 'search.close', '关闭查找替换', '搜索', '关闭查找面板'),
  define('minimap.open', 'minimap.open', '打开小地图', '视图', '打开小地图'),
  define('minimap.close', 'minimap.close', '关闭小地图', '视图', '关闭小地图'),
  define('minimap.read', 'minimap.read', '查看小地图状态', '视图', '小地图打开了吗'),
  define('viewport.read', 'viewport.read', '查看缩放比例', '视图', '当前画布缩放比例是多少'),
  define('palette.open', 'palette.open', '打开外观设置', '外观', '打开外观设置'),
  define('theme-bright', 'appearance.preset.apply', '切换明调主题', '外观', '切换到明调主题', '同时应用画布、连线、编辑器和工具栏的配套颜色。'),
  define('theme-dark', 'appearance.preset.apply', '切换暗调主题', '外观', '切换到暗调主题', '同时应用画布、连线、编辑器和工具栏的配套颜色。'),
  define('theme-eye-care', 'appearance.preset.apply', '切换护眼主题', '外观', '切换到护眼主题', '同时应用画布、连线、编辑器和工具栏的配套颜色。'),
  define('settings.keys.open', 'settings.keys.open', '打开快捷键设置', '设置', '打开快捷键面板'),
  define('settings.personal.open', 'settings.personal.open', '打开指令与偏好', '设置', '打开指令与偏好'),
  define('settings.personal.close', 'settings.personal.close', '关闭指令与偏好', '设置', '关闭指令与偏好'),
  define('settings.plugins.open', 'settings.plugins.open', '打开插件中心', '设置', '打开插件'),
  define('settings.plugins.close', 'settings.plugins.close', '关闭插件中心', '设置', '关闭插件中心'),
  define('settings.retrieval.open', 'settings.retrieval.open', '打开检索设置', '设置', '打开检索'),
  define('settings.retrieval.close', 'settings.retrieval.close', '关闭检索设置', '设置', '关闭检索设置'),
  define('settings.models.open', 'settings.models.open', '打开 AI 模型连接', '设置', '打开模型连接设置'),
  define('settings.models.close', 'settings.models.close', '关闭 AI 模型连接', '设置', '关闭模型连接设置'),
  define('settings.cloud.open', 'settings.cloud.open', '打开云同步', '设置', '打开云同步'),
  define('settings.cloud.close', 'settings.cloud.close', '关闭云同步', '设置', '关闭云同步'),
  define('settings.keys.close', 'settings.keys.close', '关闭快捷键设置', '设置', '关闭快捷键面板'),
  define('file.panel.close', 'file.panel.close', '关闭书籍与恢复', '书籍与恢复', '关闭书籍与恢复'),
  define('diagnostics.close', 'diagnostics.close', '关闭诊断面板', '设置', '关闭内核与诊断'),
  define('diagnostics.log', 'diagnostics.log', '查看操作记录', '设置', '打开操作记录'),
  define('file.panel', 'file.panel', '打开书籍与恢复', '书籍与恢复', '打开文件与恢复面板'),
  define('recovery.list', 'recovery.list', '查看恢复点', '书籍与恢复', '查看本地恢复点列表'),
  define('settings.open', 'settings.open', '打开设置中心', '设置', '打开设置中心'),
  define('settings.close', 'settings.close', '关闭设置中心', '设置', '关闭设置中心'),
  define('group.management.open', 'group.management.open', '打开群组管理', '群组', '打开群组管理'),
  define('group.management.close', 'group.management.close', '关闭群组管理', '群组', '关闭群组管理'),
  define('palette.close', 'palette.close', '关闭外观设置', '外观', '关闭外观设置'),
  define('viewport.tool.hand', 'viewport.tool', '使用手形工具', '视图', '切换到手形工具'),
  define('viewport.tool.select', 'viewport.tool', '使用选择工具', '视图', '切换到选择工具'),
  define('editor.closeActive', 'editor.closeActive', '关闭当前编辑器', '编辑器', '关闭当前编辑器'),
  define('editor.immersive.current', 'editor.immersive.current', '进入当前编辑器沉浸写作', '编辑器', '进入沉浸写作模式', '先打开要写作的节点。'),
  define('editor.immersive.toggle', 'editor.immersive.toggle', '切换沉浸写作', '编辑器', '切换沉浸写作模式', '先打开要写作的节点。'),
  define('layout.guides.toggle', 'layout.guides.toggle', '切换智能参考线', '视图', '切换智能参考线'),
  define('layout.snap.toggle', 'layout.snap.toggle', '切换吸附', '视图', '切换吸附'),
  define('correction.toggle', 'correction.toggle', '切换本地纠错', '校对', '切换本地纠错'),
  define('completion.toggle', 'completion.toggle', '切换本地补全', '校对', '切换本地补全'),
  define('persistence.enabled', 'persistence.enabled', '切换自动保存', '书籍与恢复', '切换自动保存', '开启时保留当前非零间隔；已关闭时采用应用默认的一分钟。'),
  define('assistant.view.memory', 'assistant.view', '打开记忆中心', '助手', '打开记忆中心'),
  define('assistant.view.prompt', 'assistant.view', '打开提示模板', '助手', '打开Prompt模板中心'),
  define('assistant.view.chat', 'assistant.view', '返回助手对话', '助手', '切换到AI对话'),
  define('assistant.web', 'assistant.web', '切换联网搜索', '助手', '切换联网搜索'),
  define('assistant.autoMemory', 'assistant.autoMemory', '切换自动记忆候选', '助手', '切换自动记忆候选'),
  define('assistant.context.automatic', 'assistant.context', '恢复自动取材', '助手', '打开自动取材'),
  define('assistant.context.explicit', 'assistant.context', '关闭自动取材', '助手', '关闭自动取材'),
  define('commands.open', 'commands.open', '打开命令面板', '界面', '打开命令面板'),
  define('commands.close', 'commands.close', '关闭命令面板', '界面', '关闭命令面板'),
  define('canvasControl.open', 'canvasControl.open', '打开画布控制面板', '界面', '打开画布控制面板'),
  define('canvasControl.close', 'canvasControl.close', '关闭画布控制面板', '界面', '关闭画布控制面板'),
];

function registeredExample(action: WorkspaceActionDescriptor): string | undefined {
  return action.id.startsWith('registered:') && action.inputSchema?.type === 'null' &&
    action.sourceKeys?.some(key => /^command:(?:canvas|selection|group|connection|annotation|palette|minimap|layout|editor|search|clipboard|history)\./u.test(key)) ? `执行本地命令：${action.label}` : undefined;
}

export function assistantInstructionCatalog(index: WorkspaceActionIndex): AssistantInstruction[] {
  return index.actions.filter(action => action.category !== '开发者工具').flatMap(action => {
    const definitions = ASSISTANT_INSTRUCTIONS.filter(item => item.action === action.id);
    const available = action.status === 'available';
    if (definitions.length) return definitions.map(item => ({ ...item, available, customizable: available }));
    const example = registeredExample(action);
    return [{ id: action.id, action: action.id, label: action.label, category: action.category, example,
      available, customizable: available && Boolean(example), modelEligible: isWorkspaceModelAction(action),
      requirement: action.status === 'inactive' ? '对应功能当前未启用。' : action.status === 'manual' ? '从对应功能界面操作。' :
        example ? '沿用对应功能的参数校验、确认和撤销规则。' : '此动作尚未提供可自定义的自然语言说法，请从对应功能界面使用。' }];
  });
}

export function preferenceInstruction(action: string, gap?: number, catalog?: readonly AssistantInstruction[]): string | undefined {
  const item = catalog ? catalog.find(item => item.id === action && item.customizable && item.available) :
    ASSISTANT_INSTRUCTIONS.find(item => item.id === action);
  return item?.example && item.example + (item.gap && gap !== undefined ? `，间距 ${gap}` : '');
}

export const preferenceActionLabel = (action: string) => ASSISTANT_INSTRUCTIONS.find(item => item.id === action)?.label ?? action;
