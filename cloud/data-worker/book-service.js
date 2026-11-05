import { decodeBlock, inspectBook, MAX_BOOK_BLOCKS, validHash } from './book-format.js';

const UPLOAD_TTL = 15 * 60_000;
const encoder = new TextEncoder();
const fail = (status, error, code) => Object.assign(new Error(error), { status, code });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{6,200}$/.test(value);

export async function readHead(env, projectId) {
  return env.DB.prepare('SELECT * FROM book_heads WHERE project_id = ?').bind(projectId).first();
}

export async function requireBookLease(env, projectId, body) {
  const row = await env.DB.prepare('SELECT lease_id, device_id, expires_at FROM leases WHERE project_id = ?').bind(projectId).first();
  if (!row || row.lease_id !== body.leaseId || row.device_id !== body.deviceId || Number(row.expires_at) <= Date.now()) throw fail(423, '编辑权已失效，本地修改仍保留', 'lease_expired');
}

function blockFromRow(row) {
  return row && { hash: row.hash, encoding: row.encoding, data: row.body_text, rawBytes: Number(row.raw_bytes) };
}

export async function readBlocks(env, projectId, hashes) {
  if (!Array.isArray(hashes) || hashes.length > 75 || hashes.some(hash => !validHash(hash))) throw fail(400, '分块请求无效');
  if (!hashes.length) return [];
  const result = await env.DB.prepare(`SELECT hash, encoding, body_text, raw_bytes FROM book_blocks WHERE project_id = ? AND hash IN (${hashes.map(() => '?').join(',')})`)
    .bind(projectId, ...hashes).all();
  return result.results.map(blockFromRow);
}

/** Bounded batch reads avoid one D1 subrequest per small content block. */
export async function prefetchBookBlocks(env, projectId, hashes, cache, knownSizes) {
  const missing = [...new Set(hashes)].filter(hash => !cache.has(hash));
  if (!missing.length) return;
  if (missing.length > MAX_BOOK_BLOCKS || missing.some(hash => !validHash(hash))) throw fail(400, '分块预取无效');
  const statements = columns => {
    const result = [];
    for (let offset = 0; offset < missing.length; offset += 75) {
      const batch = missing.slice(offset, offset + 75);
      result.push(env.DB.prepare(`SELECT ${columns} FROM book_blocks WHERE project_id=? AND hash IN (${batch.map(() => '?').join(',')})`).bind(projectId, ...batch));
    }
    return result;
  };
  const sizes = knownSizes ?? new Map();
  if (!knownSizes) for (const result of await env.DB.batch(statements('hash,raw_bytes'))) for (const row of result.results) sizes.set(row.hash, Number(row.raw_bytes));
  if (missing.some(hash => !sizes.has(hash)) || missing.reduce((sum, hash) => sum + sizes.get(hash), 0) > 8 * 1024 * 1024) throw fail(400, '分块预取超过内存限制或引用缺失');
  for (const result of await env.DB.batch(statements('hash,encoding,body_text,raw_bytes'))) for (const row of result.results) cache.set(row.hash, blockFromRow(row));
}

