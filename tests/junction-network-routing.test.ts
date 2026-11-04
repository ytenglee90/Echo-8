import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionGraphPoints } from '../src/plugins/connections/routing.ts';
import { createConnectionScenePlanner, planConnectionScene } from '../src/plugins/connections/connection-scene.ts';
import { connectionCurvePath, distanceToConnectionCurve } from '../src/plugins/connections/rendering.ts';
import type { ConnectionNodeGeometry, ConnectionRecord } from '../src/protocols/connections.ts';
import { assertSmoothRoute, assertNoSelfIntersection } from './helpers/route-assertions.ts';

const edge = (id: string, a: string, b: string): ConnectionRecord => ({ id, from: { nodeId: a, side: 'right', ...(a.startsWith('j') ? { kind: 'junction' } : {}) },
  to: { nodeId: b, side: 'left', ...(b.startsWith('j') ? { kind: 'junction' } : {}) }, revision: 1, createdAt: 1, labelWidth: 0, labelHeight: 0 });
function fixture() {
  const nodes = new Map<string, ConnectionNodeGeometry>();
  for (let i = 0; i < 6; i++) nodes.set(`n${i}`, { id: `n${i}`, x: i < 3 ? 0 : 1000, y: i % 3 * 260, width: 260, height: 146 });
  nodes.set('j0', { id: 'j0', kind: 'junction', x: 500, y: 340, width: 0, height: 0 });
  nodes.set('j1', { id: 'j1', kind: 'junction', x: 760, y: 340, width: 0, height: 0 });
  return { nodes, records: [edge('a', 'n0', 'j0'), edge('b', 'j0', 'n1'), edge('c', 'n2', 'j0'), edge('trunk', 'j0', 'j1'), edge('d', 'j1', 'n3'), edge('e', 'n4', 'j1'), edge('f', 'j1', 'n5')] };
}

test('a many-to-many junction network keeps continuous tangent/curvature on every planned path', () => {
  const { nodes, records } = fixture(), graph = connectionGraphPoints(records, nodes);
  assert.equal(graph.size, records.length, 'a network must not expand into every input/output pair');
  for (const pair of graph.values()) {
    assert.equal(pair.from.route, pair.to.route); assertSmoothRoute(pair.from.route!);
    assert.equal(distanceToConnectionCurve(pair.from, pair.from, pair.to), 0);
  }
});

test('reversing historical graph roles cannot change physical routes or the shared transition', () => {
  const { nodes, records } = fixture(), before = structuredClone(records), original = connectionGraphPoints(records, nodes);
  for (let index = 0; index < records.length; index++) {
    const changed = records.map((record, i) => i === index ? { ...record, from: record.to, to: record.from } : record), result = connectionGraphPoints(changed, nodes);
    for (const record of records) {
      const a = original.get(record.id)!, b = result.get(record.id)!;
      assert.equal(connectionCurvePath(a.from, a.to), index === records.indexOf(record) ? connectionCurvePath(b.to, b.from) : connectionCurvePath(b.from, b.to));
    }
  }
  assert.deepEqual(records, before);
});

test('wide, narrow, same-side, overlapping and angle-preference layouts never introduce a cusp', () => {
  for (const jx of [0, 260, 500, 999, 1260]) for (const jy of [0, 73, 340, 900]) for (const angle of [0, 15, 90, 180, 270, 345]) {
    const { nodes, records } = fixture(); nodes.set('j0', { ...nodes.get('j0')!, x: jx, y: jy, handleAngle: angle });
    for (const pair of connectionGraphPoints(records, nodes).values()) assertSmoothRoute(pair.from.route!);
  }
});

test('a manually steered mixed fan changes all branches while keeping one shared axis and no self-intersections', () => {
  const { nodes } = fixture(), records = [edge('a', 'j0', 'n3'), edge('b', 'j0', 'n4'), edge('c', 'j0', 'n5')];
  const original = connectionGraphPoints(records, nodes);
  for (const angle of [15, 30, 45, 90, 270, 330, 345]) {
    const moved = new Map(nodes); moved.set('j0', { ...nodes.get('j0')!, handleAngle: angle });
    const graph = connectionGraphPoints(records, moved), axes = [...graph.values()].map(pair => pair.from.tangent);
    assert.deepEqual(axes[0], axes[1]); assert.deepEqual(axes[1], axes[2]);
    for (const [id, pair] of graph) {
      assert.notEqual(pair.from.route!.key, original.get(id)!.from.route!.key);
      assertSmoothRoute(pair.from.route!); assertNoSelfIntersection(pair.from.route!);
    }
  }
});

