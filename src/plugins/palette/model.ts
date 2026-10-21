import { isRecord, type PluginContext, type PluginDefinition } from '../../core/contracts.ts';
import type {
  AppearanceReadContribution,
  AppearanceReadRequest,
  AppearancePreview,
  AppearanceTarget,
  AppearanceUpdatePlan,
  AppearanceUpdateRequest,
  ColorPickerCloseRequest,
  ColorPickerCommitRequest,
  ColorPickerOpenRequest,
  ColorPickerResult,
  ColorPickerState,
  NodeTitleColorPickerOpenRequest,
  NodeTitleColorPickerState,
  PalettePanelState,
  PalettePreferences,
  PalettePreferencesPatch,
  PalettePreferencesPreview,
  PaletteTitleColorRecord,
} from '../../protocols/appearance.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import type { ThemeDefinition } from '../../protocols/theme.ts';
import { defineManifest } from '../manifest.ts';

const PALETTE_NAMESPACE = 'palette';

export const LIGHT_THEME: ThemeDefinition = {
  id: 'light',
  label: '明亮',
  mode: 'light',
  tokens: {
    surface: '#f5f5f3',
    panel: '#ffffff',
    panelSoft: 'rgba(255, 255, 255, 0.88)',
    ink: '#18181a',
    muted: '#707075',
    faint: '#a7a7ac',
    border: 'rgba(24, 24, 27, 0.11)',
    borderStrong: 'rgba(24, 24, 27, 0.2)',
    accent: '#202124',
    accentSoft: '#ececeb',
    success: '#27855a',
    danger: '#c83d43',
    toolbar: 'rgba(250, 250, 249, 0.92)',
    rail: '#fafaf9',
    status: '#fafaf9',
    canvas: '#efefec',
    canvasGrid: 'rgba(24, 24, 27, 0.15)',
    nodeSurface: 'rgba(255, 255, 255, 0.97)',
    editor: '#f1f1ef',
    editorPaper: '#ffffff',
    editorChrome: '#ffffff',
    annotation: '#ff9f0a',
    groupBackground: '#202124',
    control: '#f1f1ef',
    selection: '#111114',
  },
};

export const DARK_THEME: ThemeDefinition = {
  id: 'dark',
  label: '深色',
  mode: 'dark',
  tokens: {
    surface: '#111214',
    panel: '#1b1c1f',
    panelSoft: 'rgba(27, 28, 31, 0.9)',
    ink: '#f2f2f3',
    muted: '#a3a3aa',
    faint: '#707078',
    border: 'rgba(255, 255, 255, 0.11)',
    borderStrong: 'rgba(255, 255, 255, 0.22)',
    accent: '#f1f1f2',
    accentSoft: '#2b2c30',
    success: '#58b88a',
    danger: '#f06b70',
    toolbar: 'rgba(20, 21, 23, 0.94)',
    rail: '#151619',
    status: '#151619',
    canvas: '#18191b',
    canvasGrid: 'rgba(255, 255, 255, 0.1)',
    nodeSurface: 'rgba(250, 250, 249, 0.98)',
    editor: '#202125',
    editorPaper: '#ffffff',
    editorChrome: '#1b1c1f',
    annotation: '#ffb340',
    groupBackground: '#f1f1f2',
    control: '#26272b',
    selection: '#f5f5f6',
  },
};

type ColorPickerRuntimeState = ColorPickerOpenRequest & {
  appearanceRequest?: Omit<AppearanceUpdateRequest, 'color'>;
  appearancePreview?: AppearancePreview;
  legacyTargets?: NodeTitleColorPickerOpenRequest['targets'];
};

