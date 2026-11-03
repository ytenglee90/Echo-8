import { createId, isRecord, type PluginDefinition } from '../../core/contracts.ts';
import {
  isAppearanceColor,
  isAppearanceEntityUpdateRequest,
  type AppearanceColorContribution,
  type AppearanceColorReadRequest,
  type AppearanceReadContribution,
  type AppearanceReadRequest,
  type AppearanceUpdatePlan,
  type AppearanceUpdateRequest,
} from '../../protocols/appearance.ts';
import type {
  ClipboardFragment,
  ClipboardInstantiateInput,
  ClipboardInstantiatePlan,
} from '../../protocols/clipboard.ts';
import type { ContentMovePlan, ContentMovePlanRequest, ContentSummary } from '../../protocols/content.ts';
import type { ConnectionTargetsRequest, ConnectionTarget } from '../../protocols/connections.ts';
import type { CanvasOverviewEntity, CanvasOverviewRequest } from '../../protocols/canvas.ts';
import type {
  GroupDropTarget,
  GroupDropTargetRequest,
  GroupMembershipDropRequest,
  GroupRecord,
  GroupTitleMark,
  GroupTitleStyle,
} from '../../protocols/groups.ts';
import type {
  EntityDeletePlan,
  SelectionCatalogContribution,
  SelectionScopeAtRequest,
  SelectionScopeContribution,
  SelectionSnapshot,
} from '../../protocols/selection.ts';
import type { StatisticsContribution } from '../../protocols/statistics.ts';
import { defineManifest } from '../manifest.ts';
import { resolveGroupDropTarget } from './drop-target.ts';
import { computeGroupBounds } from './layout.ts';

const GROUP_NAMESPACE = 'groups';
const GROUP_MEMBERSHIP_UI_NAMESPACE = 'groupMembershipUI';

interface GroupIdPayload {
  id: string;
}

interface CreateGroupPayload {
  title?: string;
}

interface GroupMembershipPayload {
  groupId: string;
  nodeIds: string[];
}

interface SerializedGroups {
  groups: GroupRecord[];
}