export async function stageUpload(env, project, body) {
  const projectId = project.id;
  await requireBookLease(env, projectId, body);
  const current = await readHead(env, projectId);
  if (current?.save_id === body.saveId) return { committed: true, revision: Number(current.revision), rootHash: current.root_hash, missing: [] };
  if (!validId(body.saveId) || !validHash(body.rootHash) || !Number.isSafeInteger(body.baseRevision) ||
    !Array.isArray(body.hashes) || !body.hashes.length || body.hashes.length > MAX_BOOK_BLOCKS ||
    body.hashes.some(hash => !validHash(hash)) || new Set(body.hashes).size !== body.hashes.length || !body.hashes.includes(body.rootHash)) throw fail(400, '上传清单无效');
  if (Number(project.head_revision) !== body.baseRevision) throw fail(409, '云端书籍已更新，本地修改仍保留', 'revision_conflict');
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM book_uploads WHERE project_id=? AND expires_at>? AND save_id<>?').bind(projectId, Date.now(), body.saveId).first();
  if (Number(count?.count) >= 4) throw fail(429, '已有上传正在处理，请稍后重试', 'upload_busy');
  const expires = Date.now() + UPLOAD_TTL;
  const statements = [env.DB.prepare(`INSERT INTO book_uploads(project_id, save_id, base_revision, root_hash, device_id, lease_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, save_id) DO UPDATE SET expires_at=excluded.expires_at
    WHERE book_uploads.base_revision=excluded.base_revision AND book_uploads.root_hash=excluded.root_hash AND book_uploads.device_id=excluded.device_id AND book_uploads.lease_id=excluded.lease_id`)
    .bind(projectId, body.saveId, body.baseRevision, body.rootHash, body.deviceId, body.leaseId, expires)];
  for (let offset = 0; offset < body.hashes.length; offset += 512) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO book_upload_refs(project_id, save_id, hash, action)
    SELECT ?, ?, value, 'add' FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM book_refs WHERE project_id=? AND hash=value)
      AND EXISTS (SELECT 1 FROM book_uploads WHERE project_id=? AND save_id=? AND root_hash=? AND device_id=?)`)
    .bind(projectId, body.saveId, JSON.stringify(body.hashes.slice(offset, offset + 512)), projectId, projectId, body.saveId, body.rootHash, body.deviceId));
  // Full manifest is a bounded read; only added/removed references become writes.
  // This avoids O(book size) row writes on each real-time save.
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO book_upload_refs(project_id,save_id,hash,action)
    SELECT project_id,?,hash,'remove' FROM book_refs WHERE project_id=? AND hash NOT IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM book_uploads WHERE project_id=? AND save_id=? AND root_hash=? AND device_id=?)`)
    .bind(body.saveId,projectId,JSON.stringify(body.hashes),projectId,body.saveId,body.rootHash,body.deviceId));
  statements.push(env.DB.prepare('UPDATE leases SET expires_at=?, updated_at=? WHERE project_id=? AND lease_id=? AND device_id=? AND expires_at>?')
    .bind(Date.now()+90_000,Date.now(),projectId,body.leaseId,body.deviceId,Date.now()));
  await env.DB.batch(statements);
  const staged = await env.DB.prepare('SELECT * FROM book_uploads WHERE project_id = ? AND save_id = ?').bind(projectId, body.saveId).first();
  if (!staged || staged.root_hash !== body.rootHash || staged.base_revision !== body.baseRevision || staged.device_id !== body.deviceId || staged.lease_id !== body.leaseId) throw fail(409, '上传编号冲突，请重新保存');
  const missing = await env.DB.prepare(`SELECT r.hash FROM book_upload_refs r LEFT JOIN book_blocks b ON b.project_id=r.project_id AND b.hash=r.hash
    WHERE r.project_id=? AND r.save_id=? AND r.action='add' AND b.hash IS NULL`).bind(projectId, body.saveId).all();
  const capacity = Number(env.D1_CAPACITY_BYTES || 500_000_000);
  const estimate = Number(body.estimatedBytes || 0);
  if (missing.results.length && Number.isFinite(estimate) && estimate >= 0 &&
    Number(missing.meta?.size_after ?? 0) + estimate + 64 * 1024 > capacity) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM book_upload_refs WHERE project_id=? AND save_id=?').bind(projectId, body.saveId),
      env.DB.prepare('DELETE FROM book_uploads WHERE project_id=? AND save_id=?').bind(projectId, body.saveId),
    ]);
    throw fail(507, '云端剩余空间不足以安全完成保存，本地修改已保留', 'storage_full');
  }
  return { missing: missing.results.map(row => row.hash), expiresAt: expires };
}

async function requireUpload(env, projectId, body) {
  await requireBookLease(env, projectId, body);
  const upload = await env.DB.prepare('SELECT * FROM book_uploads WHERE project_id = ? AND save_id = ?').bind(projectId, body.saveId).first();
  if (!upload || upload.device_id !== body.deviceId || upload.lease_id !== body.leaseId || Number(upload.expires_at) <= Date.now()) throw fail(409, '上传已过期，请重新保存；本地修改仍保留', 'upload_expired');
  return upload;
}

