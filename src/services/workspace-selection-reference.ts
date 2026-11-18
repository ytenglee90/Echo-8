export interface WorkspaceSelectionReference {
  argument?: 'ids' | 'nodeIds' | 'sourceIds';
  expectedCount?: number;
  expectedKind?: 'text-node' | 'group' | 'connection';
  emptyOnly?: true;
}

const NUMBER = '[一二两三四五六七八九十百零〇0-9]{1,5}';
const UNIT = '(?:张|个|条)';
const ENTITY = '(?:文字节点|文本节点|节点|(?:人物|章节|资料|设定)?卡片?|文本框|群组|分组|连线|连接线|对象|项目|项)';
const current = '(?:(?:当前|目前|现在|刚才)\\s*)?';
const selected = new RegExp('^' + current + '(?:(?:选区|选中(?:项)?|选着|选择)(?:的)?(?:全部|所有)?\\s*(?:这|那)?(?:(' + NUMBER +
  ')' + UNIT + ')?\\s*(?:空白|空)?(' + ENTITY + ')?|(?:这|那)(?:些|几' + UNIT + '|(' + NUMBER + ')' + UNIT +
  ')\\s*(?:空白|空)?(' + ENTITY + ')?|它们)$', 'u');
const named = new RegExp('^' + current + '选中(?:的)?\\s*(.+)$', 'u');

export function selectedWorkspaceName(operand: string): string | undefined {
  return named.exec(operand.normalize('NFKC').trim())?.[1]?.trim();
}

export function workspaceCount(text: string): number | undefined {
  const digits = '零一二三四五六七八九';
  const value = text.normalize('NFKC').replace(/两/gu, '二').replace(/〇/gu, '零');
  if (/^\d+$/u.test(value)) return Number(value);
  if (value.length === 1 && digits.includes(value)) return digits.indexOf(value);
  const compound = /^(?:([一二三四五六七八九])百)?(?:([一二三四五六七八九])?十)?([零一二三四五六七八九])?$/u.exec(value);
  if (!compound || !/[十百]/u.test(value)) return undefined;
  return (compound[1] ? digits.indexOf(compound[1]) * 100 : 0) +
    (value.includes('十') ? (compound[2] ? digits.indexOf(compound[2]) : 1) * 10 : 0) +
    (compound[3] ? digits.indexOf(compound[3]) : 0);
}

/** A complete operand. A card title surrounded by a selection phrase remains a named reference. */
export function readWorkspaceSelectionReference(operand: string): WorkspaceSelectionReference | undefined {
  const match = selected.exec(operand.normalize('NFKC').trim().replace(/(?:吧|[。！!])$/u, ''));
  if (!match) return undefined;
  const count = match[1] ?? match[3];
  const noun = match[2] ?? match[4] ?? '';
  const expectedCount = count ? workspaceCount(count) : undefined;
  const expectedKind = /节点|卡|文本框/u.test(noun) ? 'text-node' : /群组|分组/u.test(noun) ? 'group'
    : /连线|连接线/u.test(noun) ? 'connection' : undefined;
  return { ...(expectedCount === undefined ? {} : { expectedCount }), ...(expectedKind ? { expectedKind } : {}),
    ...(expectedKind === 'text-node' && /空(?:白)?(?:卡|节点|文本框)/u.test(operand) ? { emptyOnly: true } : {}) };
}
