import { createId, isRecord, type PluginContext, type PluginDefinition, type CommandOutcome } from '../../core/contracts.ts';
import type {
  AppearanceColorContribution,
  AppearanceReadContribution,
  AppearanceReadRequest,
  AppearanceUpdatePlan,
  AppearanceUpdateRequest,
} from '../../protocols/appearance.ts';
import type { CanvasAppearanceSnapshot, CanvasContextRequest, CanvasPointerSnapshot } from '../../protocols/canvas.ts';
import type {
  ClipboardFragment,
  ClipboardInstantiateInput,
  ClipboardInstantiatePlan,
} from '../../protocols/clipboard.ts';
import {
  DEFAULT_CONNECTION_LABEL_HEIGHT,
  DEFAULT_CONNECTION_LABEL_WIDTH,
  resolveConnectionEndpoints,
  connectionUsesTextBoxRegions,
  isConnectionTitleOrigin,
  isTitleConnection,
  connectionJunctionRequest,
  resolveConnectionRecordEndpoints,
  MAX_CONNECTION_LABEL_LENGTH,
  normalizeConnectionLabelSize,
  type ConnectionCreatePlanRequest,
  type ConnectionAppearanceSnapshot,
  type ConnectionEndpoint,
  type ConnectionMutationPlan,
  type ConnectionRecord,
  type ConnectionJunction,
  type ConnectionGraphSnapshot,
  type ConnectionResizeLabelRequest,
  type ConnectionReconnectRequest,
  type ConnectionSetLabelRequest,
  type ConnectionTargetAtRequest,
  type ConnectionNodeGeometry,
  type ConnectionTarget,
} from '../../protocols/connections.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type {
  EntityDeletePlan,
  EntityMovePlan,
  EntityMoveRequest,
  SelectionCatalogContribution,
  SelectionItem,
  SelectionSnapshot,
  SelectionResolution,
} from '../../protocols/selection.ts';
import type { StatisticsContribution } from '../../protocols/statistics.ts';
import { defineManifest } from '../manifest.ts';
import { connectionGraphPoints } from './routing.ts';
import { canvasContrastColors } from '../../ui/canvas-contrast.ts';
import {
  CONNECTION_LASSO_REGION_PADDING,
  connectionCurveBounds,
  connectionCurveLassoRegions,
} from './rendering.ts';

import {
  assertJunctionChanges, assertJunctionLineTypes,
  JUNCTION_NAMESPACE, isJunction, isAddJunctionRequest, isMoveJunctionRequest,
  junctionGeometry, logicalConnectionPaths, planConnectionGraphDeletion, serializeConnectionGraph, splitConnectionsAtJunction,
} from './junctions.ts';

const CONNECTION_NAMESPACE = 'connections';
const CONNECTION_APPEARANCE_NAMESPACE = 'connectionAppearance';
const CONNECTION_APPEARANCE_KEY = 'line';
const FALLBACK_CONNECTION_LINE_COLOR = '#888886';
type LocalConnectionAppearanceKind =
  | 'connection-line'
  | 'connection-label-background'
  | 'connection-label-text';

interface CreateConnectionPayload {
  titleOrigin?: ConnectionRecord['titleOrigin'];
  from: ConnectionEndpoint;
  to: ConnectionEndpoint;
}

interface SerializedConnections {
  schemaVersion?: 2 | 3 | 4 | 5 | 6;
  junctions?: ConnectionJunction[];
  connections: ConnectionRecord[];
}

