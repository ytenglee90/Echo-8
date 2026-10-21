const API_VERSION = 1;
const LEASE_MS = 90_000;
const MAX_COMMITS = 256;
const MAX_CHUNKS = 512;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const D1_CHECKPOINT_PART_BYTES = 512 * 1024;
const D1_CHUNK_QUERY_SIZE = 75;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return corsResponse(request, env, new Response(null, { status: 204 }));
    try {
      const url = new URL(request.url);
      if (url.pathname === '/v1/health') {
        return corsResponse(request, env, json({
          ok: true,
          apiVersion: API_VERSION,
          workerVersion: positiveInteger(env.DATA_WORKER_VERSION, 1),
        }));
      }
      const identity = await authorize(request, env);
      let response;
      if (url.pathname === '/v1/projects' && request.method === 'GET') {
        response = await listProjects(env);
      } else if (url.pathname === '/v1/projects' && request.method === 'POST') {
        response = await createProject(request, env);
      } else {
        response = await routeProject(request, env, url, identity);
      }
      return corsResponse(request, env, response);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const message = status >= 500 ? '数据服务暂时不可用' : String(error?.message || error);
      if (status >= 500) console.error('echo8-data-worker', error);
      return corsResponse(request, env, json({ error: message }, status));
    }
  },
};

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function routeProject(request, env, url, identity) {
  const match = /^\/v1\/projects\/([a-zA-Z0-9:_-]{6,160})(?:\/(bootstrap|changes|lease|chunks|sync))?$/.exec(url.pathname);
  if (!match) throw httpError(404, '接口不存在');
  const projectId = match[1];
  const action = match[2];
  if (!action && request.method === 'PATCH') return renameProject(projectId, request, env);
  if (!action && request.method === 'DELETE') return deleteProject(projectId, env);
  if (action === 'bootstrap' && request.method === 'GET') return bootstrapProject(projectId, env);
  if (action === 'changes' && request.method === 'GET') {
    return listChanges(projectId, Number(url.searchParams.get('after') || 0), env);
  }
  if (action === 'lease' && request.method === 'POST') return acquireLease(projectId, request, env, identity);
  if (action === 'lease' && request.method === 'DELETE') return releaseLease(projectId, request, env, identity);
  if (action === 'chunks' && request.method === 'POST') return uploadChunks(projectId, request, env);
  if (action === 'sync' && request.method === 'POST') return syncProject(projectId, request, env, identity);
  throw httpError(405, '不支持的操作');
}

async function listProjects(env) {
  const result = await env.DB.prepare(
    'SELECT id, name, created_at, updated_at, head_revision FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200',
  ).all();
  return json({ projects: (result.results || []).map(projectSummary) });
}

async function createProject(request, env) {
  const body = await readJson(request);
  const id = validId(body.id) ? body.id : `project-${crypto.randomUUID()}`;
  const name = cleanName(body.name);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO projects(id, name, created_at, updated_at, head_revision, checkpoint_revision) VALUES (?, ?, ?, ?, 0, 0)',
  ).bind(id, name, now, now).run();
  return json({ project: { id, name, createdAt: now, updatedAt: now, headRevision: 0 } }, 201);
}

async function renameProject(projectId, request, env) {
  const current = await requireProject(projectId, env);
  const body = await readJson(request);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) throw httpError(400, '书籍名称不能为空');
  if (name === current.name) return json({ project: projectSummary(current) });
  const now = Date.now();
  await env.DB.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, now, projectId).run();
  return json({
    project: projectSummary({ ...current, name, updated_at: now }),
  });
}

async function deleteProject(projectId, env) {
  const now = Date.now();
  await requireProject(projectId, env);
  await env.DB.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .bind(now, now, projectId).run();
  return json({ deleted: true });
}

async function bootstrapProject(projectId, env) {
  const project = await requireProject(projectId, env);
  const checkpoint = await readCheckpoint(projectId, project, env);
  const chunkIds = new Set();
  if (checkpoint) {
    for (const id of Array.isArray(checkpoint.contentChunkIds) ? checkpoint.contentChunkIds : []) {
      if (validChunkId(id)) chunkIds.add(id);
    }
  }
  const operations = await readOperations(projectId, Number(project.checkpoint_revision || 0), env);
  for (const id of operationChunkIds(operations)) chunkIds.add(id);
  const chunks = await readChunkValues(projectId, [...chunkIds], env);
  const leaseRow = await env.DB.prepare(
    'SELECT lease_id, device_id, expires_at FROM leases WHERE project_id = ?',
  ).bind(projectId).first();
  return json({
    project: projectSummary(project),
    checkpointRevision: Number(project.checkpoint_revision || 0),
    checkpoint,
    chunks,
    operations,
    lease: leaseRow && Number(leaseRow.expires_at) > Date.now()
      ? { id: leaseRow.lease_id, deviceId: leaseRow.device_id, expiresAt: Number(leaseRow.expires_at), owned: false }
      : undefined,
  });
}

