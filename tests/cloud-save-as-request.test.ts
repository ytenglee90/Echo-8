import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { createCloudSyncPlugin } from '../src/plugins/cloud-sync/model.ts';
import type { CloudSyncState } from '../src/cloud/contracts.ts';

test('versioned cloud Save As request opens the owned form without saving, keeps legacy sync and cleans up on stop', async () => {
  const kernel = new ApplicationKernel([createCloudSyncPlugin()]);
  await kernel.start();
  try {
    const revision = await kernel.router.ask('system.document.revision', undefined, 'core.test');
    await assert.rejects(kernel.router.dispatch('cloudSync.requestSaveAs@1', { name: 'unexpected' }, 'core.test'), /Invalid command payload/u);
    assert.deepEqual(await kernel.router.dispatch('cloudSync.requestSaveAs@1', undefined, 'core.test'), { open: true });
    const state = await kernel.router.ask<CloudSyncState>('cloudSync.state', undefined, 'core.test');
    assert.equal(state.panelOpen, true);
    assert.equal(state.activeProjectId, undefined);
    assert.deepEqual(await kernel.router.ask('system.document.revision', undefined, 'core.test'), revision);
    assert.equal(kernel.ui.listActions().find(action => action.id === 'cloud-sync.save-as-action')?.command, 'cloudSync.requestSaveAs@1');
    assert.ok(kernel.ui.listShortcuts().some(shortcut => shortcut.command === 'cloudSync.syncNow'));
    assert.ok(kernel.ui.listShortcuts().some(shortcut => shortcut.command === 'cloudSync.requestSaveAs@1' && shortcut.chord === ''));
    assert.equal((await kernel.router.dispatch<CloudSyncState>('cloudSync.syncNow', undefined, 'core.test')).activeProjectId, undefined);
    await kernel.router.dispatch('cloudSync.close', undefined, 'core.test');
    assert.equal((await kernel.router.ask<CloudSyncState>('cloudSync.state', undefined, 'core.test')).panelOpen, false);
  } finally {
    await kernel.plugins.stop('cloud-sync');
  }
  assert.equal(kernel.ui.listActions().some(action => action.owner === 'cloud-sync'), false);
  assert.equal(kernel.ui.listShortcuts().some(shortcut => shortcut.owner === 'cloud-sync'), false);
});