export function createConnectionsPlugin(connectionLayer?: unknown, toolbarAction?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('connections', '连线', {
      dataVersion: 11,
      namespaces: [CONNECTION_NAMESPACE, CONNECTION_APPEARANCE_NAMESPACE, JUNCTION_NAMESPACE],
      namespaceDomains: {
        [CONNECTION_NAMESPACE]: 'document',
        [CONNECTION_APPEARANCE_NAMESPACE]: 'document',
        [JUNCTION_NAMESPACE]: 'document',
      },
      requiresCapabilities: [
        'content.summaries@1',
        'content.summariesById@1',
        'content.catalog@2',
        'selection.read@1',
      ],
      optionalCapabilities: ['canvas.camera@1', 'canvas.appearance@1', 'canvas.pointer@1', 'canvas.viewport@1', 'layout.snap@1', 'connections.targets@1', 'selection.resolve@1'],
      providesCapabilities: [
        'entity.movePlan@1',
        'connections.detachPlan@1',
        'connections.targetAt@1',
        'connections.list@1',
        'connections.graph@1',
        'connections.available@1',
        'connections.createPlan@1',
        'connections.appearance@1',
        'appearance.read@1',
        'appearance.updatePlan@1',
        'appearance.colors@1',
        'appearance.resetPlan@1',
        'entity.deletePlan@1',
        'clipboard.serialize@1',
        'clipboard.instantiate@1',
        'statistics.contribute@1',
        'selection.entities@1',
      ],
      commands: [
        'connection.create',
        'connection.reconnect',
        'connection.rotateJunctionHandle',
        'connection.moveJunctions',
        'connection.connectSelectedEndpoints',
        'connection.addJunction',
        'connection.addJunctionFromContext',
        'connection.addJunctionAtPointer',
        'connection.moveJunction',
        'connection.nudgeJunction',
        'connection.removeSelectedJunctions',
        'connection.setLabel',
        'connection.resizeLabel',
        'connection.toggleSelected',
        'connection.toggleTitleSelected',
      ],
      dispatches: ['selection.moveEntities', 'selection.set', 'selection.clear', 'interaction.begin', 'interaction.end', 'connection.addJunction', 'connection.moveJunction', 'connection.moveJunctions'],
      asks: ['editor.openPanes'],
      events: [
        'entity.deleted',
        'connection.created',
        'connection.changed',
        'connection.appearance.changed',
        'connections.deleted',
        'nodes.pasted',
        'history.changed',
        'document.replaced',
      ],
      signals: [
        'group.membership.preview',
        'connection.targets.invalidated',
        'canvas.camera.preview',
        'canvas.pointer.preview',
        'canvas.snap.preview',
        'connection.junction.preview',
        'canvas.drag.preview',
        'canvas.node.resize.preview',
        'canvas.appearance.invalidated',
        'canvas.wheel.requested',
        'connection.draft.preview',
        'appearance.color.preview',
        'content.catalog.invalidated',
        'connections.invalidated',
        'connections.appearance.invalidated',
        'connection.label.resize.preview',
        'canvas.entity.hover.preview',
        'canvas.lasso.preview',
        'canvas.lasso.external.requested',
        'canvas.lasso.external.preview',
        'canvas.lasso.external.finished',
      ],
      ui: ['connections.layer', 'connections.toolbar-action'],
      actions: ['connections.toggle-selected-action', 'connections.toggle-title-selected-action', 'connections.add-junction-action', 'connections.remove-junction-action', 'connections.connect-endpoints-action'],
      shortcuts: ['connections.toggle-selected-shortcut', 'connections.toggle-title-selected-shortcut', 'connections.add-junction-shortcut', 'connections.remove-junction-shortcut', 'connections.connect-endpoints-shortcut'],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.canvas.contribute',
        'ui.top.contribute',
        'ui.action.register',
        'ui.shortcut.register',
      ],
    }),

    migrations: [{
      from: 1,
      to: 2,
      migrate: (data) => data,
    }, {
      from: 2,
      to: 3,
      migrate: (data) => ({
        ...data,
        [CONNECTION_NAMESPACE]: Object.fromEntries(
          Object.entries(data[CONNECTION_NAMESPACE] ?? {}).map(([id, value]) => [
            id,
            isRecord(value) && (!Number.isInteger(value.revision) || Number(value.revision) < 1)
              ? { ...value, revision: 1 }
              : value,
          ]),
        ),
      }),
    }, {
      from: 3,
      to: 4,
      migrate: (data) => ({
        ...data,
        [CONNECTION_APPEARANCE_NAMESPACE]: data[CONNECTION_APPEARANCE_NAMESPACE] ?? {},
      }),
    }, {
      from: 4,
      to: 5,
      migrate: (data) => ({
        ...data,
        [CONNECTION_NAMESPACE]: Object.fromEntries(
          Object.entries(data[CONNECTION_NAMESPACE] ?? {}).map(([id, value]) => {
            if (!isRecord(value)) return [id, value];
            const size = normalizeConnectionLabelSize(value.labelWidth, value.labelHeight);
            return [id, { ...value, labelWidth: size.width, labelHeight: size.height }];
          }),
        ),
      }),
    }, {
      from: 5,
      to: 6,
      migrate: (data) => data,
    }, {
      from: 6,
      to: 7,
      migrate: (data) => ({ ...data, [JUNCTION_NAMESPACE]: data[JUNCTION_NAMESPACE] ?? {} }),
    }, {
      from: 7, to: 8, migrate: data => data,
    }, {
      from: 8, to: 9, migrate: data => data,
    }, {
      from: 9, to: 10, migrate: data => data,
    }, {
      from: 10, to: 11, migrate: data => data,
    }],

    start(context) {
      const readConnections = () =>
        context.store.readNamespace<Record<string, ConnectionRecord>>(CONNECTION_NAMESPACE);
      const readJunctions = () => {
        const points = context.store.readNamespace<Record<string, ConnectionJunction>>(JUNCTION_NAMESPACE);
        for (const [id, point] of Object.entries(points)) {
          if (!isJunction(point) || point.id !== id) throw new Error('中转点数据不正确，请从完整的书籍副本恢复');
        }
        return points;
      };
      const readTargets = async (excludedIds?: string[], nodes?: ConnectionNodeGeometry[]) => (await context.capabilities.requestAll<ConnectionTarget[]>(
        'connections.targets@1', nodes || excludedIds ? { nodes, excludedIds } : undefined,
      )).flat();
      const readConnectionAppearance = (): ConnectionAppearanceSnapshot => {
        const value = context.store.readValue<unknown>(
          CONNECTION_APPEARANCE_NAMESPACE,
          CONNECTION_APPEARANCE_KEY,
        );
        return isConnectionAppearanceRecord(value)
          ? { color: value.color.toLowerCase(), revision: value.revision }
          : { revision: 0 };
      };
      const readEffectiveConnectionColor = async () => {
        const appearance = readConnectionAppearance();
        if (appearance.color) return appearance.color;
        try {
          const canvas = await context.capabilities.request<CanvasAppearanceSnapshot>('canvas.appearance@1');
          return canvasContrastColors(canvas.color).line;
        } catch {
          return FALLBACK_CONNECTION_LINE_COLOR;
        }
      };

      context.commands.register({
        type: 'connection.addJunction',
        validate: isAddJunctionRequest,
        handle: (payload) => {
          const all = readConnections();
          const ids = new Set(payload.connections.map((reference) => reference.id));
          if (ids.size !== payload.connections.length) throw new Error('连接线选择不能重复');
          const records = payload.connections.map((reference) => {
            const record = all[reference.id];
            if (!record || record.revision !== reference.revision) throw new Error('连接线已变化，请重新选择后添加中转点');
            return record;
          });
          const split = splitConnectionsAtJunction(records, payload);
          assertJunctionChanges(Object.values(all), split.connections);
          return {
            result: { id: split.junction.id },
            transaction: {
              label: '添加连接中转点',
              patches: [
                { op: 'set' as const, domain: 'document' as const, namespace: JUNCTION_NAMESPACE, key: split.junction.id, value: split.junction },
                ...split.connections.map((record) => ({ op: 'set' as const, domain: 'document' as const, namespace: CONNECTION_NAMESPACE, key: record.id, value: record })),
              ],
              events: [{ type: 'connection.changed', payload: { ids: split.connections.map((record) => record.id) } }],
            },
          };
        },
      });
      const selectedConnectionReferences = async () => {
        const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
        const records = readConnections();
        return selection.ids.flatMap((id) => records[id] ? [{ id, revision: records[id].revision }] : []);
      };
      context.commands.register({
        type: 'connection.addJunctionAtPointer',
        handle: async () => {
          const references = await selectedConnectionReferences();
          if (references.length === 0) throw new Error('请先选中连接线');
          const pointer = await context.capabilities.request<CanvasPointerSnapshot>('canvas.pointer@1');
          if (!('point' in pointer)) throw new Error('请先将鼠标移到画布中的中转位置');
          const result = await context.commands.invoke('connection.addJunction', { ...pointer.point, connections: references });
          return { result };
        },
      });
      context.commands.register({
        type: 'connection.addJunctionFromContext',
        validate: (value): value is CanvasContextRequest => isRecord(value) && isRecord(value.point) &&
          Number.isFinite(value.point.x) && Number.isFinite(value.point.y),
        handle: async (payload) => {
          const references = await selectedConnectionReferences();
          if (references.length === 0) return { result: {} };
          return { result: await context.commands.invoke('connection.addJunction', { ...payload.point, connections: references }) };
        },
      });
      context.commands.register<{ id: string }, { handleAngle: number; revision: number }>({
        type: 'connection.rotateJunctionHandle',
        validate: (value): value is { id: string } => isRecord(value) && typeof value.id === 'string' && value.id.length > 0,
        handle: payload => {
          const point = readJunctions()[payload.id];
          if (!point) throw new Error('连接中转点已不存在');
          const handleAngle = ((point.handleAngle ?? 0) + 15) % 360;
          const next: ConnectionJunction = { ...point, handleAngle, revision: point.revision + 1 };
          if (handleAngle === 0) delete next.handleAngle;
          return { result: { handleAngle, revision: next.revision }, transaction: { label: '旋转中转点曲线手柄',
            patches: [{ op: 'set', domain: 'document', namespace: JUNCTION_NAMESPACE, key: point.id, value: next }],
            events: [{ type: 'connection.changed', payload: { junctionIds: [point.id] } }] } };
        },
      });
      const junctionMovesPlan = (positions: import('../../protocols/connections.ts').ConnectionMoveJunctionRequest[]) => {
        const points = readJunctions();
        for (const input of positions) if (!points[input.id] || points[input.id].revision !== input.expectedRevision) throw new Error('中转点已变化，请重新移动');
        const changed = positions.filter(input => points[input.id].x !== input.x || points[input.id].y !== input.y);
        return {
          patches: changed.map(input => ({ op: 'set' as const, domain: 'document' as const, namespace: JUNCTION_NAMESPACE,
            key: input.id, schemaOwner: 'connections', value: { ...points[input.id], x: input.x, y: input.y, revision: points[input.id].revision + 1 } })),
          events: changed.length ? [{ type: 'connection.changed', payload: { junctionIds: changed.map(input => input.id) } }] : [],
        };
      };
      context.capabilities.provide<EntityMoveRequest, EntityMovePlan>({
        key: 'entity.movePlan@1', invoke: input => {
          const points = readJunctions();
          const owned = input.positions.filter(position => points[position.id]);
          if (owned.some(position => !isMoveJunctionRequest(position))) throw new Error('中转点移动缺少有效修订');
          return { ids: owned.map(position => position.id), ...junctionMovesPlan(owned as import('../../protocols/connections.ts').ConnectionMoveJunctionRequest[]) };
        },
      });
      context.commands.register({
        type: 'connection.moveJunctions',
        validate: (value): value is { positions: import('../../protocols/connections.ts').ConnectionMoveJunctionRequest[] } => isRecord(value) &&
          Array.isArray(value.positions) && value.positions.length > 0 && value.positions.length <= 10_000 &&
          value.positions.every(isMoveJunctionRequest) && new Set(value.positions.map(item => item.id)).size === value.positions.length,
        handle: payload => {
          const plan = junctionMovesPlan(payload.positions);
          return { result: { moved: plan.patches.length }, transaction: plan.patches.length ? { label: '移动连接中转点', ...plan } : undefined };
        },
      });
      context.commands.register({
        type: 'connection.moveJunction',
        validate: isMoveJunctionRequest,
        handle: (payload) => {
          const point = readJunctions()[payload.id];
          if (!point || point.revision !== payload.expectedRevision) throw new Error('中转点已变化，请重新移动');
          if (point.x === payload.x && point.y === payload.y) return { result: { revision: point.revision } };
          const next = { ...point, x: payload.x, y: payload.y, revision: point.revision + 1 };
          return {
            result: { revision: next.revision },
            transaction: {
              label: '移动连接中转点',
              patches: [{ op: 'set' as const, domain: 'document' as const, namespace: JUNCTION_NAMESPACE, key: point.id, value: next }],
              events: [{ type: 'connection.changed', payload: { junctionId: point.id } }],
            },
          };
        },
      });
      context.commands.register({
        type: 'connection.removeSelectedJunctions',
        handle: async () => {
          const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
          const points = Object.values(readJunctions());
          const selected = new Set(points.filter((point) => selection.ids.includes(point.id)).map((point) => point.id));
          const plan = planConnectionGraphDeletion(Object.values(readConnections()), points, selected);
          return {
            result: { removed: selected.size },
            transaction: plan.patches.length ? {
              label: '删除中转点并恢复连接', patches: plan.patches,
              events: [
                { type: 'connection.changed', payload: { ids: plan.changedIds } },
                { type: 'connections.deleted', payload: { ids: plan.removedIds } },
                { type: 'entity.deleted', payload: { ids: [...selected] } },
              ],
            } : undefined,
          };
        },
      });
      context.commands.register({
        type: 'connection.nudgeJunction',
        validate: (value): value is { id: string; dx: number; dy: number } => isRecord(value) &&
          typeof value.id === 'string' && Number.isFinite(value.dx) && Number.isFinite(value.dy),
        handle: async (payload) => {
          const point = readJunctions()[payload.id];
          if (!point) throw new Error('中转点已经不存在');
          const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
          const selected = selection.ids.includes(point.id) ? Object.values(readJunctions()).filter(item => selection.ids.includes(item.id)) : [point];
          const resolution = await context.capabilities.request<SelectionResolution>('selection.resolve@1', { ids: selection.ids.includes(point.id) ? selection.ids : [point.id], mode: 'replace' });
          const included = new Set(resolution.expandedIds);
          const content = (await context.capabilities.request<ContentSummary[]>('content.summaries@1')).filter(node => included.has(node.id));
          if (content.length) {
            await context.commands.invoke('selection.moveEntities', { positions: [...selected.map(item => ({ id: item.id, x: item.x + payload.dx, y: item.y + payload.dy, expectedRevision: item.revision })),
              ...content.map(node => ({ id: node.id, x: node.x + payload.dx, y: node.y + payload.dy }))] });
            return { result: { revision: point.revision + 1 } };
          }
          await context.commands.invoke('connection.moveJunctions', { positions: selected.map(item => ({
            id: item.id, x: item.x + payload.dx, y: item.y + payload.dy, expectedRevision: item.revision,
          })) });
          return { result: { revision: point.revision + 1 } };
        },
      });
      context.capabilities.provide<undefined, ConnectionGraphSnapshot>({
        key: 'connections.graph@1',
        invoke: () => ({ version: 1, connections: Object.values(readConnections()), junctions: Object.values(readJunctions()) }),
      });
      context.capabilities.provide<ConnectionTargetAtRequest, ConnectionEndpoint | undefined>({
        key: 'connections.targetAt@1',
        invoke: (input) => {
          if (!input?.point || !Number.isFinite(input.point.x) || !Number.isFinite(input.point.y) ||
            !Number.isFinite(input.radius) || input.radius < 0 || input.radius > 1000) return undefined;
          let nearest: ConnectionJunction | undefined, distance = input.radius;
          for (const point of Object.values(readJunctions())) {
            if (point.id === input.excludeId) continue;
            const next = Math.hypot(input.point.x - point.x, input.point.y - point.y);
            if (next <= distance) { nearest = point; distance = next; }
          }
          return nearest ? { nodeId: nearest.id, kind: 'junction', side: 'left' } : undefined;
        },
      });

      const createOrReconnect = async (payload: CreateConnectionPayload, reference?: ConnectionReconnectRequest): Promise<CommandOutcome<{ id?: string }>> => {
          const current = reference ? readConnections()[reference.id] : undefined;
          if (reference && (!current || current.revision !== reference.expectedRevision)) throw new Error('连线已经变化，请重新拖动箭头');
          if (payload.from.nodeId === payload.to.nodeId) throw new Error('不能把节点连接到自己');
          const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
          const known = new Map<string, ConnectionNodeGeometry>(nodes.map((node) => [node.id, node]));
          for (const target of await readTargets()) known.set(target.id, target);
          const points = readJunctions();
          for (const endpoint of [payload.from, payload.to]) {
            if (endpoint.kind === 'junction') {
              if (!points[endpoint.nodeId]) throw new Error('连接中转点不存在');
              known.set(endpoint.nodeId, junctionGeometry(points[endpoint.nodeId]));
            } else if (endpoint.kind === 'group') {
              if (known.get(endpoint.nodeId)?.kind !== 'group') throw new Error('连接群组不存在');
            } else if (known.get(endpoint.nodeId)?.kind === 'group' || points[endpoint.nodeId]) {
              throw new Error('连接端点类型不正确');
            }
          }
          const fromNode = known.get(payload.from.nodeId);
          const toNode = known.get(payload.to.nodeId);
          if (!fromNode || !toNode) {
            throw new Error('连接端点不存在');
          }
          const connections = Object.values(readConnections()).filter(edge => edge.id !== reference?.id);
          if (payload.from.kind === 'junction' && payload.to.kind === 'junction') {
            const queue = [payload.to.nodeId], seen = new Set<string>();
            const outgoing = new Map<string, string[]>();
            for (const edge of connections) if (edge.from.kind === 'junction' && edge.to.kind === 'junction') {
              const targets = outgoing.get(edge.from.nodeId) ?? [];
              targets.push(edge.to.nodeId); outgoing.set(edge.from.nodeId, targets);
            }
            for (let index = 0; index < queue.length; index += 1) {
              const id = queue[index];
              if (id === payload.from.nodeId) throw new Error('中转点不能形成循环连接');
              if (seen.has(id)) continue;
              seen.add(id); queue.push(...(outgoing.get(id) ?? []));
            }
          }
          const requested = connectionJunctionRequest(payload, fromNode, toNode, current ? [...connections, current] : connections);
          const endpoints = { ...resolveRequestedConnectionEndpoints(requested, fromNode, toNode),
            ...(requested.titleRoute !== undefined ? { titleRoute: requested.titleRoute } : {}) };
          const candidates = payload.from.kind || payload.to.kind
            ? connections : logicalConnectionPaths(connections).map((item) => item.record);
          const duplicate = candidates.find((connection) => isTitleConnection(connection) === isTitleConnection(endpoints) && (payload.from.kind || payload.to.kind
            ? connection.from.nodeId === payload.from.nodeId && connection.to.nodeId === payload.to.nodeId &&
              connection.from.kind === payload.from.kind && connection.to.kind === payload.to.kind
            : sameNodePair(connection, payload)));
          if (duplicate) {
            if (reference) throw new Error('目标已有相同连线');
            return { result: { id: duplicate.id } };
          }
          const id = current?.id ?? createId('connection');
          const connection: ConnectionRecord = {
            ...(current ?? { labelWidth: DEFAULT_CONNECTION_LABEL_WIDTH, labelHeight: DEFAULT_CONNECTION_LABEL_HEIGHT, createdAt: Date.now() }),
            id, ...endpoints,
            revision: (current?.revision ?? 0) + 1,
          };
          if (payload.titleOrigin && isTitleConnection(connection)) {
            if (payload.from.kind || payload.from.side !== 'title') throw new Error('标题起始端口不正确');
            // New gestures record ordering from authoritative target geometry, including point/group targets.
            connection.titleOrigin = { ...payload.titleOrigin, sourceCenterX: fromNode.x + fromNode.width / 2, targetCenterX: toNode.x + toNode.width / 2,
              sourceIsLeft: fromNode.x + fromNode.width / 2 <= toNode.x + toNode.width / 2 };
          } else if (current && current.from.nodeId !== payload.from.nodeId) delete connection.titleOrigin;
          if (reference && requested.titleRoute === undefined) delete connection.titleRoute;
          assertJunctionChanges(Object.values(readConnections()), [connection]);
          return {
            result: { id },
            transaction: {
              label: reference ? '重新连接连线' : '创建连线',
              patches: [
                {
                  op: 'set',
                  domain: 'document',
                  namespace: CONNECTION_NAMESPACE,
                  key: id,
                  value: connection,
                },
              ],
              events: [{ type: reference ? 'connection.changed' : 'connection.created', payload: { id } }],
            },
          };
      };
      context.commands.register<CreateConnectionPayload, { id?: string }>({
        type: 'connection.create', validate: isCreateConnectionPayload, handle: payload => createOrReconnect(payload),
      });
      context.commands.register<ConnectionReconnectRequest, { id?: string }>({
        type: 'connection.reconnect',
        validate: (payload): payload is ConnectionReconnectRequest => isCreateConnectionPayload(payload) && isRecord(payload) &&
          typeof payload.id === 'string' && Number.isInteger(payload.expectedRevision) && Number(payload.expectedRevision) > 0,
        handle: payload => createOrReconnect(payload, payload),
      });

      context.commands.register({
        type: 'connection.connectSelectedEndpoints',
        handle: async () => {
          const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
          const points = readJunctions();
          const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
          const known = new Set(nodes.map(node => node.id));
          const groups = new Set((await readTargets()).map(target => target.id));
          const endpoints = selection.ids.flatMap<ConnectionEndpoint>(id => points[id]
            ? [{ nodeId: id, kind: 'junction' as const, side: 'right' as const }]
            : groups.has(id) ? [{ nodeId: id, kind: 'group' as const, side: 'left' as const }]
            : known.has(id) ? [{ nodeId: id, side: 'left' as const }] : []);
          if (endpoints.length !== 2) throw new Error('请按顺序选中两个节点或中转点');
          return { result: await context.commands.invoke('connection.create', { from: endpoints[0], to: endpoints[1] }) };
        },
      });
      context.ui.action({ id: 'connections.connect-endpoints-action', label: '按选择顺序连接节点或中转点',
        category: '连接', command: 'connection.connectSelectedEndpoints', keywords: ['中转点', '连接', '分支'] });
      context.ui.shortcut({ id: 'connections.connect-endpoints-shortcut', label: '按选择顺序连接节点或中转点',
        category: '连接', command: 'connection.connectSelectedEndpoints' });

      context.commands.register<ConnectionSetLabelRequest, { revision: number }>({
        type: 'connection.setLabel',
        validate: isConnectionSetLabelRequest,
        handle: (payload) => {
          const current = readConnections()[payload.id];
          if (!current) throw new Error('连线已经不存在');
          if (current.revision !== payload.expectedRevision) throw new Error('连线文字已变化，请重新编辑');
          const label = normalizeConnectionLabel(payload.label);
          if (label === (current.label ?? '')) return { result: { revision: current.revision } };
          const next: ConnectionRecord = { ...current, revision: current.revision + 1 };
          if (label) next.label = label;
          else delete next.label;
          return {
            result: { revision: next.revision },
            transaction: {
              label: '编辑连线文字',
              patches: [{
                op: 'set',
                domain: 'document',
                namespace: CONNECTION_NAMESPACE,
                key: current.id,
                value: next,
              }],
              events: [{ type: 'connection.changed', payload: { id: current.id } }],
            },
          };
        },
      });

      context.commands.register<ConnectionResizeLabelRequest, {
        width: number;
        height: number;
        revision: number;
      }>({
        type: 'connection.resizeLabel',
        validate: isConnectionResizeLabelRequest,
        handle: (payload) => {
          const current = readConnections()[payload.id];
          if (!current) throw new Error('连线已经不存在');
          if (!current.label) throw new Error('连线没有可调整的文字框');
          if (current.revision !== payload.expectedRevision) {
            throw new Error('连线文字框已经变化，请重新调整');
          }
          const size = normalizeConnectionLabelSize(payload.width, payload.height);
          if (current.labelWidth === size.width && current.labelHeight === size.height) {
            return { result: { ...size, revision: current.revision } };
          }
          const next: ConnectionRecord = {
            ...current,
            labelWidth: size.width,
            labelHeight: size.height,
            revision: current.revision + 1,
          };
          return {
            result: { ...size, revision: next.revision },
            transaction: {
              label: '调整连线文字框大小',
              patches: [{
                op: 'set',
                domain: 'document',
                namespace: CONNECTION_NAMESPACE,
                key: current.id,
                value: next,
              }],
              events: [{ type: 'connection.changed', payload: { id: current.id } }],
            },
          };
        },
      });

      context.commands.register<undefined, { removed?: number; id?: string }>({
        type: 'connection.toggleSelected',
        handle: async () => {
          const [selection, nodes] = await Promise.all([
            context.capabilities.request<SelectionSnapshot>('selection.read@1'),
            context.capabilities.request<ContentSummary[]>('content.summaries@1'),
          ]);
          const targets = await readTargets();
          const known = new Map<string, ConnectionNodeGeometry>([...nodes, ...targets, ...Object.values(readJunctions()).map(point => ({ ...junctionGeometry(point), kind: 'junction' as const }))].map(node => [node.id, node]));
          const selected = [...new Set(selection.ids)]
            .map((id) => known.get(id))
            .filter(Boolean) as ConnectionNodeGeometry[];
          if (selected.length < 1 || selected.length > 2) throw new Error('请选择一个或两个文字节点');

          if (selected.length === 1) {
            const nodeId = selected[0].id;
            const attached = Object.values(readConnections()).filter((connection) =>
              connection.from.nodeId === nodeId || connection.to.nodeId === nodeId,
            );
            if (attached.length === 0) throw new Error('选中的文字节点没有连线');
            return {
              result: { removed: attached.length },
              transaction: {
                label: '断开选中节点的连线',
                patches: attached.map((connection) => ({
                  op: 'delete' as const,
                  domain: 'document' as const,
                  namespace: CONNECTION_NAMESPACE,
                  key: connection.id,
                })),
                events: [{
                  type: 'connections.deleted',
                  payload: { ids: attached.map((connection) => connection.id) },
                }],
              },
            };
          }

          const selectedIds = new Set(selected.map((node) => node.id));
          const records = Object.values(readConnections());
          const candidates = selected.some(node => node.kind === 'junction') ? records : logicalConnectionPaths(records).map(item => item.record);
          const requested = connectionJunctionRequest({ from: { nodeId: selected[0].id, kind: selected[0].kind, side: 'right' },
            to: { nodeId: selected[1].id, kind: selected[1].kind, side: 'left' } }, selected[0], selected[1], records);
          const existing = candidates.filter((connection) => isTitleConnection(connection) === isTitleConnection(requested) &&
            selectedIds.has(connection.from.nodeId) && selectedIds.has(connection.to.nodeId),
          );
          if (existing.length > 0) {
            return {
              result: { removed: existing.length },
              transaction: {
                label: '断开节点连线',
                patches: existing.map((connection) => ({
                  op: 'delete' as const,
                  domain: 'document' as const,
                  namespace: CONNECTION_NAMESPACE,
                  key: connection.id,
                })),
                events: [{
                  type: 'connections.deleted',
                  payload: { ids: existing.map((connection) => connection.id) },
                }],
              },
            };
          }

          return { result: await context.commands.invoke('connection.create', requested) };
        },
      });

      context.commands.register<undefined, { removed?: number; id?: string; converted?: boolean }>({
        type: 'connection.toggleTitleSelected',
        handle: async () => {
          const [selection, nodes] = await Promise.all([
            context.capabilities.request<SelectionSnapshot>('selection.read@1'),
            context.capabilities.request<ContentSummary[]>('content.summaries@1'),
          ]);
          const targets = await readTargets();
          const known = new Map<string, ConnectionNodeGeometry>([...nodes, ...targets].map(node => [node.id, node]));
          const selected = [...new Set(selection.ids)]
            .map((id) => known.get(id))
            .filter(Boolean) as ConnectionNodeGeometry[];
          if (selected.length !== 2) throw new Error('请选择两个文字节点');
          if (selected.every(node => node.kind === 'group')) return { result: await context.commands.invoke('connection.toggleSelected') };

          const selectedIds = new Set(selected.map((node) => node.id));
          const existing = logicalConnectionPaths(Object.values(readConnections())).find(({ record }) => isTitleConnection(record) &&
            selectedIds.has(record.from.nodeId) && selectedIds.has(record.to.nodeId))?.record;
          if (existing?.from.side === 'title' || existing?.to.side === 'title') {
            return {
              result: { removed: 1 },
              transaction: {
                label: '断开标题连线',
                patches: [{
                  op: 'delete' as const,
                  domain: 'document' as const,
                  namespace: CONNECTION_NAMESPACE,
                  key: existing.id,
                }],
                events: [{ type: 'connections.deleted', payload: { ids: [existing.id] } }],
              },
            };
          }

          const { from, to } = resolveConnectionRecordEndpoints({
            from: { nodeId: selected[0].id, side: 'title', kind: selected[0].kind },
            to: { nodeId: selected[1].id, side: 'title', kind: selected[1].kind },
          }, selected[0], selected[1]);
          const id = createId('connection');
          const connection: ConnectionRecord = {
            id,
            from,
            to,
            labelWidth: DEFAULT_CONNECTION_LABEL_WIDTH,
            labelHeight: DEFAULT_CONNECTION_LABEL_HEIGHT,
            revision: 1,
            createdAt: Date.now(),
          };
          return {
            result: { id },
            transaction: {
              label: '创建标题连线',
              patches: [{
                op: 'set' as const,
                domain: 'document' as const,
                namespace: CONNECTION_NAMESPACE,
                key: id,
                value: connection,
              }],
              events: [{ type: 'connection.created', payload: { id } }],
            },
          };
        },
      });

      context.capabilities.provide({
        key: 'connections.list@1',
        invoke: async () => {
          const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
          const nodeMap = new Map<string, import('../../protocols/connections.ts').ConnectionNodeGeometry>(nodes.map((node) => [node.id, node]));
          for (const target of await readTargets()) nodeMap.set(target.id, target);
          for (const point of Object.values(readJunctions())) nodeMap.set(point.id, junctionGeometry(point));
          return logicalConnectionPaths(Object.values(readConnections())).map(({ record: connection }) => {
            const fromNode = nodeMap.get(connection.from.nodeId);
            const toNode = nodeMap.get(connection.to.nodeId);
            if (!fromNode || !toNode) return connection;
            return { ...connection, ...resolveConnectionRecordEndpoints(connection, fromNode, toNode) };
          });
        },
      });
      context.capabilities.provide({
        key: 'connections.available@1',
        invoke: () => true,
      });
      context.capabilities.provide<undefined, ConnectionAppearanceSnapshot>({
        key: 'connections.appearance@1',
        invoke: readConnectionAppearance,
      });
      context.capabilities.provide<AppearanceReadRequest, AppearanceReadContribution>({
        key: 'appearance.read@1',
        invoke: async (input) => {
          if (input?.mode === 'selection') {
            const requestedItems: SelectionItem[] = input.selectedItems?.length
              ? input.selectedItems
              : (input.selectedIds ?? []).map((id) => ({ id, kind: 'connection' }));
            const items = requestedItems.filter((item) => item.kind === 'connection');
            const records = new Map(Object.values(readConnections()).map((record) => [record.id, record]));
            const canvasColor = await readCanvasColor(context);
            const globalLineColor = await readEffectiveConnectionColor();
            const byKind = new Map<LocalConnectionAppearanceKind, ConnectionRecord[]>();
            for (const item of items) {
              const record = records.get(item.id);
              if (!record) continue;
              const kind: LocalConnectionAppearanceKind = item.part === 'label-text'
                  ? 'connection-label-text'
                  : 'connection-line';
              const list = byKind.get(kind) ?? [];
              list.push(record);
              byKind.set(kind, list);
            }
            return {
              targets: [...byKind].map(([kind, selectedConnections]) => {
                const colors = selectedConnections.map((record) => connectionPartColor(
                  record,
                  kind,
                  globalLineColor,
                  canvasColor,
                ));
                return {
                  kind,
                  label: connectionPartLabel(kind),
                  scopeLabel: `${selectedConnections.length} 个选中连接对象`,
                  color: colors[0],
                  mixed: new Set(colors).size > 1,
                  entities: selectedConnections.map((record, index) => ({
                    id: record.id,
                    revision: record.revision,
                    expectedColor: colors[index],
                  })),
                };
              }),
            };
          }
          const appearance = readConnectionAppearance();
          const color = appearance.color ?? await readEffectiveConnectionColor();
          return {
            targets: [{
              kind: 'connection-line',
              label: '连接曲线',
              scopeLabel: '当前画布的全部连接曲线',
              color,
              mixed: false,
              entities: [{
                id: CONNECTION_APPEARANCE_KEY,
                revision: appearance.revision,
                expectedColor: color,
              }],
            }],
          };
        },
      });
      context.capabilities.provide<AppearanceUpdateRequest, AppearanceUpdatePlan>({
        key: 'appearance.updatePlan@1',
        invoke: async (input) => {
          if (input.kind !== 'connection-line' && input.kind !== 'connection-label-text') return { patches: [], changed: 0 };
          if (!(input.kind === 'connection-line' && input.entities.length === 1 &&
            input.entities[0].id === CONNECTION_APPEARANCE_KEY)) {
            if (!isLocalConnectionAppearanceUpdate(input)) throw new Error('选中连接对象的颜色请求不正确');
            const records = readConnections();
            const canvasColor = await readCanvasColor(context);
            const globalLineColor = await readEffectiveConnectionColor();
            const changed: ConnectionRecord[] = [];
            for (const reference of input.entities) {
              const record = records[reference.id];
              if (!record || record.revision !== reference.revision ||
                connectionPartColor(record, input.kind, globalLineColor, canvasColor) !==
                  reference.expectedColor.toLowerCase()) {
                throw new Error('选中连接对象的颜色已经变化，请重新打开调色盘');
              }
              const field = connectionPartField(input.kind);
              if (record[field] === input.color.toLowerCase()) continue;
              changed.push({
                ...record,
                [field]: input.color.toLowerCase(),
                revision: record.revision + 1,
              });
            }
            return {
              changed: changed.length,
              patches: changed.map((record) => ({
                op: 'set' as const,
                domain: 'document' as const,
                namespace: CONNECTION_NAMESPACE,
                key: record.id,
                value: record,
                schemaOwner: 'connections',
              })),
              events: changed.length > 0
                ? [{ type: 'connection.changed', payload: { ids: changed.map((record) => record.id) } }]
                : [],
            };
          }
          if (!isConnectionAppearanceUpdate(input)) throw new Error('连接曲线颜色更新请求不正确');
          const appearance = readConnectionAppearance();
          const currentColor = appearance.color ?? await readEffectiveConnectionColor();
          const reference = input.entities[0];
          if (reference.revision !== appearance.revision ||
            reference.expectedColor.toLowerCase() !== currentColor) {
            throw new Error('连接曲线颜色已经变化，请重新选择颜色');
          }
          const color = input.color.toLowerCase();
          if (appearance.color === color) return { patches: [], changed: 0 };
          return {
            changed: 1,
            patches: [{
              op: 'set',
              domain: 'document',
              namespace: CONNECTION_APPEARANCE_NAMESPACE,
              key: CONNECTION_APPEARANCE_KEY,
              value: { color, revision: appearance.revision + 1 },
              schemaOwner: 'connections',
            }],
            events: [{ type: 'connection.appearance.changed', payload: { color } }],
          };
        },
      });
      context.capabilities.provide<undefined, AppearanceColorContribution>({
        key: 'appearance.colors@1',
        invoke: async () => {
          const counts = new Map<string, number>();
          const add = (color: string) => counts.set(color, (counts.get(color) ?? 0) + 1);
          const canvasColor = await readCanvasColor(context);
          const globalLineColor = await readEffectiveConnectionColor();
          for (const connection of Object.values(readConnections())) {
            add(connectionPartColor(connection, 'connection-line', globalLineColor, canvasColor));
            if (connection.label) {
              add(connectionPartColor(connection, 'connection-label-text', globalLineColor, canvasColor));
            }
          }
          return { colors: [...counts].map(([color, count]) => ({ color, count })) };
        },
      });
      context.capabilities.provide<undefined, AppearanceUpdatePlan>({
        key: 'appearance.resetPlan@1',
        invoke: () => {
          const patches: AppearanceUpdatePlan['patches'] = [];
          const changedConnections: string[] = [];
          const storedAppearance = context.store.readValue<{ color: string; revision: number }>(
            CONNECTION_APPEARANCE_NAMESPACE,
            CONNECTION_APPEARANCE_KEY,
          );
          if (storedAppearance) {
            patches.push({
              op: 'delete',
              domain: 'document',
              namespace: CONNECTION_APPEARANCE_NAMESPACE,
              key: CONNECTION_APPEARANCE_KEY,
              schemaOwner: 'connections',
            });
          }
          for (const connection of Object.values(readConnections())) {
            if (!connection.lineColor && !connection.labelBackgroundColor && !connection.labelTextColor) continue;
            const next = { ...connection, revision: connection.revision + 1 };
            delete next.lineColor;
            delete next.labelBackgroundColor;
            delete next.labelTextColor;
            changedConnections.push(connection.id);
            patches.push({
              op: 'set',
              domain: 'document',
              namespace: CONNECTION_NAMESPACE,
              key: connection.id,
              value: next,
              schemaOwner: 'connections',
            });
          }
          return {
            patches,
            changed: changedConnections.length + (storedAppearance ? 1 : 0),
            events: [
              ...(storedAppearance
                ? [{ type: 'connection.appearance.changed', payload: { color: undefined } }]
                : []),
              ...(changedConnections.length > 0
                ? [{ type: 'connection.changed', payload: { ids: changedConnections } }]
                : []),
            ],
          };
        },
      });
      context.capabilities.provide<ConnectionCreatePlanRequest, ConnectionMutationPlan>({
        key: 'connections.createPlan@1',
        invoke: (input) => {
          if (!isConnectionCreatePlanRequest(input)) throw new Error('connections.createPlan request is invalid');
          if (input.fromNodeId === input.toNodeId) throw new Error('不能把节点连接到自己');
          const duplicate = logicalConnectionPaths(Object.values(readConnections())).map((item) => item.record).find((connection) => !isTitleConnection(connection) && sameNodeIds(
            connection,
            input.fromNodeId,
            input.toNodeId,
          ));
          if (duplicate) return { id: duplicate.id, patches: [] };
          const id = createId('connection');
          const connection: ConnectionRecord = {
            id,
            from: { nodeId: input.fromNodeId, side: 'right' },
            to: { nodeId: input.toNodeId, side: 'left' },
            labelWidth: DEFAULT_CONNECTION_LABEL_WIDTH,
            labelHeight: DEFAULT_CONNECTION_LABEL_HEIGHT,
            revision: 1,
            createdAt: Date.now(),
          };
          return {
            id,
            patches: [{
              op: 'set',
              domain: 'document',
              namespace: CONNECTION_NAMESPACE,
              key: id,
              value: connection,
              schemaOwner: 'connections',
            }],
            events: [{ type: 'connection.created', payload: { id } }],
          };
        },
      });
      context.capabilities.provide<undefined, SelectionCatalogContribution>({
        key: 'selection.entities@1',
        invoke: async () => {
          const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
          const nodeMap = new Map<string, import('../../protocols/connections.ts').ConnectionNodeGeometry>(nodes.map((node) => [node.id, node]));
          for (const target of await readTargets()) nodeMap.set(target.id, target);
          for (const point of Object.values(readJunctions())) nodeMap.set(point.id, junctionGeometry(point));
          const graphPoints = connectionGraphPoints(Object.values(readConnections()), nodeMap);
          return {
            owner: 'connections',
            entities: [...Object.values(readJunctions()).map((point) => ({
              id: point.id, kind: 'connection-junction', geometryRevision: point.revision,
              bounds: { x: point.x - 6, y: point.y - 6, width: 12, height: 12 },
            })), ...Object.values(readConnections()).flatMap((connection) => {
              const fromNode = nodeMap.get(connection.from.nodeId);
              const toNode = nodeMap.get(connection.to.nodeId);
              if (!fromNode || !toNode) return [];
              const { from, to } = graphPoints.get(connection.id)!;
              const bounds = connectionCurveBounds(from, to, CONNECTION_LASSO_REGION_PADDING);
              return [{
                id: connection.id,
                kind: 'connection',
                geometryRevision: [
                  connection.from.nodeId,
                  connection.from.side,
                  fromNode.x,
                  fromNode.y,
                  fromNode.width,
                  fromNode.height,
                  fromNode.presentation,
                  connection.titleOrigin?.side, connection.titleOrigin?.sourceIsLeft,
                  connection.to.nodeId,
                  connection.to.side,
                  toNode.x,
                  toNode.y,
                  toNode.width,
                  toNode.height,
                  toNode.presentation,
                  from.side, to.side, from.tangent?.x, from.tangent?.y, to.tangent?.x, to.tangent?.y,
                  from.route?.key,
                ].join(':'),
                parts: ['line', 'label-background', 'label-text'],
                includeInSelectAll: false,
                bounds,
                boxRegions: connectionCurveLassoRegions(from, to),
              }];
            })],
          };
        },
      });
      context.capabilities.provide<{ ids: string[] }, EntityDeletePlan>({
        key: 'entity.deletePlan@1',
        invoke: async (input) => {
          const selected = new Set(Array.isArray(input?.ids) ? input.ids : []);
          const [before, after] = await Promise.all([readTargets(), readTargets([...selected])]);
          const surviving = new Set(after.map(target => target.id));
          for (const target of before) if (!surviving.has(target.id)) selected.add(target.id);
          const plan = planConnectionGraphDeletion(Object.values(readConnections()), Object.values(readJunctions()), selected);
          return {
            patches: plan.patches,
            events: plan.patches.length ? [
              { type: 'connections.deleted', payload: { ids: plan.removedIds } },
              { type: 'connection.changed', payload: { ids: plan.changedIds } },
            ] : [],
          };
        },
      });
      context.capabilities.provide<{ ids: string[] }, EntityDeletePlan>({
        key: 'connections.detachPlan@1',
        invoke: input => {
          const ids = new Set(Array.isArray(input?.ids) ? input.ids : []);
          const records = Object.values(readConnections()).filter(edge =>
            (edge.from.kind === 'group' && ids.has(edge.from.nodeId)) || (edge.to.kind === 'group' && ids.has(edge.to.nodeId)));
          return { patches: records.map(edge => ({ op: 'delete' as const, domain: 'document' as const, namespace: CONNECTION_NAMESPACE, key: edge.id, schemaOwner: 'connections' })),
            events: records.length ? [{ type: 'connections.deleted', payload: { ids: records.map(edge => edge.id) } }] : [] };
        },
      });

      context.capabilities.provide<{ ids: string[] }, ClipboardFragment>({
        key: 'clipboard.serialize@1',
        invoke: async (input) => {
          const selected = new Set(Array.isArray(input?.ids) ? input.ids : []);
          const records = Object.values(readConnections());
          const copyingGroup = (await readTargets()).some(target => selected.has(target.id));
          const graph = copyingGroup
            ? { connections: records.filter(edge => edge.from.kind !== 'junction' && edge.to.kind !== 'junction' && selected.has(edge.from.nodeId) && selected.has(edge.to.nodeId)), junctions: [] }
            : serializeConnectionGraph(records, Object.values(readJunctions()), selected);
          return {
            owner: 'connections', version: 1,
            entityIds: [...graph.connections.map((record) => record.id), ...graph.junctions.map((point) => point.id)],
            payload: { schemaVersion: 6, ...graph } satisfies SerializedConnections,
          };
        },
      });

      context.capabilities.provide<ClipboardInstantiateInput, ClipboardInstantiatePlan>({
        key: 'clipboard.instantiate@1',
        invoke: (input) => {
          const fragment = input.fragments.find((item) => item.owner === 'connections' && item.version === 1);
          if (!fragment || !isSerializedConnections(fragment.payload)) return { patches: [] };
          const connections = fragment.payload.connections.filter(
            (connection) => input.idMap[connection.from.nodeId] && input.idMap[connection.to.nodeId],
          );
          assertJunctionLineTypes(connections);
          return {
            selectIds: (fragment.payload.junctions ?? []).flatMap((point) => input.idMap[point.id] ? [input.idMap[point.id]] : []),
            events: [{ type: 'connection.changed', payload: { pasted: true } }],
            patches: [
              ...(fragment.payload.junctions ?? []).filter((point) => input.idMap[point.id]).map((point) => ({
                op: 'set' as const, domain: 'document' as const, namespace: JUNCTION_NAMESPACE, key: input.idMap[point.id],
                value: { ...point, id: input.idMap[point.id], x: point.x + input.offset.x, y: point.y + input.offset.y, revision: 1 }, schemaOwner: 'connections',
              })), ...connections.map((connection) => {
              const id = input.idMap[connection.id] ?? createId('connection');
              const size = normalizeConnectionLabelSize(connection.labelWidth, connection.labelHeight);
              return {
                op: 'set' as const,
                domain: 'document' as const,
                namespace: CONNECTION_NAMESPACE,
                key: id,
                value: {
                  ...connection,
                  ...(connection.titleOrigin?.sourceCenterX !== undefined && connection.titleOrigin.targetCenterX !== undefined
                    ? { titleOrigin: { ...connection.titleOrigin, sourceCenterX: connection.titleOrigin.sourceCenterX + input.offset.x, targetCenterX: connection.titleOrigin.targetCenterX + input.offset.x } } : {}),
                  id,
                  from: { ...connection.from, nodeId: input.idMap[connection.from.nodeId] },
                  to: { ...connection.to, nodeId: input.idMap[connection.to.nodeId] },
                  labelWidth: size.width,
                  labelHeight: size.height,
                  revision: 1,
                  createdAt: Date.now(),
                },
                schemaOwner: 'connections',
              };
            })],
          };
        },
      });

      context.capabilities.provide<undefined, StatisticsContribution>({
        key: 'statistics.contribute@1',
        invoke: () => ({ kind: 'connections', label: '连线', count: Object.keys(readConnections()).length }),
      });

      const invalidateConnections = () => context.signals.emit('connections.invalidated');
      context.signals.subscribe('connection.targets.invalidated', invalidateConnections);
      const invalidateAppearance = () => context.signals.emit('connections.appearance.invalidated');
      context.events.subscribe('connection.created', invalidateConnections);
      context.events.subscribe('connection.changed', invalidateConnections);
      context.events.subscribe('connection.appearance.changed', invalidateAppearance);
      context.events.subscribe('connections.deleted', invalidateConnections);
      context.events.subscribe('nodes.pasted', invalidateConnections);
      context.events.subscribe('history.changed', invalidateConnections);
      context.events.subscribe('history.changed', invalidateAppearance);
      context.events.subscribe('document.replaced', invalidateConnections);
      context.events.subscribe('document.replaced', invalidateAppearance);

      context.ui.contribute({
        id: 'connections.layer',
        slot: 'canvas.connections',
        kind: 'view',
        label: '连线图层',
        component: connectionLayer,
      });
      context.ui.contribute({
        id: 'connections.toolbar-action',
        slot: 'top.primary',
        kind: 'view',
        label: '节点连线工具',
        group: 'appearance',
        component: toolbarAction,
        priority: 10,
      });
      context.ui.shortcut({
        id: 'connections.toggle-selected-shortcut',
        chord: 'l',
        command: 'connection.toggleSelected',
        label: '连接两个节点或断开选中节点的连线',
        category: '节点与连线',
        instruction: '先选节点为输出端，后选节点为带箭头的输入端。',
      });
      context.ui.shortcut({
        id: 'connections.toggle-title-selected-shortcut',
        chord: 'shift+l',
        command: 'connection.toggleTitleSelected',
        label: '标题到标题连接两个文字节点',
        category: '节点与连线',
        instruction: '先选标题为输出端，后选标题为带箭头的输入端。',
      });
      for (const [suffix, command, label] of [
        ['add', 'connection.addJunctionAtPointer', '在鼠标位置添加连接中转点'],
        ['remove', 'connection.removeSelectedJunctions', '删除选中中转点并恢复节点连接'],
      ] as const) {
        context.ui.shortcut({ id: 'connections.' + suffix + '-junction-shortcut', command, label, category: '节点与连线' });
        context.ui.action({ id: 'connections.' + suffix + '-junction-action', command, label, category: '节点与连线', keywords: ['连线', '中转点', '连接点', 'junction', 'route'], priority: 65 });
      }
      context.ui.action({
        id: 'connections.toggle-selected-action',
        label: '连接两个节点或断开选中节点的连线',
        command: 'connection.toggleSelected',
        category: '节点与连线',
        keywords: ['连线', '连接', '断开', 'link', 'connection'],
        priority: 63,
      });
      context.ui.action({
        id: 'connections.toggle-title-selected-action',
        label: '标题到标题连接两个文字节点',
        command: 'connection.toggleTitleSelected',
        category: '节点与连线',
        keywords: ['标题', '标题栏', '连线', '连接', 'title', 'connection'],
        priority: 64,
      });
    },
  };
}

