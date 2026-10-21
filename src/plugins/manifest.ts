import type { PluginManifest } from '../core/contracts.ts';

export function defineManifest(
  id: string,
  name: string,
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id,
    name,
    version: '0.1.0',
    apiVersion: '1',
    dataVersion: 1,
    autoStart: true,
    dependencies: [],
    optionalDependencies: [],
    requiresCapabilities: [],
    optionalCapabilities: [],
    providesCapabilities: [],
    permissions: [],
    namespaces: [],
    namespaceDomains: {},
    commands: [],
    dispatches: [],
    events: [],
    signals: [],
    queries: [],
    asks: [],
    ui: [],
    actions: [],
    shortcuts: [],
    themes: [],
    workerJobs: [],
    ...overrides,
  };
}
