import { createId, isRecord, type PluginContext, type PluginDefinition } from '../../core/contracts.ts';
import type {
  AppearanceReadContribution,
  AppearanceReadRequest,
  AppearanceUpdatePlan,
  AppearanceUpdateRequest,
} from '../../protocols/appearance.ts';
import type {
  AnnotationCreateRequest,
  AnnotationOpenRequest,
  AnnotationOpenState,
  AnnotationRecord,
  AnnotationTarget,
  AnnotationUpdateRequest,
  ContentAnnotationCloneRequest,
  ContentAnchorMoveRequest,
  ContentAnchorTransformPlan,
  ContentAnchorTransformRequest,
} from '../../protocols/annotations.ts';
import {
  MAX_ANNOTATION_BODY_LENGTH,
  MAX_ANNOTATION_CLIPBOARD_BODY,
  MAX_ANNOTATION_CLIPBOARD_ITEMS,
} from '../../protocols/annotations.ts';
import type {
  EntityDeletePlan,
  SelectionCatalogContribution,
  SelectionSnapshot,
} from '../../protocols/selection.ts';
import type { EditorSelectionSnapshot } from '../../protocols/editor.ts';
import type { EditorContextSnapshot } from '../../protocols/editor.ts';
import type { CameraState, CanvasViewportSize } from '../../protocols/canvas.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import { normalizeFloatingRect, type FloatingPanelRect } from '../../protocols/floating.ts';
import { defineManifest } from '../manifest.ts';

export const ANNOTATION_NAMESPACE = 'annotations';
export const ANNOTATION_UI_NAMESPACE = 'annotationUI';
const DEFAULT_RECT: FloatingPanelRect = { x: 420, y: 120, width: 380, height: 280 };

