import { createShortcutCenterPlugin } from './model.ts';
import { ShortcutCenterPanel } from './ShortcutCenterPanel.tsx';

export const shortcutCenterPlugin = createShortcutCenterPlugin(ShortcutCenterPanel);
