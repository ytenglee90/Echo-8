import { createSearchReplacePlugin } from './model.ts';
import { SearchReplacePanel } from './SearchReplacePanel.tsx';

export const searchReplacePlugin = createSearchReplacePlugin(SearchReplacePanel);
