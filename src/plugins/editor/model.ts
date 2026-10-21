import { createId, isRecord, type PatchOperation, type PluginDefinition } from '../../core/contracts.ts';
import { countGraphemes } from '../../services/text-metrics.ts';
import type {
  EditorContextSnapshot,
  EditorDocumentInvalidation,
  EditorOpenRequested,
  EditorRevealRequest,
  EditorMetricsRequest,
  EditorMetricsSnapshot,
  EditorPaneState,
  EditorSelectionSnapshot,
  WritingActivityRequest,
  WritingMetricsSnapshot,
} from '../../protocols/editor.ts';
import { EDITOR_OPEN_REQUESTED_EVENT } from '../../protocols/editor.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { UI_SURFACE_REVEALED_EVENT } from '../../protocols/ui.ts';
import { defineManifest } from '../manifest.ts';
import {
  DEFAULT_EDITOR_DOCK_WIDTH,
  EDITOR_PANE_DIVIDER_WIDTH,
  EDITOR_READ_WINDOW,
  MAX_EDITOR_DOCK_WIDTH,
  MIN_EDITOR_DOCK_WIDTH,
  minimumEditorDockWidth,
} from './constants.ts';

const EDITOR_NAMESPACE = 'editor';
const EDITOR_METRICS_NAMESPACE = 'editorMetrics';
const DEFAULT_PANE_WIDTH = 520;
const IDLE_TIMEOUT_MS = 60_000;
const CANVAS_REVEAL_DELAY_MS = 40;

interface StoredWritingMetrics extends WritingMetricsSnapshot {
  runtimeSessionId: string;
}