function sameNodePair(connection: ConnectionRecord, input: CreateConnectionPayload): boolean {
  return (
    connection.from.nodeId === input.from.nodeId && connection.to.nodeId === input.to.nodeId
  ) || (
    connection.from.nodeId === input.to.nodeId && connection.to.nodeId === input.from.nodeId
  );
}

function sameNodeIds(connection: ConnectionRecord, fromNodeId: string, toNodeId: string): boolean {
  return (
    connection.from.nodeId === fromNodeId && connection.to.nodeId === toNodeId
  ) || (
    connection.from.nodeId === toNodeId && connection.to.nodeId === fromNodeId
  );
}

function resolveRequestedConnectionEndpoints(
  payload: CreateConnectionPayload,
  fromNode: ConnectionNodeGeometry,
  toNode: ConnectionNodeGeometry,
): { from: ConnectionEndpoint; to: ConnectionEndpoint } {
  if (connectionUsesTextBoxRegions(fromNode, toNode)) {
    const automatic = resolveConnectionEndpoints(fromNode, toNode);
    const title = payload.to.side === 'title';
    return { from: { ...automatic.from, ...(payload.from.kind ? { kind: payload.from.kind } : {}), side: !payload.from.kind && title ? 'title' : automatic.from.side },
      to: { ...automatic.to, side: title ? 'title' : automatic.to.side } };
  }
  if (payload.from.kind || payload.to.kind) {
    return resolveConnectionRecordEndpoints(payload, fromNode, toNode);
  }
  if (payload.from.side === 'title' || payload.to.side === 'title') {
    return {
      from: { nodeId: fromNode.id, side: 'title' },
      to: { nodeId: toNode.id, side: 'title' },
    };
  }
  return resolveConnectionEndpoints(fromNode, toNode);
}

