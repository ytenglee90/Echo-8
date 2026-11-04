import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraForFocus, cameraForBounds } from '../src/plugins/canvas/surface-geometry.ts';

test('whole-canvas focus fits compact contents and centres an oversized canvas without changing its zoom', () => {
  const viewport = { width: 1000, height: 800 }, current = { x: 400, y: -300, zoom: .4 };
  const compact = { x: -100, y: -50, width: 500, height: 300 };
  assert.deepEqual(cameraForFocus({ bounds: compact, mode: 'center-if-overflow' }, viewport, current), cameraForBounds(compact, viewport));
  for (const zoom of [.4, 1, 2.4]) {
    const bounds = { x: -3000, y: -1000, width: 10000, height: 8000 };
    const next = cameraForFocus({ bounds, mode: 'center-if-overflow' }, viewport, { ...current, zoom });
    assert.equal(next.zoom, zoom);
    assert.equal((bounds.x + bounds.width / 2) * zoom + next.x, viewport.width / 2);
    assert.equal((bounds.y + bounds.height / 2) * zoom + next.y, viewport.height / 2);
    assert.deepEqual(cameraForFocus({ bounds }, viewport, { ...current, zoom }), cameraForBounds(bounds, viewport));
  }
});
