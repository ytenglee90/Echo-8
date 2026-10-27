import type { PluginDefinition } from '../core/contracts.ts';
import { createLazyPlugin } from '../core/lazy-plugin.ts';
import { annotationsPlugin } from './annotations/plugin.ts';
import { aiAssistantPlugin } from './ai-assistant/plugin.ts';
import { aiProviderPlugin } from './ai-provider/plugin.ts';
import { canvasPlugin } from './canvas/plugin.ts';
import { bookLibraryPlugin } from './book-library/plugin.ts';
import { clipboardPlugin } from './clipboard/plugin.ts';
import { cloudSyncPlugin } from './cloud-sync/plugin.ts';
import { commandPalettePlugin } from './command-palette/plugin.ts';
import { connectionsPlugin } from './connections/plugin.ts';
import { diagnosticCenterPlugin } from './diagnostic-center/plugin.ts';
import { editorPlugin } from './editor/plugin.ts';
import { groupsPlugin } from './groups/plugin.ts';
import { importExportPlugin } from './import-export/plugin.ts';
import { localSemanticProviderPlugin } from './local-semantic-provider/plugin.ts';
import { palettePlugin } from './palette/plugin.ts';
import { searchReplacePlugin } from './search-replace/plugin.ts';
import { searchIndexPlugin } from './search-index/plugin.ts';
import { semanticProviderManifest } from './semantic-provider/manifest.ts';
import { smartLayoutPlugin } from './smart-layout/plugin.ts';
import { shortcutCenterPlugin } from './shortcut-center/plugin.ts';
import { selectionPlugin } from './selection/plugin.ts';
import { statisticsPlugin } from './statistics/plugin.ts';
import { historyControlsPlugin } from './system/history-controls.ts';
import { pluginCenterPlugin } from './system/plugin-center.ts';
import { textNodePlugin } from './text-node/view-plugin.ts';
import { textAssistPlugin } from './text-assist/view-plugin.ts';

const lazySemanticProvider = createLazyPlugin({
  manifest: semanticProviderManifest,
  load: () => import('./semantic-provider/plugin.ts').then((module) => module.semanticProviderPlugin),
});

/** Hosted composition: optional heavy tools are fetched only after explicit activation. */
export const hostedPlugins: PluginDefinition[] = [
  textNodePlugin,
  selectionPlugin,
  canvasPlugin,
  connectionsPlugin,
  groupsPlugin,
  annotationsPlugin,
  textAssistPlugin,
  smartLayoutPlugin,
  clipboardPlugin,
  cloudSyncPlugin,
  searchReplacePlugin,
  searchIndexPlugin,
  statisticsPlugin,
  editorPlugin,
  palettePlugin,
  importExportPlugin,
  bookLibraryPlugin,
  historyControlsPlugin,
  pluginCenterPlugin,
  commandPalettePlugin,
  shortcutCenterPlugin,
  diagnosticCenterPlugin,
  localSemanticProviderPlugin,
  lazySemanticProvider,
  aiProviderPlugin,
  aiAssistantPlugin,
];
