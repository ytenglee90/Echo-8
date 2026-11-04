import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionGroupPortHit, connectionHorizontalSides, connectionTitleAlignmentTolerance, type ConnectionNodeGeometry, type ConnectionRecord } from '../src/protocols/connections.ts';
import { connectionGraphPoints, connectionStrokeForEndpoints } from '../src/plugins/connections/routing.ts';
import { connectionCurvePath } from '../src/plugins/connections/rendering.ts';
import { splitConnectionsAtJunction } from '../src/plugins/connections/junctions.ts';

const edge = (id: string, from: ConnectionRecord['from'], to: ConnectionRecord['to']): ConnectionRecord => ({ id, from, to, labelWidth: 180, labelHeight: 48, revision: 1, createdAt: 1 });
const values = (path: string) => path.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);

test('group source and target hit rectangles have the same screen size at 40%, normal and enlarged zoom', () => {
  for (const zoom of [.4, 1, 2.4]) for (const height of [200, 1600]) for (const side of ['left', 'right'] as const) {
    const node = { id: 'g', x: 100, y: 80, width: 320, height, kind: 'group' as const };
    const x = node.x + (side === 'left' ? 0 : node.width), y = node.y + height / 2;
    const sign = side === 'left' ? -1 : 1;
    assert.equal(connectionGroupPortHit(node, { x: x + sign * 23 / zoom, y: y + 31 / zoom }, zoom)?.side, side);
    assert.equal(connectionGroupPortHit(node, { x: x + sign * 25 / zoom, y }, zoom), undefined);
    assert.equal(connectionGroupPortHit(node, { x, y: y + 33 / zoom }, zoom), undefined);
  }
});

test('title alignment band retains the original operation side across tiny centre reversals for cards and boxes', () => {
  for (const presentation of ['card', 'text-box'] as const) for (const side of ['left', 'right'] as const) for (const sourceIsLeft of [false, true]) {
    const from = { id: 'a', x: 100, y: 500, width: 260, height: 120, presentation };
    const to = { ...from, id: 'b', y: 0 };
    const record = { ...edge('e', { nodeId: 'a', side: 'title' }, { nodeId: 'b', side: 'title' }), titleOrigin: { side, sourceIsLeft } };
    const tolerance = connectionTitleAlignmentTolerance(from, to);
    for (const dx of [-tolerance, -1, 0, 1, tolerance]) {
      const sides = connectionHorizontalSides(record, { ...from, x: from.x + dx }, to);
      assert.equal(sides.from.side, side); assert.equal(sides.to.side, side);
    }
    for (const dx of [-tolerance - 1, tolerance + 1]) {
      const sides = connectionHorizontalSides(record, { ...from, x: from.x + dx }, to);
      const expected = dx < 0 ? 'left' : 'right';
      assert.equal(sides.from.side, expected); assert.equal(sides.to.side, expected);
    }
  }
});