function isConnectionCreatePlanRequest(value: unknown): value is ConnectionCreatePlanRequest {
  return isRecord(value) && typeof value.fromNodeId === 'string' && value.fromNodeId.length > 0 &&
    typeof value.toNodeId === 'string' && value.toNodeId.length > 0;
}

function isEndpoint(value: unknown): value is ConnectionEndpoint {
  return (
    isRecord(value) &&
    typeof value.nodeId === 'string' &&
    (value.kind === undefined || value.kind === 'junction' || value.kind === 'group') &&
    (value.side === 'left' || value.side === 'right' || value.side === 'title')
  );
}

function isCreateConnectionPayload(payload: unknown): payload is CreateConnectionPayload {
  return isRecord(payload) && isEndpoint(payload.from) && isEndpoint(payload.to) &&
    (payload.titleOrigin === undefined || isConnectionTitleOrigin(payload.titleOrigin));
}

function isConnectionSetLabelRequest(payload: unknown): payload is ConnectionSetLabelRequest {
  return isRecord(payload) &&
    typeof payload.id === 'string' && payload.id.length > 0 &&
    typeof payload.label === 'string' && payload.label.length <= MAX_CONNECTION_LABEL_LENGTH &&
    Number.isInteger(payload.expectedRevision) && Number(payload.expectedRevision) > 0;
}

