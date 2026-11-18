import { canvasIntentText, canvasRequestDisposition } from './ai-task-route.ts';
import { NATURAL_QUOTED_NAME } from './natural-canvas-rules.ts';
import { workspaceCatalogIntent, type CatalogIntent } from './workspace-catalog-intent.ts';
import { compileWorkspaceLanguage } from './workspace-language.ts';

const verb = '(?:打开|开(?:小)?地图|关闭|显示|隐藏|保存|另存|缩放|聚焦|定位|读取|查询|查看|检查|预览|展示|统计|设置|恢复|还原|重置|切换|停止|创建|建立|修改|把|将|给|为|选择|导入|更新)';
const next = '(?:(?:先|然后|接着|随后|最后|再|并且|同时)\\s*)?' + verb;
const separator = new RegExp('[,，;；]\\s*(?=' + next + ')|(?:然后|接着|随后|最后|(?<!不)再|并且|同时)\\s*(?=' + verb + ')', 'u');
const imperativeStart = new RegExp('^(?:(?:先|临时)\\s*)?' + verb, 'u');
type WorkspaceSequence = { matched: false; intent?: never } | { matched: true; intent?: CatalogIntent };

/** Parse once; matched but unsupported sequences must never fall back to a partial action. */
export function readWorkspaceSequence(prompt: string): WorkspaceSequence {
  if (canvasRequestDisposition(prompt) !== 'normal') return { matched: false };
  const literals: string[] = [];
  const masked = canvasIntentText(prompt).replace(new RegExp(NATURAL_QUOTED_NAME, 'gu'), value => {
    return '\u0000' + (literals.push(value) - 1) + '\u0000';
  });
  const maskedClauses = masked.split(separator);
  // Purpose, network limits and preview constraints are not imperative steps.
  if (maskedClauses.length < 2 || !imperativeStart.test(maskedClauses[0]!)) return { matched: false };
  if (prompt.length > 1200 || /[\u0000\r\n]/u.test(prompt) ||
    /^(?:怎么|如何|如果|假如)|临时|否则|失败就|等我|确认后/u.test(masked)) return { matched: true };
  const clauses = maskedClauses.map(clause => clause
    .replace(/\u0000(\d+)\u0000/gu, (_token, index: string) => literals[Number(index)]!)
    .replace(/^(?:(?:先|然后|接着|随后|最后|再|并且|同时)\s*)+/u, '')
    .replace(/[。！!]+$/u, '').trim()).filter(Boolean);
  if (clauses.length < 2 || clauses.length > 8) return { matched: true };
  const parts: CatalogIntent[] = [];
  for (const clause of clauses) {
    let part = workspaceCatalogIntent(clause);
    if (!part) {
      const steps = compileWorkspaceLanguage(clause);
      if (!steps) return { matched: true };
      part = { input: clause, steps, primitive: true };
    }
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