for (const title of [false, true]) for (const commonTo of [false, true]) test(`${title ? 'title' : 'body'} shared ${commonTo ? 'input' : 'output'} junction segments face their own counterpart; input arrows follow physical ports`, () => {
  const nodes = new Map<string, ConnectionNodeGeometry>();
  for (let i = 0; i < 4; i += 1) nodes.set(String(i), { id: String(i), x: 200, y: i * 220, width: 240, height: 160 });
  const endpoint = (id: string) => ({ nodeId: id, side: title ? 'title' as const : 'right' as const });
  const records = [0, 1, 2].map(i => ({ ...edge(String(i), endpoint(commonTo ? String(i) : '3'), endpoint(commonTo ? '3' : String(i))), titleOrigin: { side: 'right' as const, sourceIsLeft: true } }));
  const split = splitConnectionsAtJunction(records, { x: 40, y: 500 });
  for (const pointX of [40, 800]) {
    nodes.set(split.junction.id, { ...split.junction, x: pointX, width: 0, height: 0, kind: 'junction' });
    const points = connectionGraphPoints(split.connections, nodes);
    let arrows = 0;
    for (const record of split.connections) {
      const p = points.get(record.id)!;
      const nodePoint = record.from.kind === 'junction' ? p.to : p.from;
      assert.equal(nodePoint.side, pointX < 200 ? 'left' : 'right', 'old title origin cannot override the new point-relative side');
      const curve = values(connectionCurvePath(p.from, p.to));
      if (record.from.kind === 'junction') assert.equal(curve.at(-3), curve.at(-1), 'node arrival is horizontal');
      else assert.equal(curve[1], curve[3], 'node departure is horizontal');
      const tangent = record.from.kind === 'junction' ? p.from.tangent : p.to.tangent;
      const reference = points.get(split.connections[0].id)!;
      const axis = (split.connections[0].from.kind === 'junction' ? reference.from.tangent : reference.to.tangent)!;
      assert.ok(Math.abs(tangent!.x * axis.y - tangent!.y * axis.x) < 1e-9, 'incident handles share an axis even when legacy logical directions disagree');
      assert.ok(tangent!.x * (p.to.x - p.from.x) >= 0 && tangent!.y * (p.to.y - p.from.y) >= 0, 'automatic handles never point backwards');
      const stroke = connectionStrokeForEndpoints(record, p);
      if (stroke.arrowPath) {
        arrows += 1;
        const endpoint = record[stroke.arrowEnd!];
        assert.notEqual(endpoint.kind, 'junction');
        if (!title) assert.equal(p[stroke.arrowEnd!].side, 'left');
        assert.deepEqual(values(stroke.arrowPath).slice(2, 4), [p[stroke.arrowEnd!].x, p[stroke.arrowEnd!].y]);
      }
    }
    if (!title) assert.equal(arrows, pointX < 200 ? 4 : 0);
  }
});

test('a direct solid edge switches its arrow to the actual input when stored endpoints reverse horizontally', () => {
  const record = edge('e', { nodeId: 'a', side: 'right' }, { nodeId: 'b', side: 'left' });
  for (const ax of [0, 1000]) {
    const points = connectionGraphPoints([record], new Map([['a', { id: 'a', x: ax, y: 0, width: 240, height: 160 }], ['b', { id: 'b', x: 500, y: 400, width: 240, height: 160 }]])).get('e')!;
    const stroke = connectionStrokeForEndpoints(record, points);
    assert.equal(stroke.arrowEnd, ax === 0 ? 'to' : 'from');
    assert.equal(points[stroke.arrowEnd!].side, 'left');
    assert.deepEqual(values(stroke.arrowPath).slice(2, 4), [points[stroke.arrowEnd!].x, points[stroke.arrowEnd!].y]);
  }
});

test('a horizontally overlapping junction faces the actual input/output anchor rather than an object centre', () => {
  const node: ConnectionNodeGeometry = { id: 'a', x: 200, y: 0, width: 260, height: 160 };
  const point: ConnectionNodeGeometry = { id: 'j', x: 330, y: 500, width: 0, height: 0, kind: 'junction' };
  for (const incoming of [false, true]) {
    const record = incoming ? edge('e', { nodeId: 'a', side: 'right' }, { nodeId: 'j', kind: 'junction', side: 'left' })
      : edge('e', { nodeId: 'j', kind: 'junction', side: 'right' }, { nodeId: 'a', side: 'left' });
    const points = connectionGraphPoints([record], new Map([['a', node], ['j', point]])).get('e')!;
    const p = incoming ? points.to : points.from, other = incoming ? points.from : points.to;
    assert.equal(p.side, other.x < p.x ? 'left' : 'right');
    const dx = incoming ? p.x - other.x : other.x - p.x, dy = incoming ? p.y - other.y : other.y - p.y, length = Math.hypot(dx, dy);
    assert.ok(Math.abs(p.tangent!.x - dx / length) < 1e-9 && Math.abs(p.tangent!.y - dy / length) < 1e-9);
  }
});
