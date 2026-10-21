import type { PluginContext, PluginDefinition, PluginManifest } from './contracts.ts';

export interface LazyPluginDescriptor {
  manifest: PluginManifest;
  load(): Promise<PluginDefinition>;
}

/**
 * Registers only a manifest in the hosted bundle. The implementation chunk is
 * fetched and evaluated when the user starts the plugin from the plugin center.
 */
export function createLazyPlugin(descriptor: LazyPluginDescriptor): PluginDefinition {
  let loaded: PluginDefinition | undefined;
  let installed = false;
  const load = async (): Promise<PluginDefinition> => {
    if (!loaded) {
      const definition = await descriptor.load();
      assertCompatibleManifest(descriptor.manifest, definition.manifest);
      loaded = definition;
    }
    return loaded;
  };
  return {
    manifest: { ...descriptor.manifest, autoStart: false },
    async loadMigrations() {
      const definition = await load();
      return definition.migrations ?? await definition.loadMigrations?.() ?? [];
    },
    async start(context: PluginContext) {
      const definition = await load();
      if (!installed) {
        await definition.install?.(context);
        installed = true;
      }
      await definition.start(context);
    },
    async pause(context: PluginContext) {
      await loaded?.pause?.(context);
    },
    async stop(context: PluginContext) {
      await loaded?.stop?.(context);
    },
    async uninstall(context: PluginContext) {
      await loaded?.uninstall?.(context);
      installed = false;
    },
  };
}

function assertCompatibleManifest(expected: PluginManifest, actual: PluginManifest): void {
  const fields: Array<keyof PluginManifest> = [
    'id', 'version', 'apiVersion', 'dataVersion', 'dependencies', 'optionalDependencies',
    'requiresCapabilities', 'optionalCapabilities', 'providesCapabilities',
    'permissions', 'namespaces', 'namespaceDomains', 'commands', 'dispatches',
    'events', 'signals', 'queries', 'asks', 'ui', 'actions', 'shortcuts',
    'themes', 'workerJobs',
  ];
  for (const field of fields) {
    if (stable(expected[field]) !== stable(actual[field])) {
      throw new Error(`Lazy plugin ${expected.id} manifest drifted at ${String(field)}`);
    }
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))));
  }
  return JSON.stringify(value);
}
