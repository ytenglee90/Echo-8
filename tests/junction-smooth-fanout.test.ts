import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionGraphPoints, connectionStrokeForEndpoints } from '../src/plugins/connections/routing.ts';
import { connectionCurvePath, connectionCurveBounds, connectionStrokeGeometry, distanceToConnectionCurve } from '../src/plugins/connections/rendering.ts';
import type { ConnectionNodeGeometry, ConnectionRecord } from '../src/protocols/connections.ts';

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
function curvature(curve: Point[], end: boolean) {
  const p = end ? curve : [...curve].reverse();
  const first = minus(p[3], p[2]), second = { x: p[3].x - 2 * p[2].x + p[1].x, y: p[3].y - 2 * p[2].y + p[1].y };
  return (first.x * second.y - first.y * second.x) / Math.hypot(first.x, first.y) ** 3;
}
function fixture(jx: number, title = true, angle = 0, incoming = false) {
  const nodes = new Map<string, ConnectionNodeGeometry>();
  for (let i = 0; i < 4; i++) nodes.set(`n${i}`, { id: `n${i}`, x: 208, y: [20, 222, 408, 594][i], width: 260, height: 146 });
  nodes.set('j', { id: 'j', x: jx, y: 576, width: 0, height: 0, kind: 'junction', handleAngle: angle });
  const endpoint = (id: string) => ({ nodeId: id, ...(id === 'j' ? { kind: 'junction' as const } : {}), side: title && id !== 'j' ? 'title' as const : 'left' as const });
  const pairs = [[endpoint('n3'), endpoint('j')], ...[0, 1, 2].map(i => [endpoint('j'), endpoint(`n${i}`)])];
  const records: ConnectionRecord[] = pairs.map(([from, to], i) => ({ id: String(i), from: incoming ? to : from, to: incoming ? from : to, titleRoute: title, labelWidth: 180, labelHeight: 48, revision: 1, createdAt: 1 }));
  return { nodes, records };
}
test('the reported fan has one forward junction derivative instead of an incoming/outgoing reversal', () => {
  for (const x of [64, 540]) for (const title of [true, false]) for (const incoming of [false, true]) {
    const { nodes, records } = fixture(x, title, 0, incoming), graph = connectionGraphPoints(records, nodes);
    const tangents = records.map(record => record.from.kind === 'junction' ? graph.get(record.id)!.from.tangent! : graph.get(record.id)!.to.tangent!);
    for (const tangent of tangents) { assert.equal(tangent.x, 0); assert.equal(tangent.y, incoming ? 1 : -1); }
    for (const record of records) {
      const pair = graph.get(record.id)!, parts = segments(connectionCurvePath(pair.from, pair.to));
      assert.ok(parts.length >= 3);
      for (let i = 1; i < parts.length; i++) {
        const left = direction(minus(parts[i - 1][3], parts[i - 1][2])), right = direction(minus(parts[i][1], parts[i][0]));
        assert.ok(Math.abs(left.x - right.x) < .0003 && Math.abs(left.y - right.y) < .0003, 'joins must share the forward tangent');
        assert.ok(Math.abs(curvature(parts[i - 1], true) + curvature(parts[i], false)) < .0005, 'joins must share signed geometric curvature');
      }
      const atPoint = record.from.kind === 'junction' ? curvature(parts[0], false) : curvature(parts.at(-1)!, true);
      assert.ok(Math.abs(atPoint) < 1e-8, 'junction curvature is zero on both sides');
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
test('manual 15-degree steps rotate the entire common axis without reintroducing a junction reversal', () => {
  for (let angle = 0; angle < 360; angle += 15) {
    const { nodes, records } = fixture(64, true, angle), graph = connectionGraphPoints(records, nodes);
    const expected = { x: Math.sin(angle * Math.PI / 180), y: -Math.cos(angle * Math.PI / 180) };
    for (const record of records) {
      const pair = graph.get(record.id)!, tangent = record.from.kind === 'junction' ? pair.from.tangent! : pair.to.tangent!;
      assert.ok(Math.abs(tangent.x - expected.x) < 1e-9 && Math.abs(tangent.y - expected.y) < 1e-9);
    }
  }
});

test('coincident routing endpoints have no loop, spurious arrow or non-finite hit bounds', () => {
  const point = { x: 120, y: 90, tangent: { x: 0, y: -1 } };
  assert.deepEqual(connectionStrokeGeometry(point, point), { shaftPath: 'M 120 90 C 120 90, 120 90, 120 90', arrowPath: '' });
  assert.deepEqual(connectionCurveBounds(point, point), { x: 112, y: 82, width: 16, height: 16 });
  assert.equal(distanceToConnectionCurve(point, point, point), 0);
});
