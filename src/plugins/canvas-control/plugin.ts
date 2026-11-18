import { createCanvasControlPlugin } from './model.ts';
import { CanvasControlPanel } from './ControlPanel.tsx';
export const canvasControlPlugin = createCanvasControlPlugin(CanvasControlPanel);
