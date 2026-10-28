import { isRecord, type PluginDefinition } from '../../core/contracts.ts';
import type {
  AppearanceColorContribution,
  AppearanceReadContribution,
  AppearanceReadRequest,
  AppearanceUpdatePlan,
  AppearanceUpdateRequest,
} from '../../protocols/appearance.ts';
import type {
  CameraState,
  CanvasPointerSnapshot,
  CanvasToolMode,
  CanvasViewportCenter,
  CanvasViewportSize,
  CanvasZoomRequest,
  FocusRequest,
} from '../../protocols/canvas.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { SelectionCatalogContribution, SelectionSnapshot } from '../../protocols/selection.ts';
import { viewportCenterInWorld } from '../../protocols/viewport.ts';
import { defineManifest } from '../manifest.ts';
import { CanvasSurface } from './CanvasSurface.tsx';
import { CanvasToolbarStatus } from './CanvasToolbarStatus.tsx';
import { CanvasToolActions } from './CanvasToolActions.tsx';
import { clampCanvasZoom, MAX_ZOOM, MIN_ZOOM } from './surface-geometry.ts';

const VIEW_NAMESPACE = 'canvasView';
const APPEARANCE_NAMESPACE = 'canvasAppearance';
const DEFAULT_CANVAS_COLOR = '#efefec';

interface CanvasAppearanceRecord {
  color: string;
  revision: number;
}

