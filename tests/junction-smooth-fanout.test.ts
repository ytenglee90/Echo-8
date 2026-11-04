import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionGraphPoints, connectionStrokeForEndpoints } from '../src/plugins/connections/routing.ts';
import { connectionCurvePath, connectionCurveBounds, connectionStrokeGeometry, distanceToConnectionCurve } from '../src/plugins/connections/rendering.ts';
import { connectionJunctionDragRequest, type ConnectionNodeGeometry, type ConnectionRecord } from '../src/protocols/connections.ts';

type Point = { x: number; y: number };
function segments(path: string) {
  const numbers = path.match(/-?\d+(?:\.\d+)?/gu)!.map(Number), result: Point[][] = [];
  let from = { x: numbers[0], y: numbers[1] };
  for (let i = 2; i < numbers.length; i += 6) {
    const end = { x: numbers[i + 4], y: numbers[i + 5] };
    result.push([from, { x: numbers[i], y: numbers[i + 1] }, { x: numbers[i + 2], y: numbers[i + 3] }, end]); from = end;
  }
  return result;
}
const minus = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
function direction(v: Point) { const length = Math.hypot(v.x, v.y); return { x: v.x / length, y: v.y / length }; }
function fixture(jx: number, title = true, angle = 0, incoming = false) {
  const nodes = new Map<string, ConnectionNodeGeometry>();
  for (let i = 0; i < 4; i++) nodes.set(`n${i}`, { id: `n${i}`, x: 208, y: [20, 222, 408, 594][i], width: 260, height: 146 });
  nodes.set('j', { id: 'j', x: jx, y: 576, width: 0, height: 0, kind: 'junction', handleAngle: angle });
  const endpoint = (id: string) => ({ nodeId: id, ...(id === 'j' ? { kind: 'junction' as const } : {}), side: title && id !== 'j' ? 'title' as const : 'left' as const });
  const pairs = [[endpoint('n3'), endpoint('j')], ...[0, 1, 2].map(i => [endpoint('j'), endpoint(`n${i}`)])];
  const records: ConnectionRecord[] = pairs.map(([from, to], i) => ({ id: String(i), from: incoming ? to : from, to: incoming ? from : to, titleRoute: title, labelWidth: 180, labelHeight: 48, revision: 1, createdAt: 1 }));
  return { nodes, records };
}
test('same-side fans share a physical transition without forcing a path through the junction', () => {
  for (const x of [64, 540]) for (const title of [true, false]) for (const incoming of [false, true]) {
    const { nodes, records } = fixture(x, title, 0, incoming), graph = connectionGraphPoints(records, nodes);
    const tangents = records.map(record => record.from.kind === 'junction' ? graph.get(record.id)!.from.tangent! : graph.get(record.id)!.to.tangent!);
    for (const tangent of tangents) { assert.equal(Math.abs(tangent.x), 1); assert.equal(Math.abs(tangent.y), 0); }
    for (const record of records) {
      const pair = graph.get(record.id)!, parts = segments(connectionCurvePath(pair.from, pair.to));
      for (let i = 1; i < parts.length; i++) {
        const left = direction(minus(parts[i - 1][3], parts[i - 1][2])), right = direction(minus(parts[i][1], parts[i][0]));
        assert.ok(Math.abs(left.x - right.x) < .0003 && Math.abs(left.y - right.y) < .0003, 'joins must share the forward tangent');
      }
      const derivative = direction(record.from.kind === 'junction' ? minus(parts[0][1], parts[0][0]) : minus(parts.at(-1)![3], parts.at(-1)![2]));
      const tangent = record.from.kind === 'junction' ? pair.from.tangent! : pair.to.tangent!;
      assert.ok(Math.abs(derivative.x - tangent.x) < .0003 && Math.abs(derivative.y - tangent.y) < .0003, 'the visible route uses the planned transition');
      const bounds = connectionCurveBounds(pair.from, pair.to);
      assert.ok(Number.isFinite(bounds.width) && Number.isFinite(bounds.height));
      assert.equal(distanceToConnectionCurve(pair.from, pair.from, pair.to), 0);
      for (const zoom of [.4, 1, 2.4]) {
        const stroke = connectionStrokeForEndpoints(record, pair, zoom);
        assert.ok(!/NaN|Infinity/u.test(stroke.shaftPath));
        if (stroke.arrowEnd) assert.notEqual(record[stroke.arrowEnd].kind, 'junction');
      }
    }
  }
});
test('all 15-degree preferences preserve the safe transition of a same-side fan', () => {
  for (let angle = 0; angle < 360; angle += 15) {
    const { nodes, records } = fixture(64, true, angle), graph = connectionGraphPoints(records, nodes);
    for (const record of records) {
      const pair = graph.get(record.id)!, tangent = record.from.kind === 'junction' ? pair.from.tangent! : pair.to.tangent!;
      assert.ok(Math.abs(tangent.x) > 0 && Math.abs(tangent.x) <= 1);
      assert.ok(Math.abs(Math.hypot(tangent.x, tangent.y) - 1) < .000001);
      const sign = record.from.kind === 'junction' ? 1 : -1;
      assert.ok(tangent.x * sign > 0 && Math.abs(tangent.y) <= Math.abs(tangent.x) + .000001);
      const reference = graph.get(records[0].id)!.to.tangent!;
      assert.ok(Math.abs(tangent.x * reference.y - tangent.y * reference.x) < .000001, 'manual preferences keep every branch on the shared axis');
    }
  }
});

test('coincident routing endpoints have no loop, spurious arrow or non-finite hit bounds', () => {
  const point = { x: 120, y: 90, tangent: { x: 0, y: -1 } };
  assert.deepEqual(connectionStrokeGeometry(point, point), { shaftPath: 'M 120 90 C 120 90, 120 90, 120 90', arrowPath: '' });
  assert.deepEqual(connectionCurveBounds(point, point), { x: 112, y: 82, width: 16, height: 16 });
  assert.equal(distanceToConnectionCurve(point, point, point), 0);
});

