import type { PluginDefinition } from '../core/contracts.ts';
import { createLazyPlugin } from '../core/lazy-plugin.ts';
import { composeBuiltInPlugins } from './composition.ts';
import { semanticProviderManifest } from './semantic-provider/manifest.ts';

const lazySemanticProvider = createLazyPlugin({
  manifest: semanticProviderManifest,
  load: () => import('./semantic-provider/plugin.ts').then((module) => module.semanticProviderPlugin),
});

/** Hosted composition: optional heavy tools are fetched only after explicit activation. */
export const hostedPlugins: PluginDefinition[] = composeBuiltInPlugins(lazySemanticProvider);
