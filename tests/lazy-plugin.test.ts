import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext, PluginDefinition, PluginManifest } from '../src/core/contracts.ts';
import { createLazyPlugin } from '../src/core/lazy-plugin.ts';

function manifest(id = 'lazy-probe'): PluginManifest {
  return {
    id,
    name: 'Lazy probe',
    version: '1.0.0',
    apiVersion: '1',
    dataVersion: 1,
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
  };
}

test('lazy plugin does not load implementation until explicit start and reuses it', async () => {
  const events: string[] = [];
  let loads = 0;
  const expected = manifest();
  const implementation: PluginDefinition = {
    manifest: expected,
    install: () => { events.push('install'); },
    start: () => { events.push('start'); },
    stop: () => { events.push('stop'); },
  };
  const lazy = createLazyPlugin({
    manifest: expected,
    load: async () => {
      loads += 1;
      return implementation;
    },
  });
  const context = {} as PluginContext;

  assert.equal(lazy.manifest.autoStart, false);
  assert.equal(loads, 0);
  await lazy.start(context);
  await lazy.stop?.(context);
  await lazy.start(context);

  assert.equal(loads, 1);
  assert.deepEqual(events, ['install', 'start', 'stop', 'start']);
});

test('lazy plugin rejects implementation manifest drift before starting', async () => {
  const expected = manifest();
  const lazy = createLazyPlugin({
    manifest: expected,
    load: async () => ({
      manifest: { ...expected, commands: ['undeclared.command'] },
      start: () => undefined,
    }),
  });

  await assert.rejects(
    () => Promise.resolve(lazy.start({} as PluginContext)),
    /manifest drifted at commands/,
  );
});
