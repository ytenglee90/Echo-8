import assert from 'node:assert/strict';
import test from 'node:test';
import dataWorker from '../cloud/data-worker/worker.js';
import { SQLiteD1 } from './helpers/d1.ts';
import {
  CLOUD_D1_FREE_DATABASE_CAPACITY_BYTES,
  CLOUD_DATA_WORKER_VERSION,
  cloudDataWorkerUpgradeAvailable,
} from '../src/cloud/contracts.ts';
import { decryptJson, encryptJson, signCompactJson, signDataToken, verifyCompactJson } from '../src/server/cloud/crypto.ts';
import { ensureControlSchema } from '../src/server/cloud/control-store.ts';
import { externalizeCloudCommit, hydrateRemoteDocument } from '../src/plugins/cloud-sync/model.ts';
import type { TransactionCommitRecord } from '../src/protocols/state.ts';

test('cloud control cryptography signs sessions, encrypts grants and issues installation-scoped tokens', async () => {
  const secret = 'test-secret-that-is-long-enough-for-a-local-contract-test';
  const signed = await signCompactJson({ sub: 'user-1', exp: 42 }, secret);
  assert.deepEqual(await verifyCompactJson(signed, secret), { sub: 'user-1', exp: 42 });
  assert.equal(await verifyCompactJson(signed, `${secret}-wrong`), undefined);

  const encrypted = await encryptJson({ accessToken: 'not-logged', refreshToken: 'also-not-logged' }, secret);
  assert.doesNotMatch(encrypted, /not-logged/u);
  assert.deepEqual(await decryptJson(encrypted, secret), {
    accessToken: 'not-logged', refreshToken: 'also-not-logged',
  });

  const token = await signDataToken({
    sub: 'user-1', aud: 'installation-1', installationId: 'installation-1', scope: ['projects:read'],
  }, secret, 60);
  const payload = JSON.parse(Buffer.from(token.token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.equal(payload.iss, 'echo8-control');
  assert.equal(payload.aud, 'installation-1');
  assert.equal(payload.sub, 'user-1');
  assert.equal(token.expiresAt > Date.now(), true);
});

test('cloud data Worker release detection upgrades older installs without downgrading newer ones', () => {
  assert.equal(CLOUD_DATA_WORKER_VERSION, 7);
  assert.equal(cloudDataWorkerUpgradeAvailable(1), true);
  assert.equal(cloudDataWorkerUpgradeAvailable(CLOUD_DATA_WORKER_VERSION), false);
  assert.equal(cloudDataWorkerUpgradeAvailable(CLOUD_DATA_WORKER_VERSION + 1), false);
  assert.equal(cloudDataWorkerUpgradeAvailable(0), false);
});

test('control schema adds a version column to legacy installation tables', async () => {
  const db = new LegacyControlD1();
  await ensureControlSchema(db as unknown as D1Database);
  assert.equal(db.addedWorkerVersion, true);
  assert.equal(db.recordedVersion2, true);
});

test('cloud commit externalization keeps large text chunks out of D1 operations and hydrates them on bootstrap', () => {
  const record: TransactionCommitRecord = {
    id: 'transaction-123456',
    label: '输入正文',
    timestamp: 100,
    sourceMessageId: 'message-123456',
    historyAction: 'record',
    forward: [{
      op: 'set', domain: 'document', namespace: 'textContentChunk', key: 'chunk-123456', value: '很长的正文',
    }],
    inverse: [{ op: 'delete', domain: 'document', namespace: 'textContentChunk', key: 'chunk-123456' }],
  };
  const externalized = externalizeCloudCommit(record);
  assert.deepEqual(externalized.chunks, [{ id: 'chunk-123456', value: '很长的正文' }]);
  assert.deepEqual(externalized.commit.forward[0]?.value, { __echo8ContentChunkRef: 'chunk-123456' });

  const document = hydrateRemoteDocument({
    project: { id: 'project-123456', name: '测试', createdAt: 1, updatedAt: 2, headRevision: 1 },
    checkpointRevision: 0,
    checkpoint: {
      formatVersion: 1,
      savedAt: 1,
      document: { revision: 0, namespaces: { textContentChunk: {} } },
      plugins: [],
      contentChunkIds: ['chunk-123456'],
    },
    chunks: externalized.chunks,
    operations: [{ revision: 1, commit: externalized.commit }],
  });
  assert.equal(document.namespaces.textContentChunk?.['chunk-123456'], '很长的正文');
  assert.equal(document.revision, 1);
});

test('user data Worker exposes only health without a token and enforces the configured browser origin', async () => {
  const env = mockDataEnv();
  const health = await dataWorker.fetch(new Request('https://data.example/v1/health', {
    headers: { origin: 'https://canvas.example' },
  }), env);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), 'https://canvas.example');
  assert.deepEqual(await health.json(), { ok: true, apiVersion: 1, workerVersion: CLOUD_DATA_WORKER_VERSION, bookFormat: 3 });

  const preflight = await dataWorker.fetch(new Request('https://data.example/v1/projects/project-123456', {
    method: 'OPTIONS',
    headers: { origin: 'https://canvas.example' },
  }), env);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PATCH/u);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /DELETE/u);

  const unauthorized = await dataWorker.fetch(new Request('https://data.example/v1/projects', {
    headers: { origin: 'https://canvas.example' },
  }), env);
  assert.equal(unauthorized.status, 401);

  const signed = await signDataToken({
    sub: 'user-1', aud: 'installation-1', installationId: 'installation-1', scope: ['projects:read'],
  }, env.DATA_SIGNING_SECRET, 60);
  const authorized = await dataWorker.fetch(new Request('https://data.example/v1/projects', {
    headers: { origin: 'https://canvas.example', authorization: `Bearer ${signed.token}` },
  }), env);
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { projects: [] });

  const foreignOrigin = await dataWorker.fetch(new Request('https://data.example/v1/health', {
    headers: { origin: 'https://attacker.example' },
  }), env);
  assert.equal(foreignOrigin.headers.get('access-control-allow-origin'), null);
});

