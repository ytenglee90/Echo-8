const MINIMUM_THUMB_HEIGHT = 24;

export interface AIChatScrollInput {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  trackHeight: number;
}

export interface AIChatScrollMetrics {
  canScroll: boolean;
  maxScrollTop: number;
  maxThumbTop: number;
  thumbHeight: number;
  thumbTop: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function resolveAIChatScrollMetrics(input: AIChatScrollInput): AIChatScrollMetrics {
  const clientHeight = Math.max(0, input.clientHeight);
  const scrollHeight = Math.max(clientHeight, input.scrollHeight);
  const trackHeight = Math.max(0, input.trackHeight);
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const canScroll = maxScrollTop > 1 && trackHeight > 0;
  const thumbHeight = canScroll
    ? Math.min(trackHeight, Math.max(MINIMUM_THUMB_HEIGHT, trackHeight * (clientHeight / scrollHeight)))
    : trackHeight;
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
  const thumbTop = canScroll && maxThumbTop > 0
    ? maxThumbTop * (clamp(input.scrollTop, 0, maxScrollTop) / maxScrollTop)
    : 0;
  return { canScroll, maxScrollTop, maxThumbTop, thumbHeight, thumbTop };
}

export function resolveAIChatScrollTopFromThumb(
  thumbTop: number,
  metrics: Pick<AIChatScrollMetrics, 'maxScrollTop' | 'maxThumbTop'>,
): number {
  if (metrics.maxScrollTop <= 0 || metrics.maxThumbTop <= 0) return 0;
  return metrics.maxScrollTop * (clamp(thumbTop, 0, metrics.maxThumbTop) / metrics.maxThumbTop);
}