export function createAnnotationsPlugin(
  markerLayer?: unknown,
  popup?: unknown,
  immersivePopup?: unknown,
): PluginDefinition {
  return {
    manifest: defineManifest('annotations', '注释', {
      dataVersion: 2,
      namespaces: [ANNOTATION_NAMESPACE, ANNOTATION_UI_NAMESPACE],
      namespaceDomains: {
        [ANNOTATION_NAMESPACE]: 'document',
        [ANNOTATION_UI_NAMESPACE]: 'workspace',
      },
      requiresCapabilities: ['selection.read@1'],
      optionalCapabilities: [
        'editor.selection@1',
        'editor.context@1',
        'content.summaries@1',
        'content.catalog@2',
        'groups.list@1',
        'canvas.camera@1',
        'canvas.viewport@1',
      ],
      providesCapabilities: [
        'annotations.list@1',
        'annotations.forTarget@1',
        'annotations.state@1',
        'content.anchorTransformPlan@1',
        'content.anchorMovePlan@1',
        'content.annotationClonePlan@1',
        'entity.deletePlan@1',
        'selection.entities@1',
        'appearance.read@1',
        'appearance.updatePlan@1',
      ],
      commands: [
        'annotation.createAtContext',
        'annotation.create',
        'annotation.open',
        'annotation.close',
        'annotation.focus',
        'annotation.update',
        'annotation.delete',
        'annotation.setPanelRect',
      ],
      dispatches: ['annotation.open', 'selection.set'],
      events: [
        'annotation.created',
        'annotation.changed',
        'annotation.deleted',
        'history.changed',
        'document.replaced',
      ],
      signals: [
        'annotations.invalidated',
        'canvas.camera.preview',
        'canvas.drag.preview',
        'canvas.node.resize.preview',
        'content.catalog.invalidated',
        'groups.invalidated',
        'appearance.color.preview',
      ],
      ui: ['annotations.create', 'annotations.markers', 'annotations.popup', 'annotations.immersive-popup'],
      actions: ['annotations.create-action'],
      shortcuts: ['annotations.create-shortcut'],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.top.contribute',
        'ui.canvas.contribute',
        'ui.overlay.contribute',
        'ui.modal.contribute',
        'ui.action.register',
        'ui.shortcut.register',
      ],
    }),

    migrations: [{
      from: 1,
      to: 2,
      migrate: (data) => data,
    }],

    start(context) {
      const readRecords = () => context.store.readNamespace<Record<string, AnnotationRecord>>(ANNOTATION_NAMESPACE);
      const readOpenState = (): AnnotationOpenState | undefined => {
        const id = context.store.readValue<string>(ANNOTATION_UI_NAMESPACE, 'openId');
        if (!id || !readRecords()[id]) return undefined;
        return {
          id,
          surface: context.store.readValue<'floating' | 'immersive'>(ANNOTATION_UI_NAMESPACE, 'surface') ?? 'floating',
          rect: normalizeFloatingRect(
            context.store.readValue<FloatingPanelRect>(ANNOTATION_UI_NAMESPACE, 'rect'),
            DEFAULT_RECT,
          ),
        };
      };
      const create = (payload: AnnotationCreateRequest) => {
        const now = Date.now();
        const record: AnnotationRecord = {
          id: createId('annotation'),
          target: normalizeTarget(payload.target),
          body: (payload.body ?? '').slice(0, MAX_ANNOTATION_BODY_LENGTH),
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        return {
          result: { id: record.id },
          transaction: {
            label: '添加注释',
            patches: [{
              op: 'set' as const,
              domain: 'document' as const,
              namespace: ANNOTATION_NAMESPACE,
              key: record.id,
              value: record,
            }],
            events: [{ type: 'annotation.created', payload: { id: record.id, anchor: payload.anchor } }],
          },
        };
      };

      context.commands.register<AnnotationCreateRequest, { id: string }>({
        type: 'annotation.create',
        validate: isAnnotationCreateRequest,
        handle: create,
      });
      context.commands.register<undefined, { id: string }>({
        type: 'annotation.createAtContext',
        handle: async () => {
          const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
          let editorSelection: EditorSelectionSnapshot | undefined;
          try {
            editorSelection = await context.capabilities.request<EditorSelectionSnapshot | undefined>('editor.selection@1');
          } catch {
            // The editor is optional; canvas selection remains available.
          }
          if (editorSelection?.focused) {
            return create({
              target: { kind: 'text-range', targetId: editorSelection.id, offset: editorSelection.end },
              anchor: editorSelection.screenAnchor,
            });
          }
          const item = selection.items.find((candidate) => candidate.kind === 'text-node' || candidate.kind === 'group');
          if (!item) throw new Error('请先选中文字节点、群组，或把光标放进文本编辑区');
          return create({
            target: { kind: item.kind as 'text-node' | 'group', targetId: item.id },
            anchor: await resolveCanvasTargetAnchor(context, item.kind as 'text-node' | 'group', item.id),
          });
        },
      });
      context.commands.register<AnnotationOpenRequest>({
        type: 'annotation.open',
        validate: isAnnotationOpenRequest,
        handle: async (payload) => {
          const record = readRecords()[payload.id];
          if (!record) throw new Error('注释已经不存在');
          let editorContext: EditorContextSnapshot | undefined;
          try {
            editorContext = await context.capabilities.request<EditorContextSnapshot>('editor.context@1');
          } catch {
            // The editor is optional; ordinary canvas annotations stay floating.
          }
          const surface = editorContext?.immersivePane ? 'immersive' : 'floating';
          if (surface === 'immersive') {
            context.ui.deactivateSurface('overlay.floating', 'annotations.popup');
            context.ui.activateSurface('editor.immersive.overlay', 'annotations.immersive-popup', 'annotation.close');
          } else {
            context.ui.deactivateSurface('editor.immersive.overlay', 'annotations.immersive-popup');
            context.ui.activateSurface('overlay.floating', 'annotations.popup', 'annotation.close');
          }
          const previous = readOpenState()?.rect ?? DEFAULT_RECT;
          const rect = payload.anchor
            ? normalizeFloatingRect({
                ...previous,
                x: payload.anchor.x + 12,
                y: payload.anchor.y + 12,
              }, DEFAULT_RECT)
            : previous;
          return {
            transaction: {
              label: '打开注释',
              history: false,
              patches: [
                workspaceSet('openId', payload.id),
                workspaceSet('rect', rect),
                workspaceSet('surface', surface),
              ],
            },
          };
        },
      });
      context.commands.register({
        type: 'annotation.close',
        handle: () => {
          context.ui.deactivateSurface('overlay.floating', 'annotations.popup');
          context.ui.deactivateSurface('editor.immersive.overlay', 'annotations.immersive-popup');
          return {
            transaction: {
              label: '关闭注释',
              history: false,
              patches: [workspaceDelete('openId'), workspaceDelete('surface')],
            },
          };
        },
      });
      context.commands.register({
        type: 'annotation.focus',
        handle: () => {
          const open = readOpenState();
          if (!open) return { result: false };
          context.ui.activateSurface(
            open.surface === 'immersive' ? 'editor.immersive.overlay' : 'overlay.floating',
            open.surface === 'immersive' ? 'annotations.immersive-popup' : 'annotations.popup',
            'annotation.close',
          );
          return { result: true };
        },
      });
      context.commands.register({
        type: 'annotation.update',
        validate: isAnnotationUpdateRequest,
        handle: (payload) => {
          const current = readRecords()[payload.id];
          if (!current) throw new Error('注释已经不存在');
          if (current.revision !== payload.expectedRevision) throw new Error('注释内容已变化，请重新打开');
          const body = payload.body.slice(0, MAX_ANNOTATION_BODY_LENGTH);
          if (body === current.body) return { result: { revision: current.revision } };
          const next = { ...current, body, revision: current.revision + 1, updatedAt: Date.now() };
          return {
            result: { revision: next.revision },
            transaction: {
              label: '编辑注释',
              mergeKey: `annotation:${current.id}`,
              mergeWindowMs: 1_400,
              patches: [{
                op: 'set', domain: 'document', namespace: ANNOTATION_NAMESPACE, key: current.id, value: next,
              }],
              events: [{ type: 'annotation.changed', payload: { id: current.id } }],
            },
          };
        },
      });
      context.commands.register<{ id: string }>({
        type: 'annotation.delete',
        validate: isAnnotationIdPayload,
        handle: (payload) => {
          if (!readRecords()[payload.id]) return { result: { deleted: false } };
          return {
            result: { deleted: true },
            transaction: {
              label: '删除注释',
              patches: [{ op: 'delete', domain: 'document', namespace: ANNOTATION_NAMESPACE, key: payload.id }],
              events: [{ type: 'annotation.deleted', payload: { id: payload.id } }],
            },
          };
        },
      });
      context.commands.register<FloatingPanelRect>({
        type: 'annotation.setPanelRect',
        validate: isFloatingRect,
        handle: (payload) => ({
          transaction: {
            label: '调整注释窗口',
            history: false,
            patches: [workspaceSet('rect', normalizeFloatingRect(payload, DEFAULT_RECT))],
          },
        }),
      });

      context.capabilities.provide<undefined, AnnotationRecord[]>({
        key: 'annotations.list@1',
        invoke: () => Object.values(readRecords()).sort((left, right) => left.createdAt - right.createdAt),
      });
      context.capabilities.provide<{ targetId: string }, AnnotationRecord[]>({
        key: 'annotations.forTarget@1',
        invoke: (payload) => Object.values(readRecords())
          .filter((record) => record.target.targetId === payload?.targetId)
          .sort((left, right) => left.createdAt - right.createdAt),
      });
      context.capabilities.provide<undefined, { open?: AnnotationOpenState; records: AnnotationRecord[] }>({
        key: 'annotations.state@1',
        invoke: () => ({
          open: readOpenState(),
          records: Object.values(readRecords()).sort((left, right) => left.createdAt - right.createdAt),
        }),
      });
      context.capabilities.provide<ContentAnchorTransformRequest, ContentAnchorTransformPlan>({
        key: 'content.anchorTransformPlan@1',
        invoke: (payload) => {
          if (!isAnchorTransformRequest(payload)) throw new Error('注释锚点变更请求不正确');
          const end = payload.start + payload.deleteCount;
          const delta = payload.insertLength - payload.deleteCount;
          const changed: AnnotationRecord[] = [];
          const deleted: AnnotationRecord[] = [];
          for (const record of Object.values(readRecords())) {
            if (record.target.kind !== 'text-range' || record.target.targetId !== payload.nodeId) continue;
            if (payload.deleteCount > 0 && record.target.offset > payload.start && record.target.offset <= end) {
              deleted.push(record);
              continue;
            }
            const offset = record.target.offset <= payload.start
              ? record.target.offset
              : record.target.offset + delta;
            if (offset === record.target.offset) continue;
            changed.push({
              ...record,
              target: { ...record.target, offset: Math.max(0, offset) },
              revision: record.revision + 1,
              updatedAt: Date.now(),
            });
          }
          return {
            patches: [
              ...changed.map((record) => ({
                op: 'set' as const, domain: 'document' as const, namespace: ANNOTATION_NAMESPACE, key: record.id,
                value: record, schemaOwner: 'annotations',
              })),
              ...deleted.map((record) => ({
                op: 'delete' as const, domain: 'document' as const, namespace: ANNOTATION_NAMESPACE,
                key: record.id, schemaOwner: 'annotations',
              })),
            ],
            events: [
              ...(changed.length > 0
                ? [{ type: 'annotation.changed', payload: { ids: changed.map((item) => item.id) } }]
                : []),
              ...(deleted.length > 0
                ? [{ type: 'annotation.deleted', payload: { ids: deleted.map((item) => item.id) } }]
                : []),
            ],
          };
        },
      });
      context.capabilities.provide<ContentAnchorMoveRequest, ContentAnchorTransformPlan>({
        key: 'content.anchorMovePlan@1',
        invoke: (payload) => {
          if (!isAnchorMoveRequest(payload)) throw new Error('注释锚点移动请求不正确');
          const changed = Object.values(readRecords()).flatMap((record) => {
            if (record.target.kind !== 'text-range' || record.target.targetId !== payload.nodeId) return [];
            const offset = moveAnchorOffset(record.target.offset, payload.start, payload.end, payload.target);
            if (offset === record.target.offset) return [];
            return [{
              ...record,
              target: { ...record.target, offset: Math.max(0, offset) },
              revision: record.revision + 1,
              updatedAt: Date.now(),
            } satisfies AnnotationRecord];
          });
          return {
            patches: changed.map((record) => ({
              op: 'set', domain: 'document', namespace: ANNOTATION_NAMESPACE, key: record.id,
              value: record, schemaOwner: 'annotations',
            })),
            events: changed.length > 0
              ? [{ type: 'annotation.changed', payload: { ids: changed.map((item) => item.id) } }]
              : [],
          };
        },
      });
      context.capabilities.provide<ContentAnnotationCloneRequest, ContentAnchorTransformPlan>({
        key: 'content.annotationClonePlan@1',
        invoke: (payload) => {
          if (!isAnnotationCloneRequest(payload)) throw new Error('注释复制请求不正确');
          const now = Date.now();
          const records = payload.items.map((item) => ({
            id: createId('annotation'),
            target: {
              kind: 'text-range' as const,
              targetId: payload.nodeId,
              offset: payload.insertionStart + item.relativeOffset,
            },
            body: item.body,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          } satisfies AnnotationRecord));
          return {
            patches: records.map((record) => ({
              op: 'set', domain: 'document', namespace: ANNOTATION_NAMESPACE, key: record.id,
              value: record, schemaOwner: 'annotations',
            })),
            events: records.length > 0
              ? [{ type: 'annotation.changed', payload: { ids: records.map((record) => record.id) } }]
              : [],
          };
        },
      });
      context.capabilities.provide<undefined, SelectionCatalogContribution>({
        key: 'selection.entities@1',
        invoke: () => ({
          owner: 'annotations',
          entities: Object.values(readRecords()).map((record) => ({
            id: record.id,
            kind: 'annotation',
            includeInSelectAll: false,
          })),
        }),
      });
      context.capabilities.provide<AppearanceReadRequest, AppearanceReadContribution>({
        key: 'appearance.read@1',
        invoke: (input) => {
          if (input?.mode !== 'selection') return { targets: [] };
          const selectedIds = new Set(input.selectedItems
            ?.filter((item) => item.kind === 'annotation')
            .map((item) => item.id) ?? input.selectedIds ?? []);
          const records = Object.values(readRecords()).filter((record) => selectedIds.has(record.id));
          if (records.length === 0) return { targets: [] };
          const fallback = input.defaults?.['annotation-marker'] ?? '#ff9f0a';
          const colors = records.map((record) => record.color ?? fallback);
          const open = readOpenState();
          return {
            targets: [{
              kind: 'annotation-marker',
              label: '注释标记',
              scopeLabel: `${records.length} 个选中注释`,
              color: colors[0],
              mixed: new Set(colors).size > 1,
              entities: records.map((record, index) => ({
                id: record.id,
                revision: record.revision,
                expectedColor: colors[index],
              })),
              anchor: open && selectedIds.has(open.id) ? open.rect : undefined,
            }],
          };
        },
      });
      context.capabilities.provide<AppearanceUpdateRequest, AppearanceUpdatePlan>({
        key: 'appearance.updatePlan@1',
        invoke: (input) => {
          if (input.kind !== 'annotation-marker') return { patches: [], changed: 0 };
          if (!isAppearanceUpdate(input)) throw new Error('注释颜色请求不正确');
          const records = readRecords();
          const changed = input.entities.flatMap((reference) => {
            const record = records[reference.id];
            if (!record || record.revision !== reference.revision ||
              (record.color ?? reference.expectedColor.toLowerCase()) !== reference.expectedColor.toLowerCase()) {
              throw new Error('注释颜色已经变化，请重新打开调色盘');
            }
            if (record.color === input.color.toLowerCase()) return [];
            return [{
              ...record,
              color: input.color.toLowerCase(),
              revision: record.revision + 1,
              updatedAt: Date.now(),
            } satisfies AnnotationRecord];
          });
          return {
            changed: changed.length,
            patches: changed.map((record) => ({
              op: 'set' as const,
              domain: 'document' as const,
              namespace: ANNOTATION_NAMESPACE,
              key: record.id,
              value: record,
              schemaOwner: 'annotations',
            })),
            events: changed.length > 0
              ? [{ type: 'annotation.changed', payload: { ids: changed.map((record) => record.id) } }]
              : [],
          };
        },
      });
      context.capabilities.provide<{ ids: string[] }, EntityDeletePlan>({
        key: 'entity.deletePlan@1',
        invoke: (payload) => {
          const ids = new Set(Array.isArray(payload?.ids) ? payload.ids : []);
          const deleted = Object.values(readRecords()).filter((record) =>
            ids.has(record.id) || ids.has(record.target.targetId));
          return {
            patches: deleted.map((record) => ({
              op: 'delete', domain: 'document', namespace: ANNOTATION_NAMESPACE, key: record.id,
              schemaOwner: 'annotations',
            })),
            events: deleted.length > 0 ? [{ type: 'annotation.deleted', payload: { ids: deleted.map((item) => item.id) } }] : [],
          };
        },
      });

      const invalidate = () => context.signals.emit('annotations.invalidated');
      context.events.subscribe<{ id: string; anchor?: { x: number; y: number } }>('annotation.created', (message) => {
        invalidate();
        void context.commands.dispatch('annotation.open', message.payload);
      });
      context.events.subscribe('annotation.changed', invalidate);
      context.events.subscribe('annotation.deleted', () => {
        invalidate();
        const open = readOpenState();
        if (!open) void context.commands.dispatch('annotation.close').catch(() => undefined);
      });
      context.events.subscribe('history.changed', invalidate);
      context.events.subscribe('document.replaced', invalidate);

      context.ui.contribute({
        id: 'annotations.create',
        slot: 'top.primary',
        kind: 'button',
        label: '添加注释',
        icon: 'comment',
        preserveEditableFocus: true,
        group: 'create',
        command: 'annotation.createAtContext',
        priority: 11,
      });
      context.ui.contribute({
        id: 'annotations.markers',
        slot: 'canvas.selection',
        kind: 'view',
        label: '画布注释标记',
        component: markerLayer,
      });
      context.ui.contribute({
        id: 'annotations.popup',
        slot: 'overlay.floating',
        kind: 'view',
        label: '注释窗口',
        component: popup,
      });
      context.ui.contribute({
        id: 'annotations.immersive-popup',
        slot: 'editor.immersive.overlay',
        kind: 'view',
        label: '沉浸写作注释窗口',
        component: immersivePopup,
        priority: 90,
      });
      context.ui.action({
        id: 'annotations.create-action',
        label: '在当前位置添加注释',
        command: 'annotation.createAtContext',
        category: '文本编辑',
        keywords: ['注释', '批注', '备注', '气泡'],
        priority: 39,
      });
      context.ui.shortcut({
        id: 'annotations.create-shortcut',
        chord: 'mod+alt+c',
        command: 'annotation.createAtContext',
        label: '在当前位置添加注释',
        category: '文本编辑',
        allowInEditable: true,
      });
      const open = readOpenState();
      if (open) {
        context.ui.activateSurface(
          open.surface === 'immersive' ? 'editor.immersive.overlay' : 'overlay.floating',
          open.surface === 'immersive' ? 'annotations.immersive-popup' : 'annotations.popup',
          'annotation.close',
        );
      }
    },
  };
}

