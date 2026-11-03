import { createMinimapPlugin } from './model.ts';
import { Minimap, MinimapToggle } from './Minimap.tsx';

export const minimapPlugin = createMinimapPlugin(Minimap, MinimapToggle);