function isConnectionResizeLabelRequest(payload: unknown): payload is ConnectionResizeLabelRequest {
  return isRecord(payload) &&
    typeof payload.id === 'string' && payload.id.length > 0 &&
    Number.isFinite(payload.width) && Number.isFinite(payload.height) &&
    Number.isInteger(payload.expectedRevision) && Number(payload.expectedRevision) > 0;
}

function isConnectionAppearanceRecord(value: unknown): value is { color: string; revision: number } {
  return isRecord(value) &&
    typeof value.color === 'string' && /^#[0-9a-f]{6}$/iu.test(value.color) &&
    Number.isInteger(value.revision) && Number(value.revision) > 0;
}

function isConnectionAppearanceUpdate(value: AppearanceUpdateRequest): boolean {
  return /^#[0-9a-f]{6}$/iu.test(value.color) &&
    value.entities.length === 1 &&
    value.entities[0].id === CONNECTION_APPEARANCE_KEY &&
    Number.isInteger(value.entities[0].revision) && value.entities[0].revision >= 0 &&
    /^#[0-9a-f]{6}$/iu.test(value.entities[0].expectedColor);
}

function isLocalConnectionAppearanceUpdate(value: AppearanceUpdateRequest): boolean {
  return isHexColor(value.color) && value.entities.length > 0 &&
    value.entities.every((entity) => entity.id !== CONNECTION_APPEARANCE_KEY &&
      Number.isInteger(entity.revision) && entity.revision > 0 && isHexColor(entity.expectedColor));
}

