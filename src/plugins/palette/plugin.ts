import { createPalettePlugin } from './model.ts';
import { GlobalColorPicker } from './NodeTitleColorPicker.tsx';
import { PalettePanel } from './PalettePanel.tsx';

export const palettePlugin = createPalettePlugin(PalettePanel, GlobalColorPicker);
