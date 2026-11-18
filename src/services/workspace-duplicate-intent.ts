import type { CatalogIntent } from './workspace-catalog-intent.ts';
import { readWorkspaceSelectionReference } from './workspace-selection-reference.ts';

const side = '(右(?:边|侧|方)|左(?:边|侧|方)|上(?:边|侧|方)|下(?:边|侧|方))';
const keep = '(?:[,，]\\s*(?:原(?:件|对象)保留|保留原(?:来的)?(?:对象|件|卡片?)|不(?:要)?(?:移动|改动)原(?:来的)?(?:对象|件|卡片?)))?';
const copy = '(?:复制|拷贝|克隆)';
const patterns = [
  new RegExp('^(?:把|将)?\\s*' + copy + '\\s*(.+?)\\s*(?:到|至)' + side + keep + '[。！!]?$','u'),
  new RegExp('^(?:把|将)?\\s*(.+?)\\s*' + copy + '\\s*(?:到|至)' + side + keep + '[。！!]?$','u'),
  new RegExp('^在' + side + '\\s*(?:建立|创建|生成)\\s*(.+?)(?:的)?副本' + keep + '[。！!]?$','u'),
];

/** Object set, relationship inclusion and placement are roles of one atomic duplicate operation. */
export function workspaceDuplicateIntent(input: string): Omit<CatalogIntent, 'input'> | undefined {
  if (input.length > 420 || /^(?:不要|别|如何|怎么|如果)|除外|排除|仅复制正文/u.test(input)) return undefined;
  for (const [index, pattern] of patterns.entries()) {
    const match = pattern.exec(input);
    if (!match) continue;
    const source = match[index === 2 ? 2 : 1]!.trim()
      .replace(/(?:及(?:它们|这些)?之间的(?:连线|连接)|(?:连同|以及|及)(?:它们的)?(?:内部|组内)(?:关系线?|连线|连接)(?:一起)?)$/u, '').trim();
    const directionWord = match[index === 2 ? 1 : 2]!;
    const direction = ({ 右: 'right', 左: 'left', 上: 'up', 下: 'down' } as const)[directionWord[0] as '右' | '左' | '上' | '下'];
    const args = { direction, ...(/内部关系|组内线|之间的连线/u.test(input) ? { includeInternalRelations: true } : {}) };
    const selection = readWorkspaceSelectionReference(source);
    return selection ? { steps: [{ id: 'duplicate', action: 'clipboard.duplicate', arguments: args,
      selection: { ...selection, argument: 'sourceIds' } }] }
      : { steps: [{ id: 'duplicate', action: 'clipboard.duplicate', arguments: args }], binding: 'duplicate', operand: source };
  }
  return undefined;
}
