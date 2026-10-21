import { createSelectionPlugin } from './model.ts';
import { SelectionActions } from './SelectionActions.tsx';

export const selectionPlugin = createSelectionPlugin(SelectionActions);
