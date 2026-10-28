'use client';

import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type {
  AppearancePreview,
  AppearanceTarget,
  PalettePanelState,
  PalettePreferencesPreview,
} from '../../protocols/appearance.ts';
import { ColorPickerTrigger } from '../../ui/ColorPickerTrigger.tsx';
import { IconButton } from '../../ui/Icon.tsx';
import { PALETTE_PRESETS, type PalettePreset, type PalettePresetId } from './presets.ts';

const EMPTY_STATE: PalettePanelState = {
  open: false,
  preferences: {
    themeId: 'light',
    editorBackground: '#f1f1ef',
    editorChromeBackground: '#ffffff',
    toolbarBackground: '#fafaf9',
    annotationColor: '#ff9f0a',
    groupBackground: '#202124',
  },
};

export function PalettePanel({ client }: { client: ViewClient }) {
  const paletteVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion('palette'),
    () => 0,
  );
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [state, setState] = useState<PalettePanelState>(EMPTY_STATE);
  const [canvasTarget, setCanvasTarget] = useState<AppearanceTarget>();
  const [connectionTarget, setConnectionTarget] = useState<AppearanceTarget>();
  const [canvasDraft, setCanvasDraft] = useState('#efefec');
  const [connectionDraft, setConnectionDraft] = useState('#888886');
  const [editorDraft, setEditorDraft] = useState(EMPTY_STATE.preferences.editorBackground);
  const [editorChromeDraft, setEditorChromeDraft] = useState(
    EMPTY_STATE.preferences.editorChromeBackground,
  );
  const [toolbarDraft, setToolbarDraft] = useState(EMPTY_STATE.preferences.toolbarBackground);
  const [annotationDraft, setAnnotationDraft] = useState(EMPTY_STATE.preferences.annotationColor);
  const [groupDraft, setGroupDraft] = useState(EMPTY_STATE.preferences.groupBackground);
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState<string>();
  const [applyingPreset, setApplyingPreset] = useState<PalettePresetId>();
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let current = true;
    void client.request<PalettePanelState>('palette.state@1').then((next) => {
      if (!current) return;
      setState(next);
      setEditorDraft(next.preferences.editorBackground);
      setEditorChromeDraft(next.preferences.editorChromeBackground);
      setToolbarDraft(next.preferences.toolbarBackground);
      setAnnotationDraft(next.preferences.annotationColor);
      setGroupDraft(next.preferences.groupBackground);
    });
    return () => {
      current = false;
    };
  }, [client, paletteVersion]);

  useEffect(() => {
    let current = true;
    if (!state.open) return () => {
      current = false;
    };
    void client.request<AppearanceTarget[]>('palette.targets@1').then(
      (targets) => {
        if (!current) return;
        const nextCanvasTarget = targets.find((candidate) => candidate.kind === 'canvas-background');
        const nextConnectionTarget = targets.find((candidate) => candidate.kind === 'connection-line');
        setCanvasTarget(nextCanvasTarget);
        setConnectionTarget(nextConnectionTarget);
        if (nextCanvasTarget) setCanvasDraft(nextCanvasTarget.color);
        if (nextConnectionTarget) setConnectionDraft(nextConnectionTarget.color);
        setError(undefined);
      },
      (reason) => current && setError(errorMessage(reason)),
    );
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, reloadToken, state.open]);

  useEffect(
    () => client.subscribeSignal('palette.targets.invalidated', () => {
      setReloadToken((value) => value + 1);
    }),
    [client],
  );

  useEffect(() => () => clearPreviews(client), [client]);

  if (!state.open) return null;

  const close = () => {
    clearPreviews(client);
    void client.dispatch('palette.close');
  };
  const previewCanvas = (color: string) => {
    if (!canvasTarget) return;
    setCanvasDraft(color);
    client.emit('appearance.color.preview', {
      kind: canvasTarget.kind,
      color,
      entityIds: canvasTarget.entities.map((entity) => entity.id),
    } satisfies AppearancePreview);
  };
  const applyCanvas = async (color: string) => {
    if (!canvasTarget) return;
    previewCanvas(color);
    try {
      await client.dispatch('palette.applyAppearance', {
        kind: canvasTarget.kind,
        color,
        entities: canvasTarget.entities,
      });
      client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview);
      setReloadToken((value) => value + 1);
      setError(undefined);
    } catch (reason) {
      client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview);
      setCanvasDraft(canvasTarget.color);
      setError(errorMessage(reason));
    }
  };
  const previewConnection = (color: string) => {
    if (!connectionTarget) return;
    setConnectionDraft(color);
    client.emit('appearance.color.preview', {
      kind: connectionTarget.kind,
      color,
      entityIds: connectionTarget.entities.map((entity) => entity.id),
    } satisfies AppearancePreview);
  };
  const applyConnection = async (color: string) => {
    if (!connectionTarget) return;
    previewConnection(color);
    try {
      await client.dispatch('palette.applyAppearance', {
        kind: connectionTarget.kind,
        color,
        entities: connectionTarget.entities,
      });
      client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview);
      setReloadToken((value) => value + 1);
      setError(undefined);
    } catch (reason) {
      client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview);
      setConnectionDraft(connectionTarget.color);
      setError(errorMessage(reason));
    }
  };
  const previewPreferences = (preview: PalettePreferencesPreview) => {
    client.emit('palette.preferences.preview', preview);
  };
  const applyPreferences = async (
    patch: Partial<Pick<
      PalettePanelState['preferences'],
      'themeId' | 'editorBackground' | 'editorChromeBackground' | 'toolbarBackground'
      | 'annotationColor'
      | 'groupBackground'
    >>,
  ) => {
    try {
      const preferences = await client.dispatch(
        'palette.setPreferences',
        patch,
      );
      setState((current) => ({ ...current, preferences }));
      setEditorDraft(preferences.editorBackground);
      setEditorChromeDraft(preferences.editorChromeBackground);
      setToolbarDraft(preferences.toolbarBackground);
      setAnnotationDraft(preferences.annotationColor);
      setGroupDraft(preferences.groupBackground);
      previewPreferences({ clear: true });
      setError(undefined);
    } catch (reason) {
      setEditorDraft(state.preferences.editorBackground);
      setEditorChromeDraft(state.preferences.editorChromeBackground);
      setToolbarDraft(state.preferences.toolbarBackground);
      setAnnotationDraft(state.preferences.annotationColor);
      setGroupDraft(state.preferences.groupBackground);
      previewPreferences({ clear: true });
      setError(errorMessage(reason));
    }
  };
  const applyPreset = async (preset: PalettePreset) => {
    clearPreviews(client);
    setApplyingPreset(preset.id);
    try {
      if (canvasTarget && canvasTarget.color.toLowerCase() !== preset.canvasBackground) {
        await client.dispatch('palette.applyAppearance', {
          kind: canvasTarget.kind,
          color: preset.canvasBackground,
          entities: canvasTarget.entities,
        });
      }
      const preferences = await client.dispatch('palette.setPreferences', preset.preferences);
      setState((current) => ({ ...current, preferences }));
      setCanvasDraft(preset.canvasBackground);
      setEditorDraft(preferences.editorBackground);
      setEditorChromeDraft(preferences.editorChromeBackground);
      setToolbarDraft(preferences.toolbarBackground);
      setAnnotationDraft(preferences.annotationColor);
      setGroupDraft(preferences.groupBackground);
      setReloadToken((value) => value + 1);
      setError(undefined);
    } catch (reason) {
      setReloadToken((value) => value + 1);
      setError(errorMessage(reason));
    } finally {
      setApplyingPreset(undefined);
    }
  };
  const resetColors = async () => {
    clearPreviews(client);
    setResetting(true);
    try {
      await client.dispatch('palette.resetAppearance');
      const preferences = await client.dispatch('palette.setPreferences', EMPTY_STATE.preferences);
      setState((current) => ({ ...current, preferences }));
      setCanvasDraft('#efefec');
      setConnectionDraft('#888886');
      setEditorDraft(preferences.editorBackground);
      setEditorChromeDraft(preferences.editorChromeBackground);
      setToolbarDraft(preferences.toolbarBackground);
      setAnnotationDraft(preferences.annotationColor);
      setGroupDraft(preferences.groupBackground);
      setReloadToken((value) => value + 1);
      setError(undefined);
    } catch (reason) {
      setReloadToken((value) => value + 1);
      setError(errorMessage(reason));
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="palette-panel global-color-settings-panel" aria-label="全局颜色设置">
      <div className="panel-heading palette-heading">
        <div>
          <span className="eyebrow">外观</span>
          <h2>全局颜色设置</h2>
        </div>
        <div className="palette-heading-actions">
          <IconButton
            icon="reset"
            label={resetting ? '正在重置全部颜色' : '重置全部颜色'}
            disabled={resetting || applyingPreset !== undefined}
            onClick={() => void resetColors()}
          />
          <IconButton icon="close" label="关闭全局颜色设置" onClick={close} />
        </div>
      </div>

      <PaletteSetting title="配套主题" description="一键统一画布与界面颜色，可继续逐项微调。">
        <div className="palette-presets" role="group" aria-label="配套主题">
          {PALETTE_PRESETS.map((preset) => {
            const active = presetMatches(preset, state.preferences, canvasTarget?.color);
            return (
              <button
                type="button"
                className={active ? 'selected' : ''}
                aria-pressed={active}
                aria-label={`${preset.key} ${preset.label}：${preset.description}`}
                disabled={applyingPreset !== undefined}
                onClick={() => void applyPreset(preset)}
                key={preset.id}
              >
                <span className="palette-preset-swatches" aria-hidden="true">
                  <i style={{ background: preset.preferences.toolbarBackground }} />
                  <i style={{ background: preset.canvasBackground }} />
                  <i style={{ background: preset.preferences.editorBackground }} />
                </span>
                <strong>{preset.key} {preset.label}</strong>
                <small>{applyingPreset === preset.id ? '应用中…' : preset.description}</small>
              </button>
            );
          })}
        </div>
      </PaletteSetting>

      <PaletteSetting title="画布背景颜色" description="保存到当前画布，可撤销和重做。">
        {canvasTarget ? (
          <ColorRow
            client={client}
            label="画布背景"
            color={canvasDraft}
            onPreview={previewCanvas}
            onCommit={(color) => void applyCanvas(color)}
            onCancel={() => {
              setCanvasDraft(canvasTarget.color);
              client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview);
            }}
          />
        ) : (
          <p className="palette-empty">画布颜色功能暂不可用。</p>
        )}
      </PaletteSetting>

      <PaletteSetting
        title="连接曲线颜色"
        description="应用到全部曲线和文字；对比不足时自动校正明暗度。"
      >
        {connectionTarget ? (
          <ColorRow
            client={client}
            label="连接曲线"
            color={connectionDraft}
            onPreview={previewConnection}
            onCommit={(color) => void applyConnection(color)}
            onCancel={() => {
              setConnectionDraft(connectionTarget.color);
              client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview);
            }}
          />
        ) : (
          <p className="palette-empty">连接曲线颜色功能暂不可用。</p>
        )}
      </PaletteSetting>

      <PaletteSetting title="群组底色" description="应用到所有群组，系统自动加入透明度。">
        <ColorRow
          client={client}
          label="群组底色"
          color={groupDraft}
          onPreview={(color) => {
            setGroupDraft(color);
            previewPreferences({ groupBackground: color });
          }}
          onCommit={(color) => void applyPreferences({ groupBackground: color })}
          onCancel={() => {
            setGroupDraft(state.preferences.groupBackground);
            previewPreferences({ clear: true });
          }}
        />
      </PaletteSetting>

      <PaletteSetting title="文本编辑区背景" description="应用到普通编辑区和沉浸写作。">
        <ColorRow
          client={client}
          label="文本编辑区背景"
          color={editorDraft}
          onPreview={(color) => {
            setEditorDraft(color);
            previewPreferences({ editorBackground: color });
          }}
          onCommit={(color) => void applyPreferences({ editorBackground: color })}
          onCancel={() => {
            setEditorDraft(state.preferences.editorBackground);
            previewPreferences({ clear: true });
          }}
        />
      </PaletteSetting>

      <PaletteSetting
        title="文本编辑区栏颜色"
        description="统一调整标题栏、格式栏和状态栏，并自动反色。"
      >
        <ColorRow
          client={client}
          label="文本编辑区栏"
          color={editorChromeDraft}
          onPreview={(color) => {
            setEditorChromeDraft(color);
            previewPreferences({ editorChromeBackground: color });
          }}
          onCommit={(color) => void applyPreferences({ editorChromeBackground: color })}
          onCancel={() => {
            setEditorChromeDraft(state.preferences.editorChromeBackground);
            previewPreferences({ clear: true });
          }}
        />
      </PaletteSetting>

      <PaletteSetting title="导航栏颜色" description="图标、文字和选中状态会自动反色。">
        <ColorRow
          client={client}
          label="导航栏"
          color={toolbarDraft}
          onPreview={(color) => {
            setToolbarDraft(color);
            previewPreferences({ toolbarBackground: color });
          }}
          onCommit={(color) => void applyPreferences({ toolbarBackground: color })}
          onCancel={() => {
            setToolbarDraft(state.preferences.toolbarBackground);
            previewPreferences({ clear: true });
          }}
        />
      </PaletteSetting>

      <PaletteSetting title="注释标记颜色" description="应用到节点、群组和正文里的注释标记，图标自动反色。">
        <ColorRow
          client={client}
          label="注释标记"
          color={annotationDraft}
          onPreview={(color) => {
            setAnnotationDraft(color);
            previewPreferences({ annotationColor: color });
          }}
          onCommit={(color) => void applyPreferences({ annotationColor: color })}
          onCancel={() => {
            setAnnotationDraft(state.preferences.annotationColor);
            previewPreferences({ clear: true });
          }}
        />
      </PaletteSetting>

      {error && <p className="palette-error" role="alert">{error}</p>}
    </section>
  );
}

