import assert from 'node:assert/strict';
import test from 'node:test';

import { isSafeStartRequested } from '../src/app/startup-recovery.ts';

test('safe startup is an explicit launch input', () => {
  assert.equal(isSafeStartRequested(), false);
  assert.equal(isSafeStartRequested('https://echo8.local/?echo8-safe-start=1'), true);
  assert.equal(isSafeStartRequested('https://echo8.local/?echo8-safe-start=0'), false);
  assert.equal(isSafeStartRequested('https://echo8.local/'), false);
  assert.equal(isSafeStartRequested('not a url'), false);
});