export function createGroupsPlugin(
  groupLayer?: unknown,
  groupActions?: unknown,
  membershipPanel?: unknown,
): PluginDefinition {
  return {
    manifest: defineManifest('groups', '群组', {
      dataVersion: 2,
      namespaces: [GROUP_NAMESPACE, GROUP_MEMBERSHIP_UI_NAMESPACE],
      namespaceDomains: {
        [GROUP_NAMESPACE]: 'document',
        [GROUP_MEMBERSHIP_UI_NAMESPACE]: 'workspace',
      },
      sessionOnlyWorkspace: { [GROUP_MEMBERSHIP_UI_NAMESPACE]: true },
      requiresCapabilities: [
        'content.summaries@1',
        'content.summariesById@1',
        'content.catalog@2',
        'content.movePlan@1',
        'selection.read@1',
        'selection.resolve@1',
      ],
      optionalCapabilities: ['canvas.camera@1', 'canvas.appearance@1', 'canvas.viewport@1', 'layout.snap@1', 'connections.graph@1', 'connections.targets@1', 'connections.detachPlan@1'],
      providesCapabilities: [
        'canvas.overview@1',
        'connections.targets@1',
        'groups.list@1',
        'entity.deletePlan@1',
        'clipboard.serialize@1',
        'clipboard.instantiate@1',
        'statistics.contribute@1',
        'selection.entities@1',
        'selection.scopeAt@1',
        'group.membership.state@1',
        'group.dropTarget@1',
        'appearance.read@1',
        'appearance.updatePlan@1',
        'appearance.colors@1',
        'appearance.resetPlan@1',
      ],
      commands: [
        'group.create',
        'group.toggleSelection',
        'group.ungroup',
        'group.ungroupSelection',
        'group.membership.open',
        'group.membership.close',
        'group.membership.add',
        'group.membership.remove',
        'group.membership.drop',
      ],
      dispatches: [
        'selection.set',
        'node.moveMany',
        'connection.create',
        'clipboard.duplicateSelectionAt',
        'interaction.begin',
        'interaction.end',
      ],
      events: [
        'group.created',
        'group.members.changed',
        'group.ungrouped',
        'group.appearance.changed',
        'nodes.pasted',
        'history.changed',
        'document.replaced',
      ],
      signals: [
        'canvas.camera.preview',
        'canvas.drag.preview',
        'canvas.snap.preview',
        'canvas.node.resize.preview',
        'canvas.appearance.invalidated',
        'canvas.pointer.preview',
        'canvas.wheel.requested',
        'group.membership.preview',
        'appearance.color.preview',
        'content.catalog.invalidated',
        'groups.invalidated',
        'connection.targets.invalidated', 'connection.draft.preview', 'canvas.entity.hover.preview', 'canvas.overview.invalidated',
        'connections.invalidated',
      ],
      ui: ['groups.layer', 'groups.actions', 'groups.membership-panel'],
      actions: [
        'groups.toggle-action',
        'groups.membership-action',
        'groups.create-action',
        'groups.ungroup-action',
      ],
      shortcuts: [
        'groups.toggle-shortcut',
        'groups.create-shortcut',
        'groups.membership-shortcut',
        'groups.ungroup-shortcut',
        'groups.membership-close-shortcut',
      ],
      permissions: [
        'store.own.read', 'store.own.write', 'ui.canvas.contribute', 'ui.top.contribute',
        'ui.modal.contribute',
        'ui.action.register', 'ui.shortcut.register',
      ],
    }),

    migrations: [{
      from: 1,
      to: 2,
      migrate: (data) => data,
    }],

    start(context) {
      const readGroups = () =>
        context.store.readNamespace<Record<string, GroupRecord>>(GROUP_NAMESPACE);
      const membershipPanelOpen = () =>
        context.store.readValue<boolean>(GROUP_MEMBERSHIP_UI_NAMESPACE, 'open') ?? false;
      const projectTargets = (input: ConnectionTargetsRequest | undefined, nodes: readonly import('../../protocols/connections.ts').ConnectionNodeGeometry[]): ConnectionTarget[] => {
        if (!Array.isArray(nodes) || nodes.some(node => typeof node.id !== 'string' ||
          ![node.x, node.y, node.width, node.height].every(Number.isFinite) || node.width < 0 || node.height < 0) ||
          (input?.excludedIds !== undefined && (!Array.isArray(input.excludedIds) || input.excludedIds.some(id => typeof id !== 'string')))) {
          throw new Error('连接目标几何参数不正确');
        }
        const excluded = new Set(input?.excludedIds ?? []);
        const byId = new Map(nodes.filter(node => !excluded.has(node.id)).map(node => [node.id, node]));
        return Object.values(readGroups()).flatMap(group => {
          if (excluded.has(group.id)) return [];
          const members = group.memberIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
          return members.length < 2 ? [] : [{ id: group.id, kind: 'group' as const, ...computeGroupBounds(members) }];
        });
      };
      context.capabilities.provide<ConnectionTargetsRequest | undefined, ConnectionTarget[]>({
        key: 'connections.targets@1',
        invoke: input => input?.nodes ? projectTargets(input, input.nodes) :
          context.capabilities.request<ContentSummary[]>('content.summaries@1').then(nodes => projectTargets(input, nodes)),
      });
      context.capabilities.provide<CanvasOverviewRequest, CanvasOverviewEntity[]>({
        key: 'canvas.overview@1', invoke: input => {
          if (!input || !Array.isArray(input.nodes)) throw new Error('概览几何参数不正确');
          const groups = readGroups();
          return projectTargets({ nodes: input.nodes }, input.nodes).map(target => ({
            ...target, color: groups[target.id]?.color,
          }));
        },
      });
      const detachConnections = async (ids: string[]): Promise<EntityDeletePlan> => {
        const plans = await context.capabilities.requestAll<EntityDeletePlan>('connections.detachPlan@1', { ids });
        return { patches: plans.flatMap(plan => plan.patches), events: plans.flatMap(plan => plan.events ?? []) };
      };

      context.commands.register<CreateGroupPayload, { id: string }>({
        type: 'group.create',
        validate: (payload): payload is CreateGroupPayload => payload === undefined || isRecord(payload),
        handle: async (payload = {}) => {
          const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
          const knownNodes = new Set(
            (await context.capabilities.request<ContentSummary[]>('content.summaries@1')).map((node) => node.id),
          );
          const memberIds = [...new Set(selection.ids.filter((id) => knownNodes.has(id)))];
          if (memberIds.length < 2) throw new Error('至少选择两个节点才能创建群组');
          const occupied = new Map<string, string>();
          for (const group of Object.values(readGroups())) {
            for (const memberId of group.memberIds) occupied.set(memberId, group.id);
          }
          const conflict = memberIds.find((id) => occupied.has(id));
          if (conflict) throw new Error('一个节点暂时只能属于一个群组');
          const id = createId('group');
          const now = Date.now();
          const group: GroupRecord = {
            id,
            title: payload.title?.trim() || '新群组',
            memberIds,
            titleStyle: { fontSize: 13, fontWeight: 650 },
            titleMarks: [],
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          return {
            result: { id },
            transaction: {
              label: `创建群组（${memberIds.length} 个节点）`,
              patches: [
                { op: 'set', domain: 'document', namespace: GROUP_NAMESPACE, key: id, value: group },
              ],
              events: [{ type: 'group.created', payload: { id, memberIds } }],
            },
          };
        },
      });

      context.commands.register<GroupIdPayload>({
        type: 'group.ungroup',
        validate: isGroupIdPayload,
        handle: async (payload) => {
          const group = context.store.readValue<GroupRecord>(GROUP_NAMESPACE, payload.id);
          if (!group) throw new Error(`Group not found: ${payload.id}`);
          const detached = await detachConnections([group.id]);
          return {
            transaction: {
              label: '取消群组',
              patches: [
                { op: 'delete', domain: 'document', namespace: GROUP_NAMESPACE, key: group.id },
                ...detached.patches,
              ],
              events: [{ type: 'group.ungrouped', payload: { id: group.id, memberIds: group.memberIds } }, ...(detached.events ?? [])],
            },
          };
        },
      });

      context.commands.register({
        type: 'group.ungroupSelection',
        handle: async () => {
          const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
          const groups = Object.values(readGroups());
          const group = groups.find((candidate) => selection.ids.includes(candidate.id));
          if (!group) throw new Error('请先直接选择一个群组');
          const detached = await detachConnections([group.id]);
          return {
            transaction: {
              label: '取消群组',
              patches: [{ op: 'delete', domain: 'document', namespace: GROUP_NAMESPACE, key: group.id }, ...detached.patches],
              events: [{ type: 'group.ungrouped', payload: { id: group.id, memberIds: group.memberIds } }, ...(detached.events ?? [])],
            },
          };
        },
      });

      context.commands.register({
        type: 'group.toggleSelection',
        handle: async () => {
          const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
          const selectedGroup = Object.values(readGroups())
            .find((candidate) => selection.ids.includes(candidate.id));
          if (selectedGroup) {
            const detached = await detachConnections([selectedGroup.id]);
            return {
              transaction: {
                label: '取消群组',
                patches: [{
                  op: 'delete' as const,
                  domain: 'document' as const,
                  namespace: GROUP_NAMESPACE,
                  key: selectedGroup.id,
                }, ...detached.patches],
                events: [{
                  type: 'group.ungrouped',
                  payload: { id: selectedGroup.id, memberIds: selectedGroup.memberIds },
                }, ...(detached.events ?? [])],
              },
            };
          }

          const knownNodes = new Set(
            (await context.capabilities.request<ContentSummary[]>('content.summaries@1')).map((node) => node.id),
          );
          const memberIds = [...new Set(selection.ids.filter((id) => knownNodes.has(id)))];
          if (memberIds.length < 2) throw new Error('至少选择两个节点才能创建群组');
          const occupied = new Set(Object.values(readGroups()).flatMap((group) => group.memberIds));
          if (memberIds.some((id) => occupied.has(id))) throw new Error('一个节点暂时只能属于一个群组');
          const id = createId('group');
          const now = Date.now();
          const group: GroupRecord = {
            id,
            title: '新群组',
            memberIds,
            titleStyle: { fontSize: 13, fontWeight: 650 },
            titleMarks: [],
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          return {
            result: { id },
            transaction: {
              label: `创建群组（${memberIds.length} 个节点）`,
              patches: [{
                op: 'set' as const,
                domain: 'document' as const,
                namespace: GROUP_NAMESPACE,
                key: id,
                value: group,
              }],
              events: [{ type: 'group.created', payload: { id, memberIds } }],
            },
          };
        },
      });

      context.commands.register({
        type: 'group.membership.open',
        handle: () => {
          context.ui.activateSurface('overlay.modal', 'groups.membership-panel', 'group.membership.close');
          return {
            transaction: {
              label: '打开群组成员管理',
              history: false,
              patches: [{
                op: 'set' as const,
                domain: 'workspace' as const,
                namespace: GROUP_MEMBERSHIP_UI_NAMESPACE,
                key: 'open',
                value: true,
              }],
            },
          };
        },
      });

      context.commands.register({
        type: 'group.membership.close',
        handle: () => {
          context.ui.deactivateSurface('overlay.modal', 'groups.membership-panel');
          return {
            transaction: {
              label: '关闭群组成员管理',
              history: false,
              patches: [{
                op: 'set' as const,
                domain: 'workspace' as const,
                namespace: GROUP_MEMBERSHIP_UI_NAMESPACE,
                key: 'open',
                value: false,
              }],
            },
          };
        },
      });

      context.commands.register<GroupMembershipPayload>({
        type: 'group.membership.add',
        validate: isGroupMembershipPayload,
        handle: async (payload) => {
          const group = context.store.readValue<GroupRecord>(GROUP_NAMESPACE, payload.groupId);
          if (!group) throw new Error('目标群组不存在');
          const knownNodes = new Set(
            (await context.capabilities.request<ContentSummary[]>('content.summaries@1')).map((node) => node.id),
          );
          const requested = [...new Set(payload.nodeIds)].filter((id) => knownNodes.has(id));
          if (requested.length === 0) throw new Error('没有可加入群组的文字节点');
          const occupied = new Map<string, string>();
          for (const candidate of Object.values(readGroups())) {
            for (const memberId of candidate.memberIds) occupied.set(memberId, candidate.id);
          }
          const conflict = requested.find((id) => occupied.has(id) && occupied.get(id) !== group.id);
          if (conflict) throw new Error('选中的文字节点已经属于其他群组');
          const memberIds = [...new Set([...group.memberIds, ...requested])];
          if (memberIds.length === group.memberIds.length) return { result: { added: 0, groupId: group.id } };
          const next: GroupRecord = {
            ...group,
            memberIds,
            revision: group.revision + 1,
            updatedAt: Date.now(),
          };
          return {
            result: { added: memberIds.length - group.memberIds.length, groupId: group.id },
            transaction: {
              label: `加入群组（${memberIds.length - group.memberIds.length} 个节点）`,
              patches: [{
                op: 'set' as const,
                domain: 'document' as const,
                namespace: GROUP_NAMESPACE,
                key: group.id,
                value: next,
                schemaOwner: 'groups',
              }],
              events: [{
                type: 'group.members.changed',
                payload: { groupId: group.id, added: requested, removed: [] },
              }],
            },
          };
        },
      });

      context.commands.register<GroupMembershipDropRequest, GroupDropTarget>({
        type: 'group.membership.drop',
        validate: isGroupMembershipDropRequest,
        handle: async (payload) => {
          const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
          const groups = Object.values(readGroups());
          const requested = new Set(payload.nodeIds ?? [payload.nodeId]);
          const target = resolveGroupDropTarget(groups, nodes, payload);
          if (!target || target.action !== payload.target.action || target.groupId !== payload.target.groupId) {
            throw new Error('群组边界已经变化，请重新拖动节点');
          }
          const movePlan = await context.capabilities.request<ContentMovePlan>(
            'content.movePlan@1',
            { positions: payload.positions } satisfies ContentMovePlanRequest,
          );
          const now = Date.now();
          const groupEvents: NonNullable<ContentMovePlan['events']> = [];
          const groupPatches: ContentMovePlan['patches'] = [];
          const dissolvedIds: string[] = [];
          const affected = target.action === 'add' ? groups.filter(group => group.id === target.groupId) :
            groups.filter(group => group.memberIds.some(id => requested.has(id)));
          for (const group of affected) {
            if (target.action === 'add') {
              const memberIds = [...new Set([...group.memberIds, ...requested])];
              groupPatches.push({
                op: 'set' as const,
                domain: 'document' as const,
                namespace: GROUP_NAMESPACE,
                key: group.id,
                value: { ...group, memberIds, revision: group.revision + 1, updatedAt: now },
                schemaOwner: 'groups',
              });
              groupEvents.push({
                type: 'group.members.changed',
                payload: { groupId: group.id, added: [...requested], removed: [] },
              });
            } else {
              const removed = group.memberIds.filter(id => requested.has(id));
              const memberIds = group.memberIds.filter((id) => !requested.has(id));
              const dissolve = memberIds.length < 2;
              groupPatches.push(dissolve ? {
                op: 'delete' as const,
                domain: 'document' as const,
                namespace: GROUP_NAMESPACE,
                key: group.id,
                schemaOwner: 'groups',
              } : {
                op: 'set' as const,
                domain: 'document' as const,
                namespace: GROUP_NAMESPACE,
                key: group.id,
                value: { ...group, memberIds, revision: group.revision + 1, updatedAt: now },
                schemaOwner: 'groups',
              });
              groupEvents.push({
                type: 'group.members.changed',
                payload: { groupId: group.id, added: [], removed, dissolved: dissolve },
              });
              if (dissolve) {
                dissolvedIds.push(group.id);
                groupEvents.push({
                  type: 'group.ungrouped',
                  payload: { id: group.id, memberIds: group.memberIds },
                });
              }
            }
          }
          const detached = dissolvedIds.length ? await detachConnections(dissolvedIds) : { patches: [], events: [] };
          return {
            result: target,
            transaction: {
              label: target.action === 'add' ? '移动节点并加入群组' : '移动节点并移出群组',
              patches: [...movePlan.patches, ...groupPatches, ...detached.patches],
              events: [...(movePlan.events ?? []), ...groupEvents, ...(detached.events ?? [])],
            },
          };
        },
      });

      context.commands.register<GroupMembershipPayload>({
        type: 'group.membership.remove',
        validate: isGroupMembershipPayload,
        handle: async (payload) => {
          const group = context.store.readValue<GroupRecord>(GROUP_NAMESPACE, payload.groupId);
          if (!group) throw new Error('目标群组不存在');
          const requested = new Set(payload.nodeIds);
          const removed = group.memberIds.filter((id) => requested.has(id));
          if (removed.length === 0) throw new Error('选中的文字节点不在该群组中');
          const memberIds = group.memberIds.filter((id) => !requested.has(id));
          const dissolve = memberIds.length < 2;
          const detached = dissolve ? await detachConnections([group.id]) : { patches: [], events: [] };
          return {
            result: { removed: removed.length, groupId: group.id, dissolved: dissolve },
            transaction: {
              label: dissolve ? '移出节点并解散空群组' : `移出群组（${removed.length} 个节点）`,
              patches: [dissolve ? {
                op: 'delete' as const,
                domain: 'document' as const,
                namespace: GROUP_NAMESPACE,
                key: group.id,
                schemaOwner: 'groups',
              } : {
                op: 'set' as const,
                domain: 'document' as const,
                namespace: GROUP_NAMESPACE,
                key: group.id,
                value: {
                  ...group,
                  memberIds,
                  revision: group.revision + 1,
                  updatedAt: Date.now(),
                } satisfies GroupRecord,
                schemaOwner: 'groups',
              }, ...detached.patches],
              events: [
                {
                  type: 'group.members.changed',
                  payload: { groupId: group.id, added: [], removed, dissolved: dissolve },
                },
                ...(dissolve ? [{
                  type: 'group.ungrouped',
                  payload: { id: group.id, memberIds: group.memberIds },
                }] : []),
                ...(detached.events ?? []),
              ],
            },
          };
        },
      });

      context.capabilities.provide({
        key: 'groups.list@1',
        invoke: () => Object.values(readGroups()),
      });
      context.capabilities.provide<AppearanceReadRequest, AppearanceReadContribution>({
        key: 'appearance.read@1',
        invoke: (input) => {
          if (input?.mode !== 'selection') return { targets: [] };
          const selectedIds = new Set(input.selectedItems
            ?.filter((item) => item.kind === 'group')
            .map((item) => item.id) ?? input.selectedIds ?? []);
          const groups = Object.values(readGroups()).filter((group) => selectedIds.has(group.id));
          if (groups.length === 0) return { targets: [] };
          const fallback = input.defaults?.['group-fill'] ?? '#202124';
          const colors = groups.map((group) => group.color ?? fallback);
          return {
            targets: [{
              kind: 'group-fill',
              label: '群组',
              scopeLabel: `${groups.length} 个选中群组`,
              color: colors[0],
              mixed: new Set(colors).size > 1,
              entities: groups.map((group, index) => ({
                id: group.id,
                revision: group.revision,
                expectedColor: colors[index],
              })),
            }],
          };
        },
      });
      context.capabilities.provide<AppearanceUpdateRequest, AppearanceUpdatePlan>({
        key: 'appearance.updatePlan@1',
        invoke: (input) => {
          if (input.kind !== 'group-fill') return { patches: [], changed: 0 };
          if (!isAppearanceEntityUpdateRequest(input)) throw new Error('群组颜色请求不正确');
          const groups = readGroups();
          const changed = input.entities.flatMap((reference) => {
            const group = groups[reference.id];
            if (!group || group.revision !== reference.revision ||
              (group.color ?? reference.expectedColor.toLowerCase()) !== reference.expectedColor.toLowerCase()) {
              throw new Error('群组颜色已经变化，请重新打开调色盘');
            }
            if (group.color === input.color.toLowerCase()) return [];
            return [{
              ...group,
              color: input.color.toLowerCase(),
              revision: group.revision + 1,
              updatedAt: Date.now(),
            } satisfies GroupRecord];
          });
          return {
            changed: changed.length,
            patches: changed.map((group) => ({
              op: 'set' as const,
              domain: 'document' as const,
              namespace: GROUP_NAMESPACE,
              key: group.id,
              value: group,
              schemaOwner: 'groups',
            })),
            events: changed.length > 0
              ? [{ type: 'group.appearance.changed', payload: { ids: changed.map((group) => group.id) } }]
              : [],
          };
        },
      });
      context.capabilities.provide<AppearanceColorReadRequest, AppearanceColorContribution>({
        key: 'appearance.colors@1',
        invoke: (input) => {
          const fallback = input?.defaults?.['group-fill'] ?? '#202124';
          const counts = new Map<string, number>();
          for (const group of Object.values(readGroups())) {
            const color = group.color ?? fallback;
            counts.set(color, (counts.get(color) ?? 0) + 1);
          }
          return { colors: [...counts].map(([color, count]) => ({ color, count })) };
        },
      });
      context.capabilities.provide<undefined, AppearanceUpdatePlan>({
        key: 'appearance.resetPlan@1',
        invoke: () => {
          const changed = Object.values(readGroups()).filter((group) => group.color !== undefined);
          const updatedAt = Date.now();
          return {
            changed: changed.length,
            patches: changed.map((group) => {
              const next = { ...group, revision: group.revision + 1, updatedAt };
              delete next.color;
              return {
                op: 'set' as const,
                domain: 'document' as const,
                namespace: GROUP_NAMESPACE,
                key: group.id,
                value: next,
                schemaOwner: 'groups',
              };
            }),
            events: changed.length > 0
              ? [{ type: 'group.appearance.changed', payload: { ids: changed.map((group) => group.id) } }]
              : [],
          };
        },
      });
      context.capabilities.provide({
        key: 'group.membership.state@1',
        invoke: () => ({ open: membershipPanelOpen() }),
      });
      context.capabilities.provide<GroupDropTargetRequest, GroupDropTarget | undefined>({
        key: 'group.dropTarget@1',
        invoke: async (input) => resolveGroupDropTarget(
          Object.values(readGroups()),
          await context.capabilities.request<ContentSummary[]>('content.summaries@1'),
          input,
        ),
      });

      context.capabilities.provide<undefined, SelectionCatalogContribution>({
        key: 'selection.entities@1',
        invoke: async () => {
          const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
          const nodeMap = new Map(nodes.map((node) => [node.id, node]));
          return {
            owner: 'groups',
            entities: Object.values(readGroups()).flatMap((group) => {
              const members = group.memberIds.map((id) => nodeMap.get(id)).filter(Boolean) as ContentSummary[];
              if (members.length < 2) return [];
              const bounds = computeGroupBounds(members);
              return [{
                id: group.id,
                kind: 'group',
                geometryRevision: members.map((member) => [
                  member.id,
                  member.x,
                  member.y,
                  member.width,
                  member.height,
                ].join(':')).join('|'),
                bounds,
                boxMatch: 'contain' as const,
                contains: [...group.memberIds],
              }];
            }),
          };
        },
      });

      context.capabilities.provide<SelectionScopeAtRequest, SelectionScopeContribution | undefined>({
        key: 'selection.scopeAt@1',
        invoke: async (input) => {
          const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
          const nodeMap = new Map(nodes.map((node) => [node.id, node]));
          const candidates = Object.values(readGroups()).flatMap((group) => {
            const members = group.memberIds.map((id) => nodeMap.get(id)).filter(Boolean) as ContentSummary[];
            if (members.length < 2) return [];
            const bounds = computeGroupBounds(members);
            if (!pointInsideBounds(input.point, bounds)) return [];
            return [{ group, members, area: bounds.width * bounds.height }];
          }).sort((left, right) =>
            left.area - right.area || right.group.updatedAt - left.group.updatedAt ||
            left.group.id.localeCompare(right.group.id));
          const match = candidates[0];
          return match ? {
            owner: 'groups',
            priority: 50,
            items: match.members.map((node) => ({ id: node.id, kind: 'text-node' })),
          } : undefined;
        },
      });

      context.capabilities.provide<{ ids: string[] }, EntityDeletePlan>({
        key: 'entity.deletePlan@1',
        invoke: (input) => {
          const deleted = new Set(Array.isArray(input?.ids) ? input.ids : []);
          const patches: EntityDeletePlan['patches'] = [];
          for (const group of Object.values(readGroups())) {
            if (deleted.has(group.id)) {
              patches.push({
                op: 'delete',
                domain: 'document',
                namespace: GROUP_NAMESPACE,
                key: group.id,
                schemaOwner: 'groups',
              });
              continue;
            }
            const memberIds = group.memberIds.filter((id) => !deleted.has(id));
            if (memberIds.length === group.memberIds.length) continue;
            if (memberIds.length < 2) {
              patches.push({
                op: 'delete',
                domain: 'document',
                namespace: GROUP_NAMESPACE,
                key: group.id,
                schemaOwner: 'groups',
              });
            } else {
              patches.push({
                op: 'set',
                domain: 'document',
                namespace: GROUP_NAMESPACE,
                key: group.id,
                value: { ...group, memberIds, revision: group.revision + 1, updatedAt: Date.now() },
                schemaOwner: 'groups',
              });
            }
          }
          return { patches };
        },
      });

      context.capabilities.provide<{ ids: string[] }, ClipboardFragment>({
        key: 'clipboard.serialize@1',
        invoke: (input) => {
          const selected = new Set(Array.isArray(input?.ids) ? input.ids : []);
          const groups = Object.values(readGroups()).filter((group) => selected.has(group.id));
          return {
            owner: 'groups',
            version: 1,
            entityIds: groups.map((group) => group.id),
            payload: { groups } satisfies SerializedGroups,
          };
        },
      });

      context.capabilities.provide<ClipboardInstantiateInput, ClipboardInstantiatePlan>({
        key: 'clipboard.instantiate@1',
        invoke: (input) => {
          const fragment = input.fragments.find((item) => item.owner === 'groups' && item.version === 1);
          if (!fragment || !isSerializedGroups(fragment.payload)) return { patches: [] };
          const groups = fragment.payload.groups.filter((group) =>
            group.memberIds.every((id) => typeof input.idMap[id] === 'string'),
          );
          return {
            patches: groups.map((group) => {
              const id = input.idMap[group.id];
              return {
                op: 'set' as const,
                domain: 'document' as const,
                namespace: GROUP_NAMESPACE,
                key: id,
                value: {
                  ...group,
                  id,
                  memberIds: group.memberIds.map((memberId) => input.idMap[memberId]),
                  revision: 1,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
                schemaOwner: 'groups',
              };
            }),
          };
        },
      });

      context.capabilities.provide<undefined, StatisticsContribution>({
        key: 'statistics.contribute@1',
        invoke: () => ({ kind: 'groups', label: '群组', count: Object.keys(readGroups()).length }),
      });

      let overviewRevision = context.store.revision(GROUP_NAMESPACE);
      const invalidateGroups = () => {
        context.signals.emit('groups.invalidated');
        context.signals.emit('connection.targets.invalidated');
        const revision = context.store.revision(GROUP_NAMESPACE);
        if (revision !== overviewRevision) {
          overviewRevision = revision;
          context.signals.emit('canvas.overview.invalidated');
        }
      };
      context.events.subscribe('group.created', invalidateGroups);
      context.events.subscribe('group.members.changed', invalidateGroups);
      context.events.subscribe('group.ungrouped', invalidateGroups);
      context.events.subscribe('group.appearance.changed', invalidateGroups);
      context.events.subscribe('nodes.pasted', invalidateGroups);
      context.events.subscribe('history.changed', invalidateGroups);
      context.events.subscribe('document.replaced', () => { overviewRevision = -1; invalidateGroups(); });

      context.ui.contribute({
        id: 'groups.layer',
        slot: 'canvas.groups',
        kind: 'view',
        label: '群组图层',
        component: groupLayer,
      });
      context.ui.contribute({
        id: 'groups.actions',
        slot: 'top.primary',
        kind: 'view',
        label: '群组操作',
        group: 'edit',
        component: groupActions,
        priority: 20,
      });
      context.ui.contribute({
        id: 'groups.membership-panel',
        slot: 'overlay.modal',
        kind: 'view',
        label: '加入或移出已有群组',
        component: membershipPanel,
        priority: 20,
      });
      if (membershipPanelOpen()) {
        context.ui.activateSurface('overlay.modal', 'groups.membership-panel', 'group.membership.close');
      }
      context.ui.action({
        id: 'groups.toggle-action',
        label: '群组或解组选中项',
        command: 'group.toggleSelection',
        category: '选择与排列',
        keywords: ['群组', '解组', '组合', 'group', 'ungroup'],
        priority: 64,
      });
      context.ui.action({
        id: 'groups.membership-action',
        label: '加入或移出已有群组',
        command: 'group.membership.open',
        category: '选择与排列',
        keywords: ['加入群组', '移出群组', '成员', 'membership'],
        priority: 65,
      });
      context.ui.action({
        id: 'groups.create-action',
        label: '将选中节点建立群组',
        command: 'group.create',
        category: '选择与排列',
        keywords: ['群组', '组合', 'group'],
        priority: 66,
      });
      context.ui.shortcut({
        id: 'groups.toggle-shortcut',
        chord: 'mod+g',
        command: 'group.toggleSelection',
        label: '群组或解组选中项',
      });
      context.ui.shortcut({
        id: 'groups.create-shortcut',
        chord: 'mod+alt+shift+g',
        command: 'group.create',
        label: '将选中节点建立群组',
      });
      context.ui.shortcut({
        id: 'groups.membership-shortcut',
        chord: 'mod+alt+g',
        command: 'group.membership.open',
        label: '加入或移出已有群组',
      });
      context.ui.shortcut({
        id: 'groups.ungroup-shortcut',
        chord: 'mod+shift+g',
        command: 'group.ungroupSelection',
        label: '取消群组',
      });
      context.ui.shortcut({
        id: 'groups.membership-close-shortcut',
        command: 'group.membership.close',
        label: '关闭群组成员管理',
        category: '群组',
      });
      context.ui.action({
        id: 'groups.ungroup-action',
        label: '取消选中的群组',
        command: 'group.ungroupSelection',
        category: '选择与排列',
        keywords: ['取消群组', '解组', 'ungroup'],
        priority: 67,
      });
    },
  };
}

function isGroupIdPayload(payload: unknown): payload is GroupIdPayload {
  return isRecord(payload) && typeof payload.id === 'string';
}

function pointInsideBounds(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function isGroupMembershipPayload(payload: unknown): payload is GroupMembershipPayload {
  return isRecord(payload) &&
    typeof payload.groupId === 'string' &&
    Array.isArray(payload.nodeIds) &&
    payload.nodeIds.length > 0 &&
    payload.nodeIds.every((id) => typeof id === 'string');
}

function isGroupMembershipDropRequest(payload: unknown): payload is GroupMembershipDropRequest {
  if (!isGroupDropTargetRequest(payload)) return false;
  const candidate = payload as GroupDropTargetRequest & { positions?: unknown; target?: unknown };
  const positions = candidate.positions;
  const positionIds = new Set(Array.isArray(positions) ? positions.map(position => isRecord(position) ? position.id : undefined) : []);
  return Array.isArray(positions) &&
    positions.length > 0 &&
    positions.length <= 10_000 &&
    positionIds.size === positions.length &&
    (candidate.nodeIds === undefined || (candidate.nodeIds.length === positions.length &&
      candidate.nodeIds.every(id => positionIds.has(id)))) &&
    positions.some((position) => isRecord(position) && position.id === candidate.nodeId) &&
    positions.every((position) => isRecord(position) &&
      typeof position.id === 'string' && Number.isFinite(position.x) && Number.isFinite(position.y)) &&
    isRecord(candidate.target) &&
    (candidate.target.action === 'add' || candidate.target.action === 'remove') &&
    typeof candidate.target.groupId === 'string';
}

function isGroupDropTargetRequest(payload: unknown): payload is GroupDropTargetRequest {
  return isRecord(payload) &&
    typeof payload.nodeId === 'string' &&
    (payload.nodeIds === undefined || (Array.isArray(payload.nodeIds) && payload.nodeIds.length > 0 && payload.nodeIds.length <= 10_000 &&
      payload.nodeIds.every(id => typeof id === 'string') && new Set(payload.nodeIds).size === payload.nodeIds.length && payload.nodeIds.includes(payload.nodeId))) &&
    isRecord(payload.pointer) &&
    Number.isFinite(payload.pointer.x) &&
    Number.isFinite(payload.pointer.y);
}

function isGroupTitleStyle(value: unknown): value is GroupTitleStyle {
  return isRecord(value) && Number.isFinite(value.fontSize) && Number.isFinite(value.fontWeight);
}

function isGroupTitleMark(value: unknown): value is GroupTitleMark {
  return isRecord(value) &&
    Number.isFinite(value.start) &&
    Number.isFinite(value.end) &&
    isGroupTitleStyle(value);
}

function isSerializedGroups(payload: unknown): payload is SerializedGroups {
  return (
    isRecord(payload) &&
    Array.isArray(payload.groups) &&
    payload.groups.every(
      (group) =>
        isRecord(group) &&
        typeof group.id === 'string' &&
        typeof group.title === 'string' &&
        Array.isArray(group.memberIds) &&
        group.memberIds.every((id) => typeof id === 'string') &&
        isGroupTitleStyle(group.titleStyle) &&
        (group.titleMarks === undefined || (
          Array.isArray(group.titleMarks) && group.titleMarks.every(isGroupTitleMark)
        )) &&
        (group.color === undefined || isAppearanceColor(group.color)),
    )
  );
}