function workspaceSet(key: string, value: unknown) {
  return { op: 'set' as const, domain: 'workspace' as const, namespace: ANNOTATION_UI_NAMESPACE, key, value };
}

function workspaceDelete(key: string) {
  return { op: 'delete' as const, domain: 'workspace' as const, namespace: ANNOTATION_UI_NAMESPACE, key };
}

async function resolveCanvasTargetAnchor(
  context: PluginContext,
  kind: 'text-node' | 'group',
  targetId: string,
): Promise<{ x: number; y: number } | undefined> {
  try {
    const [camera, viewport, nodes] = await Promise.all([
      context.capabilities.request<CameraState>('canvas.camera@1'),
      context.capabilities.request<CanvasViewportSize>('canvas.viewport@1'),
      context.capabilities.request<ContentSummary[]>('content.summaries@1'),
    ]);
    let worldPoint: { x: number; y: number } | undefined;
    if (kind === 'text-node') {
      const node = nodes.find((candidate) => candidate.id === targetId);
      if (node) worldPoint = { x: node.x + 16, y: node.y + 21 };
    } else {
      const groups = await context.capabilities.request<GroupRecord[]>('groups.list@1');
      const group = groups.find((candidate) => candidate.id === targetId);
      const members = group?.memberIds
        .map((id) => nodes.find((candidate) => candidate.id === id))
        .filter(Boolean) as ContentSummary[] | undefined;
      if (members?.length) {
        const top = Math.min(...members.map((node) => node.y));
        const right = Math.max(...members.map((node) => node.x + node.width));
        worldPoint = { x: right + 18, y: top - 32 };
      }
    }
    if (!worldPoint) return undefined;
    return {
      x: (viewport.left ?? 0) + camera.x + worldPoint.x * camera.zoom,
      y: (viewport.top ?? 0) + camera.y + worldPoint.y * camera.zoom,
    };
  } catch {
    return undefined;
  }
}