export function createEditorPlugin(
  dockView?: unknown,
  immersiveView?: unknown,
  replacementView?: unknown,
): PluginDefinition {
  let runtimeSessionId = createId('writing-session');
  let selections = new Map<string, EditorSelectionSnapshot>();

  return {
    manifest: defineManifest('editor', '多文本编辑器', {
      namespaces: [EDITOR_NAMESPACE, EDITOR_METRICS_NAMESPACE],
      namespaceDomains: {
        [EDITOR_NAMESPACE]: 'workspace',
        [EDITOR_METRICS_NAMESPACE]: 'workspace',
      },
      requiresCapabilities: [
        'content.summaries@1',
        'content.summariesById@1',
        'content.metrics@3',
        'content.read@1',
        'content.formatting@2',
      ],
      optionalCapabilities: [
        'selection.read@1',
        'text.assist.analyze@2',
        'text.assist.settings@1',
        'text.assist.resources@3',
        'file.textExportState@1',
        'annotations.forTarget@1',
      ],
      providesCapabilities: [
        'editor.activeNode@1',
        'editor.context@1',
        'editor.selection@1',
        'editor.metrics@1',
      ],
      commands: [
        'editor.open',
        'editor.openSelected',
        'editor.closeActive',
        'editor.activatePrevious',
        'editor.activateNext',
        'editor.toggleImmersive',
        'editor.toggleFormatBrush',
        'editor.increaseFontSize',
        'editor.decreaseFontSize',
        'editor.increaseFontWeight',
        'editor.decreaseFontWeight',
        'editor.increaseLineHeight',
        'editor.decreaseLineHeight',
        'editor.increaseLetterSpacing',
        'editor.decreaseLetterSpacing',
        'editor.increaseFirstLineIndent',
        'editor.decreaseFirstLineIndent',
        'editor.increaseParagraphSpacing',
        'editor.decreaseParagraphSpacing',
        'editor.revealRange',
        'editor.replacePane',
        'editor.cancelReplace',
        'editor.close',
        'editor.activate',
        'editor.setDockWidth',
        'editor.setPaneLayout',
        'editor.setPaneRatios',
        'editor.setWindow',
        'editor.enterImmersive',
        'editor.exitImmersive',
        'editor.recordActivity',
        'editor.migrateMetrics',
        'editor.resetDocumentViews',
      ],
      dispatches: [
        'content.applyDelta',
        'content.moveRange',
        'content.setDocumentFormat',
        'content.setRangeFormat',
        'node.rename',
        'interaction.begin',
        'interaction.end',
        'file.exportText',
        'file.exportWord',
        'palette.colorPicker.open',
        'palette.colorPicker.close',
        'selection.set',
        'canvas.focusSelection',
        'canvas.focusEntity',
        'textAssist.toggleCorrection',
        'textAssist.toggleCompletion',
        'editor.open',
        'annotation.open',
        'annotation.createAtContext',
        'history.undo',
        'history.redo',
      ],
      events: [
        'content.changed',
        'content.format.changed',
        'node.renamed',
        'nodes.deleted',
        'history.changed',
        'document.replaced',
      ],
      queries: ['editor.openPanes', 'editor.state'],
      asks: ['editor.openPanes', 'editor.state'],
      signals: [
        'editor.body.preview',
        'editor.title.preview',
        'editor.format.preview',
        'editor.selection.preview',
        'editor.dock.resize.preview',
        'editor.panes.resize.preview',
        'editor.document.invalidated',
        'editor.formatBrush.requested',
        'editor.formatStep.requested',
        'appearance.color.preview',
        'annotations.invalidated',
        'palette.colorPicker.preview',
        'palette.colorPicker.result',
        'text.assist.invalidated',
        'text.assist.settings.changed',
        'text.assist.resources.status',
        'file.text-export-state.changed',
        EDITOR_OPEN_REQUESTED_EVENT,
      ],
      ui: ['editor.dock', 'editor.immersive', 'editor.replacePrompt'],
      shortcuts: [
        'editor.close-active-shortcut',
        'editor.open-selected-shortcut',
        'editor.previous-pane-shortcut',
        'editor.next-pane-shortcut',
        'editor.toggle-immersive-shortcut',
        'editor.format-brush-shortcut',
        'editor.font-size-increase-shortcut',
        'editor.font-size-decrease-shortcut',
        'editor.font-weight-increase-shortcut',
        'editor.font-weight-decrease-shortcut',
        'editor.line-height-increase-shortcut',
        'editor.line-height-decrease-shortcut',
        'editor.letter-spacing-increase-shortcut',
        'editor.letter-spacing-decrease-shortcut',
        'editor.first-indent-increase-shortcut',
        'editor.first-indent-decrease-shortcut',
        'editor.paragraph-spacing-increase-shortcut',
        'editor.paragraph-spacing-decrease-shortcut',
      ],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.editor.contribute',
        'ui.modal.contribute',
        'ui.shortcut.register',
        'history.manage',
      ],
    }),

    start(context) {
      runtimeSessionId = createId('writing-session');
      selections = new Map();
      const openPanes = () => readOpenPanes(context.store.readValue(EDITOR_NAMESPACE, 'openPanes'));
      const activePane = () => {
        const panes = openPanes();
        const stored = context.store.readValue<string>(EDITOR_NAMESPACE, 'activePane');
        return stored && panes.includes(stored) ? stored : panes.at(-1);
      };
      const paneRecency = () => readRecency(context.store.readValue(EDITOR_NAMESPACE, 'paneRecency'));
      const paneWindows = () => readWindows(context.store.readValue(EDITOR_NAMESPACE, 'paneWindows'));
      const paneRatios = () => normalizePaneRatios(
        context.store.readValue(EDITOR_NAMESPACE, 'paneRatios'),
        openPanes(),
      );
      const dockWidth = () => clampDockWidth(
        context.store.readValue<number>(EDITOR_NAMESPACE, 'dockWidth') ?? DEFAULT_EDITOR_DOCK_WIDTH,
        Number.MAX_SAFE_INTEGER,
        openPanes().length,
      );
      const immersivePane = () => {
        const stored = context.store.readValue<string>(EDITOR_NAMESPACE, 'immersivePane');
        return stored && openPanes().includes(stored) ? stored : undefined;
      };
      const pendingPane = () => {
        const stored = context.store.readValue<string>(EDITOR_NAMESPACE, 'pendingPane');
        return stored && !openPanes().includes(stored) ? stored : undefined;
      };
      const revealRequest = () => readRevealRequest(
        context.store.readValue(EDITOR_NAMESPACE, 'revealRequest'),
      );
      const state = (): EditorPaneState => ({
        openPanes: openPanes(),
        activePane: activePane(),
        pendingPane: pendingPane(),
        revealRequest: revealRequest(),
        dockWidth: dockWidth(),
        immersivePane: immersivePane(),
        paneRecency: paneRecency(),
        paneWindows: paneWindows(),
        paneRatios: paneRatios(),
      });
      const revealCanvasEntity = (id: string) => {
        context.resources.timeout(() => {
          void context.commands.dispatch('canvas.focusEntity', { id }).catch((error) => {
            context.diagnostics.warn('编辑器打开后无法重新定位画布节点', error);
          });
        }, CANVAS_REVEAL_DELAY_MS);
      };

      context.commands.register<{ id: string }>({
        type: 'editor.open',
        validate: isNodeIdPayload,
        handle: (payload, envelope) => {
          context.ui.activateSurface('right.editor', 'editor.dock', 'editor.closeActive');
          const current = openPanes();
          const recency = paneRecency();
          const addedPane = !current.includes(payload.id);
          if (addedPane && current.length >= 3) {
            context.ui.activateSurface('overlay.modal', 'editor.replacePrompt', 'editor.cancelReplace');
            return {
              result: { status: 'limit', openPanes: current },
              transaction: {
                label: '等待选择要替换的编辑器',
                history: false,
                patches: [workspaceSet('pendingPane', payload.id)],
                events: [
                  { type: 'editor.replace.requested', payload: { id: payload.id, openPanes: current } },
                  { type: UI_SURFACE_REVEALED_EVENT, payload: { slot: 'right.editor' } },
                ],
              },
            };
          }
          const next = addedPane ? [...current, payload.id] : current;
          if (pendingPane()) context.ui.deactivateSurface('overlay.modal', 'editor.replacePrompt');
          const nextRecency = { ...recency, [payload.id]: envelope.timestamp };
          const nextRatios = { ...paneRatios() };
          if (!(payload.id in nextRatios)) nextRatios[payload.id] = 1;
          const nextDockWidth = clampDockWidth(
            Math.max(
              dockWidth(),
              addedPane && next.length > 1 ? next.length * DEFAULT_PANE_WIDTH : dockWidth(),
            ),
            Number.MAX_SAFE_INTEGER,
            next.length,
          );
          const patches: PatchOperation[] = [
            workspaceSet('openPanes', next),
            workspaceSet('activePane', payload.id),
            workspaceSet('paneRecency', nextRecency),
            workspaceSet('paneRatios', normalizePaneRatios(nextRatios, next)),
            workspaceSet('dockWidth', nextDockWidth),
            ...(pendingPane() ? [workspaceDelete('pendingPane')] : []),
          ];
          revealCanvasEntity(payload.id);
          return {
            result: { status: addedPane ? 'opened' : 'activated', openPanes: next },
            transaction: {
              label: addedPane ? '打开文本编辑器' : '激活文本编辑器',
              history: false,
              patches,
              events: [
                { type: 'editor.panes.changed', payload: { openPanes: next } },
                { type: UI_SURFACE_REVEALED_EVENT, payload: { slot: 'right.editor' } },
              ],
            },
          };
        },
      });

      context.signals.subscribe<EditorOpenRequested>(EDITOR_OPEN_REQUESTED_EVENT, (message) => {
        if (!message.payload || typeof message.payload.id !== 'string') return;
        void Promise.resolve()
          .then(() => context.commands.dispatch('editor.open', { id: message.payload.id }))
          .catch((error) => context.diagnostics.warn('无法打开请求的文本编辑区', error));
      });

      context.commands.register({
        type: 'editor.openSelected',
        handle: async () => {
          let selection: SelectionSnapshot;
          try {
            selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
          } catch {
            return { result: false };
          }
          const summaries = await context.capabilities.request<Array<{ id: string }>>('content.summaries@1');
          const available = new Set(summaries.map((summary) => summary.id));
          const id = selection.ids.find((candidate) => available.has(candidate));
          if (!id) return { result: false };
          return { result: await context.commands.invoke('editor.open', { id }) };
        },
      });

      context.commands.register<{ replaceId: string }>({
        type: 'editor.replacePane',
        validate: (payload): payload is { replaceId: string } =>
          isRecord(payload) && typeof payload.replaceId === 'string' && payload.replaceId.length > 0,
        handle: (payload, envelope) => {
          const requested = pendingPane();
          const current = openPanes();
          if (!requested) return { result: false };
          const replaceIndex = current.indexOf(payload.replaceId);
          if (replaceIndex < 0) throw new Error('要替换的编辑器已经关闭');
          const next = [...current];
          next[replaceIndex] = requested;
          const recency = paneRecency();
          delete recency[payload.replaceId];
          recency[requested] = envelope.timestamp;
          const windows = paneWindows();
          delete windows[payload.replaceId];
          const ratios = paneRatios();
          const inheritedRatio = ratios[payload.replaceId] ?? 1;
          delete ratios[payload.replaceId];
          ratios[requested] = inheritedRatio;
          const wasImmersive = immersivePane() === payload.replaceId;
          if (wasImmersive) context.ui.deactivateSurface('overlay.modal', 'editor.immersive');
          context.ui.deactivateSurface('overlay.modal', 'editor.replacePrompt');
          revealCanvasEntity(requested);
          return {
            result: true,
            transaction: {
              label: '替换文本编辑器',
              history: false,
              patches: [
                workspaceSet('openPanes', next),
                workspaceSet('activePane', requested),
                workspaceSet('paneRecency', recency),
                workspaceSet('paneWindows', windows),
                workspaceSet('paneRatios', normalizePaneRatios(ratios, next)),
                workspaceDelete('pendingPane'),
                ...(revealRequest()?.id === payload.replaceId ? [workspaceDelete('revealRequest')] : []),
                ...(wasImmersive ? [workspaceDelete('immersivePane')] : []),
              ],
              events: [
                {
                  type: 'editor.panes.changed',
                  payload: { openPanes: next, replacedId: payload.replaceId, openedId: requested },
                },
                { type: UI_SURFACE_REVEALED_EVENT, payload: { slot: 'right.editor' } },
              ],
            },
          };
        },
      });

      context.commands.register({
        type: 'editor.cancelReplace',
        handle: () => {
          if (!pendingPane()) return { result: false };
          context.ui.deactivateSurface('overlay.modal', 'editor.replacePrompt');
          return {
            result: true,
            transaction: {
              label: '取消替换编辑器',
              history: false,
              patches: [workspaceDelete('pendingPane')],
              events: [{ type: 'editor.replace.cancelled', payload: {} }],
            },
          };
        },
      });

      context.commands.register<{ id: string; currentDockWidth?: number }>({
        type: 'editor.close',
        validate: (payload): payload is { id: string; currentDockWidth?: number } =>
          isRecord(payload) && typeof payload.id === 'string' && payload.id.length > 0 &&
          (payload.currentDockWidth === undefined || Number.isFinite(payload.currentDockWidth)),
        handle: (payload) => {
          const current = openPanes();
          if (!current.includes(payload.id)) return { result: false };
          if (immersivePane() === payload.id) {
            context.ui.deactivateSurface('overlay.modal', 'editor.immersive');
          }
          const next = current.filter((id) => id !== payload.id);
          if (next.length === 0) context.ui.deactivateSurface('right.editor', 'editor.dock');
          const recency = paneRecency();
          delete recency[payload.id];
          const windows = paneWindows();
          delete windows[payload.id];
          const ratios = paneRatios();
          const closedRatio = ratios[payload.id] ?? 1;
          const currentWidth = clampDockWidth(
            payload.currentDockWidth ?? dockWidth(),
            Number.MAX_SAFE_INTEGER,
            current.length,
          );
          const ratioTotal = Object.values(ratios).reduce((sum, ratio) => sum + ratio, 0) || current.length;
          const usableWidth = Math.max(
            0,
            currentWidth - Math.max(0, current.length - 1) * EDITOR_PANE_DIVIDER_WIDTH,
          );
          const closedWidth = usableWidth * (closedRatio / ratioTotal);
          delete ratios[payload.id];
          const nextDockWidth = next.length > 0
            ? clampDockWidth(
              currentWidth - closedWidth - EDITOR_PANE_DIVIDER_WIDTH,
              Number.MAX_SAFE_INTEGER,
              next.length,
            )
            : currentWidth;
          const nextActive = activePane() === payload.id ? next.at(-1) : activePane();
          return {
            result: true,
            transaction: {
              label: '关闭文本编辑器',
              history: false,
              patches: [
                workspaceSet('openPanes', next),
                workspaceSet('paneRecency', recency),
                workspaceSet('paneWindows', windows),
                workspaceSet('paneRatios', normalizePaneRatios(ratios, next)),
                workspaceSet('dockWidth', nextDockWidth),
                ...(nextActive ? [workspaceSet('activePane', nextActive)] : [workspaceDelete('activePane')]),
                ...(immersivePane() === payload.id ? [workspaceDelete('immersivePane')] : []),
                ...(revealRequest()?.id === payload.id ? [workspaceDelete('revealRequest')] : []),
              ],
              events: [{ type: 'editor.panes.changed', payload: { openPanes: next } }],
            },
          };
        },
      });

      context.commands.register({
        type: 'editor.closeActive',
        handle: async () => {
          const id = activePane();
          if (!id) return { result: false };
          if (immersivePane() === id) {
            await context.commands.invoke('editor.exitImmersive');
            await context.commands.invoke('interaction.end', { mode: 'immersive' }).catch(() => undefined);
          }
          return { result: await context.commands.invoke('editor.close', { id }) };
        },
      });

      const activateRelativePane = async (offset: -1 | 1) => {
        const panes = openPanes();
        if (panes.length < 2) return { result: false };
        const currentIndex = Math.max(0, panes.indexOf(activePane() ?? panes[0]));
        const id = panes[(currentIndex + offset + panes.length) % panes.length];
        return { result: await context.commands.invoke('editor.activate', { id }) };
      };
      context.commands.register({
        type: 'editor.activatePrevious',
        handle: () => activateRelativePane(-1),
      });
      context.commands.register({
        type: 'editor.activateNext',
        handle: () => activateRelativePane(1),
      });

      context.commands.register({
        type: 'editor.resetDocumentViews',
        handle: () => {
          context.ui.deactivateSurface('overlay.modal', 'editor.immersive');
          context.ui.deactivateSurface('overlay.modal', 'editor.replacePrompt');
          context.ui.deactivateSurface('right.editor', 'editor.dock');
          const keys = Object.keys(context.store.readNamespace<Record<string, unknown>>(EDITOR_NAMESPACE));
          return {
            transaction: {
              label: '重置文件相关编辑器状态',
              history: false,
              patches: keys
                .filter((key) => [
                  'openPanes',
                  'activePane',
                  'pendingPane',
                  'revealRequest',
                  'paneRecency',
                  'paneWindows',
                  'paneRatios',
                  'immersivePane',
                ].includes(key) || key.startsWith('metrics:'))
                .map((key) => workspaceDelete(key)),
              events: [{ type: 'editor.panes.changed', payload: { openPanes: [] } }],
            },
          };
        },
      });

      context.commands.register<{ id: string }>({
        type: 'editor.activate',
        validate: isNodeIdPayload,
        handle: (payload, envelope) => {
          if (!openPanes().includes(payload.id)) throw new Error(`Editor pane is not open: ${payload.id}`);
          context.ui.activateSurface('right.editor', 'editor.dock', 'editor.closeActive');
          if (activePane() === payload.id) return { result: true };
          return {
            result: true,
            transaction: {
              label: '切换活动编辑器',
              history: false,
              patches: [
                workspaceSet('activePane', payload.id),
                workspaceSet('paneRecency', { ...paneRecency(), [payload.id]: envelope.timestamp }),
              ],
              events: [{ type: 'editor.active.changed', payload: { id: payload.id } }],
            },
          };
        },
      });

      context.commands.register<Omit<EditorRevealRequest, 'requestId'>, {
        status: 'revealed';
        openPanes: string[];
      }>({
        type: 'editor.revealRange',
        validate: isEditorRevealPayload,
        handle: (payload, envelope) => {
          const request: EditorRevealRequest = { ...payload, requestId: envelope.id };
          const current = openPanes();
          if (!current.includes(payload.id) || activePane() !== payload.id) {
            throw new Error('上一个/下一个只对当前正在使用的文本编辑区生效');
          }
          const windows = { ...paneWindows(), [payload.id]: revealWindowStart(payload.start) };
          return {
            result: { status: 'revealed', openPanes: current },
            transaction: {
              label: '定位查找结果',
              history: false,
              patches: [
                workspaceSet('paneWindows', windows),
                workspaceSet('revealRequest', request),
              ],
              events: [{ type: 'editor.range.revealed', payload: request }],
            },
          };
        },
      });

      context.commands.register<{ width: number; boundaryWidth?: number }, { width: number }>({
        type: 'editor.setDockWidth',
        validate: (payload): payload is { width: number; boundaryWidth?: number } =>
          isRecord(payload) && Number.isFinite(payload.width) &&
          (payload.boundaryWidth === undefined || Number.isFinite(payload.boundaryWidth)),
        handle: (payload) => {
          const width = clampDockWidth(payload.width, payload.boundaryWidth, openPanes().length);
          if (dockWidth() === width) return { result: { width } };
          return {
            result: { width },
            transaction: {
              label: '调整编辑区宽度',
              history: false,
              patches: [workspaceSet('dockWidth', width)],
            },
          };
        },
      });

      context.commands.register<{
        width: number;
        boundaryWidth?: number;
        ratios: Record<string, number>;
      }, { width: number; ratios: Record<string, number> }>({
        type: 'editor.setPaneLayout',
        validate: (payload): payload is {
          width: number;
          boundaryWidth?: number;
          ratios: Record<string, number>;
        } => isRecord(payload) && Number.isFinite(payload.width) && isRecord(payload.ratios) &&
          (payload.boundaryWidth === undefined || Number.isFinite(payload.boundaryWidth)) &&
          Object.values(payload.ratios).every((value) => Number.isFinite(value) && (value as number) > 0),
        handle: (payload) => {
          const panes = openPanes();
          if (panes.some((id) => !Number.isFinite(payload.ratios[id]) || payload.ratios[id] <= 0)) {
            throw new Error('编辑器宽度比例不完整');
          }
          const width = clampDockWidth(payload.width, payload.boundaryWidth, panes.length);
          const ratios = normalizePaneRatios(payload.ratios, panes);
          return {
            result: { width, ratios },
            transaction: {
              label: '调整多编辑器布局',
              history: false,
              patches: [
                workspaceSet('dockWidth', width),
                workspaceSet('paneRatios', ratios),
              ],
            },
          };
        },
      });

      context.commands.register<{ ratios: Record<string, number> }, { ratios: Record<string, number> }>({
        type: 'editor.setPaneRatios',
        validate: (payload): payload is { ratios: Record<string, number> } =>
          isRecord(payload) && isRecord(payload.ratios) &&
          Object.values(payload.ratios).every((value) => Number.isFinite(value) && (value as number) > 0),
        handle: (payload) => {
          const panes = openPanes();
          if (panes.some((id) => !Number.isFinite(payload.ratios[id]) || payload.ratios[id] <= 0)) {
            throw new Error('编辑器宽度比例不完整');
          }
          const ratios = normalizePaneRatios(payload.ratios, panes);
          return {
            result: { ratios },
            transaction: {
              label: '调整多编辑器宽度',
              history: false,
              patches: [workspaceSet('paneRatios', ratios)],
            },
          };
        },
      });

      context.commands.register<{ id: string; start: number }, { start: number }>({
        type: 'editor.setWindow',
        validate: (payload): payload is { id: string; start: number } =>
          isRecord(payload) && typeof payload.id === 'string' && typeof payload.start === 'number' &&
          Number.isInteger(payload.start) && payload.start >= 0,
        handle: (payload) => {
          if (!openPanes().includes(payload.id)) throw new Error(`Editor pane is not open: ${payload.id}`);
          const start = Math.max(0, payload.start);
          const current = paneWindows();
          if (current[payload.id] === start) return { result: { start } };
          return {
            result: { start },
            transaction: {
              label: '切换超长正文范围',
              history: false,
              patches: [workspaceSet('paneWindows', { ...current, [payload.id]: start })],
            },
          };
        },
      });

      context.commands.register<{ id: string }>({
        type: 'editor.enterImmersive',
        validate: isNodeIdPayload,
        handle: (payload) => {
          if (!openPanes().includes(payload.id)) throw new Error(`Editor pane is not open: ${payload.id}`);
          context.ui.activateSurface('overlay.modal', 'editor.immersive', 'editor.exitImmersive');
          return {
            result: true,
            transaction: {
              label: '进入沉浸写作',
              history: false,
              patches: [workspaceSet('immersivePane', payload.id), workspaceSet('activePane', payload.id)],
              events: [
                { type: 'editor.immersive.changed', payload: { id: payload.id } },
                { type: 'editor.active.changed', payload: { id: payload.id } },
              ],
            },
          };
        },
      });

      context.commands.register({
        type: 'editor.exitImmersive',
        handle: () => {
          if (!immersivePane()) return { result: false };
          context.ui.deactivateSurface('overlay.modal', 'editor.immersive');
          return {
            result: true,
            transaction: {
              label: '退出沉浸写作',
              history: false,
              patches: [workspaceDelete('immersivePane')],
              events: [{ type: 'editor.immersive.changed', payload: {} }],
            },
          };
        },
      });

      context.commands.register({
        type: 'editor.toggleImmersive',
        handle: async () => {
          if (immersivePane()) {
            const result = await context.commands.invoke('editor.exitImmersive');
            await context.commands.invoke('interaction.end', { mode: 'immersive' }).catch(() => undefined);
            return { result };
          }
          const id = activePane();
          if (!id) return { result: false };
          await context.commands.invoke('interaction.begin', { mode: 'immersive' });
          try {
            return { result: await context.commands.invoke('editor.enterImmersive', { id }) };
          } catch (error) {
            await context.commands.invoke('interaction.end', { mode: 'immersive' }).catch(() => undefined);
            throw error;
          }
        },
      });

      const emitActiveEditorIntent = (
        type: string,
        payload: Record<string, unknown> = {},
        requestedId?: string,
      ) => {
        const id = requestedId && openPanes().includes(requestedId) ? requestedId : activePane();
        if (!id) return { result: false };
        context.signals.emit(type, { id, ...payload });
        return { result: true };
      };
      context.commands.register<{ id?: string }>({
        type: 'editor.toggleFormatBrush',
        validate: isOptionalNodeIdPayload,
        handle: (payload) => emitActiveEditorIntent('editor.formatBrush.requested', {}, payload?.id),
      });
      const formatSteps = [
        ['editor.increaseFontSize', 'fontSize', 1],
        ['editor.decreaseFontSize', 'fontSize', -1],
        ['editor.increaseFontWeight', 'fontWeight', 1],
        ['editor.decreaseFontWeight', 'fontWeight', -1],
        ['editor.increaseLineHeight', 'lineHeight', 1],
        ['editor.decreaseLineHeight', 'lineHeight', -1],
        ['editor.increaseLetterSpacing', 'letterSpacing', 1],
        ['editor.decreaseLetterSpacing', 'letterSpacing', -1],
        ['editor.increaseFirstLineIndent', 'firstLineIndent', 1],
        ['editor.decreaseFirstLineIndent', 'firstLineIndent', -1],
        ['editor.increaseParagraphSpacing', 'paragraphSpacing', 1],
        ['editor.decreaseParagraphSpacing', 'paragraphSpacing', -1],
      ] as const;
      for (const [type, property, direction] of formatSteps) {
        context.commands.register({
          type,
          handle: () => emitActiveEditorIntent('editor.formatStep.requested', { property, direction }),
        });
      }

      context.commands.register<WritingActivityRequest, WritingMetricsSnapshot>({
        type: 'editor.recordActivity',
        validate: isWritingActivityRequest,
        handle: (payload, envelope) => {
          const current = readWritingMetrics(
            context.store.readValue(EDITOR_METRICS_NAMESPACE, metricKey(payload.nodeId)),
          );
          const next = updateWritingMetrics(current, payload, envelope.timestamp, runtimeSessionId);
          return {
            result: stripRuntimeSession(next),
            transaction: {
              label: '更新码字指标',
              history: false,
              patches: [workspaceSet(metricKey(payload.nodeId), next, EDITOR_METRICS_NAMESPACE)],
            },
          };
        },
      });

      context.commands.register<undefined, { migrated: number }>({
        type: 'editor.migrateMetrics',
        handle: () => {
          const values = context.store.readNamespace<Record<string, unknown>>(EDITOR_NAMESPACE);
          const patches: PatchOperation[] = [];
          for (const [key, value] of Object.entries(values)) {
            if (!key.startsWith('metrics:') || !isRecord(value) ||
              (!Object.prototype.hasOwnProperty.call(value, 'recentBuckets') &&
                !Object.prototype.hasOwnProperty.call(value, 'recentWindowMs'))) continue;
            patches.push(workspaceDelete(key));
          }
          return {
            result: { migrated: patches.length },
            transaction: {
              label: '清理旧码字统计',
              history: false,
              patches,
            },
          };
        },
      });

      context.queries.register({ type: 'editor.openPanes', handle: openPanes });
      context.queries.register({ type: 'editor.state', handle: state });
      context.signals.subscribe<EditorSelectionSnapshot>('editor.selection.preview', (message) => {
        if (!isEditorSelectionSnapshot(message.payload)) return;
        selections.set(message.payload.id, message.payload);
      });
      context.capabilities.provide({ key: 'editor.activeNode@1', invoke: activePane });
      context.capabilities.provide<undefined, EditorContextSnapshot>({
        key: 'editor.context@1',
        invoke: () => {
          const immersive = immersivePane();
          return {
            openPanes: openPanes(),
            activePane: activePane(),
            ...(immersive ? { immersivePane: immersive } : {}),
          };
        },
      });
      context.capabilities.provide<undefined, EditorSelectionSnapshot | undefined>({
        key: 'editor.selection@1',
        invoke: () => {
          const active = activePane();
          return active ? selections.get(active) : undefined;
        },
      });
      context.capabilities.provide<EditorMetricsRequest, EditorMetricsSnapshot>({
        key: 'editor.metrics@1',
        invoke: (input) => {
          const nodeIds = Array.isArray(input?.nodeIds) ? [...new Set(input.nodeIds)] : [];
          const byNode: Record<string, WritingMetricsSnapshot> = {};
          for (const nodeId of nodeIds) {
            const stored = readWritingMetrics(
              context.store.readValue(EDITOR_METRICS_NAMESPACE, metricKey(nodeId)),
            );
            if (stored?.runtimeSessionId === runtimeSessionId) byNode[nodeId] = stripRuntimeSession(stored);
          }
          return { runtimeSessionId, byNode };
        },
      });

      const invalidateDocuments = (payload: EditorDocumentInvalidation) =>
        context.signals.emit('editor.document.invalidated', payload);
      context.events.subscribe<{ nodeId: string; revision?: number }>('content.changed', (message) => {
        invalidateDocuments({ content: [{ id: message.payload.nodeId, revision: message.payload.revision }] });
      });
      context.events.subscribe<{ nodeId?: string; nodeIds?: string[]; revision?: number }>(
        'content.format.changed',
        (message) => {
          const ids = message.payload.nodeIds ?? (message.payload.nodeId ? [message.payload.nodeId] : []);
          invalidateDocuments({
            formatting: ids.map((id) => ({ id, revision: message.payload.revision })),
          });
        },
      );
      context.events.subscribe<{ id: string }>('node.renamed', (message) => {
        invalidateDocuments({ metadataIds: [message.payload.id] });
      });
      context.events.subscribe('history.changed', () => invalidateDocuments({ all: true }));
      context.events.subscribe('document.replaced', () => {
        invalidateDocuments({ all: true });
        void context.commands.dispatch('editor.resetDocumentViews');
      });
      context.events.subscribe<{ ids: string[] }>('nodes.deleted', (message) => {
        invalidateDocuments({ metadataIds: message.payload.ids });
        const deleted = Array.isArray(message.payload?.ids) ? new Set(message.payload.ids) : new Set<string>();
        if (pendingPane() && deleted.has(pendingPane()!)) void context.commands.dispatch('editor.cancelReplace');
        for (const id of openPanes()) {
          if (deleted.has(id)) void context.commands.dispatch('editor.close', { id });
        }
      });

      context.ui.contribute({
        id: 'editor.dock',
        slot: 'right.editor',
        kind: 'view',
        label: '文本编辑区',
        component: dockView,
      });
      context.ui.contribute({
        id: 'editor.immersive',
        slot: 'overlay.modal',
        kind: 'view',
        label: '沉浸写作',
        component: immersiveView,
      });
      context.ui.contribute({
        id: 'editor.replacePrompt',
        slot: 'overlay.modal',
        kind: 'view',
        label: '选择要替换的文本编辑器',
        component: replacementView,
      });
      context.ui.shortcut({
        id: 'editor.close-active-shortcut',
        command: 'editor.closeActive',
        label: '关闭当前文本编辑区',
        category: '文本编辑',
        allowInEditable: true,
      });
      context.ui.shortcut({
        id: 'editor.open-selected-shortcut',
        command: 'editor.openSelected',
        label: '打开选中文本节点的编辑区',
        category: '文本编辑',
      });
      context.ui.shortcut({
        id: 'editor.previous-pane-shortcut',
        command: 'editor.activatePrevious',
        label: '切换到上一个文本编辑区',
        category: '文本编辑',
        allowInEditable: true,
      });
      context.ui.shortcut({
        id: 'editor.next-pane-shortcut',
        command: 'editor.activateNext',
        label: '切换到下一个文本编辑区',
        category: '文本编辑',
        allowInEditable: true,
      });
      context.ui.shortcut({
        id: 'editor.toggle-immersive-shortcut',
        command: 'editor.toggleImmersive',
        label: '进入或退出沉浸写作',
        category: '文本编辑',
        allowInEditable: true,
      });
      const editorShortcuts = [
        ['editor.format-brush-shortcut', 'editor.toggleFormatBrush', '格式刷'],
        ['editor.font-size-increase-shortcut', 'editor.increaseFontSize', '增大字号'],
        ['editor.font-size-decrease-shortcut', 'editor.decreaseFontSize', '减小字号'],
        ['editor.font-weight-increase-shortcut', 'editor.increaseFontWeight', '增大字重'],
        ['editor.font-weight-decrease-shortcut', 'editor.decreaseFontWeight', '减小字重'],
        ['editor.line-height-increase-shortcut', 'editor.increaseLineHeight', '增大行距'],
        ['editor.line-height-decrease-shortcut', 'editor.decreaseLineHeight', '减小行距'],
        ['editor.letter-spacing-increase-shortcut', 'editor.increaseLetterSpacing', '增大字距'],
        ['editor.letter-spacing-decrease-shortcut', 'editor.decreaseLetterSpacing', '减小字距'],
        ['editor.first-indent-increase-shortcut', 'editor.increaseFirstLineIndent', '增大首行缩进'],
        ['editor.first-indent-decrease-shortcut', 'editor.decreaseFirstLineIndent', '减小首行缩进'],
        ['editor.paragraph-spacing-increase-shortcut', 'editor.increaseParagraphSpacing', '增大段后空行'],
        ['editor.paragraph-spacing-decrease-shortcut', 'editor.decreaseParagraphSpacing', '减小段后空行'],
      ] as const;
      for (const [id, command, label] of editorShortcuts) {
        context.ui.shortcut({
          id,
          command,
          label,
          category: '文本格式',
          allowInEditable: true,
        });
      }
      if (immersivePane()) {
        context.ui.activateSurface('overlay.modal', 'editor.immersive', 'editor.exitImmersive');
      } else if (pendingPane()) {
        context.ui.activateSurface('overlay.modal', 'editor.replacePrompt', 'editor.cancelReplace');
      }
      if (openPanes().length > 0) {
        context.ui.activateSurface('right.editor', 'editor.dock', 'editor.closeActive');
      }
      void context.commands.dispatch('editor.migrateMetrics').catch((error) => {
        context.diagnostics.warn('旧码字统计清理失败', error);
      });
    },
  };
}

