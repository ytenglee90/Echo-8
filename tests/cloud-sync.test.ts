import assert from 'node:assert/strict';
import test from 'node:test';
import dataWorker from '../cloud/data-worker/worker.js';
import {
  CLOUD_DATA_WORKER_VERSION,
  cloudDataWorkerUpgradeAvailable,
} from '../src/cloud/contracts.ts';
import { decryptJson, encryptJson, signCompactJson, signDataToken, verifyCompactJson } from '../src/server/cloud/crypto.ts';
import { ensureControlSchema } from '../src/server/cloud/control-store.ts';
import { externalizeCloudCommit, hydrateRemoteDocument } from '../src/plugins/cloud-sync/model.ts';
import type { TransactionCommitRecord } from '../src/core/transaction-manager.ts';

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
  assert.equal(CLOUD_DATA_WORKER_VERSION, 3);
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
  assert.deepEqual(await health.json(), { ok: true, apiVersion: 1, workerVersion: CLOUD_DATA_WORKER_VERSION });

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

class MemoryD1 {
  readonly projects = new Map<string, Record<string, unknown>>();
  readonly leases = new Map<string, Record<string, unknown>>();
  readonly chunks = new Map<string, Record<string, unknown>>();
  readonly checkpointManifests = new Map<string, Record<string, unknown>>();
  readonly checkpointParts = new Map<string, Array<Record<string, unknown>>>();

  prepare(sql: string) { return new MemoryD1Statement(this, sql); }