async function listChanges(projectId, after, env) {
  const project = await requireProject(projectId, env);
  const revision = Number.isSafeInteger(after) && after >= 0 ? after : 0;
  const operations = await readOperations(projectId, revision, env);
  return json({
    headRevision: Number(project.head_revision),
    operations,
    chunks: await readChunkValues(projectId, [...operationChunkIds(operations)], env),
  });
}

async function readOperations(projectId, after, env) {
  const result = await env.DB.prepare(
    'SELECT revision, body_json FROM operations WHERE project_id = ? AND revision > ? ORDER BY revision ASC LIMIT 2000',
  ).bind(projectId, after).all();
  return (result.results || []).map((row) => ({ revision: Number(row.revision), commit: JSON.parse(row.body_json) }));
}

async function acquireLease(projectId, request, env, identity) {
  await requireProject(projectId, env);
  const body = await readJson(request);
  const deviceId = requireDeviceId(body.deviceId);
  const now = Date.now();
  const existing = await env.DB.prepare(
    'SELECT lease_id, device_id, expires_at FROM leases WHERE project_id = ?',
  ).bind(projectId).first();
  if (existing && Number(existing.expires_at) > now && existing.device_id !== deviceId && body.takeover !== true) {
    return json({
      error: '此书籍正在另一台设备上编辑',
      lease: { id: existing.lease_id, deviceId: existing.device_id, expiresAt: Number(existing.expires_at), owned: false },
    }, 409);
  }
  const leaseId = existing?.device_id === deviceId && Number(existing.expires_at) > now
    ? existing.lease_id
    : `lease-${crypto.randomUUID()}`;
  const expiresAt = now + LEASE_MS;
  await env.DB.prepare(
    `INSERT INTO leases(project_id, lease_id, device_id, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET lease_id=excluded.lease_id, device_id=excluded.device_id,
       expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
  ).bind(projectId, leaseId, deviceId, expiresAt, now).run();
  return json({ lease: { id: leaseId, deviceId, expiresAt, owned: true }, subject: identity.sub });
}

async function releaseLease(projectId, request, env) {
  const body = await readJson(request);
  const deviceId = requireDeviceId(body.deviceId);
  const leaseId = String(body.leaseId || '');
  await env.DB.prepare('DELETE FROM leases WHERE project_id = ? AND lease_id = ? AND device_id = ?')
    .bind(projectId, leaseId, deviceId).run();
  return json({ released: true });
}

async function uploadChunks(projectId, request, env) {
  await requireProject(projectId, env);
  const body = await readJson(request);
  await requireActiveLease(projectId, body, env);
  const chunks = Array.isArray(body.chunks) ? body.chunks : [];
  await storeChunks(projectId, chunks, env);
  return json({ stored: chunks.length });
}

async function syncProject(projectId, request, env) {
  const body = await readJson(request);
  const deviceId = requireDeviceId(body.deviceId);
  const leaseId = String(body.leaseId || '');
  const baseRevision = Number(body.baseRevision);
  const commits = Array.isArray(body.commits) ? body.commits : [];
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw httpError(400, '同步基线无效');
  if (commits.length > MAX_COMMITS) throw httpError(413, '一次同步的操作过多');
  const now = Date.now();
  await requireActiveLease(projectId, body, env);
  const project = await requireProject(projectId, env);
  const ids = commits.map((commit) => String(commit?.id || ''));
  if (ids.some((id) => !validCommitId(id))) throw httpError(400, '提交编号无效');
  const existingIds = new Set();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const existing = await env.DB.prepare(
      `SELECT commit_id FROM operations WHERE project_id = ? AND commit_id IN (${placeholders})`,
    ).bind(projectId, ...ids).all();
    for (const row of existing.results || []) existingIds.add(row.commit_id);
  }
  const unseen = commits.filter((commit) => !existingIds.has(commit.id));
  const head = Number(project.head_revision);
  if (unseen.length && baseRevision !== head) {
    return json({ error: '云端版本已经前进', code: 'revision_conflict', headRevision: head }, 409);
  }

  await storeChunks(projectId, Array.isArray(body.chunks) ? body.chunks : [], env);

  const nextHead = head + unseen.length;
  let checkpointKeyValue = project.checkpoint_key;
  let checkpointRevision = Number(project.checkpoint_revision || 0);
  if (body.checkpoint) {
    validateCheckpoint(body.checkpoint);
    checkpointRevision = nextHead;
    checkpointKeyValue = await writeCheckpoint(projectId, checkpointRevision, body.checkpoint, env);
  }

  const statements = [];
  unseen.forEach((commit, index) => {
    const serialized = JSON.stringify(commit);
    if (byteLength(serialized) > 1024 * 1024) throw httpError(413, '单个提交过大');
    statements.push(env.DB.prepare(
      'INSERT INTO operations(project_id, revision, commit_id, device_id, committed_at, body_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(projectId, head + index + 1, commit.id, deviceId, now, serialized));
  });
  statements.push(env.DB.prepare(
    `UPDATE projects SET updated_at = ?, head_revision = ?, checkpoint_revision = ?, checkpoint_key = ?
     WHERE id = ? AND head_revision = ?`,
  ).bind(now, nextHead, checkpointRevision, checkpointKeyValue || null, projectId, head));
  statements.push(env.DB.prepare(
    'UPDATE leases SET expires_at = ?, updated_at = ? WHERE project_id = ? AND lease_id = ? AND device_id = ?',
  ).bind(now + LEASE_MS, now, projectId, leaseId, deviceId));
  const results = await env.DB.batch(statements);
  const update = results[unseen.length];
  if (unseen.length && Number(update?.meta?.changes || 0) !== 1) {
    return json({ error: '云端版本已经前进', code: 'revision_conflict' }, 409);
  }
  return json({
    accepted: unseen.length,
    headRevision: nextHead,
    checkpointRevision,
    lease: { id: leaseId, deviceId, expiresAt: now + LEASE_MS, owned: true },
  });
}

async function requireProject(projectId, env) {
  const project = await env.DB.prepare(
    `SELECT id, name, created_at, updated_at, head_revision, checkpoint_revision, checkpoint_key
     FROM projects WHERE id = ? AND deleted_at IS NULL`,
  ).bind(projectId).first();
  if (!project) throw httpError(404, '书籍不存在');
  return project;
}

async function requireActiveLease(projectId, body, env) {
  const deviceId = requireDeviceId(body.deviceId);
  const leaseId = String(body.leaseId || '');
  const lease = await env.DB.prepare(
    'SELECT lease_id, device_id, expires_at FROM leases WHERE project_id = ?',
  ).bind(projectId).first();
  if (!lease || lease.lease_id !== leaseId || lease.device_id !== deviceId || Number(lease.expires_at) <= Date.now()) {
    throw httpError(423, '编辑租约已经失效，请重新取得编辑权');
  }
  return lease;
}

async function storeChunks(projectId, chunks, env) {
  if (chunks.length > MAX_CHUNKS) throw httpError(413, '一次同步的正文分块过多');
  const prepared = chunks.map((chunk) => {
    if (!validChunkId(chunk?.id)) throw httpError(400, '正文分块编号无效');
    const value = JSON.stringify(chunk.value);
    const sizeBytes = byteLength(value);
    if (sizeBytes > 512 * 1024) throw httpError(413, '正文分块过大');
    return { id: chunk.id, value, sizeBytes };
  });
  if (objectStorageMode(env) === 'r2') {
    for (let offset = 0; offset < prepared.length; offset += 32) {
      await Promise.all(prepared.slice(offset, offset + 32).map((chunk) => env.BUCKET.put(
        chunkKey(projectId, chunk.id),
        chunk.value,
        {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { projectId, chunkId: chunk.id },
        },
      )));
    }
    return;
  }
  const now = Date.now();
  for (let offset = 0; offset < prepared.length; offset += 32) {
    await env.DB.batch(prepared.slice(offset, offset + 32).map((chunk) => env.DB.prepare(
      `INSERT INTO content_chunks(project_id, chunk_id, body_json, size_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, chunk_id) DO UPDATE SET body_json=excluded.body_json,
         size_bytes=excluded.size_bytes, updated_at=excluded.updated_at`,
    ).bind(projectId, chunk.id, chunk.value, chunk.sizeBytes, now)));
  }
}

function operationChunkIds(operations) {
  const ids = new Set();
  for (const operation of operations) {
    for (const patch of [...(operation.commit?.forward || []), ...(operation.commit?.inverse || [])]) {
      const id = patch?.value?.__echo8ContentChunkRef;
      if (validChunkId(id)) ids.add(id);
    }
  }
  return ids;
}

async function readChunkValues(projectId, ids, env) {
  if (ids.length > 20_000) throw httpError(413, '书籍正文分块数量超过当前协议上限');
  const values = new Map();
  if (objectStorageMode(env) === 'r2') {
    const missing = [];
    for (let offset = 0; offset < ids.length; offset += 32) {
      const batch = await Promise.all(ids.slice(offset, offset + 32).map(async (id) => {
        const chunk = await env.BUCKET.get(chunkKey(projectId, id));
        return chunk ? { id, value: await chunk.json() } : undefined;
      }));
      for (const chunk of batch) {
        if (chunk) values.set(chunk.id, chunk.value);
      }
      for (const id of ids.slice(offset, offset + 32)) {
        if (!values.has(id)) missing.push(id);
      }
    }
    const fallback = await readD1ChunkValues(projectId, missing, env);
    for (const [id, value] of fallback) values.set(id, value);
  } else {
    const stored = await readD1ChunkValues(projectId, ids, env);
    for (const [id, value] of stored) values.set(id, value);
  }
  return ids.map((id) => {
    if (!values.has(id)) throw httpError(500, `正文分块缺失：${id}`);
    return { id, value: values.get(id) };
  });
}

async function readD1ChunkValues(projectId, ids, env) {
  const output = new Map();
  for (let offset = 0; offset < ids.length; offset += D1_CHUNK_QUERY_SIZE) {
    const batch = ids.slice(offset, offset + D1_CHUNK_QUERY_SIZE);
    if (!batch.length) continue;
    const placeholders = batch.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `SELECT chunk_id, body_json FROM content_chunks
       WHERE project_id = ? AND chunk_id IN (${placeholders})`,
    ).bind(projectId, ...batch).all();
    for (const row of result.results || []) output.set(row.chunk_id, JSON.parse(row.body_json));
  }
  return output;
}

async function writeCheckpoint(projectId, revision, checkpoint, env) {
  const serialized = JSON.stringify(checkpoint);
  const sizeBytes = byteLength(serialized);
  if (sizeBytes > MAX_JSON_BYTES) throw httpError(413, '检查点结构过大');
  if (objectStorageMode(env) === 'r2') {
    const key = `projects/${projectId}/checkpoints/${revision}-${crypto.randomUUID()}.json`;
    await env.BUCKET.put(key, serialized, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { projectId, revision: String(revision) },
    });
    return key;
  }
  const parts = splitUtf8Text(serialized, D1_CHECKPOINT_PART_BYTES);
  const now = Date.now();
  const statements = [
    env.DB.prepare('DELETE FROM checkpoint_parts WHERE project_id = ? AND revision = ?').bind(projectId, revision),
    env.DB.prepare('DELETE FROM checkpoint_manifests WHERE project_id = ? AND revision = ?').bind(projectId, revision),
    env.DB.prepare(
      `INSERT INTO checkpoint_manifests(project_id, revision, part_count, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(projectId, revision, parts.length, sizeBytes, now),
    ...parts.map((part, index) => env.DB.prepare(
      `INSERT INTO checkpoint_parts(project_id, revision, part_index, body_text, size_bytes)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(projectId, revision, index, part, byteLength(part))),
  ];
  await env.DB.batch(statements);
  return `d1:${revision}`;
}

async function readCheckpoint(projectId, project, env) {
  const key = String(project.checkpoint_key || '');
  const revision = Number(project.checkpoint_revision || 0);
  if (key && !key.startsWith('d1:') && env.BUCKET) {
    const object = await env.BUCKET.get(key);
    if (object) return object.json();
  }
  if (!key && revision === 0) return undefined;
  const manifest = await env.DB.prepare(
    `SELECT part_count, size_bytes FROM checkpoint_manifests
     WHERE project_id = ? AND revision = ?`,
  ).bind(projectId, revision).first();
  if (!manifest) return undefined;
  const result = await env.DB.prepare(
    `SELECT part_index, body_text, size_bytes FROM checkpoint_parts
     WHERE project_id = ? AND revision = ? ORDER BY part_index ASC`,
  ).bind(projectId, revision).all();
  const rows = result.results || [];
  if (rows.length !== Number(manifest.part_count) || rows.some((row, index) => Number(row.part_index) !== index)) {
    throw httpError(500, '云端检查点分片不完整');
  }
  const serialized = rows.map((row) => String(row.body_text)).join('');
  if (byteLength(serialized) !== Number(manifest.size_bytes)) throw httpError(500, '云端检查点校验失败');
  return JSON.parse(serialized);
}

function splitUtf8Text(value, maxBytes) {
  const encoded = new TextEncoder().encode(value);
  if (!encoded.length) return [''];
  const decoder = new TextDecoder();
  const parts = [];
  let offset = 0;
  while (offset < encoded.length) {
    let end = Math.min(offset + maxBytes, encoded.length);
    while (end < encoded.length && (encoded[end] & 0xc0) === 0x80) end -= 1;
    if (end <= offset) throw httpError(500, '检查点分片失败');
    parts.push(decoder.decode(encoded.subarray(offset, end)));
    offset = end;
  }
  return parts;
}

function objectStorageMode(env) {
  if (env.STORAGE_MODE === 'r2') {
    if (!env.BUCKET) throw httpError(500, 'R2 存储绑定缺失');
    return 'r2';
  }
  return 'd1';
}

async function authorize(request, env) {
  const value = request.headers.get('authorization') || '';
  if (!value.startsWith('Bearer ')) throw httpError(401, '缺少访问令牌');
  const token = value.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) throw httpError(401, '访问令牌无效');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = JSON.parse(decodeBase64Url(encodedHeader));
  const payload = JSON.parse(decodeBase64Url(encodedPayload));
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw httpError(401, '访问令牌算法无效');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.DATA_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, base64UrlBytes(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  const now = Math.floor(Date.now() / 1000);
  if (!valid || payload.iss !== 'echo8-control' || payload.aud !== env.INSTALLATION_ID ||
    !Number.isFinite(payload.exp) || payload.exp <= now || !payload.sub || !Array.isArray(payload.scope) ||
    !payload.scope.includes(request.method === 'GET' ? 'projects:read' : 'projects:write')) {
    throw httpError(401, '访问令牌已经失效');
  }
  return payload;
}

function corsResponse(request, env, response) {
  const origin = request.headers.get('origin');
  const allowed = String(env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
  if (origin && origin.replace(/\/$/, '') === allowed) {
    response.headers.set('access-control-allow-origin', origin);
    response.headers.set('vary', 'Origin');
    response.headers.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    response.headers.set('access-control-allow-headers', 'authorization,content-type');
    response.headers.set('access-control-max-age', '86400');
  }
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('cache-control', 'no-store');
  return response;
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_JSON_BYTES) throw httpError(413, '请求过大');
  let value;
  try { value = await request.json(); } catch { throw httpError(400, 'JSON 请求无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '请求结构无效');
  return value;
}

function validateCheckpoint(value) {
  if (!value || value.formatVersion !== API_VERSION || !value.document ||
    !Number.isFinite(value.savedAt) || !Array.isArray(value.contentChunkIds) || !Array.isArray(value.plugins)) {
    throw httpError(400, '检查点结构无效');
  }
}

function projectSummary(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    headRevision: Number(row.head_revision),
  };
}

function cleanName(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, 120) : '';
  return text || '未命名书籍';
}

function requireDeviceId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{6,160}$/.test(value)) throw httpError(400, '设备编号无效');
  return value;
}

function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9:_-]{6,160}$/.test(value); }
function validCommitId(value) { return typeof value === 'string' && /^[a-zA-Z0-9:_-]{6,200}$/.test(value); }
function validChunkId(value) { return typeof value === 'string' && /^[a-zA-Z0-9:._-]{6,240}$/.test(value); }
function chunkKey(projectId, id) { return `projects/${projectId}/chunks/${encodeURIComponent(id)}.json`; }
function byteLength(value) { return new TextEncoder().encode(value).byteLength; }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function decodeBase64Url(value) { return new TextDecoder().decode(base64UrlBytes(value)); }
function base64UrlBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
