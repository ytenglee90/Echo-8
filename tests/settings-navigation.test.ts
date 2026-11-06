import assert from 'node:assert/strict';
import test from 'node:test';
import { UIRuntime } from '../src/core/ui-runtime.ts';
import type { UIContribution } from '../src/core/contracts.ts';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { createCloudSyncPlugin } from '../src/plugins/cloud-sync/model.ts';
import { createShortcutCenterPlugin } from '../src/plugins/shortcut-center/model.ts';
import { defineManifest } from '../src/plugins/manifest.ts';

function page(id: string, order: number): UIContribution {
  return {
    id, label: id, slot: 'right.primary', kind: 'view',
    settings: { version: 1, label: id, icon: 'settings', order, openCommand: `${id}.open` },
  };
}

test('settings entry opens the first available owner page after navigation and owner removal', async () => {
  const kernel = new ApplicationKernel([createCloudSyncPlugin(), createShortcutCenterPlugin()]);
  await kernel.start();
  try {
    await kernel.router.dispatch('shortcuts.open', undefined, 'core.test');
    assert.deepEqual(await kernel.router.dispatch('system.ui.openSettings@1', undefined, 'core.test'), { opened: true });
    assert.equal(kernel.ui.topSurface(['right.primary'])?.owner, 'cloud-sync');
    await kernel.router.dispatch('shortcuts.open', undefined, 'core.test');
    await kernel.router.dispatch('system.ui.openSettings@1', undefined, 'core.test');
    assert.equal(kernel.ui.topSurface(['right.primary'])?.owner, 'cloud-sync');
    await kernel.plugins.stop('cloud-sync');
    await kernel.router.dispatch('system.ui.openSettings@1', undefined, 'core.test');
    assert.equal(kernel.ui.topSurface(['right.primary'])?.owner, 'shortcut-center');
    await kernel.plugins.stop('shortcut-center');
    assert.deepEqual(await kernel.router.dispatch('system.ui.openSettings@1', undefined, 'core.test'), { opened: false });
    assert.equal(kernel.history.getState().undoCount, 0);
  } finally {
    await kernel.plugins.stop('cloud-sync');
    await kernel.plugins.stop('shortcut-center');
  }
});

test('settings contributions cannot claim another owners command', async () => {
  const kernel = new ApplicationKernel([]);
  kernel.plugins.register({
    manifest: defineManifest('invalid-settings', 'Invalid settings', {
      ui: ['foreign-page'], permissions: ['ui.right.contribute'],
    }),
    start(context) { context.ui.contribute(page('foreign-page', 1)); },
  });
  await assert.rejects(kernel.plugins.start('invalid-settings'), /settings open command/u);
  assert.deepEqual(kernel.ui.listSettingsPages(), []);
});

test('cloud settings yields the previous page and Escape does not uncover a stale settings page', async () => {
  const kernel = new ApplicationKernel([createCloudSyncPlugin(), createShortcutCenterPlugin()]);
  await kernel.start();
  try {
    await kernel.router.dispatch('shortcuts.open', undefined, 'core.test');
    await kernel.router.dispatch('cloudSync.open', undefined, 'core.test');
    // Let committed UI observers enqueue their owning close commands.
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(await kernel.router.ask('shortcuts.state', undefined, 'core.test'), { open: false, overrides: [] });
    assert.equal(kernel.ui.topSurface(['right.primary'])?.owner, 'cloud-sync');
    await kernel.router.dispatch('system.ui.escape', undefined, 'core.test');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(kernel.ui.topSurface(['right.primary']), undefined);
    assert.equal(kernel.history.getState().undoCount, 0);
  } finally {
    await kernel.plugins.stop('cloud-sync');
    await kernel.plugins.stop('shortcut-center');
  }
});

test('settings navigation retains inactive pages without rendering them and releases stopped owners', () => {
  const ui = new UIRuntime();
  const releaseA = ui.contribute('a', page('first', 10));
  ui.contribute('b', page('second', 20));
  ui.activateSurface('a', 'right.primary', 'first', 'first.close');
  assert.deepEqual(ui.listSettingsPages().map(item => item.owner), ['a', 'b']);
  assert.deepEqual(ui.list('right.primary').map(item => item.owner), ['a']);
  ui.activateSurface('b', 'right.primary', 'second', 'second.close');
  assert.deepEqual(ui.list('right.primary').map(item => item.owner), ['b']);
  releaseA();
  assert.deepEqual(ui.listSettingsPages().map(item => item.owner), ['b']);
  assert.equal(ui.topSurface(['right.primary'])?.owner, 'b');
});

test('settings metadata is immutable and rejects unsupported versions and non-page slots', () => {
  const ui = new UIRuntime();
  const contribution = page('first', 10);
  ui.contribute('a', contribution);
  contribution.settings!.label = 'changed after registration';
  assert.equal(ui.listSettingsPages()[0].settings?.label, 'first');
  assert.throws(() => { ui.listSettingsPages()[0].settings!.openCommand = 'foreign.command'; }, TypeError);
  assert.throws(() => ui.contribute('b', { ...page('bad-slot', 0), slot: 'top.primary' }), /Invalid settings page/u);
  assert.throws(() => ui.contribute('b', {
    ...page('bad-version', 0), settings: { ...page('bad-version', 0).settings!, version: 2 as 1 },
  }), /Invalid settings page/u);
});