function normalizeTarget(target: AnnotationTarget): AnnotationTarget {
  if (target.kind === 'text-range') return { ...target, offset: Math.max(0, Math.trunc(target.offset)) };
  return { ...target };
}

function isAnnotationTarget(value: unknown): value is AnnotationTarget {
  return isRecord(value) && typeof value.targetId === 'string' && (
    value.kind === 'text-node' || value.kind === 'group' ||
    value.kind === 'text-range' && Number.isFinite(value.offset)
  );
}

function isAnnotationCreateRequest(value: unknown): value is AnnotationCreateRequest {
  return isRecord(value) && isAnnotationTarget(value.target) &&
    (value.body === undefined || typeof value.body === 'string');
}

function isAnnotationOpenRequest(value: unknown): value is AnnotationOpenRequest {
  return isRecord(value) && typeof value.id === 'string' &&
    (value.anchor === undefined || isRecord(value.anchor) &&
      Number.isFinite(value.anchor.x) && Number.isFinite(value.anchor.y));
}

function isAnnotationUpdateRequest(value: unknown): value is AnnotationUpdateRequest {
  return isRecord(value) && typeof value.id === 'string' && typeof value.body === 'string' &&
    Number.isInteger(value.expectedRevision);
}

function isAppearanceUpdate(value: AppearanceUpdateRequest): boolean {
  return isHexColor(value.color) && value.entities.length > 0 && value.entities.every((entity) =>
    typeof entity.id === 'string' && Number.isInteger(entity.revision) && entity.revision > 0 &&
    isHexColor(entity.expectedColor));
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value);
}