export function createPalettePlugin(panel?: unknown, colorPicker?: unknown): PluginDefinition {
  let colorPickerState: ColorPickerRuntimeState | undefined;
  return {
    manifest: defineManifest('palette', '全局颜色设置', {
      namespaces: [PALETTE_NAMESPACE],
      namespaceDomains: { [PALETTE_NAMESPACE]: 'workspace' },
      optionalCapabilities: [
        'appearance.read@1',
        'appearance.updatePlan@1',
        'selection.read@1',
        'editor.activeNode@1',
        'content.summaries@1',
      ],
      providesCapabilities: ['palette.state@1', 'palette.targets@1', 'palette.titleColors@1'],
      commands: [
        'palette.open',
        'palette.close',
        'palette.setPreferences',
        'palette.applyAppearance',
        'palette.colorPicker.open',
        'palette.colorPicker.commit',
        'palette.colorPicker.close',
        'palette.nodeTitlePicker.open',
        'palette.nodeTitlePicker.close',
      ],
      events: [
        'palette.preferences.changed',
        'selection.changed',
        'editor.panes.changed',
        'editor.active.changed',
        'node.appearance.changed',
        'canvas.appearance.changed',
        'connection.appearance.changed',
        'content.format.changed',
        'history.changed',
        'document.replaced',
      ],
      signals: [
        'appearance.color.preview',
        'palette.targets.invalidated',
        'palette.colorPicker.preview',
        'palette.colorPicker.result',
        'palette.nodeTitlePicker.changed',
        'palette.preferences.preview',
      ],
      queries: ['palette.colorPicker.state', 'palette.nodeTitlePicker.state'],
      ui: ['palette.panel', 'palette.node-title-picker'],
      actions: ['palette.open-action'],
      shortcuts: [
        'palette.open-shortcut',
        'palette.close-shortcut',
      ],
      themes: ['light', 'dark'],
      permissions: [
        'store.own.read',
        'store.own.write',
        'ui.right.contribute',
        'ui.modal.contribute',
        'ui.action.register',
        'ui.shortcut.register',
        'ui.theme.manage',
      ],
    }),

    start(context) {
      colorPickerState = undefined;
      context.ui.theme(LIGHT_THEME);
      context.ui.theme(DARK_THEME);

      const readPreferences = (): PalettePreferences => normalizePreferences(
        context.store.readValue(PALETTE_NAMESPACE, 'preferences'),
      );
      const applyTheme = (preview?: PalettePreferencesPreview) => {
        const preferences = readPreferences();
        const editorBackground = preview?.editorBackground ?? preferences.editorBackground;
        const editorChromeBackground = preview?.editorChromeBackground ?? preferences.editorChromeBackground;
        const toolbarBackground = preview?.toolbarBackground ?? preferences.toolbarBackground;
        const annotationColor = preview?.annotationColor ?? preferences.annotationColor;
        const groupBackground = preview?.groupBackground ?? preferences.groupBackground;
        context.ui.activateTheme(preferences.themeId, {
          editor: editorBackground,
          editorPaper: editorBackground,
          editorChrome: editorChromeBackground,
          toolbar: toolbarBackground,
          annotation: annotationColor,
          groupBackground,
        });
      };
      const readState = (): PalettePanelState => ({
        open: context.store.readValue<boolean>(PALETTE_NAMESPACE, 'open') ?? false,
        preferences: readPreferences(),
      });
      const readTitleColors = async (): Promise<PaletteTitleColorRecord[]> => {
        let summaries: ContentSummary[];
        try {
          summaries = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
        } catch {
          return [];
        }
        const counts = new Map<string, number>();
        for (const node of summaries) {
          const color = node.titleColor.toLowerCase();
          counts.set(color, (counts.get(color) ?? 0) + 1);
        }
        return [...counts.entries()]
          .map(([color, count]) => ({ color, count }))
          .sort((left, right) => right.count - left.count || left.color.localeCompare(right.color));
      };
      const readCanvasColors = async (): Promise<PaletteTitleColorRecord[]> => {
        let summaries: ContentSummary[];
        try {
          summaries = await context.capabilities.request<ContentSummary[]>('content.summaries@1');
        } catch {
          summaries = [];
        }
        const counts = new Map<string, number>();
        const add = (color: string | undefined) => {
          if (!color || !isHexColor(color)) return;
          const normalized = color.toLowerCase();
          counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
        };
        for (const node of summaries) {
          add(node.titleColor);
          add(node.textColor);
        }
        try {
          const contributions = await context.capabilities.requestAll<AppearanceReadContribution>(
            'appearance.read@1',
            { selectedIds: [] } satisfies AppearanceReadRequest,
          );
          for (const target of contributions.flatMap((contribution) => contribution.targets)) add(target.color);
        } catch {
          // Appearance providers are optional; node colors remain available.
        }
        const preferences = readPreferences();
        add(preferences.editorBackground);
        add(preferences.editorChromeBackground);
        add(preferences.toolbarBackground);
        add(preferences.annotationColor);
        add(preferences.groupBackground);
        return [...counts.entries()]
          .map(([color, count]) => ({ color, count }))
          .sort((left, right) => right.count - left.count || left.color.localeCompare(right.color));
      };
      const appearanceUpdate = async (payload: AppearanceUpdateRequest) => {
        const plans = await context.capabilities.requestAll<AppearanceUpdatePlan>(
          'appearance.updatePlan@1',
          { ...payload, color: payload.color.toLowerCase() },
        );
        const changed = plans.reduce((total, plan) => total + plan.changed, 0);
        const patches = plans.flatMap((plan) => plan.patches);
        if (patches.length === 0) return { result: { changed } };
        return {
          result: { changed },
          transaction: {
            label: appearanceLabel(payload, changed),
            patches,
            events: plans.flatMap((plan) => plan.events ?? []),
          },
        };
      };
      const emitPickerResult = (committed: boolean, color?: string) => {
        if (!colorPickerState) return;
        context.signals.emit('palette.colorPicker.result', {
          sessionId: colorPickerState.sessionId,
          color: (color ?? colorPickerState.color).toLowerCase(),
          committed,
        } satisfies ColorPickerResult);
      };
      const closePicker = (payload?: ColorPickerCloseRequest) => {
        if (!colorPickerState) return { result: { closed: false } };
        if (payload?.sessionId && payload.sessionId !== colorPickerState.sessionId) {
          return { result: { closed: false } };
        }
        if (!payload?.silent) emitPickerResult(false);
        colorPickerState = undefined;
        context.signals.emit('appearance.color.preview', { clear: true });
        context.signals.emit('palette.nodeTitlePicker.changed', { open: false });
        context.ui.deactivateSurface('overlay.modal', 'palette.node-title-picker');
        return { result: { closed: true } };
      };
      const openPicker = (next: typeof colorPickerState) => {
        if (!next) throw new Error('取色器请求不能为空');
        if (colorPickerState) emitPickerResult(false);
        colorPickerState = structuredClone(next);
        context.ui.activateSurface(
          'overlay.modal',
          'palette.node-title-picker',
          'palette.colorPicker.close',
        );
        context.signals.emit('palette.nodeTitlePicker.changed', { open: true });
        return { result: { opened: true as const } };
      };

      context.commands.register({
        type: 'palette.open',
        handle: () => {
          context.ui.activateSurface('right.primary', 'palette.panel', 'palette.close');
          return workspaceStateTransaction('打开全局颜色设置', 'open', true);
        },
      });
      context.commands.register({
        type: 'palette.close',
        handle: () => {
          context.signals.emit('palette.preferences.preview', { clear: true });
          context.ui.deactivateSurface('right.primary', 'palette.panel');
          return workspaceStateTransaction('关闭全局颜色设置', 'open', false);
        },
      });
      context.commands.register({
        type: 'palette.setPreferences',
        validate: isPreferencesPatch,
        handle: (payload) => {
          const current = readPreferences();
          const themeId = payload.themeId ?? current.themeId;
          const theme = themeId === 'dark' ? DARK_THEME : LIGHT_THEME;
          const preferences: PalettePreferences = {
            themeId,
            editorBackground: payload.editorBackground ??
              (payload.themeId && payload.themeId !== current.themeId ? theme.tokens.editor : current.editorBackground),
            editorChromeBackground: payload.editorChromeBackground ??
              (payload.themeId && payload.themeId !== current.themeId
                ? theme.tokens.editorChrome
                : current.editorChromeBackground),
            toolbarBackground: payload.toolbarBackground ?? current.toolbarBackground,
            annotationColor: payload.annotationColor ?? current.annotationColor,
            groupBackground: payload.groupBackground ?? current.groupBackground,
          };
          if (preferences.themeId === current.themeId &&
            preferences.editorBackground === current.editorBackground &&
            preferences.editorChromeBackground === current.editorChromeBackground &&
            preferences.toolbarBackground === current.toolbarBackground &&
            preferences.annotationColor === current.annotationColor &&
            preferences.groupBackground === current.groupBackground) {
            return { result: current };
          }
          return {
            result: preferences,
            transaction: {
              label: '更新界面主题',
              history: false,
              patches: [{
                op: 'set',
                domain: 'workspace',
                namespace: PALETTE_NAMESPACE,
                key: 'preferences',
                value: preferences,
              }],
              events: [{ type: 'palette.preferences.changed', payload: preferences }],
            },
          };
        },
      });
      context.commands.register<AppearanceUpdateRequest, { changed: number }>({
        type: 'palette.applyAppearance',
        validate: isAppearanceUpdateRequest,
        handle: appearanceUpdate,
      });
      context.commands.register<ColorPickerOpenRequest, { opened: true }>({
        type: 'palette.colorPicker.open',
        validate: isColorPickerOpenRequest,
        handle: (payload) => openPicker(payload),
      });
      context.commands.register<ColorPickerCommitRequest>({
        type: 'palette.colorPicker.commit',
        validate: isColorPickerCommitRequest,
        handle: async (payload) => {
          if (!colorPickerState || payload.sessionId !== colorPickerState.sessionId) {
            return { result: { committed: false } };
          }
          colorPickerState.color = payload.color.toLowerCase();
          if (!colorPickerState.appearanceRequest) return { result: { committed: true } };
          return appearanceUpdate({
            ...colorPickerState.appearanceRequest,
            color: payload.color,
          });
        },
      });
      context.commands.register<ColorPickerCloseRequest>({
        type: 'palette.colorPicker.close',
        validate: isColorPickerCloseRequest,
        handle: closePicker,
      });
      context.commands.register<NodeTitleColorPickerOpenRequest, { opened: true }>({
        type: 'palette.nodeTitlePicker.open',
        validate: isNodeTitleColorPickerOpenRequest,
        handle: (payload) => openPicker({
          sessionId: `node-title:${payload.targets.map((target) => `${target.id}:${target.revision}`).join(',')}`,
          color: payload.targets[0].expectedColor,
          anchor: payload.anchor,
          appearanceRequest: {
            kind: 'node-title',
            entities: payload.targets,
          },
          appearancePreview: {
            kind: 'node-title',
            entityIds: payload.targets.map((target) => target.id),
          },
          legacyTargets: payload.targets,
        }),
      });
      context.commands.register({
        type: 'palette.nodeTitlePicker.close',
        handle: () => closePicker(),
      });
      context.queries.register<undefined, ColorPickerState | undefined>({
        type: 'palette.colorPicker.state',
        handle: async () => colorPickerState ? {
          sessionId: colorPickerState.sessionId,
          color: colorPickerState.color,
          anchor: structuredClone(colorPickerState.anchor),
          open: true,
          colors: await readCanvasColors(),
          appearancePreview: colorPickerState.appearancePreview
            ? structuredClone(colorPickerState.appearancePreview)
            : undefined,
        } : undefined,
      });
      context.queries.register<undefined, NodeTitleColorPickerState | undefined>({
        type: 'palette.nodeTitlePicker.state',
        handle: async () => colorPickerState?.legacyTargets ? {
          targets: structuredClone(colorPickerState.legacyTargets),
          anchor: structuredClone(colorPickerState.anchor),
          open: true,
          titleColors: await readTitleColors(),
        } : undefined,
      });

      context.events.subscribe('palette.preferences.changed', () => applyTheme());
      context.signals.subscribe<PalettePreferencesPreview>('palette.preferences.preview', (message) => {
        applyTheme(message.payload.clear ? undefined : message.payload);
      });
      const invalidateTargets = () => context.signals.emit('palette.targets.invalidated');
      context.events.subscribe('selection.changed', invalidateTargets);
      context.events.subscribe('editor.panes.changed', invalidateTargets);
      context.events.subscribe('editor.active.changed', invalidateTargets);
      context.events.subscribe('node.appearance.changed', invalidateTargets);
      context.events.subscribe('canvas.appearance.changed', invalidateTargets);
      context.events.subscribe('connection.appearance.changed', invalidateTargets);
      context.events.subscribe('content.format.changed', invalidateTargets);
      context.events.subscribe('history.changed', invalidateTargets);
      context.events.subscribe('document.replaced', invalidateTargets);
      context.capabilities.provide({ key: 'palette.state@1', invoke: readState });
      context.capabilities.provide<undefined, AppearanceTarget[]>({
        key: 'palette.targets@1',
        invoke: async () => {
          const request = await resolveAppearanceScope(context);
          const contributions = await context.capabilities.requestAll<AppearanceReadContribution>(
            'appearance.read@1',
            request,
          );
          const targets = contributions.flatMap((contribution) => contribution.targets);
          const duplicates = targets.filter(
            (target, index) => targets.findIndex((candidate) => candidate.kind === target.kind) !== index,
          );
          if (duplicates.length > 0) throw new Error(`外观能力冲突：${duplicates[0].kind}`);
          return targets;
        },
      });
      context.capabilities.provide<undefined, PaletteTitleColorRecord[]>({
        key: 'palette.titleColors@1',
        invoke: readTitleColors,
      });

      context.ui.contribute({
        id: 'palette.panel',
        slot: 'right.primary',
        kind: 'view',
        label: '全局颜色设置',
        component: panel,
      });
      context.ui.contribute({
        id: 'palette.node-title-picker',
        slot: 'overlay.modal',
        kind: 'view',
        label: '全局取色器',
        component: colorPicker,
        priority: 45,
      });
      context.ui.shortcut({
        id: 'palette.open-shortcut',
        chord: 'mod+shift+c',
        command: 'palette.open',
        label: '打开全局颜色设置',
      });
      context.ui.shortcut({
        id: 'palette.close-shortcut',
        command: 'palette.close',
        label: '关闭全局颜色设置',
        category: '外观',
      });
      context.ui.action({
        id: 'palette.open-action',
        label: '打开全局颜色设置',
        command: 'palette.open',
        category: '外观',
        keywords: ['全局颜色', '主题', '颜色', '背景', 'theme'],
        priority: 30,
      });

      applyTheme();
      if (readState().open) {
        context.ui.activateSurface('right.primary', 'palette.panel', 'palette.close');
      }
    },
    stop(context) {
      if (colorPickerState) {
        context.signals.emit('palette.colorPicker.result', {
          sessionId: colorPickerState.sessionId,
          color: colorPickerState.color.toLowerCase(),
          committed: false,
        } satisfies ColorPickerResult);
        context.signals.emit('palette.nodeTitlePicker.changed', { open: false });
        colorPickerState = undefined;
      }
      context.signals.emit('appearance.color.preview', { clear: true });
      context.signals.emit('palette.preferences.preview', { clear: true });
      context.ui.deactivateSurface('overlay.modal', 'palette.node-title-picker');
      context.ui.deactivateSurface('right.primary', 'palette.panel');
    },
  };
}

