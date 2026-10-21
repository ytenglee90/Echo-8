export interface CanvasContrastColors {
  line: string;
  selection: string;
  selectionSoft: string;
  overlayFill: string;
}

export const MIN_CANVAS_LINE_CONTRAST = 3;

/**
 * Derives canvas-only semantic colors from the actual document background.
 * The opaque line color meets WCAG's 3:1 non-text contrast target while the
 * stronger selection color always uses the higher-contrast black/white pole.
 */
export function canvasContrastColors(background: string): CanvasContrastColors {
  const backgroundChannels = parseColor(background) ?? [239, 239, 236];
  const black: RGB = [0, 0, 0];
  const white: RGB = [255, 255, 255];
  const selectionChannels = contrastRatioForChannels(backgroundChannels, white) >=
      contrastRatioForChannels(backgroundChannels, black)
    ? white
    : black;
  const lineChannels = mixUntilContrast(
    backgroundChannels,
    selectionChannels,
    MIN_CANVAS_LINE_CONTRAST,
  );
  const selection = toHex(selectionChannels);
  const rgb = selectionChannels.join(', ');
  return {
    line: toHex(lineChannels),
    selection,
    selectionSoft: `rgba(${rgb}, 0.24)`,
    overlayFill: `rgba(${rgb}, 0.09)`,
  };
}

export function canvasContrastVariables(background: string): Record<string, string> {
  const colors = canvasContrastColors(background);
  return {
    '--canvas-line': colors.line,
    '--canvas-selection': colors.selection,
    '--canvas-selection-soft': colors.selectionSoft,
    '--canvas-overlay-fill': colors.overlayFill,
  };
}

/** Keeps a user-selected canvas foreground color when it is visible, otherwise
 * moves it toward the stronger black/white pole until non-text contrast is met. */
export function ensureCanvasColorContrast(
  preferred: string,
  background: string,
  target = MIN_CANVAS_LINE_CONTRAST,
): string {
  const backgroundChannels = parseColor(background) ?? [239, 239, 236];
  const preferredChannels = parseColor(preferred);
  if (!preferredChannels) return canvasContrastColors(background).line;
  if (contrastRatioForChannels(backgroundChannels, preferredChannels) >= target) {
    return toHex(preferredChannels);
  }
  const black: RGB = [0, 0, 0];
  const white: RGB = [255, 255, 255];
  const pole = contrastRatioForChannels(backgroundChannels, white) >=
      contrastRatioForChannels(backgroundChannels, black)
    ? white
    : black;
  return toHex(mixForegroundUntilContrast(
    preferredChannels,
    pole,
    backgroundChannels,
    target,
  ));
}

/** Public for deterministic contrast tests and future canvas renderers. */
export function colorContrastRatio(first: string, second: string): number {
  const firstChannels = parseColor(first);
  const secondChannels = parseColor(second);
  if (!firstChannels || !secondChannels) return 1;
  return contrastRatioForChannels(firstChannels, secondChannels);
}

type RGB = [number, number, number];

function mixUntilContrast(background: RGB, foreground: RGB, target: number): RGB {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const amount = (low + high) / 2;
    const mixed = mix(background, foreground, amount);
    if (contrastRatioForChannels(background, mixed) >= target) high = amount;
    else low = amount;
  }
  return mix(background, foreground, Math.min(1, high + 0.01));
}

function mixForegroundUntilContrast(
  foreground: RGB,
  pole: RGB,
  background: RGB,
  target: number,
): RGB {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const amount = (low + high) / 2;
    const mixed = mix(foreground, pole, amount);
    if (contrastRatioForChannels(background, mixed) >= target) high = amount;
    else low = amount;
  }
  return mix(foreground, pole, Math.min(1, high + 0.01));
}

function mix(from: RGB, to: RGB, amount: number): RGB {
  return from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * amount)) as RGB;
}

function parseColor(color: string): RGB | undefined {
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

function contrastRatioForChannels(first: RGB, second: RGB): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(channels: RGB): number {
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function toHex(channels: RGB): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
