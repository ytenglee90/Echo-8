import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { OperationLog } from '../src/core/operation-log.ts';
import { TaskScheduler } from '../src/core/task-scheduler.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { OPERATION_LOG_QUERY, type OperationLogSnapshot } from '../src/protocols/operation-log.ts';

test('operation log retains actual scheduler progress, delay, retry, timeout, and cancellation', async () => {
  const log = new OperationLog(() => undefined);
  const scheduler = new TaskScheduler(1, 4, log);
  const read = (code: string) => log.snapshot().entries.find(entry => entry.code === code)!;
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const running = scheduler.schedule('core.test', {
    category: 'test.running', label: 'private-label-123', priority: 1,
    run: async (_signal, report) => { report(0.42); started(); await new Promise<void>(resolve => { release = resolve; }); },
  });
  await ready;
  const cancelled = scheduler.schedule('core.test', { category: 'test.cancel', priority: 1, run: async () => undefined });
  const delayed = scheduler.schedule('core.test', { category: 'test.delay', delayMs: 1000, priority: 1, run: async () => undefined });
  assert.equal(read('test.running').progress, 0.42);
  assert.equal(read('test.cancel').status, 'queued');
  assert.equal(read('test.delay').status, 'waiting');
  assert.ok(read('test.delay').nextRunAt! > read('test.delay').createdAt);
  cancelled.cancel();
  delayed.cancel();
  await Promise.allSettled([cancelled.result, delayed.result]);
  assert.equal(read('test.cancel').status, 'cancelled');
  release();
  await running.result;
  assert.equal(read('test.running').status, 'completed');

  const timedOut = scheduler.schedule('core.test', { category: 'test.timeout', priority: 1, timeoutMs: 5,
    run: () => new Promise<void>(() => undefined) });
  await assert.rejects(timedOut.result, { name: 'TimeoutError' });
  assert.equal(read('test.timeout').status, 'timed-out');
  assert.equal(read('test.timeout').timeoutMs, 5);

  let attempts = 0;
  const retry = scheduler.schedule('core.test', { category: 'test.retry', priority: 1, maxRetries: 1, retryDelayMs: 1,
    run: async () => { if (++attempts === 1) throw new Error('private-diagnostic-message'); } });
  await retry.result;
  assert.equal(read('test.retry').attempts, 2);
  assert.equal(read('test.retry').status, 'completed');
  assert.doesNotMatch(JSON.stringify(log.snapshot()), /private-/u);
});

test('the operation query distinguishes committed changes, failures, and undo without leaking node data', async () => {
  const kernel = new ApplicationKernel([createTextNodePlugin()]);
  await kernel.start();
  await kernel.router.dispatch('node.create', { title: 'private-node-title', body: 'private-node-body' }, 'core.test');
  await assert.rejects(kernel.router.dispatch('node.rename', { id: 'missing', title: 'private-rename' }, 'core.test'));
  await kernel.router.dispatch('history.undo', undefined, 'core.test');
  const log = await kernel.router.ask<OperationLogSnapshot>(OPERATION_LOG_QUERY, undefined, 'core.test');
  for (const [code, status] of [['node.create', 'applied'], ['node.rename', 'failed'], ['history.undo', 'applied']]) {
    assert.ok(log.entries.some(entry => entry.code === code && entry.status === status), code);
  }
  assert.doesNotMatch(JSON.stringify(log), /private-/u);
});

test('owner stages reject forged messages, expire without mutation, and retain a bounded completion history', () => {
  const log = new OperationLog(() => undefined);
  log.stage('text-node', { id: 'forged', phase: 'canvas-plan', state: 'applied' });
  log.stage('canvas-control', { id: 'review', phase: 'canvas-plan', state: 'pending', expiresAt: Date.now() - 1 });
  assert.deepEqual(log.snapshot().entries.map(entry => entry.status), ['expired']);
  for (let index = 0; index < 260; index++) log.transaction('text-node', 'node.create', Date.now());
  assert.equal(log.snapshot().entries.filter(entry => entry.kind === 'transaction').length, 240);
});
