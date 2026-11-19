import type { NaturalCanvasOperation } from './ai-task-route.ts';
import { NATURAL_QUOTED_NAME } from './natural-canvas-rules.ts';

const SUBJECT = /工作区|画布|节点|卡片|文本框|连接线|连线|群组|分组|编组|编辑器|窗格|沉浸|主题|配色|工具|面板|菜单|窗口|界面|页面|标签|查找|搜索|小地图|吸附|参考线|快捷键|自动保存|书库|指令|偏好|配置|设置|插件|检索|索引|记忆中心|模型|模板|选中|选区|prompt/iu;
const IMPERATIVE = /^(?:把|将|给|让|打开|关闭|开启|关掉|关上|收起|展开|显示|隐藏|进入|退出|切换|切到|换|改|调|设|选|删|移|清|连|断开|取消|恢复|返回|回到|聚焦|定位|找到|找出|找一下|查一下|查找|查看|查询|列出|读出|启用|停用|禁用|调出|唤出|呼出|叫出|看看)/u;

export function workspaceRequestText(prompt: string): string {
  return prompt.trim().replace(/^@(?:画布操作|通用)\s+/u, '')
    .replace(/^(?:(?:请你?|麻烦你?|劳驾|帮我|替我|给我|我想要?|我要|能不能|可不可以|能否|可以|你)(?:帮我|替我)?\s*)+/u, '')
    .replace(/[。！!？?]+$/u, '').trim();
}

/** A current imperative about an application object; ordinary questions and story prose remain chat. */
export function isWorkspaceCommandRequest(prompt: string): boolean {
  if (prompt.length > 1200) return false;
  const text = workspaceRequestText(prompt.replace(new RegExp(NATURAL_QUOTED_NAME, 'gu'), ' □ '));
  if (/^(?:先)?(?:别|不要|不用|暂不|先不|禁止)|^(?:怎么|怎样|如何|为什么|如果|假如|假设|解释|介绍|讲述|写|改写|润色|创作|生成)|为什么|怎么|如何|怎样|会怎样|有什么(?:用|区别)|是什么意思/u.test(text)) return false;
  return IMPERATIVE.test(text) && SUBJECT.test(text);
}

/** A weak operand is not a verified title. Explicit quoted titles keep their literal semantics. */
export function needsSemanticCanvasParsing(prompt: string, local: NaturalCanvasOperation | undefined): boolean {
  if (!local || !['find', 'connect', 'remove', 'color', 'presentation', 'select'].includes(local.kind)) return false;
  if (new RegExp(NATURAL_QUOTED_NAME, 'u').test(prompt) || /@\[|@node:/u.test(prompt)) return false;
  return local.names.some(name => /^(?:所有|全部|一切|全都|当前选中|我(?:现在)?选中的|连接线|连线)$/u.test(name) ||
    SUBJECT.test(name) && /(?:打开|关闭|切换|改成|改为|设为|能调|管理页|管理窗口|另一个端点|调成|换成)/u.test(name));
}
