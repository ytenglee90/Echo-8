'use client';

import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type {
  AppearancePreview,
  ColorPickerPreview,
  ColorPickerResult,
  ColorPickerState,
} from '../../protocols/appearance.ts';

const PICKER_WIDTH = 232;
const PICKER_HEIGHT_ESTIMATE = 330;
const VIEWPORT_MARGIN = 12;

export function GlobalColorPicker({ client }: { client: ViewClient }) {
  const [state, setState] = useState<ColorPickerState>();
  const [color, setColor] = useState('#222124');
  const [hue, setHue] = useState(0);
  const [error, setError] = useState('');
  const finishing = useRef(false);

  useEffect(() => {
    let current = true;
    void client.ask<ColorPickerState | undefined>('palette.colorPicker.state').then(
      (next) => {
        if (!current || !next) return;
        const initial = next.color.toLowerCase();
        setState(next);
        setColor(initial);
        setHue(rgbToHsv(hexToRgb(initial)).h);
      },
      (reason) => current && setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      current = false;
      client.emit('appearance.color.preview', { clear: true } satisfies AppearancePreview);
    };
  }, [client]);

  const rgb = useMemo(() => hexToRgb(color), [color]);
  const hsv = useMemo(() => rgbToHsv(rgb, hue), [hue, rgb]);
  if (!state) return null;

  const close = () => void client.dispatch('palette.colorPicker.close', { sessionId: state.sessionId });
  const preview = (next: string, nextHue?: number) => {
    const normalized = next.toLowerCase();
    const resolvedHue = nextHue ?? rgbToHsv(hexToRgb(normalized), hue).h;
    setError('');
    setColor(normalized);
    setHue(resolvedHue);
    client.emit('palette.colorPicker.preview', {
      sessionId: state.sessionId,
      color: normalized,
    } satisfies ColorPickerPreview);
    if (state.appearancePreview) {
      client.emit('appearance.color.preview', {
        ...state.appearancePreview,
        color: normalized,
      } satisfies AppearancePreview);
    }
  };
  const updateChannel = (channel: 'r' | 'g' | 'b', value: number) => {
    preview(rgbToHex({ ...rgb, [channel]: clampChannel(value) }));
  };
  const updatePlane = (element: HTMLElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const saturation = clampUnit((clientX - rect.left) / Math.max(1, rect.width));
    const value = 1 - clampUnit((clientY - rect.top) / Math.max(1, rect.height));
    preview(hsvToHex({ h: hue, s: saturation, v: value }), hue);
  };
  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    setError('');
    try {
      await client.dispatch('palette.colorPicker.commit', { sessionId: state.sessionId, color });
      client.emit('palette.colorPicker.result', {
        sessionId: state.sessionId,
        color,
        committed: true,
      } satisfies ColorPickerResult);
      await client.dispatch('palette.colorPicker.close', { sessionId: state.sessionId, silent: true });
    } catch (reason) {
      finishing.current = false;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const position = pickerPosition(state.anchor);

  return (
    <div
      className="node-title-picker-backdrop"
      onPointerDown={(event) => {
        if (event.currentTarget === event.target) void finish();
      }}
    >
      <section
        className="node-title-color-picker"
        role="dialog"
        aria-modal="true"
        aria-label="颜色选择器"
        style={{ left: position.left, top: position.top } as CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void finish();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
      >
        <div
          className="node-title-picker-plane"
          role="slider"
          tabIndex={0}
          aria-label="颜色饱和度和亮度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsv.s * 100)}
          aria-valuetext={`${Math.round(hsv.s * 100)}% 饱和度，${Math.round(hsv.v * 100)}% 亮度`}
          style={{
            '--picker-hue-color': hsvToHex({ h: hue, s: 1, v: 1 }),
            '--picker-saturation': `${hsv.s * 100}%`,
            '--picker-value': `${(1 - hsv.v) * 100}%`,
          } as CSSProperties}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            updatePlane(event.currentTarget, event.clientX, event.clientY);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            updatePlane(event.currentTarget, event.clientX, event.clientY);
          }}
          onPointerUp={(event) => {
            updatePlane(event.currentTarget, event.clientX, event.clientY);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 0.05 : 0.01;
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const saturation = clampUnit(hsv.s + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0));
            const value = clampUnit(hsv.v + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0));
            preview(hsvToHex({ h: hue, s: saturation, v: value }), hue);
          }}
        >
          <i aria-hidden="true" />
        </div>

        <div className="node-title-picker-controls">
          <i className="node-title-picker-current-color" style={{ backgroundColor: color }} aria-hidden="true" />
          <input
            className="node-title-picker-hue"
            type="range"
            min={0}
            max={359}
            value={Math.round(hue)}
            aria-label="色相"
            onInput={(event) => {
              const nextHue = Number(event.currentTarget.value);
              preview(hsvToHex({ h: nextHue, s: hsv.s, v: hsv.v }), nextHue);
            }}
          />
        </div>

        <div className="node-title-picker-rgb" aria-label="RGB 颜色通道">
          <ChannelNumber channel="R" value={rgb.r} onChange={(value) => updateChannel('r', value)} />
          <ChannelNumber channel="G" value={rgb.g} onChange={(value) => updateChannel('g', value)} />
          <ChannelNumber channel="B" value={rgb.b} onChange={(value) => updateChannel('b', value)} />
        </div>

        {state.colors.length > 0 && (
          <div className="node-title-picker-records" role="group" aria-label="当前画布已有颜色">
            {state.colors.map((record) => (
              <button
                type="button"
                className={record.color === color ? 'selected' : ''}
                key={record.color}
                style={{ '--picker-record-color': record.color } as CSSProperties}
                aria-label={`${record.color.toUpperCase()}，画布中 ${record.count} 处使用`}
                onClick={() => preview(record.color)}
              />
            ))}
          </div>
        )}

        {error && <p className="node-title-picker-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

function ChannelNumber({
  channel,
  value,
  onChange,
}: {
  channel: 'R' | 'G' | 'B';
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <input
        type="number"
        min={0}
        max={255}
        value={value}
        aria-label={`${channel} 通道数值`}
        onInput={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span>{channel}</span>
    </label>
  );
}

function pickerPosition(anchor: ColorPickerState['anchor']): { left: number; top: number } {
  const viewportWidth = globalThis.innerWidth || 1200;
  const viewportHeight = globalThis.innerHeight || 800;
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchor.x + anchor.width - PICKER_WIDTH),
    Math.max(VIEWPORT_MARGIN, viewportWidth - PICKER_WIDTH - VIEWPORT_MARGIN),
  );
  const below = anchor.y + anchor.height + 8;
  const top = below + PICKER_HEIGHT_ESTIMATE <= viewportHeight - VIEWPORT_MARGIN
    ? below
    : Math.max(VIEWPORT_MARGIN, anchor.y - PICKER_HEIGHT_ESTIMATE - 8);
  return { left, top };
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(color.slice(1), 16);
  return { r: value >> 16, g: value >> 8 & 255, b: value & 255 };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((value) => clampChannel(value).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsv(
  { r, g, b }: { r: number; g: number; b: number },
  fallbackHue = 0,
): { h: number; s: number; v: number } {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let nextHue = fallbackHue;
  if (delta > 0) {
    if (maximum === red) nextHue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) nextHue = 60 * ((blue - red) / delta + 2);
    else nextHue = 60 * ((red - green) / delta + 4);
  }
  return {
    h: (nextHue + 360) % 360,
    s: maximum === 0 ? 0 : delta / maximum,
    v: maximum,
  };
}

function hsvToHex({ h, s, v }: { h: number; s: number; v: number }): string {
  const chroma = v * s;
  const section = ((h % 360) + 360) % 360 / 60;
  const intermediate = chroma * (1 - Math.abs(section % 2 - 1));
  const offset = v - chroma;
  const [red, green, blue] = section < 1 ? [chroma, intermediate, 0]
    : section < 2 ? [intermediate, chroma, 0]
      : section < 3 ? [0, chroma, intermediate]
        : section < 4 ? [0, intermediate, chroma]
          : section < 5 ? [intermediate, 0, chroma]
            : [chroma, 0, intermediate];
  return rgbToHex({
    r: (red + offset) * 255,
    g: (green + offset) * 255,
    b: (blue + offset) * 255,
  });
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Number.isFinite(value) ? Math.round(value) : 0));
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
