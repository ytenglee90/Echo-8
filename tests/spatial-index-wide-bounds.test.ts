import assert from 'node:assert/strict';
import test from 'node:test';
import { SpatialHashIndex } from '../src/services/spatial-index.ts';

test('very long routed edges and distant vertices remain queryable without enumerating huge cell grids', () => {
  const index = new SpatialHashIndex<string>();
  index.set('edge', 'edge', { x: -1e12, y: -1e12, width: 2e12, height: 2e12 });
  index.set('distant', 'distant', { x: 1e100, y: 1e100, width: 12, height: 12 });
  index.set('node', 'node', { x: 100, y: 100, width: 20, height: 20 });
  assert.deepEqual(index.query({ x: 90, y: 90, width: 40, height: 40 }).sort(), ['edge', 'node']);
  assert.deepEqual(index.query({ x: 1e100, y: 1e100, width: 20, height: 20 }), ['distant']);
  assert.deepEqual(index.query({ x: -1e100, y: -1e100, width: 2e100, height: 2e100 }).sort(), ['distant', 'edge', 'node']);
  index.set('edge', 'edge', { x: 300, y: 300, width: 5, height: 5 });
  assert.deepEqual(index.query({ x: 0, y: 0, width: 50, height: 50 }), []);
  index.delete('distant');
  assert.deepEqual(index.query({ x: 1e100, y: 1e100, width: 20, height: 20 }), []);
  index.clear();
  assert.deepEqual(index.query({ x: 0, y: 0, width: 1e100, height: 1e100 }), []);
});
