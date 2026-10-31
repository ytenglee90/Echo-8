import assert from 'node:assert/strict';
import test from 'node:test';
import { CanvasPanSessionController } from '../src/plugins/canvas/pan-session.ts';

test('canvas pan sessions keep a stable identity from begin through release', () => {
    const sessions = new CanvasPanSessionController();
    const started = sessions.begin(4, 10, 20, { x: 3, y: 7, zoom: 1.5 });

    assert.equal(started?.interactionSessionId, 'canvas:pan:4:1');
    assert.deepEqual(sessions.move(4, 30, 45), { x: 23, y: 32, zoom: 1.5 });
    assert.deepEqual(sessions.release(4), {
      pointerId: 4,
      interactionSessionId: 'canvas:pan:4:1',
      pointerX: 10,
      pointerY: 20,
      origin: { x: 3, y: 7, zoom: 1.5 },
      latest: { x: 23, y: 32, zoom: 1.5 },
    });
    assert.equal(sessions.active, false);
});

test('a stale pan begin failure cannot clear a newer session', () => {
    const sessions = new CanvasPanSessionController();
    const first = sessions.begin(1, 0, 0, { x: 0, y: 0, zoom: 1 });
    sessions.release(1);
    const second = sessions.begin(1, 5, 5, { x: 10, y: 10, zoom: 1 });

    assert.equal(sessions.reject(first!.interactionSessionId), undefined);
    assert.equal(sessions.active, true);
    assert.equal(sessions.release(1)?.interactionSessionId, second?.interactionSessionId);
});

test('a pan session ignores pointer events from non-owners', () => {
    const sessions = new CanvasPanSessionController();
    sessions.begin(7, 10, 10, { x: 0, y: 0, zoom: 1 });

    assert.equal(sessions.move(8, 50, 50), undefined);
    assert.equal(sessions.release(8), undefined);
    assert.equal(sessions.cancel()?.pointerId, 7);
});
