import { createEditorPlugin } from './model.ts';
import { EditorDock, EditorReplacementPrompt, ImmersiveEditor } from './EditorDock.tsx';

export const editorPlugin = createEditorPlugin(EditorDock, ImmersiveEditor, EditorReplacementPrompt);
