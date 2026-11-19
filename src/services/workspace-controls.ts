import type { WorkspacePlanStep } from '../protocols/workspace-actions.ts';
import { workspaceRequestText } from './workspace-request-intent.ts';

type Control = Pick<WorkspacePlanStep, 'action' | 'arguments'>;

// Exact surface names shared by single instructions and compound local plans.
const surfaces = [
  { names: '指令与偏好|个人用语与偏好|我的用语|个人用语|用语与偏好|指令列表|全部指令', open: 'settings.personal.open', close: 'settings.personal.close' },
  { names: '插件|插件中心|插件管理|扩展|扩展管理', open: 'settings.plugins.open', close: 'settings.plugins.close' },
  { names: '检索|索引|语义检索|检索与索引', open: 'settings.retrieval.open', close: 'settings.retrieval.close' },
  { names: 'AI模型连接|模型连接|模型与连接|模型平台|模型密钥|AI配置|模型配置', open: 'settings.models.open', close: 'settings.models.close' },
  { names: '云同步|账户同步|账号同步', open: 'settings.cloud.open', close: 'settings.cloud.close' },
  { names: '小地图|画布小地图|右下角小地图|缩略地图|导航小窗|导航图|迷你地图', open: 'minimap.open', close: 'minimap.close', read: 'minimap.read', toggle: 'minimap.toggle' },
  { names: '查找|搜索|搜索替换|查找替换', open: 'search.open', close: 'search.close' },
  { names: '外观|全局颜色|配色|颜色设置|主题设置', open: 'palette.open', close: 'palette.close' },
  { names: '设置|工作区设置|设置中心|应用设置', open: 'settings.open', close: 'settings.close' },
  { names: '快捷键|按键设置|键盘快捷键|命令与快捷键', open: 'settings.keys.open', close: 'settings.keys.close' },
  { names: '诊断|内核与诊断|本地诊断|运行诊断', open: 'diagnostics.open', close: 'diagnostics.close' },
  { names: '操作记录|操作日志|实时操作日志|实时日志|实时操作记录', open: 'diagnostics.log', close: 'diagnostics.close' },
  { names: '文件|文件与恢复|书籍与恢复|文件管理', open: 'file.panel', close: 'file.panel.close' },
  { names: '群组管理|分组管理|群组管理器|群组成员管理', open: 'group.management.open', close: 'group.management.close', read: 'group.management.read' },
  { names: '命令面板|命令菜单|命令搜索', open: 'commands.open', close: 'commands.close' },
  { names: '画布控制|画布控制面板|画布操作面板', open: 'canvasControl.open', close: 'canvasControl.close' },
  { names: '助手|AI助手|助手窗口|AI助手窗口', open: 'assistant.open' },
  { names: '书库|书库首页|书库列表|书籍首页|书籍列表', open: 'library.show', read: 'library.state' },
  { names: '画布|当前画布|当前书籍画布|这本书的画布|之前那本书|刚才那本书', open: 'library.canvas' },
  { names: '本地校对规则|校对规则|纠错规则|本地纠错规则|纠错补全规则', open: 'correction.rules' },
  { names: '项目文件选择器|书籍文件选择器|本地文件选择器', open: 'file.choose' },
  { names: '标注窗口|注释窗口|批注窗口|标注面板|注释面板|批注面板', close: 'annotation.close' },
] as const;

const OPEN = '打开|开启|显示|展开|进入|弹出|返回|回到|切换到|切到|切回|转到|回|使用|继续显示|调出|唤出|呼出|叫出|调|看看|亮出|弹开|翻到|翻开|去到|去|进到|进|看一下|看下|查看一下|开起来|开(?!关)';
const CLOSE = '关闭|关掉|关上|收起|隐藏|退出|关|退掉|收起来|关起来|藏起来|隐藏掉';
const SWITCH = '切换|切一下|开关';
export function controlText(input: string): string {
  return workspaceRequestText(input).replace(/^(?:带我到|带我去|带我|先)\s*/u, '')
    .replace(/(?:一下|吧|就好|就行|就可以了|就行了)?[。！!]*$/u, '').trim();
}

function controlOperand(input: string): { name: string; operation: 'open' | 'close' | 'read' | 'toggle' } | undefined {
  const text = controlText(input);
  const query = /^(?:(?:查看|查询)(?:一下)?\s*)?(?:现在|当前)?(.+?)(?:目前|现在)?(?:打开了吗|开着吗|显示了吗|开没开|是否打开|是开还是关)[？?]?$/u.exec(text);
  if (query) return { name: query[1]!, operation: 'read' };
  const command = new RegExp('^(?:从(?:当前)?书库)?(' + OPEN + '|' + CLOSE + '|查看|查询|' + SWITCH + ')\\s*(.+)$', 'u').exec(text);
  const reversed = new RegExp('^(?:把|将)?\\s*(.+?)\\s*(' + OPEN + '|' + CLOSE + ')(?:一下|来|出来|起来|了)?$', 'u').exec(text);
  const hide = /^(?:不要|别|不再)显示\s*(.+?)(?:了)?$/u.exec(text);
  if (!command && !reversed && !hide) return undefined;
  const verb = command?.[1] ?? reversed?.[2] ?? '隐藏';
  return { name: command?.[2] ?? reversed?.[1] ?? hide![1]!, operation: /^(?:查看|查询)$/u.test(verb) ? 'read'
    : new RegExp('^(?:' + CLOSE + ')$', 'u').test(verb) ? 'close' : /^(?:切换|开关)$/u.test(verb) ? 'toggle' : 'open' };
}