test('user data Worker stores chunks and multipart checkpoints in D1 without an R2 binding', async () => {
  const db = new MemoryD1();
  const env = {
    INSTALLATION_ID: 'installation-d1-only',
    DATA_SIGNING_SECRET: 'data-worker-d1-only-contract-secret',
    ALLOWED_ORIGIN: 'https://canvas.example',
    STORAGE_MODE: 'd1',
    D1_CAPACITY_BYTES: String(CLOUD_D1_FREE_DATABASE_CAPACITY_BYTES),
    DB: db,
  };
  const signed = await signDataToken({
    sub: 'user-1', aud: env.INSTALLATION_ID, installationId: env.INSTALLATION_ID,
    scope: ['projects:read', 'projects:write'],
  }, env.DATA_SIGNING_SECRET, 60);
  const headers = {
    origin: env.ALLOWED_ORIGIN,
    authorization: `Bearer ${signed.token}`,
    'content-type': 'application/json',
  };
  const projectId = 'project-d1-only';
  const created = await dataWorker.fetch(new Request('https://data.example/v1/projects', {
    method: 'POST', headers, body: JSON.stringify({ id: projectId, name: 'D1 画布' }),
  }), env);
  assert.equal(created.status, 201);

  const renamed = await dataWorker.fetch(new Request(`https://data.example/v1/projects/${projectId}`, {
    method: 'PATCH', headers, body: JSON.stringify({ name: '  重命名的书籍  ' }),
  }), env);
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json() as { project: { name: string } }).project.name, '重命名的书籍');

  const rejectedRename = await dataWorker.fetch(new Request(`https://data.example/v1/projects/${projectId}`, {
    method: 'PATCH', headers, body: JSON.stringify({ name: '   ' }),
  }), env);
  assert.equal(rejectedRename.status, 400);

  const leased = await dataWorker.fetch(new Request(`https://data.example/v1/projects/${projectId}/lease`, {
    method: 'POST', headers, body: JSON.stringify({ deviceId: 'device-d1-only' }),
  }), env);
  assert.equal(leased.status, 200);
  const lease = (await leased.json() as { lease: { id: string } }).lease;

  const chunkId = 'chunk-d1-only';
  const chunkValue = '跨设备正文';
  const uploaded = await dataWorker.fetch(new Request(`https://data.example/v1/projects/${projectId}/chunks`, {
    method: 'POST', headers, body: JSON.stringify({
      deviceId: 'device-d1-only', leaseId: lease.id,
      chunks: [{ id: chunkId, value: chunkValue }],
    }),
  }), env);
  assert.equal(uploaded.status, 200);

  const unicodePayload = '界'.repeat(190_000);
  const checkpoint = {
    formatVersion: 1,
    savedAt: 1,
    document: { revision: 0, namespaces: { textContentChunk: {}, testMetadata: { large: unicodePayload } } },
    plugins: [],
    contentChunkIds: [chunkId],
  };
  const synced = await dataWorker.fetch(new Request(`https://data.example/v1/projects/${projectId}/sync`, {
    method: 'POST', headers, body: JSON.stringify({
      deviceId: 'device-d1-only', leaseId: lease.id, baseRevision: 0, commits: [], checkpoint, chunks: [],
    }),
  }), env);
  assert.equal(synced.status, 200);
  assert.equal((db.checkpointParts.get(`${projectId}:0`) ?? []).length > 1, true);

  const storage = await dataWorker.fetch(new Request('https://data.example/v1/storage', {
    method: 'GET', headers,
  }), env);
  assert.equal(storage.status, 200);
  const storageBody = await storage.json() as { storage: Record<string, unknown> };
  assert.equal(storageBody.storage.storageMode, 'd1');
  assert.equal(storageBody.storage.usedBytes, db.sizeBytes);
  assert.equal(storageBody.storage.capacityBytes, CLOUD_D1_FREE_DATABASE_CAPACITY_BYTES);
  assert.equal(
    storageBody.storage.remainingBytes,
    CLOUD_D1_FREE_DATABASE_CAPACITY_BYTES - db.sizeBytes,
  );
  assert.equal(storageBody.storage.quotaBasis, 'd1-free-database-limit');
  assert.equal(Number.isFinite(storageBody.storage.measuredAt), true);

  const bootstrapped = await dataWorker.fetch(new Request(`https://data.example/v1/projects/${projectId}/bootstrap`, {
    method: 'GET', headers,
  }), env);
  assert.equal(bootstrapped.status, 200);
  const body = await bootstrapped.json() as {
    project: { name: string };
    checkpoint: typeof checkpoint;
    chunks: Array<{ id: string; value: unknown }>;
  };
  assert.equal(body.project.name, '重命名的书籍');
  assert.equal(body.checkpoint.document.namespaces.testMetadata.large, unicodePayload);
  assert.deepEqual(body.chunks, [{ id: chunkId, value: chunkValue }]);

  const deleted = await dataWorker.fetch(new Request(`https://data.example/v1/projects/${projectId}`, {
    method: 'DELETE', headers,
  }), env);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });

  const listedAfterDelete = await dataWorker.fetch(new Request('https://data.example/v1/projects', {
    method: 'GET', headers,
  }), env);
  assert.equal(listedAfterDelete.status, 200);
  assert.deepEqual(await listedAfterDelete.json(), { projects: [] });

  const bootstrapAfterDelete = await dataWorker.fetch(new Request(
    `https://data.example/v1/projects/${projectId}/bootstrap`,
    { method: 'GET', headers },
  ), env);
  assert.equal(bootstrapAfterDelete.status, 404);
});

