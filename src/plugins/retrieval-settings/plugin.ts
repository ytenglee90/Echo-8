import { createRetrievalSettingsPlugin } from './model.ts';
import { RetrievalSettingsPanel } from './RetrievalSettingsPanel.tsx';

export const retrievalSettingsPlugin = createRetrievalSettingsPlugin(RetrievalSettingsPanel);
