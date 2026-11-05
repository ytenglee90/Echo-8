import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecoveryDeleteRequest, isRecoveryRetentionLimit } from '../src/protocols/recovery-management.ts';
import { ApplicationKernel } from '../src/core/kernel.ts';

test('recovery management v1 rejects ambiguous or unbounded destructive requests', () => {
  assert.equal(isRecoveryDeleteRequest({ ids: ['recovery:1'] }), true);
  assert.equal(isRecoveryDeleteRequest({ through: 123 }), true);
  for (const value of [undefined, {}, { ids: [] }, { ids: [3] }, { ids: [''] },
    { ids: Array.from({ length: 1001 }, () => 'id') }, { ids: ['id'], through: 123 },
    { through: -1 }, { through: Infinity }, { through: 1.5 }]) {
    assert.equal(isRecoveryDeleteRequest(value), false);
  }
  assert.equal(isRecoveryRetentionLimit(null), true);
  assert.equal(isRecoveryRetentionLimit(8), true);
  for (const value of [undefined, 0, -1, 9, '8']) assert.equal(isRecoveryRetentionLimit(value), false);
});

test('legacy recovery query and new versioned catalog coexist without persistent storage', async () => {
  const kernel = new ApplicationKernel([]);
  assert.deepEqual(await kernel.router.ask('system.recovery.list', undefined, 'core.test'), []);
  const catalog = await kernel.router.ask<{ points: unknown[]; retentionLimit: number | null }>('system.recovery.catalog@1', undefined, 'core.test');
  assert.deepEqual(catalog.points, []);
  assert.equal(catalog.retentionLimit, null);
  await assert.rejects(kernel.router.ask('system.recovery.catalog@1', { before: 2 }, 'core.test'), /Invalid query payload/u);
  await assert.rejects(kernel.router.dispatch('system.recovery.delete@1', { ids: [] }, 'core.test'), /Invalid command payload/u);
  await assert.rejects(kernel.router.dispatch('system.recovery.setRetention@1', { limit: 0 }, 'core.test'), /Invalid command payload/u);
});
