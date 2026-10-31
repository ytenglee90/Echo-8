import { contrastRatioForChannels, parseColor } from './color-math.ts';

export type ContrastInk = '#18181a' | '#ffffff';

/** Chooses the higher-contrast monochrome ink for a UI surface color. */
export function contrastingInk(background: string): ContrastInk {
  const channels = parseColor(background);
  if (!channels) return '#18181a';
  const whiteContrast = contrastRatioForChannels(channels, [255, 255, 255]);
  const darkContrast = contrastRatioForChannels(channels, [24, 24, 26]);
  return whiteContrast >= darkContrast ? '#ffffff' : '#18181a';
}

export function contrastTextColor(color: string): '#111111' | '#ffffff' {
  const channels = parseColor(color);
  if (!channels) return '#ffffff';
  return contrastRatioForChannels(channels, [17, 17, 17]) >=
      contrastRatioForChannels(channels, [255, 255, 255])
    ? '#111111'
    : '#ffffff';
}
