import { createId, isRecord, type PluginDefinition } from '../../core/contracts.ts';
import type {
  AppearanceReadContribution,
  AppearanceReadRequest,
  AppearanceUpdatePlan,
  AppearanceUpdateRequest,
} from '../../protocols/appearance.ts';
import type { CanvasAppearanceSnapshot } from '../../protocols/canvas.ts';
import type {
  ClipboardFragment,
  ClipboardInstantiateInput,
  ClipboardInstantiatePlan,
} from '../../protocols/clipboard.ts';
import {
  connectionEndpointPoint,
  DEFAULT_CONNECTION_LABEL_HEIGHT,
  DEFAULT_CONNECTION_LABEL_WIDTH,
  resolveConnectionEndpoints,
  resolveConnectionRecordEndpoints,
  MAX_CONNECTION_LABEL_LENGTH,
  normalizeConnectionLabelSize,
  type ConnectionCreatePlanRequest,
  type ConnectionAppearanceSnapshot,
  type ConnectionEndpoint,
  type ConnectionMutationPlan,
  type ConnectionRecord,
  type ConnectionResizeLabelRequest,
  type ConnectionSetLabelRequest,
} from '../../protocols/connections.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { EntityDeletePlan, SelectionCatalogContribution, SelectionSnapshot } from '../../protocols/selection.ts';
import type { StatisticsContribution } from '../../protocols/statistics.ts';
import { defineManifest } from '../manifest.ts';
import { canvasContrastColors } from '../../ui/canvas-contrast.ts';
import { connectionCurveBounds } from './rendering.ts';

const CONNECTION_NAMESPACE = 'connections';
const CONNECTION_APPEARANCE_NAMESPACE = 'connectionAppearance';
const CONNECTION_APPEARANCE_KEY = 'line';
const FALLBACK_CONNECTION_LINE_COLOR = '#888886';

interface CreateConnectionPayload {
  from: ConnectionEndpoint;
  to: ConnectionEndpoint;
}

interface SerializedConnections {
  connections: ConnectionRecord[];
}