export async function uploadBlocks(env, projectId, body) {
  return storeUploadBlocks(env, projectId, body, 16);
}

/** Trusted maintenance still uses the same lease, upload-list and hash checks. */
export async function uploadPlannedBlocks(env, projectId, body) {
  return storeUploadBlocks(env, projectId, body, 256);
}

async function storeUploadBlocks(env, projectId, body, maximum) {
  const upload = await requireUpload(env, projectId, body);
  if (!Array.isArray(body.blocks) || body.blocks.length > maximum) throw fail(413, '单次上传分块过多');
  const references = await env.DB.prepare("SELECT hash FROM book_upload_refs WHERE project_id = ? AND save_id = ? AND action='add'").bind(projectId, body.saveId).all();
  const allowed = new Set(references.results.map(row => row.hash));
  const statements = [];
  for (const block of body.blocks) {
    if (!allowed.has(block.hash)) throw fail(400, '分块不在上传清单内');
    try { await decodeBlock(block); } catch { throw fail(400, '上传分块校验失败'); }
    statements.push(env.DB.prepare(`INSERT INTO book_blocks(project_id, hash, encoding, body_text, raw_bytes, size_bytes, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM book_uploads WHERE project_id=? AND save_id=? AND expires_at>?)
      ON CONFLICT(project_id, hash) DO UPDATE SET updated_at=excluded.updated_at`)
      .bind(projectId, block.hash, block.encoding, block.data, block.rawBytes, encoder.encode(block.data).length, Date.now(), projectId, upload.save_id, Date.now()));
  }
  statements.push(env.DB.prepare('UPDATE leases SET expires_at=?, updated_at=? WHERE project_id=? AND lease_id=? AND device_id=? AND expires_at>?')
    .bind(Date.now()+90_000,Date.now(),projectId,body.leaseId,body.deviceId,Date.now()));
  if (statements.length) await env.DB.batch(statements);
  return { stored: body.blocks.length };
}

