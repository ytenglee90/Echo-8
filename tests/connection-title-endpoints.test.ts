import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONNECTION_TITLE_ANCHOR_OFFSET_Y,
  DEFAULT_CONNECTION_LABEL_HEIGHT,
  DEFAULT_CONNECTION_LABEL_WIDTH,
  connectionEndpointPoint,
  resolveConnectionRecordEndpoints,
  type ConnectionRecord,
} from '../src/protocols/connections.ts';
import { updateConnectionSession } from '../src/plugins/canvas/surface-geometry.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import {
  CONNECTION_ARROW_SCREEN_HALF_WIDTH,
  CONNECTION_ARROW_SCREEN_LENGTH,
  CONNECTION_MIN_HANDLE_LENGTH,
  connectionCurveBounds,
  connectionCurveMidpoint,
  connectionCurvePath,
  connectionCurvePathWithArrow,
  distanceToConnectionCurve,
  orderConnectionsForPaint,
} from '../src/plugins/connections/rendering.ts';

const nodeDefaults = {
  revision: 1,
  title: '节点',
  preview: '',
  titleColor: '#111111',
  textColor: '#111111',
  presentation: 'card' as const,
  resizeLimits: { minWidth: 220, maxWidth: 1600, minHeight: 120, maxHeight: 1200 },
  length: 0,
};
const source = { ...nodeDefaults, id: 'source', x: 100, y: 80, width: 320, height: 180 };
const target = { ...nodeDefaults, id: 'target', x: 120, y: 420, width: 320, height: 180 };

test('title connections retain both title endpoints and anchor before the title dot', () => {
  const record: ConnectionRecord = {
    id: 'connection-title',
    from: { nodeId: source.id, side: 'title' },
    to: { nodeId: target.id, side: 'title' },
    labelWidth: DEFAULT_CONNECTION_LABEL_WIDTH,
    labelHeight: DEFAULT_CONNECTION_LABEL_HEIGHT,
    revision: 1,
    createdAt: 1,
  };
  const endpoints = resolveConnectionRecordEndpoints(record, source, target);
  assert.deepEqual(endpoints, {
    from: { nodeId: source.id, side: 'title' },
    to: { nodeId: target.id, side: 'title' },
  });
  assert.deepEqual(connectionEndpointPoint(endpoints.from, source), {
    x: source.x,
    y: source.y + CONNECTION_TITLE_ANCHOR_OFFSET_Y,
    side: 'title',
  });
});

test('dragging from a title port keeps title routing while targeting another node', () => {
  const session = updateConnectionSession({
    from: { nodeId: source.id, side: 'title' },
    pointer: { x: source.x, y: source.y + CONNECTION_TITLE_ANCHOR_OFFSET_Y },
    pointerId: 1,
    startClientX: 100,
    startClientY: 101,
    moved: false,
  }, { x: target.x + 20, y: target.y + 20 }, 120, 440, [source, target], {}, {}, 1);
  assert.equal(session.from.side, 'title');
  assert.equal(session.to?.side, 'title');
  assert.equal(session.to?.nodeId, target.id);
});

test('title connection curves route outside the title edge and remain bounded', () => {
  const from = connectionEndpointPoint({ nodeId: source.id, side: 'title' }, source);
  const to = connectionEndpointPoint({ nodeId: target.id, side: 'title' }, target);
  const bounds = connectionCurveBounds(from, to);
  assert.ok(bounds.x < Math.min(from.x, to.x) - 170);
  assert.ok(bounds.x > Math.min(from.x, to.x) - 230);
  assert.match(connectionCurvePath(from, to), /^M 100 101 C /u);
  assert.doesNotMatch(connectionCurvePath(from, to), / L /u);
  const coordinates = connectionCurvePath(from, to).match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  assert.equal(coordinates[3], from.y);
  assert.equal(coordinates[5], to.y);
  const midpoint = connectionCurveMidpoint(from, to);
  assert.ok(midpoint.x < Math.min(from.x, to.x));
  assert.ok(midpoint.y > from.y && midpoint.y < to.y);
  assert.ok(distanceToConnectionCurve(midpoint, from, to) < 1);
  assert.ok(bounds.y <= from.y && bounds.y + bounds.height >= to.y);
});

test('ordinary connection curves use enlarged horizontal handles at both endpoints', () => {
  const path = connectionCurvePath(
    { x: 0, y: 0, side: 'right' },
    { x: 120, y: 300, side: 'left' },
  );
  const coordinates = path.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  assert.deepEqual(coordinates, [0, 0, 160, 0, -40, 300, 120, 300]);
  assert.equal(coordinates[2] - coordinates[0], CONNECTION_MIN_HANDLE_LENGTH);
  assert.equal(coordinates[6] - coordinates[4], CONNECTION_MIN_HANDLE_LENGTH);
});

