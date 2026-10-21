import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canvasDetailScreenScale,
  canvasDetailWorldScale,
  worldPointToCanvasScreen,
} from '../src/ui/canvas-screen-scale.ts';

test('canvas detail compensation stays legible without dominating a zoomed-out overview', () => {
  assert.equal(canvasDetailScreenScale(1), 1);
  assert.equal(canvasDetailScreenScale(0.4), Math.sqrt(0.4));
  assert.equal(canvasDetailScreenScale(2.4), 1);
  assert.equal(canvasDetailScreenScale(Number.NaN), 1);
  assert.equal(canvasDetailWorldScale(0.4), Math.sqrt(0.4) / 0.4);
  assert.equal(canvasDetailWorldScale(2.4), 1 / 2.4);
});

test('screen-space overlays follow world anchors without inheriting canvas scale', () => {
  assert.deepEqual(
    worldPointToCanvasScreen({ x: 80, y: -20, zoom: 0.4 }, { x: 300, y: 150 }),
    { x: 200, y: 40 },
  );
});
