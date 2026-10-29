'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { AppearancePreview } from '../../protocols/appearance.ts';
import type { TextDocumentFormat } from '../../protocols/formatting.ts';
import {
  DEFAULT_TEXT_ASSIST_SETTINGS,
  type TextAssistResourceStatus,
  type TextAssistSettings,
} from '../../protocols/text-assist.ts';
import { ColorPickerTrigger } from '../../ui/ColorPickerTrigger.tsx';
import { scrollHorizontalOverflow } from '../../ui/horizontal-overflow.ts';
import { Icon, IconButton, type IconName } from '../../ui/Icon.tsx';
import { useNonPassiveWheel } from '../../ui/use-non-passive-wheel.ts';
import { FORMAT_STEP_OPTIONS } from './format-options.ts';

export interface TextAssistRuntime {
  available: boolean;
  settings: TextAssistSettings;
  resources?: TextAssistResourceStatus;
}

export function FormatBar({
  client,
  nodeId,
  textRange,
  format,
  brushActive,
  textAssist,
  onBrush,
  onEnterImmersive,
  onChange,
}: {
  client: ViewClient;
  nodeId: string;
  textRange?: NonNullable<AppearancePreview['textRange']>;
  format: TextDocumentFormat;
  brushActive?: boolean;
  textAssist: TextAssistRuntime;
  onBrush?: () => void;
  onEnterImmersive: () => void;
  onChange: (patch: Partial<TextDocumentFormat>) => void;
}) {
  const stripRef = useRef<HTMLFieldSetElement>(null);
  useNonPassiveWheel(stripRef, (event) => {
    const strip = stripRef.current;
    if (strip && scrollHorizontalOverflow(strip, event)) event.preventDefault();
  });
  return (
    <fieldset
      ref={stripRef}
      className="format-strip"
      aria-label="正文格式栏"
    >
      <legend>有选区时修改选区；没有选区时修改默认格式</legend>
      <IconButton
        icon="paintbrush"
        label={brushActive ? '取消格式刷' : '格式刷：先选中源文字，再点击目标文字'}
        className={`icon-button format-brush-button ${brushActive ? 'active' : ''}`}
        aria-pressed={brushActive}
        onClick={onBrush}
      />
      <FormatSelect icon="font-size" label="字号" value={format.fontSize} options={[...FORMAT_STEP_OPTIONS.fontSize]} onChange={(fontSize) => onChange({ fontSize })} suffix="px" />
      <FormatSelect icon="font-weight" label="字重" value={format.fontWeight} options={[...FORMAT_STEP_OPTIONS.fontWeight]} onChange={(fontWeight) => onChange({ fontWeight })} />
      <FormatSelect icon="line-height" label="行距" value={format.lineHeight} options={[...FORMAT_STEP_OPTIONS.lineHeight]} onChange={(lineHeight) => onChange({ lineHeight })} />
      <FormatSelect icon="letter-spacing" label="字距" value={format.letterSpacing} options={[...FORMAT_STEP_OPTIONS.letterSpacing]} onChange={(letterSpacing) => onChange({ letterSpacing })} suffix="px" />
      <FormatSelect icon="first-indent" label="首行缩进" value={format.firstLineIndent} options={[...FORMAT_STEP_OPTIONS.firstLineIndent]} onChange={(firstLineIndent) => onChange({ firstLineIndent })} suffix="字" />
      <FormatSelect icon="paragraph-spacing" label="段后空行" value={format.paragraphSpacing} options={[...FORMAT_STEP_OPTIONS.paragraphSpacing]} onChange={(paragraphSpacing) => onChange({ paragraphSpacing })} suffix="行" />
      <label className="format-control format-control-inline format-color-control" title="文字颜色">
        <Icon name="text-color" size={15} />
        <ColorPickerTrigger
          client={client}
          value={format.color}
          label="文字颜色"
          onPreview={(color) => client.emit('appearance.color.preview', {
            kind: 'text-color',
            color,
            entityIds: [nodeId],
            textRange,
          } satisfies AppearancePreview)}
          onCommit={(color) => {
            client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview);
            onChange({ color });
          }}
          onCancel={() => client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview)}
        />
      </label>
      {textAssist.available && (
        <span className="format-assist-actions" aria-label="文本辅助开关">
          <IconButton
            icon="spellcheck"
            label={correctionStatusLabel(textAssist)}
            className={`icon-button text-assist-toggle ${textAssist.settings.correctionEnabled ? 'active' : ''} ${resourceStatusClass(textAssist.resources)}`}
            busy={resourceStatusClass(textAssist.resources) === 'rules-loading'}
            aria-pressed={textAssist.settings.correctionEnabled}
            onClick={() => void client.dispatch('textAssist.toggleCorrection').catch(() => undefined)}
          />
          <IconButton
            icon="autocomplete"
            label={textAssist.settings.completionEnabled ? '文字补全已开启，点击关闭' : '文字补全已关闭，点击开启'}
            className={`icon-button text-assist-toggle ${textAssist.settings.completionEnabled ? 'active' : ''}`}
            aria-pressed={textAssist.settings.completionEnabled}
            onClick={() => void client.dispatch('textAssist.toggleCompletion').catch(() => undefined)}
          />
        </span>
      )}
      <span className="format-immersive-action">
        <IconButton
          icon="maximize"
          label="进入沉浸式写作"
          className="icon-button immersive-button"
          onClick={onEnterImmersive}
        />
      </span>
    </fieldset>
  );
}

