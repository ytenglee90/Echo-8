export type ContrastInk = '#18181a' | '#ffffff';

/** Chooses the higher-contrast monochrome ink for a UI surface color. */
export function contrastingInk(background: string): ContrastInk {
  const channels = parseColor(background);
  if (!channels) return '#18181a';
  const backgroundLuminance = relativeLuminance(channels);
  const darkLuminance = relativeLuminance([24, 24, 26]);
  const whiteContrast = 1.05 / (backgroundLuminance + 0.05);
  const darkContrast = (backgroundLuminance + 0.05) / (darkLuminance + 0.05);
  return whiteContrast >= darkContrast ? '#ffffff' : '#18181a';
}

function parseColor(color: string): [number, number, number] | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(color.trim());
  if (hex) {
    const expanded = hex[1].length === 3
      ? [...hex[1]].map((value) => `${value}${value}`).join('')
      : hex[1];
    const numeric = Number.parseInt(expanded, 16);
    return [numeric >> 16, (numeric >> 8) & 255, numeric & 255];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/iu.exec(color.trim());
  if (!rgb) return undefined;
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map(
    (channel) => Math.min(255, Math.max(0, channel)),
  ) as [number, number, number];
}

function relativeLuminance(channels: [number, number, number]): number {
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