test('ordinary connection handles follow endpoint sides even when endpoint x positions overlap', () => {
  const path = connectionCurvePath(
    { x: 320, y: 100, side: 'right' },
    { x: 280, y: 500, side: 'left' },
  );
  const coordinates = path.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  assert.ok(coordinates[2] > coordinates[0]);
  assert.ok(coordinates[4] < coordinates[6]);

  const arrow = connectionCurvePathWithArrow(
    { x: 320, y: 100, side: 'right' },
    { x: 280, y: 500, side: 'left' },
  ).match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  assert.equal(arrow.at(-4), 280);
  assert.ok(arrow.at(-6)! < arrow.at(-4)!);
  assert.ok(arrow.at(-2)! < arrow.at(-4)!);
});

test('connection output is one larger integrated solid arrow path without a marker tail', () => {
  const path = connectionCurvePathWithArrow(
    { x: 0, y: 0, side: 'right' },
    { x: 120, y: 300, side: 'left' },
  );
  const coordinates = path.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  assert.equal((path.match(/\bM\b/gu) ?? []).length, 2);
  assert.equal((path.match(/\bC\b/gu) ?? []).length, 2);
  assert.equal((path.match(/\bL\b/gu) ?? []).length, 2);
  assert.equal((path.match(/\bZ\b/gu) ?? []).length, 2);
  assert.equal(coordinates.length, 20);
  assert.deepEqual(coordinates.slice(6, 8), [
    120 - CONNECTION_ARROW_SCREEN_LENGTH,
    300,
  ]);
  assert.deepEqual(coordinates.slice(-6), [
    120 - CONNECTION_ARROW_SCREEN_LENGTH,
    300 + CONNECTION_ARROW_SCREEN_HALF_WIDTH,
    120,
    300,
    120 - CONNECTION_ARROW_SCREEN_LENGTH,
    300 - CONNECTION_ARROW_SCREEN_HALF_WIDTH,
  ]);
  const zoomed = connectionCurvePathWithArrow(
    { x: 0, y: 0, side: 'right' },
    { x: 120, y: 300, side: 'left' },
    0.5,
  ).match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  const expectedScreenRatio = Math.sqrt(0.5);
  assert.ok(Math.abs(
    (120 - zoomed.at(-6)!) * 0.5 - CONNECTION_ARROW_SCREEN_LENGTH * expectedScreenRatio,
  ) < 0.001);
  assert.ok(Math.abs(
    (zoomed.at(-5)! - zoomed.at(-1)!) * 0.5 -
      CONNECTION_ARROW_SCREEN_HALF_WIDTH * 2 * expectedScreenRatio,
  ) < 0.001);
});

test('selected connections paint after ordinary connections without changing either stable order', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ connection: { id } }));
  assert.deepEqual(
    orderConnectionsForPaint(items, new Set(['b', 'd'])).map((item) => item.connection.id),
    ['a', 'c', 'b', 'd'],
  );
  assert.deepEqual(items.map((item) => item.connection.id), ['a', 'b', 'c', 'd']);
});

test('connection data migration adds a revision without dropping legacy fields', async () => {
  const migration = createConnectionsPlugin().migrations?.find((candidate) => candidate.from === 2);
  assert.ok(migration);
  const migrated = await migration.migrate({
    connections: {
      legacy: {
        id: 'legacy',
        from: { nodeId: 'a', side: 'right' },
        to: { nodeId: 'b', side: 'left' },
        createdAt: 1,
        futureField: '保留',
      },
    },
  });
  assert.deepEqual(migrated.connections.legacy, {
    id: 'legacy',
    from: { nodeId: 'a', side: 'right' },
    to: { nodeId: 'b', side: 'left' },
    createdAt: 1,
    futureField: '保留',
    revision: 1,
  });

  const appearanceMigration = createConnectionsPlugin().migrations?.find((candidate) => candidate.from === 3);
  assert.ok(appearanceMigration);
  const appearanceMigrated = await appearanceMigration.migrate({
    connections: migrated.connections,
    futureNamespace: { keep: true },
  });
  assert.deepEqual(appearanceMigrated.connectionAppearance, {});
  assert.deepEqual(appearanceMigrated.futureNamespace, { keep: true });

  const labelSizeMigration = createConnectionsPlugin().migrations?.find((candidate) => candidate.from === 4);
  assert.ok(labelSizeMigration);
  const labelSizeMigrated = await labelSizeMigration.migrate({
    connections: {
      legacy: appearanceMigrated.connections.legacy,
    },
    connectionAppearance: appearanceMigrated.connectionAppearance,
    futureNamespace: { keep: true },
  });
  const migratedLegacySize = labelSizeMigrated.connections.legacy as Record<string, unknown>;
  assert.equal(migratedLegacySize.labelWidth, DEFAULT_CONNECTION_LABEL_WIDTH);
  assert.equal(migratedLegacySize.labelHeight, DEFAULT_CONNECTION_LABEL_HEIGHT);
  assert.equal(migratedLegacySize.futureField, '保留');
  assert.deepEqual(labelSizeMigrated.futureNamespace, { keep: true });
});
