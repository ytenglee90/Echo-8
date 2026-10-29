import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoreSnapshot, TransactionCommitRecord } from '../src/protocols/state.ts';
import { createWorkspacePersistencePolicy } from '../src/core/workspace-persistence.ts';
import { defineManifest } from '../src/plugins/manifest.ts';

const policy = createWorkspacePersistencePolicy([
  defineManifest('layout-probe', 'Layout probe', {
    namespaces: ['searchUI', 'palette'],
    namespaceDomains: { searchUI: 'workspace', palette: 'workspace' },
    sessionOnlyWorkspace: { searchUI: true, palette: ['open'] },
  }),
]);

test('session-only UI state is removed while colors, connections and functional preferences persist', () => {
  const snapshot: StoreSnapshot = {
    formatVersion: 1,
    document: {
      revision: 4,
      namespaces: {
        connections: { edge: { id: 'edge', from: 'a', to: 'b' } },
        canvasAppearance: { canvas: { background: '#202124' } },
      },
    },
    workspace: {
      revision: 7,
      namespaces: {
        searchUI: {
          open: true,
          panelRect: { x: 12, y: 24, width: 420, height: 640 },
        },
        palette: {
          open: true,
          preferences: { themeId: 'dark', toolbarBackground: '#141517' },
        },
      },
    },
  };

  assert.equal(policy.scrubStore(snapshot), true);
  assert.deepEqual(snapshot.document.namespaces.connections, {
    edge: { id: 'edge', from: 'a', to: 'b' },
  });
  assert.deepEqual(snapshot.document.namespaces.canvasAppearance, {
    canvas: { background: '#202124' },
  });
  assert.equal(snapshot.workspace.namespaces.searchUI, undefined);
  assert.deepEqual(snapshot.workspace.namespaces.palette, {
    preferences: { themeId: 'dark', toolbarBackground: '#141517' },
  });
});

test('recovery journal filtering drops layout-only transactions and retains mixed functional settings', () => {
  const record: TransactionCommitRecord = {
    id: 'transaction:layout',
    label: '更新界面',
    timestamp: 1,
    sourceMessageId: 'message:layout',
    historyAction: 'none',
    forward: [
      { op: 'set', domain: 'workspace', namespace: 'palette', key: 'open', value: true },
      {
        op: 'set',
        domain: 'workspace',
        namespace: 'palette',
        key: 'preferences',
        value: { themeId: 'dark' },
      },
    ],
    inverse: [
      { op: 'delete', domain: 'workspace', namespace: 'palette', key: 'preferences' },
      { op: 'delete', domain: 'workspace', namespace: 'palette', key: 'open' },
    ],
  };

  assert.deepEqual(policy.scrubRecord(record), {
    ...record,
    forward: [record.forward[1]],
    inverse: [record.inverse[0]],
  });
  assert.equal(policy.scrubRecord({
    ...record,
    forward: [record.forward[0]],
    inverse: [record.inverse[1]],
  }), undefined);
});