async function readCanvasColor(context: PluginContext): Promise<string> {
  try {
    return (await context.capabilities.request<CanvasAppearanceSnapshot>('canvas.appearance@1')).color.toLowerCase();
  } catch {
    return '#efefec';
  }
}

function connectionPartColor(
  connection: ConnectionRecord,
  kind: LocalConnectionAppearanceKind,
  globalLineColor: string,
  canvasColor: string,
): string {
  if (kind === 'connection-label-background') return connection.labelBackgroundColor ?? canvasColor;
  if (kind === 'connection-label-text') {
    return connection.labelTextColor ?? connection.lineColor ?? globalLineColor;
  }
  return connection.lineColor ?? globalLineColor;
}

function connectionPartField(
  kind: LocalConnectionAppearanceKind,
): 'lineColor' | 'labelBackgroundColor' | 'labelTextColor' {
  if (kind === 'connection-label-background') return 'labelBackgroundColor';
  if (kind === 'connection-label-text') return 'labelTextColor';
  return 'lineColor';
}

function connectionPartLabel(kind: LocalConnectionAppearanceKind): string {
  if (kind === 'connection-label-background') return '连接文字框';
  if (kind === 'connection-label-text') return '连接文字';
  return '连接线';
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value);
}

function normalizeConnectionLabel(label: string): string {
  return label.replace(/\r\n?/gu, '\n').trim();
}