export function workspaceSurfaceAction(input: string): string | undefined {
  const operand = controlOperand(input);
  if (!operand) return undefined;
  const normalize = (name: string) => name.replace(/\s+/gu, '').replace(/(?:给我|替我)$/u, '')
    .replace(/^(?:那个|这个)/u, '').replace(/(?:设置页|设置页面|设置面板|设置|页面|面板|窗口|中心|界面|那一页|页)$/u, '').replace(/的/gu, '').toLowerCase();
  const name = normalize(operand.name);
  const surface = surfaces.find(item => item.names.split('|').some(alias =>
    alias.toLowerCase() === operand.name.replace(/\s+/gu, '').toLowerCase() ||
    normalize(alias) === name));
  return surface && (surface as Partial<Record<typeof operand.operation, string>>)[operand.operation];
}

const switches = [
  { names: '智能参考线|参考线|对齐辅助线|对齐参考线', action: 'layout.guides.toggle' },
  { names: '吸附|自动吸附|磁吸|对齐吸附', action: 'layout.snap.toggle' },
  { names: '本地纠错|纠错|自动纠错|本地校对|校对', action: 'correction.toggle' },
  { names: '本地补全|补全|自动补全|自动补写词句', action: 'completion.toggle' },
  { names: '自动保存|自动存盘|自动存档', action: 'persistence.enabled' },
] as const;

export function workspaceSimpleControl(input: string): Control | undefined {
  if (/^(?:我要|我想要?|请帮我)?(?:调整|修改)(?:工作区|全局)?(?:配色|外观)[，,]\s*打开设置页[。！!]?$/u.test(input.trim())) return { action: 'palette.open' };
  const surface = workspaceSurfaceAction(input);
  if (surface) return { action: surface };
  const text = controlText(input);
  const enabled = /^(启用|停用|禁用|停止|暂停|恢复)\s*(.+)$/u.exec(text);
  const state = /^(?:把|将)?\s*(.+?)(?:的)?(?:设为|设置为|改为|改成|切换为|切换到)\s*(开启|打开|启用|关闭|关掉|停用)$/u.exec(text);
  const operand = state ? { name: state[1]!, operation: /关闭|关掉|停用/u.test(state[2]!) ? 'close' as const : 'open' as const }
    : enabled ? { name: enabled[2]!, operation: /启用|恢复/u.test(enabled[1]!) ? 'open' as const : 'close' as const } : controlOperand(text);
  const item = operand && switches.find(item => item.names.split('|').includes(operand.name.replace(/的?(?:状态|功能|开关)$/u, '')));
  if (item && operand && operand.operation !== 'read') return { action: item.action,
    ...(operand.operation === 'toggle' ? {} : { arguments: { enabled: operand.operation === 'open' } }) };
  if (/^(?:退出|关闭|关掉|离开)(?:沉浸(?:式)?(?:编辑|写作)?|专注(?:编辑|写作)?|全屏(?:编辑|写作)?)(?:模式)?$/u.test(text) ||
    /^(?:返回|切换到|切回)(?:普通|正常)(?:编辑|写作)(?:界面|模式)?$/u.test(text)) return { action: 'editor.immersive.exit' };
  if (/^(?:进入|打开|开启|切到|切换到)(?:当前编辑器的)?(?:沉浸(?:式)?(?:编辑|写作)?|专注写作|全屏写作)(?:模式)?$/u.test(text)) return { action: 'editor.immersive.current' };
  if (/^切换(?:当前编辑器)?(?:的)?沉浸(?:式)?(?:编辑|写作)?(?:模式)?$/u.test(text)) return { action: 'editor.immersive.toggle' };
  if (/^(?:切换|开关)(?:当前编辑器的)?格式刷$/u.test(text)) return { action: 'editor.formatBrush.toggle' };
  if (/^(?:关闭|关掉|收起)(?:当前|这个|当前的)?(?:编辑器|编辑窗格|编辑页)$/u.test(text)) return { action: 'editor.closeActive' };
  if (/^(?:关闭|关掉|收起)(?:全部|所有)(?:的)?(?:编辑器|编辑窗格|编辑页)$/u.test(text)) return { action: 'editor.closeAll' };
  if (/^(?:上一步|刚才那一步)(?:撤销|撤回)$|^(?:撤回|退回)上一步$|^(?:撤销掉|撤回|退回)(?:刚才|上一次|最后)(?:的)?(?:一步|操作|修改)$/u.test(text)) return { action: 'history.undo' };
  if (/^(?:上一步|刚才撤销的那一步)重做$|^恢复刚才撤销的操作$|^(?:再做一次|重新执行)(?:刚才|上次)(?:撤销|撤回)(?:的)?(?:操作|修改)$/u.test(text)) return { action: 'history.redo' };
  const pane = /^(?:切换?到?|切回|跳到|回到|激活)(?:右侧|右边)?(?:第)?(下一个|下一张|下个|上一个|上一张|上个|前一个)(?:编辑窗格|编辑器|编辑页|文档|窗格)$/u.exec(text);
  if (pane) return { action: /^下/u.test(pane[1]!) ? 'editor.next' : 'editor.previous' };
  const tool = /^(?:(?:把|将)?(?:画布)?(?:当前)?工具(?:切换|切|设|改|换)(?:为|到|成)?|(?:切换?|改用|使用|用|换)(?:到|成|为)?)\s*(?:拖动画布的)?(手抓|手形|手型|抓手|平移|选择|框选|选取|箭头)(?:工具|模式)?(?:平移画面)?$/u.exec(text);
  if (tool) return { action: 'viewport.tool', arguments: { tool: /选择|框选|选取|箭头/u.test(tool[1]!) ? 'select' : 'hand' } };
  return undefined;
}