  async batch(statements: MemoryD1Statement[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  run(sql: string, args: unknown[]) {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('INSERT INTO projects')) {
      const [id, name, createdAt, updatedAt] = args;
      this.projects.set(String(id), {
        id, name, created_at: createdAt, updated_at: updatedAt, head_revision: 0,
        checkpoint_revision: 0, checkpoint_key: null, deleted_at: null,
      });
      return changed();
    }
    if (normalized.startsWith('UPDATE projects SET name')) {
      const [name, updatedAt, projectId] = args;
      const project = this.projects.get(String(projectId));
      if (!project) return unchanged();
      project.name = name;
      project.updated_at = updatedAt;
      return changed();
    }
    if (normalized.startsWith('UPDATE projects SET deleted_at')) {
      const [deletedAt, updatedAt, projectId] = args;
      const project = this.projects.get(String(projectId));
      if (!project) return unchanged();
      project.deleted_at = deletedAt;
      project.updated_at = updatedAt;
      return changed();
    }
    if (normalized.startsWith('INSERT INTO leases')) {
      const [projectId, leaseId, deviceId, expiresAt, updatedAt] = args;
      this.leases.set(String(projectId), {
        project_id: projectId, lease_id: leaseId, device_id: deviceId,
        expires_at: expiresAt, updated_at: updatedAt,
      });
      return changed();
    }
    if (normalized.startsWith('UPDATE leases SET expires_at')) {
      const [expiresAt, updatedAt, projectId, leaseId, deviceId] = args;
      const lease = this.leases.get(String(projectId));
      if (!lease || lease.lease_id !== leaseId || lease.device_id !== deviceId) return unchanged();
      lease.expires_at = expiresAt;
      lease.updated_at = updatedAt;
      return changed();
    }
    if (normalized.startsWith('DELETE FROM leases')) {
      const [projectId, leaseId, deviceId] = args;
      const lease = this.leases.get(String(projectId));
      if (lease?.lease_id === leaseId && lease?.device_id === deviceId) this.leases.delete(String(projectId));
      return changed();
    }
    if (normalized.startsWith('INSERT INTO content_chunks')) {
      const [projectId, chunkId, bodyJson, sizeBytes, updatedAt] = args;
      this.chunks.set(`${projectId}:${chunkId}`, {
        project_id: projectId, chunk_id: chunkId, body_json: bodyJson,
        size_bytes: sizeBytes, updated_at: updatedAt,
      });
      return changed();
    }
    if (normalized.startsWith('DELETE FROM checkpoint_parts')) {
      this.checkpointParts.delete(`${args[0]}:${args[1]}`);
      return changed();
    }
    if (normalized.startsWith('DELETE FROM checkpoint_manifests')) {
      this.checkpointManifests.delete(`${args[0]}:${args[1]}`);
      return changed();
    }
    if (normalized.startsWith('INSERT INTO checkpoint_manifests')) {
      const [projectId, revision, partCount, sizeBytes, createdAt] = args;
      this.checkpointManifests.set(`${projectId}:${revision}`, {
        project_id: projectId, revision, part_count: partCount, size_bytes: sizeBytes, created_at: createdAt,
      });
      return changed();
    }
    if (normalized.startsWith('INSERT INTO checkpoint_parts')) {
      const [projectId, revision, partIndex, bodyText, sizeBytes] = args;
      const key = `${projectId}:${revision}`;
      const parts = this.checkpointParts.get(key) ?? [];
      parts[Number(partIndex)] = {
        project_id: projectId, revision, part_index: partIndex, body_text: bodyText, size_bytes: sizeBytes,
      };
      this.checkpointParts.set(key, parts);
      return changed();
    }
    if (normalized.startsWith('UPDATE projects SET updated_at')) {
      const [updatedAt, headRevision, checkpointRevision, checkpointKey, projectId, expectedHead] = args;
      const project = this.projects.get(String(projectId));
      if (!project || project.head_revision !== expectedHead) return unchanged();
      project.updated_at = updatedAt;
      project.head_revision = headRevision;
      project.checkpoint_revision = checkpointRevision;
      project.checkpoint_key = checkpointKey;
      return changed();
    }
    throw new Error(`MemoryD1 cannot run SQL: ${normalized}`);
  }

  all(sql: string, args: unknown[]) {
    const normalized = normalizeSql(sql);
    if (normalized.includes('FROM projects WHERE deleted_at IS NULL')) {
      return {
        results: [...this.projects.values()]
          .filter((project) => project.deleted_at == null)
          .sort((left, right) => Number(right.updated_at) - Number(left.updated_at)),
      };
    }
    if (normalized.includes('FROM operations WHERE project_id = ? AND revision > ?')) return { results: [] };
    if (normalized.includes('FROM content_chunks')) {
      const [projectId, ...ids] = args.map(String);
      return {
        results: ids.flatMap((id) => {
          const row = this.chunks.get(`${projectId}:${id}`);
          return row ? [{ chunk_id: row.chunk_id, body_json: row.body_json }] : [];
        }),
      };
    }
    if (normalized.includes('FROM checkpoint_parts')) {
      return { results: [...(this.checkpointParts.get(`${args[0]}:${args[1]}`) ?? [])] };
    }
    throw new Error(`MemoryD1 cannot query SQL: ${normalized}`);
  }

  first(sql: string, args: unknown[]) {
    const normalized = normalizeSql(sql);
    if (normalized.includes('FROM projects WHERE id = ? AND deleted_at IS NULL')) {
      const project = this.projects.get(String(args[0]));
      return project?.deleted_at == null ? project : null;
    }
    if (normalized.includes('FROM leases WHERE project_id = ?')) return this.leases.get(String(args[0])) ?? null;
    if (normalized.includes('FROM checkpoint_manifests')) {
      return this.checkpointManifests.get(`${args[0]}:${args[1]}`) ?? null;
    }
    throw new Error(`MemoryD1 cannot read SQL: ${normalized}`);
  }
}

class MemoryD1Statement {
  private args: unknown[] = [];
  private readonly db: MemoryD1;
  private readonly sql: string;

  constructor(db: MemoryD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: unknown[]) { this.args = args; return this; }
  async run() { return this.db.run(this.sql, this.args); }
  async all() { return this.db.all(this.sql, this.args); }
  async first() { return this.db.first(this.sql, this.args); }
}

function normalizeSql(sql: string) { return sql.replace(/\s+/gu, ' ').trim(); }
function changed() { return { success: true, meta: { changes: 1 } }; }
function unchanged() { return { success: true, meta: { changes: 0 } }; }
