import type { PluginDefinition } from '../core/contracts.ts';
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
import { semanticProviderPlugin } from './semantic-provider/plugin.ts';
import { smartLayoutPlugin } from './smart-layout/plugin.ts';
import { shortcutCenterPlugin } from './shortcut-center/plugin.ts';
import { selectionPlugin } from './selection/plugin.ts';
import { statisticsPlugin } from './statistics/plugin.ts';
import { historyControlsPlugin } from './system/history-controls.ts';
import { pluginCenterPlugin } from './system/plugin-center.ts';
import { textNodePlugin } from './text-node/view-plugin.ts';
import { textAssistPlugin } from './text-assist/view-plugin.ts';

export const builtInPlugins: PluginDefinition[] = [
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
  semanticProviderPlugin,
  aiProviderPlugin,
  aiAssistantPlugin,
];