export async function commitUpload(env, project, body) {
  const current = await readHead(env, project.id);
  if (current?.save_id === body.saveId) return { revision: Number(current.revision), rootHash: current.root_hash, documentRevision: Number(current.document_revision), savedAt: Number(current.saved_at) };
  const upload = await requireUpload(env, project.id, body);
  const references = await env.DB.prepare(`SELECT desired.hash,b.raw_bytes FROM (
    SELECT hash FROM book_refs r WHERE project_id=? AND NOT EXISTS (SELECT 1 FROM book_upload_refs u WHERE u.project_id=r.project_id AND u.save_id=? AND u.hash=r.hash AND u.action='remove')
    UNION SELECT hash FROM book_upload_refs WHERE project_id=? AND save_id=? AND action='add'
    ) desired LEFT JOIN book_blocks b ON b.project_id=? AND b.hash=desired.hash`)
    .bind(project.id,body.saveId,project.id,body.saveId,project.id).all();
  if (references.results.some(row => row.raw_bytes == null)) throw fail(409, '上传尚未完整，原书籍保持可用', 'missing_blocks');
  const sizes = new Map(references.results.map(row => [row.hash, Number(row.raw_bytes)]));
  const cache = new Map();
  const get = async hash => {
    if (!cache.has(hash)) cache.set(hash, (await readBlocks(env, project.id, [hash]))[0]);
    return cache.get(hash);
  };
  let plan;
  try {
    const root = JSON.parse(new TextDecoder().decode(await decodeBlock(await get(upload.root_hash))));
    if (current) {
      const previousRoot = JSON.parse(new TextDecoder().decode(await decodeBlock(await get(current.root_hash))));
      if (previousRoot.formatVersion > root.formatVersion) throw fail(426, '请刷新应用后保存，旧客户端不能覆盖新格式书籍', 'client_upgrade_required');
    }
    if (!Array.isArray(root.pages) || root.pages.some(hash => !validHash(hash)) ||
      root.pages.reduce((sum, hash) => sum + (sizes.get(hash) ?? 0), 0) > 8 * 1024 * 1024) throw new Error('清单过大');
    const prefetch = hashes => prefetchBookBlocks(env, project.id, hashes, cache, sizes);
    await prefetch(root.pages);
    plan = await inspectBook(upload.root_hash, get, new Set(sizes.keys()), prefetch);
    for (const entry of plan.entries.values()) {
      const size = entry.segments.reduce((sum, hash) => sum + (sizes.get(hash) ?? -1), 0);
      if (entry.offset === undefined ? size !== entry.bytes : entry.offset + entry.bytes > size) throw new Error('记录长度不一致');
    }
  } catch (error) { if (error?.status === 426) throw error; throw fail(400, '书籍清单或引用校验失败，原书籍保持可用'); }
  const now = Date.now();
  const revision = Number(upload.base_revision) + 1;
  // All writes share one D1 transaction. Every dependent statement is guarded
  // by this unique save ID, so a failed CAS cannot modify another generation.
  const guard = 'EXISTS (SELECT 1 FROM book_heads WHERE project_id=? AND save_id=?)';
  const statements = [env.DB.prepare(`INSERT INTO book_heads(project_id, revision, root_hash, save_id, document_revision, saved_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects p JOIN leases l ON l.project_id=p.id
      WHERE p.id=? AND p.deleted_at IS NULL AND p.head_revision=? AND l.lease_id=? AND l.device_id=? AND l.expires_at>?)
    ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision, root_hash=excluded.root_hash, save_id=excluded.save_id,
      document_revision=excluded.document_revision, saved_at=excluded.saved_at WHERE book_heads.revision=?`)
    .bind(project.id, revision, upload.root_hash, body.saveId, plan.root.documentRevision, now, project.id, upload.base_revision, body.leaseId, body.deviceId, now, upload.base_revision),
  env.DB.prepare(`DELETE FROM book_refs WHERE project_id=? AND hash IN (SELECT hash FROM book_upload_refs WHERE project_id=? AND save_id=? AND action='remove') AND ${guard}`)
    .bind(project.id,project.id,body.saveId,project.id,body.saveId),
  env.DB.prepare(`INSERT OR IGNORE INTO book_refs(project_id, hash) SELECT project_id, hash FROM book_upload_refs WHERE project_id=? AND save_id=? AND action='add' AND ${guard}`)
    .bind(project.id, body.saveId, project.id, body.saveId),
  env.DB.prepare(`UPDATE projects SET head_revision=?, updated_at=? WHERE id=? AND ${guard}`).bind(revision, now, project.id, project.id, body.saveId),
  env.DB.prepare(`UPDATE leases SET expires_at=?,updated_at=? WHERE project_id=? AND lease_id=? AND device_id=? AND ${guard}`)
    .bind(now+90_000,now,project.id,body.leaseId,body.deviceId,project.id,body.saveId),
  env.DB.prepare(`DELETE FROM book_upload_refs WHERE project_id=? AND save_id=? AND ${guard}`).bind(project.id, body.saveId, project.id, body.saveId),
  env.DB.prepare(`DELETE FROM book_uploads WHERE project_id=? AND save_id=? AND ${guard}`).bind(project.id, body.saveId, project.id, body.saveId)];
  const result = await env.DB.batch(statements);
  if (!result[0]?.meta?.changes) throw fail(409, '云端书籍或编辑权已变化，本地修改仍保留', 'revision_conflict');
  return { revision, rootHash: upload.root_hash, documentRevision: plan.root.documentRevision, savedAt: now,
    storageUsedBytes: Number(result.at(-1)?.meta?.size_after ?? 0) };
}