export const canvasPlugin: PluginDefinition = {
  manifest: defineManifest('canvas', 'Echo-8 画布', {
    namespaces: [VIEW_NAMESPACE, APPEARANCE_NAMESPACE],
    namespaceDomains: { [VIEW_NAMESPACE]: 'workspace', [APPEARANCE_NAMESPACE]: 'document' },
    requiresCapabilities: ['content.summaries@1', 'content.catalog@2', 'content.metrics@2'],
    optionalCapabilities: [
      'selection.read@1',
      'selection.resolve@1',
      'selection.entities@1',
      'connections.available@1',
      'group.dropTarget@1',
      'layout.snap@1',
      'layout.resizeSnap@1',
    ],
    providesCapabilities: [
      'canvas.camera@1',
      'canvas.viewportCenter@1',
      'canvas.viewport@1',
      'canvas.pointer@1',
      'canvas.tool@1',
      'canvas.appearance@1',
      'appearance.read@1',
      'appearance.updatePlan@1',
      'appearance.colors@1',
      'appearance.resetPlan@1',
    ],
    commands: [
      'canvas.camera.commit',
      'canvas.tool.set',
      'canvas.tool.select',
      'canvas.tool.hand',
      'canvas.focusSelection',
      'canvas.focusEntity',
      'canvas.zoomIn',
      'canvas.zoomOut',
      'canvas.resetZoom',
    ],
    dispatches: [
      'node.moveMany',
      'node.create',
      'node.resize',
      'selection.set',
      'selection.clear',
      'selection.box',
      'connection.create',
      'file.importDocuments',
      'file.openProject',
      'interaction.begin',
      'interaction.end',
      'group.membership.drop',
      'clipboard.duplicateSelectionAt',
      'content.materializeCopy',
    ],
    events: ['canvas.appearance.changed', 'history.changed', 'document.replaced'],
    signals: [
      'canvas.drag.preview',
      'canvas.snap.preview',
      'canvas.node.resize.preview',
      'canvas.camera.preview',
      'canvas.viewport.preview',
      'canvas.pointer.preview',
      'canvas.zoom.requested',
      'canvas.wheel.requested',
      'canvas.lasso.preview',
      'canvas.focus.requested',
      'connection.draft.preview',
      'group.membership.preview',
      'appearance.color.preview',
      'content.catalog.invalidated',
      'canvas.appearance.invalidated',
      'content.reference.drop-zone',
      'content.reference.drag.preview',
      'content.reference.drop',
    ],
    ui: ['canvas.surface', 'canvas.tool-actions', 'canvas.focus-button', 'canvas.toolbar-zoom'],
    actions: ['canvas.select-tool-action', 'canvas.hand-tool-action', 'canvas.focus-selection-action'],
    shortcuts: [
      'canvas.pan-shortcut',
      'canvas.select-tool-shortcut',
      'canvas.hand-tool-shortcut',
      'canvas.focus-selection-shortcut',
      'canvas.zoom-in-shortcut',
      'canvas.zoom-out-shortcut',
      'canvas.zoom-reset-shortcut',
      'canvas.group-membership-modifier',
      'canvas.duplicate-modifier',
    ],
    permissions: [
      'store.own.read', 'store.own.write', 'ui.canvas.contribute', 'ui.top.contribute',
      'ui.action.register', 'ui.shortcut.register',
    ],
  }),
  start(context) {
    let liveCamera: CameraState | undefined;
    let viewportSize: CanvasViewportSize | undefined;
    let livePointer: CanvasPointerSnapshot = { clear: true };
    const readCamera = (): CameraState => {
      const stored = context.store.readValue<CameraState>(VIEW_NAMESPACE, 'camera');
      return stored ? { ...stored, zoom: clampCanvasZoom(stored.zoom) } : { x: 0, y: 0, zoom: 1 };
    };
    const readTool = (): CanvasToolMode =>
      context.store.readValue<CanvasToolMode>(VIEW_NAMESPACE, 'tool') ?? 'select';
    const readAppearance = (): CanvasAppearanceRecord =>
      context.store.readValue<CanvasAppearanceRecord>(APPEARANCE_NAMESPACE, 'canvas') ?? {
        color: DEFAULT_CANVAS_COLOR,
        revision: 0,
      };
    const invalidateAppearance = () => context.signals.emit('canvas.appearance.invalidated');
    context.events.subscribe('canvas.appearance.changed', invalidateAppearance);
    context.events.subscribe('history.changed', invalidateAppearance);
    context.events.subscribe('document.replaced', invalidateAppearance);

    context.signals.subscribe<CameraState>('canvas.camera.preview', (message) => {
      if (isCameraState(message.payload)) liveCamera = message.payload;
    });
    context.signals.subscribe<CanvasViewportSize>('canvas.viewport.preview', (message) => {
      if (isViewportSize(message.payload)) viewportSize = message.payload;
    });
    context.signals.subscribe<CanvasPointerSnapshot>('canvas.pointer.preview', (message) => {
      if (isCanvasPointerSnapshot(message.payload)) livePointer = message.payload;
    });

    context.commands.register<CameraState>({
      type: 'canvas.camera.commit',
      validate: (payload): payload is CameraState =>
        typeof payload === 'object' &&
        payload !== null &&
        Number.isFinite((payload as CameraState).x) &&
        Number.isFinite((payload as CameraState).y) &&
        Number.isFinite((payload as CameraState).zoom) &&
        (payload as CameraState).zoom >= MIN_ZOOM &&
        (payload as CameraState).zoom <= MAX_ZOOM,
      handle: (payload) => ({
        transaction: {
          label: '保存画布视图',
          history: false,
          patches: [
            { op: 'set', domain: 'workspace', namespace: VIEW_NAMESPACE, key: 'camera', value: payload },
          ],
        },
      }),
    });

    context.commands.register<{ tool: CanvasToolMode }>({
      type: 'canvas.tool.set',
      validate: (payload): payload is { tool: CanvasToolMode } =>
        isRecord(payload) && (payload.tool === 'select' || payload.tool === 'hand'),
      handle: (payload) => ({
        transaction: {
          label: payload.tool === 'hand' ? '切换为手抓工具' : '切换为选择工具',
          history: false,
          patches: [{
            op: 'set',
            domain: 'workspace',
            namespace: VIEW_NAMESPACE,
            key: 'tool',
            value: payload.tool,
          }],
          events: [{ type: 'canvas.tool.changed', payload }],
        },
      }),
    });
    context.commands.register({
      type: 'canvas.tool.select',
      handle: () => ({
        transaction: {
          label: '切换为选择工具',
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: VIEW_NAMESPACE,
            key: 'tool',
            value: 'select' satisfies CanvasToolMode,
          }],
          events: [{ type: 'canvas.tool.changed', payload: { tool: 'select' } }],
        },
      }),
    });
    context.commands.register({
      type: 'canvas.tool.hand',
      handle: () => ({
        transaction: {
          label: '切换为手抓工具',
          history: false,
          patches: [{
            op: 'set' as const,
            domain: 'workspace' as const,
            namespace: VIEW_NAMESPACE,
            key: 'tool',
            value: 'hand' satisfies CanvasToolMode,
          }],
          events: [{ type: 'canvas.tool.changed', payload: { tool: 'hand' } }],
        },
      }),
    });

    context.commands.register({
      type: 'canvas.focusSelection',
      handle: async () => {
        const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
        if (selection.ids.length === 0) return { result: false };
        const catalogs = await context.capabilities.requestAll<SelectionCatalogContribution>(
          'selection.entities@1',
        );
        const selectedBounds = catalogs
          .flatMap((catalog) => catalog.entities)
          .filter((entity) => selection.ids.includes(entity.id) && entity.bounds)
          .map((entity) => entity.bounds!);
        if (selectedBounds.length === 0) {
          const selected = (await context.capabilities.request<ContentSummary[]>('content.summaries@1'))
            .filter((node) => selection.ids.includes(node.id));
          selectedBounds.push(...selected.map((node) => ({
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
          })));
        }
        if (selectedBounds.length === 0) return { result: false };
        const left = Math.min(...selectedBounds.map((bounds) => bounds.x));
        const top = Math.min(...selectedBounds.map((bounds) => bounds.y));
        const right = Math.max(...selectedBounds.map((bounds) => bounds.x + bounds.width));
        const bottom = Math.max(...selectedBounds.map((bounds) => bounds.y + bounds.height));
        const request: FocusRequest = {
          bounds: { x: left, y: top, width: right - left, height: bottom - top },
        };
        context.signals.emit('canvas.focus.requested', request);
        return { result: true };
      },
    });

    context.commands.register<{ id: string }>({
      type: 'canvas.focusEntity',
      validate: (payload): payload is { id: string } =>
        isRecord(payload) && typeof payload.id === 'string' && payload.id.length > 0,
      handle: async (payload) => {
        const entity = (await context.capabilities.request<ContentSummary[]>('content.summaries@1'))
          .find((summary) => summary.id === payload.id);
        if (!entity) return { result: false };
        context.signals.emit('canvas.focus.requested', {
          bounds: { x: entity.x, y: entity.y, width: entity.width, height: entity.height },
        } satisfies FocusRequest);
        return { result: true };
      },
    });

    const requestZoom = (zoom: number) => {
      context.signals.emit('canvas.zoom.requested', {
        zoom: clampCanvasZoom(zoom),
        commit: true,
      } satisfies CanvasZoomRequest);
      return { result: true };
    };
    context.commands.register({
      type: 'canvas.zoomIn',
      handle: () => requestZoom((liveCamera ?? readCamera()).zoom + 0.1),
    });
    context.commands.register({
      type: 'canvas.zoomOut',
      handle: () => requestZoom((liveCamera ?? readCamera()).zoom - 0.1),
    });
    context.commands.register({
      type: 'canvas.resetZoom',
      handle: () => requestZoom(1),
    });

    context.capabilities.provide({ key: 'canvas.camera@1', invoke: readCamera });
    context.capabilities.provide<undefined, CanvasViewportSize>({
      key: 'canvas.viewport@1',
      invoke: () => {
        if (!viewportSize) throw new Error('画布视图尚未完成布局');
        return viewportSize;
      },
    });
    context.capabilities.provide({ key: 'canvas.pointer@1', invoke: () => livePointer });
    context.capabilities.provide<undefined, CanvasViewportCenter>({
      key: 'canvas.viewportCenter@1',
      invoke: () => {
        if (!viewportSize) throw new Error('画布视图尚未完成布局');
        const camera = liveCamera ?? readCamera();
        return viewportCenterInWorld(camera, viewportSize);
      },
    });
    context.capabilities.provide({ key: 'canvas.tool@1', invoke: readTool });
    context.capabilities.provide({ key: 'canvas.appearance@1', invoke: readAppearance });
    context.capabilities.provide<AppearanceReadRequest, AppearanceReadContribution>({
      key: 'appearance.read@1',
      invoke: () => {
        const appearance = readAppearance();
        return {
          targets: [{
            kind: 'canvas-background',
            label: '画布背景',
            scopeLabel: '当前画布',
            color: appearance.color,
            mixed: false,
            entities: [{ id: 'canvas', revision: appearance.revision, expectedColor: appearance.color }],
          }],
        };
      },
    });
    context.capabilities.provide<AppearanceUpdateRequest, AppearanceUpdatePlan>({
      key: 'appearance.updatePlan@1',
      invoke: (input) => {
        if (input.kind !== 'canvas-background') return { patches: [], changed: 0 };
        if (!isAppearanceUpdate(input) || input.entities.length !== 1 || input.entities[0].id !== 'canvas') {
          throw new Error('画布背景更新请求不正确');
        }
        const current = readAppearance();
        const reference = input.entities[0];
        if (reference.revision !== current.revision || reference.expectedColor !== current.color) {
          throw new Error('画布背景已经变化，请重新选择颜色');
        }
        if (current.color === input.color) return { patches: [], changed: 0 };
        return {
          changed: 1,
          patches: [{
            op: 'set',
            domain: 'document',
            namespace: APPEARANCE_NAMESPACE,
            key: 'canvas',
            value: { color: input.color, revision: current.revision + 1 } satisfies CanvasAppearanceRecord,
            schemaOwner: 'canvas',
          }],
          events: [{ type: 'canvas.appearance.changed', payload: { color: input.color } }],
        };
      },
    });
    context.capabilities.provide<undefined, AppearanceColorContribution>({
      key: 'appearance.colors@1',
      invoke: () => ({ colors: [{ color: readAppearance().color, count: 1 }] }),
    });
    context.capabilities.provide<undefined, AppearanceUpdatePlan>({
      key: 'appearance.resetPlan@1',
      invoke: () => {
        const stored = context.store.readValue<CanvasAppearanceRecord>(APPEARANCE_NAMESPACE, 'canvas');
        if (!stored) return { patches: [], changed: 0 };
        return {
          changed: 1,
          patches: [{
            op: 'delete',
            domain: 'document',
            namespace: APPEARANCE_NAMESPACE,
            key: 'canvas',
            schemaOwner: 'canvas',
          }],
          events: [{ type: 'canvas.appearance.changed', payload: { color: DEFAULT_CANVAS_COLOR } }],
        };
      },
    });

    context.ui.contribute({
      id: 'canvas.surface',
      slot: 'canvas.background',
      kind: 'view',
      label: 'Echo-8 画布',
      component: CanvasSurface,
    });
    context.ui.contribute({
      id: 'canvas.tool-actions',
      slot: 'top.primary',
      kind: 'view',
      label: '选择与手抓工具',
      group: 'tools',
      component: CanvasToolActions,
      priority: 10,
    });
    context.ui.contribute({
      id: 'canvas.focus-button',
      slot: 'top.primary',
      kind: 'button',
      label: '聚焦选中项',
      icon: 'focus',
      group: 'status',
      tooltip: '聚焦至当前选中项（Ctrl/⌘ + Shift + F）',
      command: 'canvas.focusSelection',
      priority: 5,
    });
    context.ui.contribute({
      id: 'canvas.toolbar-zoom',
      slot: 'top.primary',
      kind: 'view',
      label: '画布缩放百分比',
      group: 'status',
      component: CanvasToolbarStatus,
      priority: 10,
    });
    context.ui.shortcut({
      id: 'canvas.pan-shortcut',
      chord: 'space',
      mode: 'hold',
      label: '平移画布',
      instruction: '按住快捷键并拖拽画布',
    });
    context.ui.shortcut({
      id: 'canvas.group-membership-modifier',
      chord: 'control',
      mode: 'hold',
      label: '拖动节点时加入或移出群组',
      instruction: '拖动文字节点时按住 Ctrl：组内节点预览并移出，组外节点按鼠标位置加入群组；松开 Ctrl 取消',
      category: '群组',
    });
    context.ui.shortcut({
      id: 'canvas.duplicate-modifier',
      chord: 'alt',
      mode: 'hold',
      label: '拖动时复制节点',
      instruction: '拖动节点时按住 Alt 显示原位置副本，松开鼠标完成复制；松开 Alt 则继续普通移动',
      category: '画布',
    });
    context.ui.shortcut({
      id: 'canvas.select-tool-shortcut',
      chord: 'v',
      command: 'canvas.tool.select',
      label: '切换为选择工具',
    });
    context.ui.shortcut({
      id: 'canvas.hand-tool-shortcut',
      chord: 'h',
      command: 'canvas.tool.hand',
      label: '切换为手抓工具',
    });
    context.ui.shortcut({
      id: 'canvas.focus-selection-shortcut',
      chord: 'mod+shift+f',
      command: 'canvas.focusSelection',
      label: '聚焦选中项',
    });
    context.ui.shortcut({
      id: 'canvas.zoom-in-shortcut',
      chord: 'mod+=',
      command: 'canvas.zoomIn',
      label: '放大画布',
      category: '画布',
    });
    context.ui.shortcut({
      id: 'canvas.zoom-out-shortcut',
      chord: 'mod+-',
      command: 'canvas.zoomOut',
      label: '缩小画布',
      category: '画布',
    });
    context.ui.shortcut({
      id: 'canvas.zoom-reset-shortcut',
      chord: 'mod+0',
      command: 'canvas.resetZoom',
      label: '画布缩放恢复 100%',
      category: '画布',
    });
    context.ui.action({
      id: 'canvas.select-tool-action',
      label: '切换为选择工具',
      command: 'canvas.tool.select',
      category: '画布',
      keywords: ['选择', '指针', 'select', 'pointer'],
      priority: 60,
    });
    context.ui.action({
      id: 'canvas.hand-tool-action',
      label: '切换为手抓工具',
      command: 'canvas.tool.hand',
      category: '画布',
      keywords: ['手抓', '平移', 'hand', 'pan'],
      priority: 61,
    });
    context.ui.action({
      id: 'canvas.focus-selection-action',
      label: '聚焦选中项',
      command: 'canvas.focusSelection',
      category: '画布',
      keywords: ['聚焦', '定位', '选中项', 'focus'],
      priority: 62,
    });
  },
};

