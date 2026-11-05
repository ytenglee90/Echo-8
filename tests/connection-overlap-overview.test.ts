import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewNetwork } from '../src/plugins/connections/overview-network.ts';
import { OverlapCycle } from '../src/plugins/connections/overlap-cycle.ts';
import { JUNCTION_MOVE_RADIUS, JUNCTION_PORT_OFFSET, JUNCTION_PORT_RADIUS } from '../src/plugins/connections/junction-controls.ts';
import type { ConnectionRecord } from '../src/protocols/connections.ts';

test('overview follows related junction networks but stops at unrelated ordinary endpoints', () => {
  const edge = (id: string, from: string, to: string): ConnectionRecord => ({ id, from: { nodeId: from, side: 'right', ...(from.startsWith('j') ? { kind: 'junction' } : {}) },
    to: { nodeId: to, side: 'left', ...(to.startsWith('j') ? { kind: 'junction' } : {}) }, labelWidth: 0, labelHeight: 0, revision: 1, createdAt: 0 });
  const records = [edge('a','n0','j0'),edge('b','j0','j1'),edge('c','j1','n1'),edge('d','n2','n1'),edge('e','g0','j2'),edge('f','j2','n3')];
  const byId = new Map(records.map(edge => [edge.id, edge])), byNode = new Map<string, Set<string>>();
  for (const edge of records) for (const end of [edge.from,edge.to]) { const ids = byNode.get(end.nodeId) ?? new Set(); ids.add(edge.id); byNode.set(end.nodeId,ids); }
  assert.equal(overviewNetwork([],byNode,byId).edges.size,0);
  const related = overviewNetwork(['n0'],byNode,byId);
  assert.deepEqual([...related.edges].sort(), ['a','b','c']);
  assert.deepEqual([...related.points].sort(), ['j0','j1']);
  assert.deepEqual([...overviewNetwork(['g0'],byNode,byId).edges].sort(), ['e','f']);
  assert.equal(overviewNetwork(['n0','g0'],byNode,byId).edges.size,5);
});

test('overlap clicks cycle stable IDs, ignore paint order and reset when position or geometry changes', () => {
  const cycle = new OverlapCycle(), ids = ['a','b','c'];
  const click = (x=100,y=100,signature='geometry') => { const next=cycle.next(ids,x,y,signature,'b')!; cycle.commit(next,x,y,signature); return next; };
  assert.equal(click(),'b'); assert.equal(click(),'c'); assert.equal(click(),'a'); assert.equal(click(102,101),'b');
  assert.equal(click(200,200),'b'); assert.equal(click(200,200,'changed'),'b');
  cycle.reset(); assert.equal(click(),'b');
  assert.equal(cycle.next([],100,100,'geometry'),undefined);
});

test('move and connect hit circles have a real screen-space gap at every supported zoom', () => {
  for (const zoom of [.4,.5,1,2.4]) {
    const radius = JUNCTION_MOVE_RADIUS / zoom, port = JUNCTION_PORT_RADIUS / zoom, offset = JUNCTION_PORT_OFFSET / zoom;
    assert.ok(Math.abs((offset - radius - port) * zoom - 6) < 1e-9);
    assert.equal(radius * zoom * 2,32); assert.equal(port * zoom * 2,24);
  }
});