test('free, hovered, duplicate and reconnect previews all use owner-planned routes', () => {
  const { nodes, records } = fixture(); const from = { nodeId: 'j0', kind: 'junction' as const, side: 'right' as const };
  const original = connectionGraphPoints(records, nodes);
  const free = planConnectionScene(records, nodes, { from, pointer: { x: 400, y: 700 } });
  for (const [id, points] of original) assert.equal(free.points.get(id)!.from.route!.key, points.from.route!.key);
  assertSmoothRoute(free.draft!.points.from.route!); assert.equal(free.draft!.record.to.nodeId, 'j0');
  const to = { nodeId: 'j1', kind: 'junction' as const, side: 'left' as const }, hovered = planConnectionScene(records, nodes, { from, to, pointer: { x: 760, y: 340 } });
  assert.equal(hovered.points.size, records.length, 'existing physical link is not counted twice');
  const reconnect = planConnectionScene(records, nodes, { from, to: { nodeId: 'n5', side: 'left' }, reconnectId: 'b', pointer: { x: 1000, y: 593 } });
  assert.equal(reconnect.points.size, records.length); assert.equal(reconnect.draft!.points.from.route, reconnect.points.get('b')!.from.route);
  assertSmoothRoute(reconnect.draft!.points.from.route!);
});

test('pointer-only updates reuse the document plan and unchanged target projection; geometry changes invalidate both', () => {
  const { nodes, records } = fixture(), planner = createConnectionScenePlanner(), baseline = planner(records, nodes, {});
  const from = { nodeId: 'j0', kind: 'junction' as const, side: 'right' as const };
  for (let i = 0; i < 100; i++) assert.equal(planner(records, nodes, { from, pointer: { x: 520 + i, y: 600 } }).points, baseline.points);
  const draft = { from, to: { nodeId: 'n3', side: 'left' as const }, pointer: { x: 1000, y: 73 } }, first = planner(records, nodes, draft);
  assert.equal(planner(records, nodes, { ...draft, pointer: { x: 1002, y: 75 } }), first);
  const moved = new Map(nodes); moved.set('n3', { ...nodes.get('n3')!, y: 900 });
  assert.notEqual(planner(records, moved, draft).draft!.points.from.route!.key, first.draft!.points.from.route!.key);
});

test('a feasible direction preference changes the transition while unsafe preferences remain smooth', () => {
  const { nodes } = fixture(), records = [edge('branch', 'j0', 'n5')], before = connectionGraphPoints(records, nodes).get('branch')!;
  const changed = new Map(nodes); changed.set('j0', { ...nodes.get('j0')!, handleAngle: 15 });
  const after = connectionGraphPoints(records, changed).get('branch')!;
  assert.notEqual(after.from.route!.key, before.from.route!.key);
  assert.equal(after.from.x, before.from.x); assert.equal(after.from.y, before.from.y); assertSmoothRoute(after.from.route!);
});

test('coincident horizontal spans, almost touching ports and mirrored detours remain smooth without self-intersection', () => {
  for (const x of [-300, -260, -100, -1, 0, 1, 100, 260, 300]) for (const y of [-300, -24, -1, 0, 1, 24, 300]) for (const angle of [0, 15, 90, 180, 270, 345]) {
    const nodes = new Map<string, ConnectionNodeGeometry>([
      ['j0', { id: 'j0', kind: 'junction', x: 0, y: 0, width: 0, height: 0, handleAngle: angle }],
      ['n0', { id: 'n0', x, y: y - 73, width: 260, height: 146 }],
    ]);
    const pair = connectionGraphPoints([edge('branch', 'j0', 'n0')], nodes).get('branch')!;
    assertSmoothRoute(pair.from.route!); assertNoSelfIntersection(pair.from.route!);
  }
});