function isAppearanceUpdate(value: unknown): value is AppearanceUpdateRequest {
  return isRecord(value) &&
    typeof value.kind === 'string' &&
    typeof value.color === 'string' &&
    /^#[0-9a-f]{6}$/iu.test(value.color) &&
    Array.isArray(value.entities) &&
    value.entities.every((entity) => isRecord(entity) &&
      typeof entity.id === 'string' &&
      Number.isInteger(entity.revision) &&
      typeof entity.expectedColor === 'string');
}

function isCameraState(value: unknown): value is CameraState {
  return isRecord(value) &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.zoom) &&
    (value.zoom as number) > 0;
}

function isViewportSize(value: unknown): value is CanvasViewportSize {
  return isRecord(value) &&
    Number.isFinite(value.width) && (value.width as number) > 0 &&
    Number.isFinite(value.height) && (value.height as number) > 0 &&
    (value.left === undefined || Number.isFinite(value.left)) &&
    (value.top === undefined || Number.isFinite(value.top));
}

function isCanvasPointerSnapshot(value: unknown): value is CanvasPointerSnapshot {
  if (!isRecord(value)) return false;
  if (value.clear === true) return true;
  return isRecord(value.point) && Number.isFinite(value.point.x) && Number.isFinite(value.point.y);
}
