import { createTextNodePlugin } from './plugin.ts';
import { TextNodeCanvasLayer } from './TextNodeCanvasLayer.tsx';
import { TextNodeEmptyState } from './TextNodeEmptyState.tsx';

export const textNodePlugin = createTextNodePlugin(TextNodeCanvasLayer, TextNodeEmptyState);
