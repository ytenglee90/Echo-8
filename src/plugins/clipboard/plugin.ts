import { ClipboardActions } from './ClipboardActions.tsx';
import { createClipboardPlugin } from './model.ts';

export const clipboardPlugin = createClipboardPlugin(ClipboardActions);