function isAnnotationIdPayload(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === 'string';
}

function isAnchorTransformRequest(value: unknown): value is ContentAnchorTransformRequest {
  return isRecord(value) && typeof value.nodeId === 'string' &&
    Number.isInteger(value.start) && Number.isInteger(value.deleteCount) && Number.isInteger(value.insertLength);
}

function isAnchorMoveRequest(value: unknown): value is ContentAnchorMoveRequest {
  return isRecord(value) && typeof value.nodeId === 'string' &&
    Number.isInteger(value.start) && Number.isInteger(value.end) && Number.isInteger(value.target) &&
    (value.end as number) > (value.start as number);
}

function isAnnotationCloneRequest(value: unknown): value is ContentAnnotationCloneRequest {
  if (!isRecord(value) || typeof value.nodeId !== 'string' ||
    !Number.isInteger(value.insertionStart) || !Number.isInteger(value.insertionLength) ||
    (value.insertionStart as number) < 0 || (value.insertionLength as number) < 0 ||
    !Array.isArray(value.items) || value.items.length > MAX_ANNOTATION_CLIPBOARD_ITEMS) return false;
  let bodyLength = 0;
  for (const item of value.items) {
    if (!isRecord(item) || !Number.isInteger(item.relativeOffset) ||
      (item.relativeOffset as number) < 0 || (item.relativeOffset as number) > (value.insertionLength as number) ||
      typeof item.body !== 'string' || item.body.length > MAX_ANNOTATION_BODY_LENGTH) return false;
    bodyLength += item.body.length;
    if (bodyLength > MAX_ANNOTATION_CLIPBOARD_BODY) return false;
  }
  return true;
}

function moveAnchorOffset(offset: number, start: number, end: number, target: number): number {
  const length = end - start;
  if (target < start) {
    if (offset > start && offset <= end) return target + offset - start;
    if (offset > target && offset <= start) return offset + length;
    return offset;
  }
  const destination = target - length;
  if (offset > start && offset <= end) return destination + offset - start;
  if (offset > end && offset <= target) return offset - length;
  return offset;
}

function isFloatingRect(value: unknown): value is FloatingPanelRect {
  return isRecord(value) && [value.x, value.y, value.width, value.height].every(Number.isFinite);
}