function workspaceSet(
  key: string,
  value: unknown,
  namespace = EDITOR_NAMESPACE,
): PatchOperation {
  return { op: 'set' as const, domain: 'workspace' as const, namespace, key, value };
}

function workspaceDelete(key: string): PatchOperation {
  return { op: 'delete' as const, domain: 'workspace' as const, namespace: EDITOR_NAMESPACE, key };
}

function metricKey(nodeId: string): string {
  return `metrics:${nodeId}`;
}

function readOpenPanes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-3) : [];
}

function readRecency(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
  );
}

function readWindows(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] =>
      Number.isInteger(entry[1]) && (entry[1] as number) >= 0),
  );
}

function readRevealRequest(value: unknown): EditorRevealRequest | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = typeof value.requestId === 'string' ? value.requestId : undefined;
  if (!requestId || !isEditorRevealPayload(value)) return undefined;
  return {
    id: value.id,
    start: value.start,
    end: value.end,
    revision: value.revision,
    requestId,
  };
}

function revealWindowStart(start: number): number {
  return Math.max(0, start - Math.floor(EDITOR_READ_WINDOW / 4));
}

function normalizePaneRatios(value: unknown, paneIds: string[]): Record<string, number> {
  if (paneIds.length === 0) return {};
  const source = isRecord(value) ? value : {};
  const raw = paneIds.map((id) => {
    const candidate = source[id];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
      ? Math.min(20, Math.max(0.05, candidate))
      : 1;
  });
  const scale = paneIds.length / raw.reduce((sum, ratio) => sum + ratio, 0);
  return Object.fromEntries(paneIds.map((id, index) => [id, Number((raw[index] * scale).toFixed(6))]));
}