test('the low junction layout does not add a downward lobe to an upward outgoing branch', () => {
  const nodes = new Map<string, ConnectionNodeGeometry>([
    ['a', { id: 'a', x: 180, y: 125, width: 280, height: 156 }], ['b', { id: 'b', x: 180, y: 350, width: 280, height: 156 }],
    ['c', { id: 'c', x: 995, y: 508, width: 280, height: 156 }], ['j', { id: 'j', kind: 'junction', x: 700, y: 612, width: 0, height: 0 }],
  ]);
  const records: ConnectionRecord[] = [['a', 'j'], ['b', 'j'], ['j', 'c']].map(([a, b], i) => ({ id: String(i),
    from: { nodeId: a, side: 'right', ...(a === 'j' ? { kind: 'junction' } : {}) }, to: { nodeId: b, side: 'left', ...(b === 'j' ? { kind: 'junction' } : {}) }, labelWidth: 0, labelHeight: 0, revision: 1, createdAt: 1 }));
  const pair = connectionGraphPoints(records, nodes).get('2')!;
  assert.deepEqual(pair.from.tangent, { x: 1, y: 0 });
  for (const curve of segments(connectionCurvePath(pair.from, pair.to))) for (const point of curve) assert.ok(point.y >= pair.to.y && point.y <= pair.from.y);
});

test('gentle changes begin across the first quarter of the span instead of after a long straight lead', () => {
  const from = { x: 364, y: 477, side: 'right' as const }, to = { x: 630, y: 398, tangent: { x: .983, y: -.184 } };
  const curves = segments(connectionCurvePath(from, to)), targetX = from.x + (to.x - from.x) * .25;
  const sample = (p: Point[], t: number) => ({ x: (1 - t) ** 3 * p[0].x + 3 * (1 - t) ** 2 * t * p[1].x + 3 * (1 - t) * t ** 2 * p[2].x + t ** 3 * p[3].x,
    y: (1 - t) ** 3 * p[0].y + 3 * (1 - t) ** 2 * t * p[1].y + 3 * (1 - t) * t ** 2 * p[2].y + t ** 3 * p[3].y });
  const firstQuarter = curves.flatMap(curve => Array.from({ length: 201 }, (_, i) => sample(curve, i / 200))).find(point => point.x >= targetX)!;
  assert.ok((from.y - firstQuarter.y) / (from.y - to.y) > .06, 'bending is already visible by the first quarter of the horizontal gap');
});

test('left/right point drags form incoming/outgoing requests for cards, boxes, groups and points while preserving style', () => {
  const j: ConnectionNodeGeometry = { id: 'j', kind: 'junction', x: 600, y: 400, width: 0, height: 0 };
  for (const side of [-1, 1]) for (const kind of ['card', 'box', 'group', 'junction']) for (const title of [false, true]) {
    const target: ConnectionNodeGeometry = { id: 'target', x: side < 0 ? 80 : 900, y: 200, width: kind === 'junction' ? 0 : 260, height: 146,
      ...(kind === 'group' || kind === 'junction' ? { kind } : kind === 'box' ? { presentation: 'text-box' } : {}) };
    const request: ConnectionRecord = { id: 'edge', from: { nodeId: 'j', kind: 'junction', side: 'right' }, to: { nodeId: 'target', kind: target.kind, side: title && !target.kind ? 'title' : 'left' }, titleRoute: title, labelWidth: 0, labelHeight: 0, revision: 1, createdAt: 1 };
    const before = structuredClone(request), normalized = connectionJunctionDragRequest(request, j, target);
    assert.equal(normalized.from.nodeId, side < 0 ? 'target' : 'j'); assert.equal(normalized.to.nodeId, side < 0 ? 'j' : 'target');
    assert.equal(normalized.titleRoute, title); assert.deepEqual(request, before);
    const pair = connectionGraphPoints([normalized], new Map([['j', j], ['target', target]])).get('edge')!;
    const point = normalized.from.kind === 'junction' && normalized.from.nodeId === 'j' ? pair.from : pair.to;
    assert.ok(point.tangent!.x > 0, 'the shared forward flow remains left-to-right on either drag side');
  }
});

test('the pointer half overrides target anchor and centre ordering without changing ordinary endpoint gestures', () => {
  const j: ConnectionNodeGeometry = { id: 'j', kind: 'junction', x: 600, y: 400, width: 0, height: 0 };
  for (const targetX of [80, 470, 900]) for (const pointerX of [599.9, 600, 600.1]) for (const kind of ['card', 'box', 'group']) {
    const target: ConnectionNodeGeometry = { id: 'target', x: targetX, y: 200, width: 260, height: 146,
      ...(kind === 'group' ? { kind: 'group' } : kind === 'box' ? { presentation: 'text-box' } : {}) };
    const request = { from: { nodeId: 'j', kind: 'junction' as const, side: 'right' as const }, to: { nodeId: 'target', kind: target.kind, side: 'left' as const } };
    const normalized = connectionJunctionDragRequest(request, j, target, { x: pointerX, y: 270 });
    assert.equal(normalized.from.nodeId, pointerX < j.x ? 'target' : 'j');
    assert.equal(normalized.to.nodeId, pointerX < j.x ? 'j' : 'target');
    const ordinary = { from: { nodeId: 'a', side: 'right' as const }, to: request.to };
    assert.equal(connectionJunctionDragRequest(ordinary, { ...j, id: 'a', kind: undefined }, target, { x: pointerX, y: 270 }), ordinary);
  }
});
