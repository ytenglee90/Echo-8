const CATEGORY_ORDER = [
  '书籍与同步',
  '画布与节点',
  '选择与排列',
  '编辑',
  '文本编辑',
  'AI',
  '外观',
  '系统',
] as const;

const CATEGORY_ALIASES: Readonly<Record<string, (typeof CATEGORY_ORDER)[number]>> = {
  文件: '书籍与同步',
  云同步: '书籍与同步',
  画布: '画布与节点',
  文本节点: '画布与节点',
  节点与连线: '画布与节点',
  选择: '选择与排列',
  群组: '选择与排列',
  查找替换: '编辑',
  文本格式: '文本编辑',
};

interface CategorizedAction {
  category: string;
  label: string;
  priority?: number;
}

export function sortActionsByCategory<T extends CategorizedAction>(actions: readonly T[]): T[] {
  return [...actions].sort((left, right) => {
    const leftCategory = displayCategory(left.category);
    const rightCategory = displayCategory(right.category);
    const categoryOrder = categoryRank(leftCategory) - categoryRank(rightCategory);
    if (categoryOrder !== 0) return categoryOrder;
    const unknownCategoryOrder = leftCategory.localeCompare(rightCategory, 'zh-CN');
    if (categoryRank(leftCategory) === CATEGORY_ORDER.length && unknownCategoryOrder !== 0) {
      return unknownCategoryOrder;
    }
    return (left.priority ?? 0) - (right.priority ?? 0) || left.label.localeCompare(right.label, 'zh-CN');
  });
}

export function groupActionsByCategory<T extends CategorizedAction>(actions: readonly T[]): Array<{
  category: string;
  actions: T[];
}> {
  const groups: Array<{ category: string; actions: T[] }> = [];
  for (const action of sortActionsByCategory(actions)) {
    const category = displayCategory(action.category);
    const current = groups.at(-1);
    if (current?.category === category) current.actions.push(action);
    else groups.push({ category, actions: [action] });
  }
  return groups;
}

export function displayCategory(category: string): string {
  return CATEGORY_ALIASES[category] ?? category;
}

function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category as (typeof CATEGORY_ORDER)[number]);
  return index >= 0 ? index : CATEGORY_ORDER.length;
}
