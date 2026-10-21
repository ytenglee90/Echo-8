import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canvasContrastColors,
  colorContrastRatio,
  ensureCanvasColorContrast,
  MIN_CANVAS_LINE_CONTRAST,
} from '../src/ui/canvas-contrast.ts';
import { PALETTE_PRESETS } from '../src/plugins/palette/presets.ts';

test('canvas strokes remain visible across light, dark, saturated and middle-tone backgrounds', () => {
  const backgrounds = [
    '#ffffff', '#000000', '#777777', '#efefec', '#18191b', '#e4e8da',
    '#ff0000', '#00ff00', '#0000ff', '#f5d000', '#7f4fa3', '#168c87',
  ];
  for (const background of backgrounds) {
    const colors = canvasContrastColors(background);
    assert.ok(
      colorContrastRatio(background, colors.line) >= MIN_CANVAS_LINE_CONTRAST,
      `${background} -> ${colors.line}`,
    );
    assert.ok(
      colorContrastRatio(background, colors.selection) >= 4.5,
      `${background} -> ${colors.selection}`,
    );
  }
});

test('custom connection colors retain their hue when visible and gain contrast when necessary', () => {
  assert.equal(ensureCanvasColorContrast('#245eb4', '#efefec'), '#245eb4');
  const adjustedLight = ensureCanvasColorContrast('#efefec', '#efefec');
  const adjustedDark = ensureCanvasColorContrast('#18191b', '#18191b');
  assert.notEqual(adjustedLight, '#efefec');
  assert.notEqual(adjustedDark, '#18191b');
  assert.ok(colorContrastRatio(adjustedLight, '#efefec') >= MIN_CANVAS_LINE_CONTRAST);
  assert.ok(colorContrastRatio(adjustedDark, '#18191b') >= MIN_CANVAS_LINE_CONTRAST);
});

test('global color presets expose distinct bright, dark and eye-care combinations', () => {
  assert.deepEqual(PALETTE_PRESETS.map((preset) => preset.key), ['A', 'B', 'C']);
  assert.deepEqual(PALETTE_PRESETS.map((preset) => preset.label), ['明调', '暗调', '护眼']);
  assert.equal(new Set(PALETTE_PRESETS.map((preset) => preset.canvasBackground)).size, 3);
  for (const preset of PALETTE_PRESETS) {
    assert.match(preset.canvasBackground, /^#[0-9a-f]{6}$/u);
    assert.match(preset.preferences.toolbarBackground, /^#[0-9a-f]{6}$/u);
    assert.match(preset.preferences.editorBackground, /^#[0-9a-f]{6}$/u);
  }
});
