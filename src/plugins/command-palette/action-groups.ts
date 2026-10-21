const CATEGORY_ORDER = ['文件', '画布', '选择', '编辑', 'AI', '外观', '系统'] as const;

interface CategorizedAction {
  category: string;
  label: string;
  priority?: number;
}

export function sortActionsByCategory<T extends CategorizedAction>(actions: readonly T[]): T[] {
  return [...actions].sort((left, right) => {
    const categoryOrder = categoryRank(left.category) - categoryRank(right.category);
    if (categoryOrder !== 0) return categoryOrder;
    const unknownCategoryOrder = left.category.localeCompare(right.category, 'zh-CN');
    if (categoryRank(left.category) === CATEGORY_ORDER.length && unknownCategoryOrder !== 0) {
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
    const current = groups.at(-1);
    if (current?.category === action.category) current.actions.push(action);
    else groups.push({ category: action.category, actions: [action] });
  }
  return groups;
}

function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category as (typeof CATEGORY_ORDER)[number]);
  return index >= 0 ? index : CATEGORY_ORDER.length;
}
