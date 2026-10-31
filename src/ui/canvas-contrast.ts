export interface CanvasContrastColors {
  line: string;
  selection: string;
  selectionSoft: string;
  overlayFill: string;
}

export const MIN_CANVAS_LINE_CONTRAST = 3;
export const MIN_CANVAS_SELECTION_CONTRAST = 4.5;

const LIGHT_CANVAS_SELECTION: RGB = [102, 102, 107];

/**
 * Derives canvas-only semantic colors from the actual document background.
 * The opaque line color meets WCAG's 3:1 non-text contrast target while the
 * stronger selection color uses a medium gray on light canvases when it meets
 * the selection contrast floor, otherwise the higher-contrast black/white pole.
 */
export function canvasContrastColors(background: string): CanvasContrastColors {
  const backgroundChannels = parseColor(background) ?? [239, 239, 236];
  const black: RGB = [0, 0, 0];
  const white: RGB = [255, 255, 255];
  const poleChannels = contrastRatioForChannels(backgroundChannels, white) >=
      contrastRatioForChannels(backgroundChannels, black)
    ? white
    : black;
  const selectionChannels = poleChannels === black &&
      contrastRatioForChannels(backgroundChannels, LIGHT_CANVAS_SELECTION) >=
        MIN_CANVAS_SELECTION_CONTRAST
    ? LIGHT_CANVAS_SELECTION
    : poleChannels;
  const lineChannels = mixUntilContrast(
    backgroundChannels,
    poleChannels,
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

import {
  contrastRatioForChannels,
  parseColor,
  toHex,
  type RGB,
} from './color-math.ts';
