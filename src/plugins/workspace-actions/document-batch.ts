import type { CanvasControlAction, CanvasControlPlan, ControlNodeAction } from '../../protocols/canvas-control.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { WorkspacePlanStep, WorkspaceTarget } from '../../protocols/workspace-actions.ts';
import { parseCanvasControlPlan } from '../../services/canvas-control-validation.ts';
import { isWorkspaceTarget } from './actions.ts';

export const batchableActions = new Set([
  'node.create', 'node.rename', 'node.move', 'node.resize', 'node.presentation',
  'content.edit', 'content.draft.preview', 'connection.create', 'connection.label',
  'group.createExplicit', 'node.color',
]);

/** Compiles protocol operations; feature owners still prepare and validate all patches. */
export async function compileDocumentBatch(
  steps: WorkspacePlanStep[], resolve: (target: WorkspaceTarget, stepId: string) => Promise<ContentSummary>,
): Promise<{ plan: CanvasControlPlan; bindings: Record<string, string> }> {
  const actions: CanvasControlAction[] = [];
  const bindings: Record<string, string> = {};
  const creates = new Map<string, ControlNodeAction & { type: 'create-node' }>();
  const updates = new Map<string, ControlNodeAction & { type: 'update-node' }>();
  let currentStep = '';
  const ref = (index: number) => 'workspace-new-' + (index + 1);
  const targetId = async (value: unknown): Promise<string> => {
    if (!isWorkspaceTarget(value)) throw new Error('组合文档动作缺少明确目标');
    if ('from' in value && bindings[value.from]) return bindings[value.from]!;
    return (await resolve(value, currentStep)).id;
  };
  const update = (id: string, fields: Record<string, unknown>) => {
    const created = creates.get(id);
    if (created) {
      const edit = fields.edit as { start: number; deleteCount: number; insert: string; expectedRevision: number } | undefined;
      if (edit) {
        const text = created.text ?? '';
        if (edit.expectedRevision !== 1 || edit.start + edit.deleteCount > text.length) throw new Error('新卡正文范围与初始修订不匹配');
        created.text = text.slice(0, edit.start) + edit.insert + text.slice(edit.start + edit.deleteCount);
        const { edit: _edit, ...rest } = fields;
        void _edit;
        Object.assign(created, rest);
      } else Object.assign(created, fields);
      return;
    }
    let action = updates.get(id);
    if (!action) {
      action = { type: 'update-node', id };
      updates.set(id, action);
      actions.push(action);
    }
    if (fields.edit && action.edit) throw new Error('同一卡片的多个正文修改需合并为一个明确范围');
    Object.assign(action, fields);
  };
  for (const [index, step] of steps.entries()) {
    currentStep = step.id;
    const args = step.arguments ?? {};
    if (!batchableActions.has(step.action)) throw new Error('此动作尚不支持原子组合：' + step.action);
    switch (step.action) {
      case 'node.create': {
        const action = { type: 'create-node' as const, ref: ref(index), title: String(args.title),
          x: Number(args.x), y: Number(args.y), ...(args.text === undefined ? {} : { text: String(args.text) }) };
        actions.push(action); creates.set(action.ref, action); bindings[step.id] = action.ref;
        break;
      }
      case 'connection.create': {
        const action = { type: 'create-connection' as const, ref: ref(index),
          from: await targetId(args.from), to: await targetId(args.to),
          line: (args.line ?? 'solid') as 'solid' | 'dashed', ...(args.label === undefined ? {} : { label: String(args.label) }) };
        actions.push(action); bindings[step.id] = action.ref;
        break;
      }
      case 'connection.label':
        actions.push({ type: 'update-connection', id: String(args.id), label: String(args.label) });
        bindings[step.id] = String(args.id);
        break;
      case 'group.createExplicit': {
        const members = await Promise.all((args.members as unknown[]).map(targetId));
        actions.push({ type: 'create-group', ref: ref(index), title: String(args.title), members });
        bindings[step.id] = ref(index);
        break;
      }
      default: {
        const id = await targetId(args.target);
        bindings[step.id] = id;
        if (step.action === 'node.rename') update(id, { title: args.title });
        if (step.action === 'node.move') update(id, { x: args.x, y: args.y });
        if (step.action === 'node.resize') update(id, { width: args.width, height: args.height });
        if (step.action === 'node.presentation') update(id, { presentation: args.presentation });
        if (step.action === 'node.color') update(id, { color: args.color });
        if (step.action === 'content.edit' || step.action === 'content.draft.preview') update(id, { edit: {
          start: Number(args.start), deleteCount: Number(args.deleteCount), expectedRevision: Number(args.expectedRevision),
          insert: String(step.action === 'content.edit' ? args.insert : args.text),
        } });
      }
    }
  }
  return { plan: parseCanvasControlPlan(JSON.stringify({ version: 2, actions })), bindings };
}
