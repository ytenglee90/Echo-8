import assert from 'node:assert/strict';
import test from 'node:test';

import { moveTextAnchor } from '../src/services/text-anchor-movement.ts';

test('text anchors retain character ownership while a range moves in either direction', () => {
  assert.equal(moveTextAnchor(4, 2, 5, 9), 8);
  assert.equal(moveTextAnchor(7, 2, 5, 9), 4);
  assert.equal(moveTextAnchor(2, 2, 5, 9), 2);

  assert.equal(moveTextAnchor(4, 5, 8, 2), 7);
  assert.equal(moveTextAnchor(7, 5, 8, 2), 4);
  assert.equal(moveTextAnchor(5, 5, 8, 2), 8);
});