async function resolveAppearanceScope(context: PluginContext): Promise<AppearanceReadRequest> {
  let selectedIds: string[] = [];
  let activeNodeId: string | undefined;
  try {
    const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1');
    selectedIds = selection.ids;
  } catch {
    // Selection is optional; canvas appearance remains available without it.
  }
  try {
    activeNodeId = await context.capabilities.request<string | undefined>('editor.activeNode@1');
  } catch {
    // Editor is optional; selected text nodes become the body-color scope.
  }
  return { selectedIds, activeNodeId };
}

function workspaceStateTransaction(label: string, key: string, value: unknown) {
  return {
    transaction: {
      label,
      history: false,
      patches: [{ op: 'set' as const, domain: 'workspace' as const, namespace: PALETTE_NAMESPACE, key, value }],
    },
  };
}

function normalizePreferences(value: unknown): PalettePreferences {
  const themeId = isRecord(value) && (value.themeId === 'light' || value.themeId === 'dark')
    ? value.themeId
    : 'light';
  const theme = themeId === 'dark' ? DARK_THEME : LIGHT_THEME;
  const editorBackground = isRecord(value) && typeof value.editorBackground === 'string' &&
    isHexColor(value.editorBackground)
    ? value.editorBackground.toLowerCase()
    : theme.tokens.editor;
  const editorChromeBackground = isRecord(value) && typeof value.editorChromeBackground === 'string' &&
    isHexColor(value.editorChromeBackground)
    ? value.editorChromeBackground.toLowerCase()
    : theme.tokens.editorChrome;
  const toolbarBackground = isRecord(value) && typeof value.toolbarBackground === 'string' &&
    isHexColor(value.toolbarBackground)
    ? value.toolbarBackground.toLowerCase()
    : themeId === 'dark' ? '#141517' : '#fafaf9';
  const annotationColor = isRecord(value) && typeof value.annotationColor === 'string' &&
    isHexColor(value.annotationColor)
    ? value.annotationColor.toLowerCase()
    : theme.tokens.annotation;
  const groupBackground = isRecord(value) && typeof value.groupBackground === 'string' &&
    isHexColor(value.groupBackground)
    ? value.groupBackground.toLowerCase()
    : theme.tokens.groupBackground;
  return {
    themeId,
    editorBackground,
    editorChromeBackground,
    toolbarBackground,
    annotationColor,
    groupBackground,
  };
}

