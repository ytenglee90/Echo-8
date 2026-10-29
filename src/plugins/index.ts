import type { PluginDefinition } from '../core/contracts.ts';
import { composeBuiltInPlugins } from './composition.ts';
import { semanticProviderPlugin } from './semantic-provider/plugin.ts';

export const builtInPlugins: PluginDefinition[] = composeBuiltInPlugins(semanticProviderPlugin);
