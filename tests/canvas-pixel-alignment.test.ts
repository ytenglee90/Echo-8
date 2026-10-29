import assert from 'node:assert/strict';
import test from 'node:test';
import { alignCanvasRectToDevicePixels } from '../src/ui/canvas-pixel-alignment.ts';

test('canvas render rectangles align every edge to physical pixels without mutating geometry', () => {
  const rect = { x: 14.37, y: 28.91, width: 317.42, height: 201.13 };
  const camera = { x: 17.25, y: -8.6, zoom: 1.17 };

  for (const pixelRatio of [1, 1.25, 2, 3]) {
    const aligned = alignCanvasRectToDevicePixels(rect, camera, pixelRatio);
    const screenEdges = [
      camera.x + aligned.x * camera.zoom,
      camera.y + aligned.y * camera.zoom,
      camera.x + (aligned.x + aligned.width) * camera.zoom,
      camera.y + (aligned.y + aligned.height) * camera.zoom,
    ];
    for (const edge of screenEdges) {
      assert.ok(Math.abs(edge * pixelRatio - Math.round(edge * pixelRatio)) < 1e-9);
    }
  }

  assert.deepEqual(rect, { x: 14.37, y: 28.91, width: 317.42, height: 201.13 });
});

test('canvas pixel alignment falls back safely for invalid scale inputs', () => {
  const rect = { x: 1.2, y: 2.4, width: 100.5, height: 80.25 };
  assert.equal(alignCanvasRectToDevicePixels(rect, { x: 0, y: 0, zoom: 0 }), rect);
  assert.deepEqual(
    alignCanvasRectToDevicePixels(rect, { x: 0.25, y: 0.25, zoom: 1 }, Number.NaN),
    { x: 0.75, y: 2.75, width: 101, height: 80 },
  );
});
