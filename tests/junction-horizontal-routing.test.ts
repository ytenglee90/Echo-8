import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionGraphPoints } from '../src/plugins/connections/routing.ts';
import { connectionCurvePath, connectionStrokeGeometry } from '../src/plugins/connections/rendering.ts';
import { resolveConnectionRecordEndpoints, type ConnectionRecord, type ConnectionNodeGeometry } from '../src/protocols/connections.ts';
import { parseProject, serializeProject } from '../src/plugins/import-export/codec.ts';

const numbers = (path: string) => path.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
function forward(path: string, direction = 1) {
  const p = numbers(path).map((value, index) => index % 2 === 0 ? value * direction : value);
  assert.equal(p[1], p[3]); assert.equal(p[5], p[7]);
  assert.ok(p[2] > p[0]); assert.ok(p[4] < p[6]);
  assert.ok(p[0] <= p[2] && p[2] <= p[4] && p[4] <= p[6], 'controls stay in forward x order even on very steep branches');
}
const record = (id: string, from: ConnectionRecord['from'], to: ConnectionRecord['to']): ConnectionRecord => ({ id, from, to, labelWidth: 180, labelHeight: 48, revision: 1, createdAt: 1 });

test('junction fan-outs face left and right horizontally at every height, distance and zoom', () => {
  for (const direction of [-1, 1]) for (const dx of [10, 20, 80, 400]) for (const dy of [-1400, -300, 0, 400, 1600]) {
    const j = { id: 'j', x: 500, y: 1000, width: 0, height: 0, kind: 'junction' as const };
    const target = { id: 'target', x: direction === 1 ? j.x + dx : j.x - dx - 260, y: j.y + dy, width: 260, height: 160 };
    const edge = record('out', { nodeId: 'j', kind: 'junction', side: 'left' }, { nodeId: 'target', side: 'title' });
    const geometry = connectionGraphPoints([edge], new Map([['j', j], ['target', target]])).get('out')!;
    assert.equal(geometry.from.side, direction === 1 ? 'right' : 'left'); assert.deepEqual(geometry.from.tangent, { x: direction, y: 0 });
    forward(connectionCurvePath(geometry.from, geometry.to), direction);
    for (const zoom of [.4, 1, 2.4]) forward(connectionStrokeGeometry(geometry.from, geometry.to, zoom).shaftPath, direction);
  }
});

test('incoming and point-to-point links face their counterpart after reversing their layout', () => {
  const edges = [record('in', { nodeId: 'source', side: 'right' }, { nodeId: 'j', kind: 'junction', side: 'right' }),
    record('chain', { nodeId: 'j', kind: 'junction', side: 'left' }, { nodeId: 'k', kind: 'junction', side: 'right' })];
  for (const x of [100, 1200]) {
    const nodes = new Map<string, ConnectionNodeGeometry>([['source', { id: 'source', x: 400, y: 0, width: 260, height: 160 }],
      ['j', { id: 'j', x, y: 800, width: 0, height: 0, kind: 'junction' }], ['k', { id: 'k', x: 700, y: -200, width: 0, height: 0, kind: 'junction' }]]);
    const points = connectionGraphPoints(edges, nodes);
    const incoming = points.get('in')!, chain = points.get('chain')!;
    assert.equal(incoming.to.side, x < 400 ? 'right' : 'left'); assert.equal(chain.from.side, x < 700 ? 'right' : 'left'); assert.equal(chain.to.side, x < 700 ? 'left' : 'right');
    const a = numbers(connectionCurvePath(incoming.from, incoming.to)), b = numbers(connectionCurvePath(chain.from, chain.to));
    assert.equal(a[5], a[7]); assert.ok(x < 400 ? a[4] > a[6] : a[4] < a[6]);
    assert.equal(b[3], b[1]); assert.ok(x < 700 ? b[2] > b[0] : b[2] < b[0]); assert.equal(b[5], b[7]); assert.ok(x < 700 ? b[4] < b[6] : b[4] > b[6]);
    assert.deepEqual(incoming.to.tangent, { x: x < 400 ? -1 : 1, y: 0 }); assert.deepEqual(chain.from.tangent, { x: x < 700 ? 1 : -1, y: 0 });
    const endpoints = resolveConnectionRecordEndpoints(edges[1], nodes.get('j')!, nodes.get('k')!);
    assert.equal(endpoints.from.side, x < 700 ? 'right' : 'left'); assert.equal(endpoints.to.side, x < 700 ? 'left' : 'right');
  }
});

test('legacy junction side fields and labels round-trip unchanged while using the new projection', async () => {
  const edge = { ...record('legacy', { nodeId: 'j', kind: 'junction', side: 'left' }, { nodeId: 'target', side: 'title' }), label: '保留标签', lineColor: '#ab3745' };
  const project = await parseProject(await serializeProject({ document: { revision: 1, namespaces: { connections: { legacy: edge } } }, plugins: [] }));
  const restored = project.document.namespaces.connections.legacy as ConnectionRecord;
  assert.deepEqual(restored, edge);
  const nodes = new Map([['j', { id: 'j', x: 100, y: 700, width: 0, height: 0 }], ['target', { id: 'target', x: 400, y: 0, width: 260, height: 160 }]]);
  const point = connectionGraphPoints([restored], nodes).get('legacy')!;
  assert.equal(point.from.side, 'right'); assert.deepEqual(point.from.tangent, { x: 1, y: 0 });
  assert.deepEqual(restored, edge, 'geometry never rewrites the stored record');
});
