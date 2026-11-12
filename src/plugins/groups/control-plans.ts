import { createId, type PluginContext } from '../../core/contracts.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { CanvasControlGroupRequest, CanvasControlGroupPlan } from '../../protocols/canvas-control.ts';
import type { ConnectionNodeGeometry } from '../../protocols/connections.ts';
import type { EventDeclaration } from '../../protocols/state.ts';
import { validateCanvasControlActions } from '../../services/canvas-control-validation.ts';
import { computeGroupBounds } from './layout.ts';

export function registerGroupControlPlans(context: PluginContext, readGroups: () => Record<string, GroupRecord>): void {
  context.capabilities.provide<CanvasControlGroupRequest, CanvasControlGroupPlan>({
    key: 'canvasControl.groupsPlan@1',
    invoke: input => {
      validateCanvasControlActions(input?.actions);
      if (input.actions.some(action => action.type !== 'create-group' && action.type !== 'update-group') || !Array.isArray(input.nodes) || !Array.isArray(input.expected)) throw new Error('群组操作计划无效');
      const groups = new Map(Object.values(readGroups()).map(group => [group.id, group]));
      const nodes = new Map(input.nodes.map(node => [node.id, node]));
      const created: Record<string, string> = Object.create(null) as Record<string, string>;
      const changed: GroupRecord[] = [];
      const events: EventDeclaration[] = [];
      for (const action of input.actions) {
        const current = action.type === 'update-group' ? groups.get(action.id) : undefined;
        if (action.type === 'update-group' && (!current || current.revision !== input.expected.find(group => group.id === action.id)?.revision)) throw new Error('群组已经变化，请重新生成操作计划');
        const id = current?.id ?? createId('group');
        const memberIds = action.members ?? current?.memberIds ?? [];
        const minimumMembers = current && action.members === undefined ? 1 : 2;
        if (memberIds.length < minimumMembers || memberIds.some(member => !nodes.has(member))) throw new Error('群组须有至少两个有效文字对象，可将分类标题文本框作为成员');
        const title = action.title?.trim() ?? current?.title ?? '新群组';
        const group: GroupRecord = {
          ...(current ?? { titleStyle: { fontSize: 13, fontWeight: 650 }, createdAt: Date.now() }),
          id, title, memberIds, revision: (current?.revision ?? 0) + 1, updatedAt: Date.now(),
          ...(action.color ? { color: action.color.toLowerCase() } : {}),
          ...(action.title !== undefined ? { titleMarks: [] } : {}),
        };
        groups.set(id, group); changed.push(group);
        if (action.type === 'create-group') created[action.ref] = id;
        if (!current) events.push({ type: 'group.created', payload: { id, memberIds } });
        const added = memberIds.filter(member => !current?.memberIds.includes(member));
        const removed = current?.memberIds.filter(member => !memberIds.includes(member)) ?? [];
        if (added.length || removed.length) events.push({ type: 'group.members.changed', payload: { groupId: id, added, removed } });
        if (current && (action.title !== undefined || action.color !== undefined)) events.push({ type: 'group.appearance.changed', payload: { ids: [id] } });
      }
      const occupied = new Set<string>();
      for (const group of groups.values()) for (const member of group.memberIds) {
        if (occupied.has(member)) throw new Error('一个文字对象只能属于一个群组，请先在计划中调整原群组成员');
        occupied.add(member);
      }
      const targets: ConnectionNodeGeometry[] = [];
      for (const group of groups.values()) {
        const members = group.memberIds.flatMap(id => nodes.has(id) ? [nodes.get(id)!] : []);
        if (members.length >= 2) targets.push({ id: group.id, kind: 'group', ...computeGroupBounds(members) });
      }
      return {
        created, targets,
        patches: changed.map(group => ({ op: 'set', domain: 'document', namespace: 'groups', key: group.id, value: group, schemaOwner: 'groups' })),
        events,
      };
    },
  });
}
