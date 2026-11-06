import assert from 'node:assert/strict';
import test from 'node:test';
import { availableCloudProjectName } from '../src/plugins/cloud-sync/project-name.ts';

test('cloud Save As keeps existing names and chooses the first free numbered name within the length limit', () => {
  const names = ['巨企', '巨企 (2)', '巨企 (4)'];
  assert.equal(availableCloudProjectName(' 巨企 ', names), '巨企 (3)');
  assert.equal(availableCloudProjectName('模板', names), '模板');
  assert.deepEqual(names, ['巨企', '巨企 (2)', '巨企 (4)']);
  const long = '书'.repeat(120);
  const second = '书'.repeat(116) + ' (2)';
  const third = availableCloudProjectName(long, [long, second]);
  assert.equal(third, '书'.repeat(116) + ' (3)');
  assert.equal(third.length, 120);
});
