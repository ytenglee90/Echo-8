export type RGB = [number, number, number];

export function parseColor(color: string): RGB | undefined {
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
    (channel) => Math.round(Math.min(255, Math.max(0, channel))),
  ) as RGB;
}

export function relativeLuminance(channels: RGB): number {
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function contrastRatioForChannels(first: RGB, second: RGB): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function toHex(channels: RGB): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
