import { canvasIntentText, canvasRequestDisposition } from './ai-task-route.ts';
import { workspaceRequirements } from './workspace-semantic-plan.ts';
import { workspaceRequestText } from './workspace-request-intent.ts';
import { workspaceCatalogIntent, type CatalogIntent } from './workspace-catalog-intent.ts';
import { compileWorkspaceLanguage, bindLocalWorkspacePronouns } from './workspace-language.ts';
import { NATURAL_QUOTED_NAME } from './natural-canvas-rules.ts';

const verb = '(?:打开|开(?:小)?地图|关闭|显示|隐藏|保存|另存|缩放|聚焦|定位|读取|查询|查看|检查|预览|展示|统计|设置|恢复|还原|重置|切换|停止|创建|建立|修改|把|将|给|为|选择|导入|更新|调出|唤出|呼出|叫出|亮出|弹开|翻到|翻开|去到|去|进到|进入|进|退出|收起|展开|看一下|看下|暂停|撤销|重做|启用|禁用|停用)';
const imperativeStart = new RegExp('^(?:(?:先|临时)\\s*)?' + verb, 'u');
type WorkspaceSequence = { matched: false; intent?: never } | { matched: true; intent?: CatalogIntent };

/** Parse once; matched but unsupported sequences must never fall back to a partial action. */
export function readWorkspaceSequence(prompt: string): WorkspaceSequence {
  if (canvasRequestDisposition(prompt) !== 'normal') return { matched: false };
  const clauses = workspaceRequirements(canvasIntentText(prompt)).map(req => workspaceRequestText(req.text));
  if (clauses.length < 2 || !imperativeStart.test(clauses[0]!)) return { matched: false };
  if (prompt.length > 2000 || /[\u0000]/u.test(prompt) ||
    /^(?:怎么|如何|如果|假如)|临时|否则|失败就|等我|确认后/u.test(prompt) || clauses.length > 24) return { matched: true };
  const parts: CatalogIntent[] = [];
  let previousTarget: Record<string, unknown> | undefined;
  for (const clause of clauses) {
    let part = workspaceCatalogIntent(clause);
    if (!part) {
      const steps = compileWorkspaceLanguage(clause);
      if (!steps) return { matched: true };
      part = { input: clause, steps, primitive: true };
    }
    const bound = bindLocalWorkspacePronouns(part.steps, previousTarget, new RegExp(NATURAL_QUOTED_NAME, 'u').test(clause));
    if (!bound) return { matched: true };
    previousTarget = bound.target;
    part = { ...part, steps: bound.steps };
    if (part.binding === 'shortcut' && /^(?:恢复|还原|重置)(?:刚才|先前)?(?:的)?(?:默认|原来)(?:的)?(?:快捷键|按键)$/u.test(clause)) {
      const shortcuts = parts.filter(previous => previous.binding === 'shortcut');
      if (shortcuts.length !== 1) return { matched: true };
      part = { ...part, operand: shortcuts[0]!.operand };
    }
    parts.push(part);
  }
  const steps = parts.flatMap(part => part.steps);
  return { matched: true, ...(steps.length <= 24 ? { intent: { input: prompt, steps, parts } } : {}) };
}