export function useTextAssistRuntime(client: ViewClient): TextAssistRuntime {
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [runtime, setRuntime] = useState<TextAssistRuntime>({
    available: false,
    settings: { ...DEFAULT_TEXT_ASSIST_SETTINGS },
  });
  useEffect(
    () => client.subscribeSignal('text.assist.settings.changed', () => {
      setSettingsRevision((value) => value + 1);
    }),
    [client],
  );
  useEffect(
    () => client.subscribeSignal('text.assist.resources.status', () => {
      setSettingsRevision((value) => value + 1);
    }),
    [client],
  );
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      client.request<TextAssistSettings>('text.assist.settings@1', undefined, controller.signal),
      client.request<TextAssistResourceStatus>('text.assist.resources@3', undefined, controller.signal),
    ]).then(
      ([settings, resources]) => {
        if (!controller.signal.aborted) setRuntime({ available: true, settings, resources });
      },
      () => {
        if (!controller.signal.aborted) setRuntime({
          available: false,
          settings: { ...DEFAULT_TEXT_ASSIST_SETTINGS },
        });
      },
    );
    return () => controller.abort();
  }, [capabilityVersion, client, settingsRevision]);
  return runtime;
}

function correctionStatusLabel(runtime: TextAssistRuntime): string {
  const action = runtime.settings.correctionEnabled ? '点击关闭纠错' : '点击开启纠错';
  const status = runtime.resources;
  if (!status) return `文本纠错状态未知；${action}`;
  if (status.association.state === 'unassociated') {
    return status.ready
      ? `基础纠错规则已加载，完整 TXT 尚未导入；${action}`
      : `完整纠错规则尚未导入；${action}`;
  }
  if (status.usingLastValid) return `规则更新有问题，正在使用上一次有效版本；${action}`;
  if (!status.ready) return `纠错规则正在加载；${action}`;
  return `纠错规则已加载，共 ${status.correctionCount.toLocaleString()} 条固定纠错；${action}`;
}

function resourceStatusClass(status: TextAssistResourceStatus | undefined): string {
  if (!status || status.association.state === 'unassociated' || status.usingLastValid) return 'rules-warning';
  return status.ready ? 'rules-ready' : 'rules-loading';
}

function FormatSelect({
  icon,
  label,
  value,
  options,
  onChange,
  suffix = '',
}: {
  icon: IconName;
  label: string;
  value: number;
  options: number[];
  onChange: (value: number) => void;
  suffix?: string;
}) {
  return (
    <label className="format-control format-control-inline" title={label}>
      <Icon name={icon} size={15} />
      <select value={value} aria-label={label} onChange={(event) => onChange(Number(event.target.value))}>
        {options.map((option) => <option value={option} key={option}>{option}{suffix}</option>)}
      </select>
    </label>
  );
}
