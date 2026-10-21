import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUniqueNodeTitle,
  isNodeTitleTaken,
} from '../src/plugins/text-node/title-policy.ts';

test('node title policy appends the first free sequence without creating nested suffixes', () => {
  const existing = [
    { id: 'one', title: '计划' },
    { id: 'two', title: '计划 2' },
    { id: 'four', title: '计划 4' },
  ];
  assert.equal(createUniqueNodeTitle('计划', existing), '计划 3');
  assert.equal(createUniqueNodeTitle('计划 4', existing), '计划 5');
  assert.equal(createUniqueNodeTitle('计划', existing, ['计划 3']), '计划 5');
});

test('node title policy compares Unicode compatibility forms and can exclude the edited node', () => {
  const existing = [{ id: 'full-width', title: 'ＡＢＣ' }];
  assert.equal(createUniqueNodeTitle('ABC', existing), 'ABC 2');
  assert.equal(isNodeTitleTaken('ABC', existing), true);
  assert.equal(isNodeTitleTaken('ABC', existing, 'full-width'), false);
});