export function createConnectionsPlugin(connectionLayer?: unknown, toolbarAction?: unknown): PluginDefinition {
  return {
    manifest: defineManifest('connections', '连线', {
      dataVersion: 5,
      namespaces: [CONNECTION_NAMESPACE, CONNECTION_APPEARANCE_NAMESPACE],
      namespaceDomains: {
        [CONNECTION_NAMESPACE]: 'document',
        [CONNECTION_APPEARANCE_NAMESPACE]: 'document',
      },
      requiresCapabilities: [
        'content.summaries@1',
        'content.summariesById@1',
        'content.catalog@2',
        'selection.read@1',
      ],
      optionalCapabilities: ['canvas.camera@1', 'canvas.appearance@1'],
      providesCapabilities: [
        'connections.list@1',
        'connections.available@1',
        'connections.createPlan@1',
        'connections.appearance@1',
        'appearance.read@1',
        'appearance.updatePlan@1',
        'entity.deletePlan@1',
        'clipboard.serialize@1',
        'clipboard.instantiate@1',
        'statistics.contribute@1',
        'selection.entities@1',
      ],
      commands: [
        'connection.create',
        'connection.setLabel',
        'connection.resizeLabel',
        'connection.toggleSelected',
      ],
      dispatches: ['selection.set', 'interaction.begin', 'interaction.end'],
      events: [
        'connection.created',
        'connection.changed',
        'connection.appearance.changed',
        'connections.deleted',
        'nodes.pasted',
        'history.changed',
        'document.replaced',
      ],
      signals: [
        'canvas.camera.preview',
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
      ],
      ui: ['connections.layer', 'connections.toolbar-action'],
      actions: ['connections.toggle-selected-action'],
      shortcuts: ['connections.toggle-selected-shortcut'],
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
    }],

    start(context) {
      const readConnections = () =>
        context.store.readNamespace<Record<string, ConnectionRecord>>(CONNECTION_NAMESPACE);
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

      context.commands.register<CreateConnectionPayload, { id?: string }>({
        type: 'connection.create',
        validate: isCreateConnectionPayload,
        handle: async (payload) => {
          if (payload.from.nodeId === payload.to.nodeId) throw new Error('不能把节点连接到自己');
          const nodes = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
          const known = new Map(nodes.map((node) => [node.id, node]));
          const fromNode = known.get(payload.from.nodeId);
          const toNode = known.get(payload.to.nodeId);
          if (!fromNode || !toNode) {
            throw new Error('连接端点不存在');
          }
          const connections = Object.values(readConnections());
          const duplicate = connections.find((connection) => sameNodePair(connection, payload));
          if (duplicate) return { result: { id: duplicate.id } };
          const id = createId('connection');
          const endpoints = resolveRequestedConnectionEndpoints(payload, fromNode, toNode);
          const connection: ConnectionRecord = {
            id,
            ...endpoints,
            labelWidth: DEFAULT_CONNECTION_LABEL_WIDTH,
            labelHeight: DEFAULT_CONNECTION_LABEL_HEIGHT,
            revision: 1,
            createdAt: Date.now(),
          };
          return {
            result: { id },
            transaction: {
              label: '创建连线',
              patches: [
                {
                  op: 'set',
                  domain: 'document',
                  namespace: CONNECTION_NAMESPACE,
                  key: id,
                  value: connection,
                },
              ],
              events: [{ type: 'connection.created', payload: { id } }],
            },
          };
        },
      });

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
          const known = new Map(nodes.map((node) => [node.id, node]));
          const selected = [...new Set(selection.ids)]
            .map((id) => known.get(id))
            .filter(Boolean) as ContentSummary[];
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
          const existing = Object.values(readConnections()).filter((connection) =>
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

          const ordered = [...selected].sort((left, right) => {
            const horizontal = (left.x + left.width / 2) - (right.x + right.width / 2);
            if (horizontal !== 0) return horizontal;
            const vertical = (left.y + left.height / 2) - (right.y + right.height / 2);
            return vertical || left.id.localeCompare(right.id);
          });
          const id = createId('connection');
          const endpoints = resolveConnectionEndpoints(ordered[0], ordered[1]);
          const connection: ConnectionRecord = {
            id,
            ...endpoints,
            labelWidth: DEFAULT_CONNECTION_LABEL_WIDTH,
            labelHeight: DEFAULT_CONNECTION_LABEL_HEIGHT,
            revision: 1,
            createdAt: Date.now(),
          };
          return {
            result: { id },
            transaction: {
              label: '连接选中节点',
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
          const nodeMap = new Map(nodes.map((node) => [node.id, node]));
          return Object.values(readConnections()).map((connection) => {
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
        invoke: async () => {
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
          if (input.kind !== 'connection-line') return { patches: [], changed: 0 };
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
      context.capabilities.provide<ConnectionCreatePlanRequest, ConnectionMutationPlan>({
        key: 'connections.createPlan@1',
        invoke: (input) => {
          if (!isConnectionCreatePlanRequest(input)) throw new Error('connections.createPlan request is invalid');
          if (input.fromNodeId === input.toNodeId) throw new Error('不能把节点连接到自己');
          const duplicate = Object.values(readConnections()).find((connection) => sameNodeIds(
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
          const nodeMap = new Map(nodes.map((node) => [node.id, node]));
          return {
            owner: 'connections',
            entities: Object.values(readConnections()).flatMap((connection) => {
              const fromNode = nodeMap.get(connection.from.nodeId);
              const toNode = nodeMap.get(connection.to.nodeId);
              if (!fromNode || !toNode) return [];
              const endpoints = resolveConnectionRecordEndpoints(connection, fromNode, toNode);
              const from = connectionEndpointPoint(endpoints.from, fromNode);
              const to = connectionEndpointPoint(endpoints.to, toNode);
              const bounds = connectionCurveBounds(from, to, 10);
              return [{
                id: connection.id,
                kind: 'connection',
                includeInSelectAll: false,
                bounds,
              }];
            }),
          };
        },
      });
      context.capabilities.provide<{ ids: string[] }, EntityDeletePlan>({
        key: 'entity.deletePlan@1',
        invoke: (input) => {
          const selected = new Set(Array.isArray(input?.ids) ? input.ids : []);
          const removed = Object.values(readConnections()).filter(
            (connection) => selected.has(connection.id) || selected.has(connection.from.nodeId) ||
              selected.has(connection.to.nodeId),
          );
          return {
            patches: removed.map((connection) => ({
              op: 'delete' as const,
              domain: 'document' as const,
              namespace: CONNECTION_NAMESPACE,
              key: connection.id,
              schemaOwner: 'connections',
            })),
            events: removed.length > 0
              ? [{ type: 'connections.deleted', payload: { ids: removed.map((item) => item.id) } }]
              : [],
          };
        },
      });

      context.capabilities.provide<{ ids: string[] }, ClipboardFragment>({
        key: 'clipboard.serialize@1',
        invoke: (input) => {
          const selected = new Set(Array.isArray(input?.ids) ? input.ids : []);
          const connections = Object.values(readConnections()).filter(
            (connection) => selected.has(connection.from.nodeId) && selected.has(connection.to.nodeId),
          );
          return {
            owner: 'connections',
            version: 1,
            entityIds: connections.map((connection) => connection.id),
            payload: { connections } satisfies SerializedConnections,
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
          return {
            patches: connections.map((connection) => {
              const id = input.idMap[connection.id] ?? createId('connection');
              const size = normalizeConnectionLabelSize(connection.labelWidth, connection.labelHeight);
              return {
                op: 'set' as const,
                domain: 'document' as const,
                namespace: CONNECTION_NAMESPACE,
                key: id,
                value: {
                  ...connection,
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
            }),
          };
        },
      });

      context.capabilities.provide<undefined, StatisticsContribution>({
        key: 'statistics.contribute@1',
        invoke: () => ({ kind: 'connections', label: '连线', count: Object.keys(readConnections()).length }),
      });

      const invalidateConnections = () => context.signals.emit('connections.invalidated');
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
        group: 'tools',
        component: toolbarAction,
        priority: 20,
      });
      context.ui.shortcut({
        id: 'connections.toggle-selected-shortcut',
        chord: 'l',
        command: 'connection.toggleSelected',
        label: '连接两个节点或断开选中节点的连线',
      });
      context.ui.action({
        id: 'connections.toggle-selected-action',
        label: '连接两个节点或断开选中节点的连线',
        command: 'connection.toggleSelected',
        category: '画布',
        keywords: ['连线', '连接', '断开', 'link', 'connection'],
        priority: 63,
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
  fromNode: ContentSummary,
  toNode: ContentSummary,
): { from: ConnectionEndpoint; to: ConnectionEndpoint } {
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
    (value.side === 'left' || value.side === 'right' || value.side === 'title')
  );
}

function isCreateConnectionPayload(payload: unknown): payload is CreateConnectionPayload {
  return isRecord(payload) && isEndpoint(payload.from) && isEndpoint(payload.to);
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

function normalizeConnectionLabel(label: string): string {
  return label.replace(/\r\n?/gu, '\n').trim();
}

function isSerializedConnections(payload: unknown): payload is SerializedConnections {
  return (
    isRecord(payload) &&
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
        (connection.revision === undefined ||
          (Number.isInteger(connection.revision) && Number(connection.revision) > 0)),
    )
  );
}