function readWritingMetrics(value: unknown): StoredWritingMetrics | undefined {
  if (!isRecord(value) || typeof value.nodeId !== 'string' || typeof value.runtimeSessionId !== 'string') {
    return undefined;
  }
  const numbers = [
    value.startedAt,
    value.lastActivityAt,
    value.activeMs,
    value.typedGraphemes,
    value.deletedGraphemes,
    value.pastedUtf16Units,
    value.idleTimeoutMs,
  ];
  if (!numbers.every((candidate) => typeof candidate === 'number' && Number.isFinite(candidate))) return undefined;
  return {
    runtimeSessionId: value.runtimeSessionId,
    nodeId: value.nodeId,
    startedAt: value.startedAt as number,
    lastActivityAt: value.lastActivityAt as number,
    activeMs: value.activeMs as number,
    typedGraphemes: value.typedGraphemes as number,
    deletedGraphemes: value.deletedGraphemes as number,
    pastedUtf16Units: value.pastedUtf16Units as number,
    idleTimeoutMs: value.idleTimeoutMs as number,
  };
}

function updateWritingMetrics(
  current: StoredWritingMetrics | undefined,
  activity: WritingActivityRequest,
  now: number,
  runtimeSessionId: string,
): StoredWritingMetrics {
  const previous = current?.runtimeSessionId === runtimeSessionId ? current : undefined;
  const activeDelta = previous ? Math.min(Math.max(0, now - previous.lastActivityAt), IDLE_TIMEOUT_MS) : 0;
  const typed = activity.kind === 'paste' || activity.kind === 'delete'
    ? 0
    : countGraphemes(activity.insertedText);
  const deleted = countGraphemes(activity.deletedText);
  return {
    runtimeSessionId,
    nodeId: activity.nodeId,
    startedAt: previous?.startedAt ?? now,
    lastActivityAt: now,
    activeMs: (previous?.activeMs ?? 0) + activeDelta,
    typedGraphemes: (previous?.typedGraphemes ?? 0) + typed,
    deletedGraphemes: (previous?.deletedGraphemes ?? 0) + deleted,
    pastedUtf16Units: (previous?.pastedUtf16Units ?? 0) + (activity.kind === 'paste' ? activity.insertedText.length : 0),
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  };
}

