import { AIAssistantPanel } from './AIAssistantPanel.tsx';
import { AIAssistantToolbar } from './AIAssistantToolbar.tsx';
import { AIMemoryDeleteDialog } from './AIMemoryDeleteDialog.tsx';
import { AIRequestInspectionDialog } from './AIRequestInspectionDialog.tsx';
import { createAIAssistantPlugin } from './model.ts';
import { PersonalPreferencesPanel } from './PersonalPreferencesPanel.tsx';

export const aiAssistantPlugin = createAIAssistantPlugin(
  AIAssistantPanel,
  AIAssistantToolbar,
  AIMemoryDeleteDialog,
  AIRequestInspectionDialog,
  PersonalPreferencesPanel,
);