function isPreferencesPatch(value: unknown): value is PalettePreferencesPatch {
  return isRecord(value) &&
    Object.keys(value).every((key) =>
      key === 'themeId' || key === 'editorBackground' || key === 'editorChromeBackground' ||
      key === 'toolbarBackground' || key === 'annotationColor' || key === 'groupBackground') &&
    (value.themeId === undefined || value.themeId === 'light' || value.themeId === 'dark') &&
    (value.editorBackground === undefined || typeof value.editorBackground === 'string' &&
      isHexColor(value.editorBackground)) &&
    (value.editorChromeBackground === undefined || typeof value.editorChromeBackground === 'string' &&
      isHexColor(value.editorChromeBackground)) &&
    (value.toolbarBackground === undefined || typeof value.toolbarBackground === 'string' &&
      isHexColor(value.toolbarBackground)) &&
    (value.annotationColor === undefined || typeof value.annotationColor === 'string' &&
      isHexColor(value.annotationColor)) &&
    (value.groupBackground === undefined || typeof value.groupBackground === 'string' &&
      isHexColor(value.groupBackground));
}

function isAppearanceUpdateRequest(value: unknown): value is AppearanceUpdateRequest {
  return isRecord(value) &&
    (value.kind === 'canvas-background' || value.kind === 'connection-line' ||
      value.kind === 'node-title' || value.kind === 'text-color') &&
    typeof value.color === 'string' && isHexColor(value.color) &&
    Array.isArray(value.entities) && value.entities.length > 0 &&
    value.entities.every((entity) => isRecord(entity) &&
      typeof entity.id === 'string' &&
      Number.isInteger(entity.revision) &&
      typeof entity.expectedColor === 'string' &&
      isHexColor(entity.expectedColor));
}