function PaletteSetting({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="palette-setting-card">
      <div className="palette-section-title">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      {children}
    </section>
  );
}

function ColorRow({
  client,
  label,
  color,
  onPreview,
  onCommit,
  onCancel,
}: {
  client: ViewClient;
  label: string;
  color: string;
  onPreview: (color: string) => void;
  onCommit: (color: string) => void;
  onCancel?: () => void;
}) {
  return (
    <div className="palette-color-row">
      <label>
        <span className="sr-only">{label}颜色</span>
        <ColorPickerTrigger
          client={client}
          value={color}
          label={`${label}颜色`}
          onPreview={onPreview}
          onCommit={onCommit}
          onCancel={onCancel}
        />
        <code>{color.toUpperCase()}</code>
      </label>
    </div>
  );
}

function clearPreviews(client: ViewClient) {
  client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview);
  client.emit('palette.preferences.preview', { clear: true } satisfies PalettePreferencesPreview);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function presetMatches(
  preset: PalettePreset,
  preferences: PalettePanelState['preferences'],
  canvasColor?: string,
): boolean {
  if (!canvasColor || canvasColor.toLowerCase() !== preset.canvasBackground) return false;
  return (Object.keys(preset.preferences) as Array<keyof typeof preset.preferences>)
    .every((key) => preferences[key].toLowerCase() === preset.preferences[key].toLowerCase());
}
