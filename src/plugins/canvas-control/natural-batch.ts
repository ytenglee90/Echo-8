import type { CanvasControlAction } from '../../protocols/canvas-control.ts';
import type { NaturalCanvasOperation } from '../../services/ai-task-route.ts';
import type { NaturalControlResult, NaturalControlState } from './natural-operations.ts';

export async function resolveNaturalBatch(
  steps: NaturalCanvasOperation[],
  previous: NaturalControlState,
  resolve: (operation: NaturalCanvasOperation, state: NaturalControlState) => Promise<NaturalControlResult>,
): Promise<NaturalControlResult> {
  const fail = (answer: string): NaturalControlResult => ({ plan: { version: 2, actions: [], answer } });
  const actions: CanvasControlAction[] = [];
  const targets = new Set<string>();
  const draftTitles = new Map<string, string>();
  let state: NaturalControlState = { ...previous, draftTitles, unfinishedConnection: undefined };
  for (const [index, step] of steps.entries()) {
    if (['theme', 'choose-theme', 'background', 'select', 'find', 'narrow'].includes(step.kind) || (step.kind === 'choose-color' && step.background)) {
      return fail('请单独发送视图、设置和筛选范围调整指令。');
    }
    const result = await resolve(step, state);
    if (result.choice) return result;
    if (result.replacement) return fail('请单独提交多处正文替换，预览会显示全部命中。');
    if (!result.plan.actions.length && step.kind !== 'filter' && step.kind !== 'relations') {
      return fail(`第 ${index + 1} 步未形成可应用的操作。${result.plan.answer ?? '请补充目标。'}`);
    }
    const aliases = new Map(result.plan.actions.flatMap(action => 'ref' in action ? [[action.ref, `step-${index + 1}-${action.ref}`]] : []));
    const resolveId = (id: string) => aliases.get(id) ?? id;
    const created: string[] = [];
    for (const action of result.plan.actions) {
      if (action.type === 'create-node') {
        const key = action.title.normalize('NFKC').trim().toLocaleLowerCase();
        if (draftTitles.has(key)) return fail(`组合操作重复新建「${action.title}」。`);
        const ref = resolveId(action.ref);
        draftTitles.set(key, ref);
        created.push(ref);
        actions.push({ ...action, ref });
      } else if (action.type === 'update-node') {
        const existing = actions.findIndex(candidate => ('id' in candidate && candidate.id === action.id) ||
          (candidate.type === 'create-node' && candidate.ref === action.id));
        if (existing < 0) actions.push(action);
        else {
          const target = actions[existing]!;
          if (target.type !== 'create-node' && target.type !== 'update-node') return fail('组合步骤的对象类型冲突。');
          if (action.edit || action.append || action.text !== undefined) return fail('同一节点的连续正文编辑请逐次预览。');
          actions[existing] = target.type === 'update-node' ? { ...target, ...action } : {
            ...target,
            title: action.title ?? target.title,
            x: action.x ?? target.x,
            y: action.y ?? target.y,
            width: action.width ?? target.width,
            height: action.height ?? target.height,
            color: action.color ?? target.color,
            presentation: action.presentation ?? target.presentation,
          };
        }
      } else if (action.type === 'create-connection') {
        actions.push({ ...action, ref: resolveId(action.ref), from: resolveId(action.from), to: resolveId(action.to) });
      } else if (action.type === 'create-group' || action.type === 'update-group') {
        actions.push(action.type === 'create-group' ? { ...action, ref: resolveId(action.ref), members: action.members.map(resolveId) } :
          { ...action, ...(action.members ? { members: action.members.map(resolveId) } : {}) });
      } else actions.push(action);
    }
    result.targets?.forEach(id => targets.add(id));
    state = { ...state, ...result.next, ...(created.length ? { ids: created } : {}) };
  }
  if (!actions.length || actions.length > 80 || targets.size > 80) return fail('组合任务需要 1 到 80 项操作，请缩小范围。');
  return { plan: { version: 2, actions }, targets: [...targets] };
}