function stripRuntimeSession(value: StoredWritingMetrics): WritingMetricsSnapshot {
  return {
    nodeId: value.nodeId,
    startedAt: value.startedAt,
    lastActivityAt: value.lastActivityAt,
    activeMs: value.activeMs,
    typedGraphemes: value.typedGraphemes,
    deletedGraphemes: value.deletedGraphemes,
    pastedUtf16Units: value.pastedUtf16Units,
    idleTimeoutMs: value.idleTimeoutMs,
  };
}

function clampDockWidth(
  value: number,
  boundaryWidth = Number.MAX_SAFE_INTEGER,
  paneCount = 1,
): number {
  const maximum = Math.max(0, Math.min(MAX_EDITOR_DOCK_WIDTH, boundaryWidth));
  const minimum = Math.min(maximum, Math.max(MIN_EDITOR_DOCK_WIDTH, minimumEditorDockWidth(paneCount)));
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

function isNodeIdPayload(payload: unknown): payload is { id: string } {
  return isRecord(payload) && typeof payload.id === 'string' && payload.id.length > 0;
}

function isOptionalNodeIdPayload(payload: unknown): payload is { id?: string } {
  return payload === undefined || (
    isRecord(payload) && (payload.id === undefined || (typeof payload.id === 'string' && payload.id.length > 0))
  );
}

function isEditorRevealPayload(payload: unknown): payload is Omit<EditorRevealRequest, 'requestId'> {
  return (
    isRecord(payload) &&
    typeof payload.id === 'string' && payload.id.length > 0 &&
    Number.isInteger(payload.start) && (payload.start as number) >= 0 &&
    Number.isInteger(payload.end) && (payload.end as number) > (payload.start as number) &&
    (payload.revision === undefined || (Number.isInteger(payload.revision) && (payload.revision as number) >= 0))
  );
}

function isEditorSelectionSnapshot(payload: unknown): payload is EditorSelectionSnapshot {
  return (
    isRecord(payload) &&
    typeof payload.id === 'string' && payload.id.length > 0 &&
    Number.isInteger(payload.start) && (payload.start as number) >= 0 &&
    Number.isInteger(payload.end) && (payload.end as number) >= (payload.start as number)
    && (payload.focused === undefined || typeof payload.focused === 'boolean')
    && (payload.screenAnchor === undefined || (isRecord(payload.screenAnchor) &&
      Number.isFinite(payload.screenAnchor.x) && Number.isFinite(payload.screenAnchor.y)))
  );
}

function isWritingActivityRequest(payload: unknown): payload is WritingActivityRequest {
  return (
    isRecord(payload) &&
    typeof payload.nodeId === 'string' &&
    ['insert', 'composition', 'delete', 'paste', 'replace', 'move'].includes(String(payload.kind)) &&
    typeof payload.insertedText === 'string' &&
    typeof payload.deletedText === 'string'
  );
}
