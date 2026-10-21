'use client';

import type { WritingMetricsSnapshot } from '../../protocols/editor.ts';

export function EditorMetrics({
  totalCharacters,
  totalCharactersPending,
  selectionCharacters,
  metric,
  now,
}: {
  totalCharacters: number;
  totalCharactersPending?: boolean;
  selectionCharacters: number;
  metric?: WritingMetricsSnapshot;
  now: number;
}) {
  const activeMs = metric ? metric.activeMs + Math.min(
    Math.max(0, now - metric.lastActivityAt),
    metric.idleTimeoutMs,
  ) : 0;
  return (
    <footer className="editor-metrics">
      <span title="按 Unicode 可见字符统计：包含标点和组合 Emoji，不含空格、制表符和换行。">
        字数 {totalCharactersPending ? '统计中…' : formatInteger(totalCharacters)}
      </span>
      <span title="选区使用相同的可见字符统计口径。">
        选中 {formatInteger(selectionCharacters)}
      </span>
      <span>码字 {formatDuration(activeMs)}</span>
      <span>速度 {formatSpeed(metric?.typedGraphemes ?? 0, activeMs)}</span>
    </footer>
  );
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatSpeed(characters: number, activeMs: number): string {
  if (activeMs < 1000 || characters === 0) return '—';
  return `${Math.round(characters / (activeMs / 60_000))} 字符/分`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}
