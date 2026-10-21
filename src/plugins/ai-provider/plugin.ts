import { AIProviderPanel } from './AIProviderPanel.tsx';
import { SemanticProviderSettings } from './SemanticProviderSettings.tsx';
import { createAIProviderPlugin } from './model.ts';

export const aiProviderPlugin = createAIProviderPlugin(AIProviderPanel, SemanticProviderSettings);
