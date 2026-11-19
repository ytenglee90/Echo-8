import type { NaturalCanvasOperation } from './ai-task-route.ts';
import { NATURAL_QUOTED_NAME, naturalName } from './natural-canvas-rules.ts';

const SUBJECT = /工作区|画布|节点|卡片|文本框|连接线|连线|群组|分组|编组|编辑器|窗格|沉浸|主题|配色|工具|面板|菜单|窗口|界面|页面|标签|查找|搜索|小地图|吸附|参考线|快捷键|自动保存|书库|指令|偏好|配置|设置|插件|检索|索引|记忆中心|模型|模板|选中|选区|prompt/iu;
const IMPERATIVE = /^(?:把|将|给|让|打开|关闭|开启|关掉|关上|收起|展开|显示|隐藏|进入|退出|切换|切到|换|改|调|设|选|删|移|清|连|断开|取消|恢复|返回|回到|聚焦|定位|找|查|看|列出|读出|启用|停用|禁用|唤出|呼出|叫出|去|到|翻|亮出|弹开|停止|暂停|重置|还原|放大|缩小|横排|竖排|整理)/u;

export function workspaceRequestText(prompt: string): string {
  return prompt.trim().replace(/^@(?:画布操作|通用)\s+/u, '')
    .replace(/^带我(?:去|到)\s*/u, '打开').replace(/^带我(?=看|打开|进入)/u, '')
    .replace(/^(?:(?:请问|请你?|麻烦你?|劳驾|帮我|替我|给我|我想请你|我希望|我需要|我想要?|我要|你能否|你能不能|是否可以|能不能|可不可以|能否|可以|你|先)(?:帮我|替我)?\s*)+/u, '')
    .replace(/(?:可以吗|行不行|好吗|好不好)?[。！!？?]*$/u, '').trim();
}

/** A current imperative about an application object; ordinary questions and story prose remain chat. */
export function isWorkspaceCommandRequest(prompt: string): boolean {
  if (prompt.length > 1200) return false;
  const text = workspaceRequestText(prompt.replace(new RegExp(NATURAL_QUOTED_NAME, 'gu'), ' □ '));
  if (/^(?:先)?(?:别|不要|不用|暂不|先不|禁止)|^(?:怎么|怎样|如何|为什么|如果|假如|假设|解释|介绍|讲述|写|改写|润色|创作|生成)|为什么|怎么|如何|怎样|会怎样|有什么(?:用|区别)|是什么意思/u.test(text)) return false;
  if (!SUBJECT.test(text)) return false;
  if (IMPERATIVE.test(text) ||
    /(?:给我|帮我|替我|我要|我希望).{0,40}(?:一下|出来|起来|打开|关掉|改掉|调好|收好)$/u.test(text) ||
    /(?:打开|关掉|收起来|关起来|开起来|换一下|调一下|改一下|切一下|显示出来)$/u.test(text)) return true;
  // Unknown verbs can still reach semantic planning; ordinary descriptions stay on the chat path.
  if (/^(?:我|这|那|当前|现在|目前|最近|今天|昨天|刚才|关于|对于)|什么|哪里|哪些|哪个|多少|是否|已经|刚刚|突然|好像|似乎|(?:很|太|非常|特别|有点).+$/u.test(text)) return false;
  const subject = SUBJECT.exec(text)!;
  const prefix = text.slice(0, subject.index);
  return /^[\p{Script=Han}]{2,10}$/u.test(prefix) && !/[我你他她它的是很太有没不会在]/u.test(prefix) ||
    /(?:一下|出来|起来|过去|回去)$/u.test(text);
}

/** A weak operand is not a verified title. Explicit quoted titles keep their literal semantics. */
export function needsSemanticCanvasParsing(prompt: string, local: NaturalCanvasOperation | undefined): boolean {
  if (!local || !['find', 'connect', 'remove', 'color', 'presentation', 'select'].includes(local.kind)) return false;
  const key = (value: string) => naturalName(value).normalize('NFKC').trim().toLowerCase();
  const literals = new Set([...prompt.matchAll(new RegExp(NATURAL_QUOTED_NAME, 'gu'))].map(match => key(match[0])));
  return local.names.some(name => !literals.has(key(name)) && (/^(?:所有|全部|一切|全都|当前选中|我(?:现在)?选中的|连接线|连线)$/u.test(name) ||
    SUBJECT.test(name) && /(?:打开|关闭|切换|改成|改为|设为|能调|管理页|管理窗口|另一个端点|调成|换成)/u.test(name)));
}

/** Existing anchored grammar may consume comma-separated parameters rather than additional actions. */
export function localCanvasCoversModifiers(prompt: string, local: NaturalCanvasOperation | undefined, clauses: string[]): boolean {
  if (!local) return false;
  if (local.kind === 'batch') return local.steps.every(step => !needsSemanticCanvasParsing(prompt, step));
  const tail = clauses.slice(1);
  if (!tail.length) return true;
  if (local.kind === 'group' && local.title) return tail.every(text => /^(?:名为|命名为|名称为|叫做?|组名为)\s*.+$/u.test(text));
  if (local.kind === 'arrange' && local.gap !== undefined) return tail.every(text =>
    /^(?:间距|间隔)\s*(?:为|设为)?\s*\d{1,4}(?:\s*(?:px|像素))?$|^(?:两张卡片|节点|卡片)(?:之间)?留白$/u.test(text));
  if (local.kind === 'presentation' && local.color) return tail.every(text => /^标题(?:栏)?(?:颜色)?(?:改|换|设).+$/u.test(text));
  if (local.kind === 'replace' && local.occurrence !== undefined) return tail.every(text =>
    /^(?:(?:只)?(?:改|替换)?第\s*\d+\s*处|(?:全部|所有|每一处)(?:都改)?)$/u.test(text));
  if (local.kind === 'find') return tail.every(text => /^(?:带我过去|定位过去|跳过去)$/u.test(text));
  if ('line' in local && local.line) return tail.every(text => /^用(?:实线|虚线)$/u.test(text));
  return false;
}