function isSerializedConnections(payload: unknown): payload is SerializedConnections {
  return (
    isRecord(payload) &&
    (payload.schemaVersion === undefined || payload.schemaVersion === 2 || payload.schemaVersion === 3 || payload.schemaVersion === 4 || payload.schemaVersion === 5 || payload.schemaVersion === 6) &&
    (payload.junctions === undefined || (Array.isArray(payload.junctions) && payload.junctions.length <= 10_000 && payload.junctions.every(isJunction))) &&
    Array.isArray(payload.connections) &&
    payload.connections.every(
      (connection) =>
        isRecord(connection) &&
        typeof connection.id === 'string' &&
        isEndpoint(connection.from) &&
        isEndpoint(connection.to) &&
        (connection.label === undefined ||
          (typeof connection.label === 'string' && connection.label.length <= MAX_CONNECTION_LABEL_LENGTH)) &&
        (connection.labelWidth === undefined || Number.isFinite(connection.labelWidth)) &&
        (connection.labelHeight === undefined || Number.isFinite(connection.labelHeight)) &&
        (connection.lineColor === undefined || isHexColor(connection.lineColor)) &&
        (connection.labelBackgroundColor === undefined || isHexColor(connection.labelBackgroundColor)) &&
        (connection.labelTextColor === undefined || isHexColor(connection.labelTextColor)) &&
        (connection.junctionTrunk === undefined || typeof connection.junctionTrunk === 'boolean') &&
        (connection.titleRoute === undefined || typeof connection.titleRoute === 'boolean') &&
        (connection.titleOrigin === undefined || isConnectionTitleOrigin(connection.titleOrigin)) &&
        (connection.revision === undefined ||
          (Number.isInteger(connection.revision) && Number(connection.revision) > 0)),
    )
  );
}