function isNodeTitleColorPickerOpenRequest(value: unknown): value is NodeTitleColorPickerOpenRequest {
  return isRecord(value) &&
    Array.isArray(value.targets) && value.targets.length > 0 &&
    value.targets.every((target) => isRecord(target) &&
      typeof target.id === 'string' &&
      Number.isInteger(target.revision) &&
      typeof target.expectedColor === 'string' &&
      isHexColor(target.expectedColor)) &&
    isRecord(value.anchor) &&
    Number.isFinite(value.anchor.x) &&
    Number.isFinite(value.anchor.y) &&
    Number.isFinite(value.anchor.width) && (value.anchor.width as number) >= 0 &&
    Number.isFinite(value.anchor.height) && (value.anchor.height as number) >= 0;
}

function isColorPickerOpenRequest(value: unknown): value is ColorPickerOpenRequest {
  return isRecord(value) &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
    typeof value.color === 'string' && isHexColor(value.color) &&
    isPaletteAnchor(value.anchor);
}

function isColorPickerCommitRequest(value: unknown): value is ColorPickerCommitRequest {
  return isRecord(value) &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
    typeof value.color === 'string' && isHexColor(value.color);
}

function isColorPickerCloseRequest(value: unknown): value is ColorPickerCloseRequest {
  return value === undefined || isRecord(value) &&
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    (value.silent === undefined || typeof value.silent === 'boolean');
}

function isPaletteAnchor(value: unknown): value is ColorPickerOpenRequest['anchor'] {
  return isRecord(value) &&
    Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Number.isFinite(value.width) && (value.width as number) >= 0 &&
    Number.isFinite(value.height) && (value.height as number) >= 0;
}

function appearanceLabel(input: AppearanceUpdateRequest, changed: number): string {
  const name = input.kind === 'canvas-background'
    ? '画布背景'
    : input.kind === 'connection-line'
      ? '连接曲线'
      : input.kind === 'node-title'
        ? '节点标题栏'
        : '正文文字';
  return changed > 1 ? `修改 ${changed} 个${name}颜色` : `修改${name}颜色`;
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/iu.test(value);
}
