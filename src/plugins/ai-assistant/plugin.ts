import { AIAssistantPanel } from './AIAssistantPanel.tsx';
import { AIAssistantToolbar } from './AIAssistantToolbar.tsx';
import { AIMemoryDeleteDialog } from './AIMemoryDeleteDialog.tsx';
import { createAIAssistantPlugin } from './model.ts';

export const aiAssistantPlugin = createAIAssistantPlugin(
  AIAssistantPanel,
  AIAssistantToolbar,
  AIMemoryDeleteDialog,
);