export async function routeBookRequest(request, env, url, identity, helpers) {
  if (url.pathname === '/v2/preferences') {
    const current = await env.DB.prepare('SELECT revision, body_json FROM account_preferences WHERE user_id=?').bind(identity.sub).first();
    if (request.method === 'GET') return json({ revision: Number(current?.revision ?? 0), preferences: current ? JSON.parse(current.body_json) : null });
    if (request.method !== 'PUT') throw fail(405, '不支持的操作');
    const body = await helpers.readJson(request), value = body.preferences;
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || !value || value.schemaVersion !== 1 ||
      ![0, 1000, 30000, 60000, 120000, 300000, 600000, 1800000].includes(value.autosaveIntervalMs) ||
      ![null, 8, 20, 50, 100].includes(value.recoveryRetentionLimit) ||
      Object.keys(value).some(key => !['schemaVersion', 'autosaveIntervalMs', 'recoveryRetentionLimit'].includes(key)) ||
      Object.keys(body).some(key => !['expectedRevision', 'preferences'].includes(key))) throw fail(400, '个人保存设置格式无效');
    const result = await env.DB.prepare(`INSERT INTO account_preferences(user_id, revision, body_json, updated_at) SELECT ?, 1, ?, ? WHERE ?=0
      ON CONFLICT(user_id) DO UPDATE SET revision=account_preferences.revision+1, body_json=excluded.body_json, updated_at=excluded.updated_at WHERE account_preferences.revision=?`)
      .bind(identity.sub, JSON.stringify(value), Date.now(), body.expectedRevision, body.expectedRevision).run();
    if (!result.meta?.changes) {
      const updated = await env.DB.prepare('UPDATE account_preferences SET revision=revision+1, body_json=?, updated_at=? WHERE user_id=? AND revision=?')
        .bind(JSON.stringify(value), Date.now(), identity.sub, body.expectedRevision).run();
      if (!updated.meta?.changes) throw fail(409, '另一台设备已修改保存设置，请重新同步', 'preferences_conflict');
    }
    return json({ revision: body.expectedRevision + 1 });
  }
  if (url.pathname === '/v2/shortcuts') {
    const current = await env.DB.prepare('SELECT revision, body_json, updated_at FROM account_shortcuts WHERE user_id=?').bind(identity.sub).first();
    if (request.method === 'GET') return json({ revision: Number(current?.revision ?? 0), overrides: current ? JSON.parse(current.body_json) : [], updatedAt: Number(current?.updated_at ?? 0) });
    if (request.method !== 'PUT') throw fail(405, '不支持的操作');
    const body = await helpers.readJson(request);
    if (!Number.isSafeInteger(body.expectedRevision) || !Array.isArray(body.overrides) || body.overrides.length > 1_000 || encoder.encode(JSON.stringify(body.overrides)).length > 128 * 1024 || body.overrides.some(value =>
      !value || typeof value.targetOwner !== 'string' || value.targetOwner.length > 160 || typeof value.targetId !== 'string' || value.targetId.length > 240 ||
      !(value.disabled === true || typeof value.chord === 'string' && value.chord.length <= 100) || Object.keys(value).some(key => !['targetOwner','targetId','chord','disabled'].includes(key)))) throw fail(400, '快捷键设置格式无效');
    const result = await env.DB.prepare(`INSERT INTO account_shortcuts(user_id, revision, body_json, updated_at) SELECT ?, 1, ?, ? WHERE ?=0
      ON CONFLICT(user_id) DO UPDATE SET revision=account_shortcuts.revision+1, body_json=excluded.body_json, updated_at=excluded.updated_at WHERE account_shortcuts.revision=?`)
      .bind(identity.sub, JSON.stringify(body.overrides), Date.now(), body.expectedRevision, body.expectedRevision).run();
    // Existing rows use UPDATE, because INSERT SELECT's WHERE must not suppress UPSERT.
    if (!result.meta?.changes) {
      const update = await env.DB.prepare('UPDATE account_shortcuts SET revision=revision+1, body_json=?, updated_at=? WHERE user_id=? AND revision=?')
        .bind(JSON.stringify(body.overrides), Date.now(), identity.sub, body.expectedRevision).run();
      if (!update.meta?.changes) throw fail(409, '另一台设备已修改快捷键，请重新同步', 'shortcut_conflict');
    }
    return json({ revision: body.expectedRevision + 1 });
  }
  const match = /^\/v2\/projects\/([a-zA-Z0-9:_-]{6,160})\/(head|blocks|uploads|commit|reads|baseline-blocks)$/.exec(url.pathname);
  if (!match) throw fail(404, '接口不存在');
  const project = await helpers.requireProject(match[1], env);
  const action = match[2];
  if (action === 'head' && request.method === 'GET') {
    const readableFormat=Number(url.searchParams.get('format')??2);
    if(!Number.isSafeInteger(readableFormat)||readableFormat<2)throw fail(400,'读取格式版本无效');
    const head = await readHead(env, project.id);
    if (!head) return json({ project: helpers.projectSummary(project), head: null });
    if (readableFormat < 3) {
      const rootBlock=(await readBlocks(env,project.id,[head.root_hash]))[0];
      const root=JSON.parse(new TextDecoder().decode(await decodeBlock(rootBlock)));
      if(root.formatVersion>2)throw fail(426,'这本书籍已优化为新格式，请刷新应用后重新打开，本机修改仍保留','client_upgrade_required');
    }
    const readerId = `reader-${crypto.randomUUID()}`;
    const expiresAt = Date.now() + UPLOAD_TTL;
    const pinned = await env.DB.batch([env.DB.prepare(`INSERT INTO book_reads(project_id,reader_id,generation,expires_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM book_heads WHERE project_id=? AND save_id=?)`)
      .bind(project.id, readerId, head.save_id, expiresAt, project.id, head.save_id),
      env.DB.prepare(`INSERT INTO book_read_refs(project_id,reader_id,hash) SELECT project_id,?,hash FROM book_refs WHERE project_id=?
        AND EXISTS (SELECT 1 FROM book_reads WHERE project_id=? AND reader_id=?)`)
        .bind(readerId,project.id,project.id,readerId)]);
    if (!pinned[0]?.meta?.changes) throw fail(409, '书籍正在更新，请重新载入', 'read_restart');
    return json({ project: { ...helpers.projectSummary(project), headRevision: Number(head.revision) }, head: { revision: Number(head.revision), rootHash: head.root_hash, documentRevision: Number(head.document_revision), savedAt: Number(head.saved_at), readerId, expiresAt } });
  }
  const body = await helpers.readJson(request);
  if (action === 'baseline-blocks' && request.method === 'POST') {
    await requireBookLease(env, project.id, body);
    if (!validHash(body.rootHash) || !Array.isArray(body.hashes) || !body.hashes.length || body.hashes.length > 75 ||
      body.hashes.some(hash => !validHash(hash)) || new Set(body.hashes).size !== body.hashes.length) throw fail(400, '保存基线请求无效');
    const rows = await env.DB.prepare(`SELECT b.hash,b.encoding,b.body_text,b.raw_bytes FROM book_blocks b
      JOIN book_refs r ON r.project_id=b.project_id AND r.hash=b.hash JOIN book_heads h ON h.project_id=b.project_id
      WHERE b.project_id=? AND h.root_hash=? AND b.hash IN (${body.hashes.map(() => '?').join(',')})`)
      .bind(project.id,body.rootHash,...body.hashes).all();
    if (rows.results.length !== body.hashes.length) throw fail(409, '保存基线已变化，本机修改仍保留', 'revision_conflict');
    return json({ blocks: rows.results.map(blockFromRow) });
  }
  if (action === 'reads' && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM book_reads WHERE project_id=? AND reader_id=?').bind(project.id, String(body.readerId)).run();
    return json({ released: true });
  }
  if (action === 'blocks' && request.method === 'POST' && !body.saveId) {
    const reader = await env.DB.prepare('SELECT expires_at FROM book_reads WHERE project_id=? AND reader_id=?').bind(project.id, String(body.readerId)).first();
    if (!reader || reader.expires_at <= Date.now()) throw fail(409, '读取已过期，请重新载入', 'read_restart');
    return json({ blocks: await readBlocks(env, project.id, body.hashes) });
  }
  if (action === 'uploads' && request.method === 'POST') return json(await stageUpload(env, project, body));
  if (action === 'blocks' && request.method === 'PUT') return json(await uploadBlocks(env, project.id, body));
  if (action === 'commit' && request.method === 'POST') {
    const result = await commitUpload(env, project, body);
    const measurement=result.storageUsedBytes===undefined?await env.DB.prepare('SELECT 1 AS echo8_storage_probe').all():{meta:{size_after:result.storageUsedBytes}};
    return json({ ...result, storage: helpers.storageUsage(env, measurement) });
  }
  throw fail(405, '不支持的操作');
}
