import { LocalSemanticProviderSettings } from './LocalSemanticProviderSettings.tsx';
import { createLocalSemanticProviderPlugin } from './model.ts';

export const localSemanticProviderPlugin = createLocalSemanticProviderPlugin(LocalSemanticProviderSettings);
