export interface OverlapHintState { id: string; x: number; y: number; index: number; count: number; label: string; viewKey: string }

export function OverlapHint({ hint, zoom, viewKey }: { hint?: OverlapHintState; zoom: number; viewKey: string }) {
  if (!hint || hint.count < 2 || hint.viewKey !== viewKey) return null;
  const text = `${hint.index + 1}/${hint.count} ${hint.label} · 再次单击切换`;
  return <g className="connection-overlap-hint" transform={`translate(${hint.x} ${hint.y}) scale(${1 / zoom})`} pointerEvents="none" role="status" aria-label={text}>
    <rect x="16" y="16" width="200" height="26" rx="6" />
    <text x="24" y="33" fontSize="11">{text}</text>
  </g>;
}