function mockDataEnv() {
  return {
    INSTALLATION_ID: 'installation-1',
    DATA_WORKER_VERSION: String(CLOUD_DATA_WORKER_VERSION),
    DATA_SIGNING_SECRET: 'data-worker-contract-secret',
    ALLOWED_ORIGIN: 'https://canvas.example',
    DB: {
      prepare() {
        const statement = {
          bind() { return statement; },
          async all() { return { results: [] }; },
          async first() { return null; },
          async run() { return { success: true }; },
        };
        return statement;
      },
      async batch() { return []; },
    },
    BUCKET: {
      async get() { return null; },
      async put() { return undefined; },
    },
  };
}

class LegacyControlD1 {
  addedWorkerVersion = false;
  recordedVersion2 = false;

  prepare(sql: string) {
    return {
      bind() { return this; },
      all: async () => {
        if (normalizeSql(sql) === 'PRAGMA table_info(installations)') {
          return { results: [{ name: 'id' }, { name: 'worker_name' }] };
        }
        return { results: [] };
      },
      async first() { return null; },
      run: async () => {
        const normalized = normalizeSql(sql);
        if (normalized.startsWith('ALTER TABLE installations ADD COLUMN worker_version')) {
          this.addedWorkerVersion = true;
        }
        if (normalized.includes('schema_migrations') && normalized.includes('VALUES (2,')) {
          this.recordedVersion2 = true;
        }
        return changed();
      },
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class MemoryD1 extends SQLiteD1 {}

function normalizeSql(sql: string) { return sql.replace(/\s+/gu, ' ').trim(); }
function changed() { return { success: true, meta: { changes: 1 } }; }
