import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileSaveTarget } from '../src/protocols/files.ts';
import { FileWriteCoordinator } from '../src/plugins/import-export/file-write-coordinator.ts';

test('same native file target has one strict write lane while different targets stay independent', async () => {
  const coordinator = new FileWriteCoordinator();
  const firstTarget = target('first.txt');
  const secondTarget = target('second.txt');
  const releaseFirst = deferred();
  const events: string[] = [];
  let activeOnFirst = 0;
  let maximumOnFirst = 0;

  const first = coordinator.run(firstTarget, new AbortController().signal, async () => {
    activeOnFirst += 1;
    maximumOnFirst = Math.max(maximumOnFirst, activeOnFirst);
    events.push('first:start');
    await releaseFirst.promise;
    events.push('first:end');
    activeOnFirst -= 1;
  });
  const queued = coordinator.run(firstTarget, new AbortController().signal, async () => {
    activeOnFirst += 1;
    maximumOnFirst = Math.max(maximumOnFirst, activeOnFirst);
    events.push('queued:start');
    activeOnFirst -= 1;
  });
  const independent = coordinator.run(secondTarget, new AbortController().signal, async () => {
    events.push('independent:start');
  });

  await independent;
  assert.deepEqual(events, ['first:start', 'independent:start']);
  releaseFirst.resolve();
  await Promise.all([first, queued]);
  assert.equal(maximumOnFirst, 1);
  assert.deepEqual(events, ['first:start', 'independent:start', 'first:end', 'queued:start']);
});

test('an aborted waiter releases its slot without overtaking the active write', async () => {
  const coordinator = new FileWriteCoordinator();
  const destination = target('book.echo8');
  const releaseFirst = deferred();
  const events: string[] = [];
  const first = coordinator.run(destination, new AbortController().signal, async () => {
    events.push('first:start');
    await releaseFirst.promise;
    events.push('first:end');
  });
  const waitingController = new AbortController();
  const aborted = coordinator.run(destination, waitingController.signal, async () => {
    events.push('aborted:unexpected');
  });
  const last = coordinator.run(destination, new AbortController().signal, async () => {
    events.push('last:start');
  });
  waitingController.abort();
  await assert.rejects(aborted, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.deepEqual(events, ['first:start']);
  releaseFirst.resolve();
  await Promise.all([first, last]);
  assert.deepEqual(events, ['first:start', 'first:end', 'last:start']);
});

function target(name: string): FileSaveTarget {
  return {
    name,
    async createWritable() {
      throw new Error('not used by coordinator unit test');
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
