import { createCanvasControlPlugin } from './model.ts';
import { CanvasControlPanel, CanvasControlToolbar } from './ControlPanel.tsx';
export const canvasControlPlugin = createCanvasControlPlugin(CanvasControlPanel, CanvasControlToolbar);