/** Assistant-local commands must bind the sending window/session rather than the first window. */
export function assistantSimpleControl(input: string): Control & { binding?: 'assistant' | 'session' } | undefined {
  const text = controlText(input);
  const enabled = /^(启用|停用|禁用)\s*(.+)$/u.exec(text);
  const operand = enabled ? { name: enabled[2]!, operation: enabled[1] === '启用' ? 'open' as const : 'close' as const } : controlOperand(text);
  if (operand) {
    const name = operand.name.replace(/\s+/gu, '').toLowerCase();
    const view = /^(?:ai)?(?:记忆中心|记忆管理|记忆库)$/u.test(name) ? 'memory'
      : /^(?:prompt|提示词|提示模板|prompt模板|提示词模板)(?:中心|管理|列表)?$/u.test(name) ? 'prompt'
      : /^(?:ai)?(?:聊天|对话)(?:页面|界面|模式)?$/u.test(name) ? 'chat' : undefined;
    if (view && ['open', 'close'].includes(operand.operation)) return { action: 'assistant.view', arguments: { view: operand.operation === 'close' ? 'chat' : view }, binding: 'assistant' };
    if (/^(?:当前)?(?:ai)?助手(?:窗口)?$/u.test(name) && operand.operation === 'close') return { action: 'assistant.closeCurrent', binding: 'assistant' };
    if (/^(?:全部|所有)(?:ai)?助手(?:窗口)?$/u.test(name) && operand.operation === 'close') return { action: 'assistant.close' };
    const setting = /^(?:联网|联网搜索|网络搜索|联网检索)$/u.test(name) ? 'assistant.web'
      : /^(?:自动提炼记忆候选|自动记忆候选|自动记忆)$/u.test(name) ? 'assistant.autoMemory' : undefined;
    if (setting && ['open', 'close', 'toggle'].includes(operand.operation)) return { action: setting,
      ...(operand.operation === 'toggle' ? {} : { arguments: { enabled: operand.operation === 'open' } }), binding: 'assistant' };
    if (/^(?:自动取材|自动检索|自动检索资料)$/u.test(name) && ['open', 'close'].includes(operand.operation)) return { action: 'assistant.context',
      arguments: { mode: operand.operation === 'open' ? 'automatic' : 'explicit-only' }, binding: 'assistant' };
  }
  return undefined;
}

/** Missing values and explicit non-execution are acknowledged without asking a model to guess. */
export function workspaceControlClarification(input: string): string | undefined {
  const text = controlText(input);
  if (/^(?:切换|更换|修改)(?:画布)?(?:当前)?工具$/u.test(text)) return '请选择选择工具或手形工具，例如“切换到手形工具”。';
  if (/^(?:打开|编辑|阅读)(?:节点|卡片|正文|编辑器|编辑窗格)$/u.test(text)) return '请提供要打开的节点名称，例如“打开空白11的正文”。';
  const negative = /^(?:先)?(?:别|不要|不用|暂不|先不)\s*(.+)$/u.exec(text);
  if (negative && !workspaceSimpleControl(text) && (workspaceSimpleControl(negative[1]!) || assistantSimpleControl(negative[1]!))) return '收到，本轮不执行这项操作。';
  return undefined;
}
