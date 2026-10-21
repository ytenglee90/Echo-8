'use client';

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createId, type ViewClient } from '../core/contracts.ts';
import type {
  ColorPickerOpenRequest,
  ColorPickerPreview,
  ColorPickerResult,
} from '../protocols/appearance.ts';
import { useCommandAvailability } from './runtime-hooks.ts';

export function ColorPickerTrigger({
  client,
  value,
  label,
  className = '',
  onPreview,
  onCommit,
  onCancel,
}: {
  client: ViewClient;
  value: string;
  label: string;
  className?: string;
  onPreview?: (color: string) => void;
  onCommit: (color: string) => void;
  onCancel?: () => void;
}) {
  const [sessionId] = useState(() => createId('color-picker'));
  const active = useRef(false);
  const available = useCommandAvailability(client, 'palette.colorPicker.open');
  const callbacks = useRef({ onPreview, onCommit, onCancel });

  useEffect(() => {
    callbacks.current = { onPreview, onCommit, onCancel };
  }, [onCancel, onCommit, onPreview]);

  useEffect(
    () => client.subscribeSignal<ColorPickerPreview>('palette.colorPicker.preview', (message) => {
      if (message.payload.sessionId !== sessionId) return;
      callbacks.current.onPreview?.(message.payload.color);
    }),
    [client, sessionId],
  );

  useEffect(
    () => client.subscribeSignal<ColorPickerResult>('palette.colorPicker.result', (message) => {
      if (message.payload.sessionId !== sessionId) return;
      active.current = false;
      if (message.payload.committed) callbacks.current.onCommit(message.payload.color);
      else callbacks.current.onCancel?.();
    }),
    [client, sessionId],
  );

  useEffect(() => () => {
    if (!active.current) return;
    void client.dispatch('palette.colorPicker.close', { sessionId }).catch(() => undefined);
  }, [client, sessionId]);

  return (
    <button
      type="button"
      className={`color-picker-trigger ${className}`.trim()}
      aria-label={label}
      title={available ? label : '全局颜色设置插件未启用'}
      disabled={!available}
      style={{ '--color-picker-trigger-color': value } as CSSProperties}
      onClick={(event) => {
        if (!available) return;
        const rect = event.currentTarget.getBoundingClientRect();
        active.current = true;
        void client.dispatch('palette.colorPicker.open', {
          sessionId,
          color: value,
          anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        } satisfies ColorPickerOpenRequest).catch(() => {
          active.current = false;
          callbacks.current.onCancel?.();
        });
      }}
    >
      <i aria-hidden="true" />
    </button>
  );
}
