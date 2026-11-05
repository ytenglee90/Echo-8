import { planBook, inspectBook, restoreBook, decodeBlock, verifyBookRepack } from './book-format.js';
import { readHead, stageUpload, uploadBlocks, uploadPlannedBlocks, commitUpload, readBlocks, prefetchBookBlocks } from './book-service.js';

const LEGACY_TABLES = ['checkpoint_parts', 'checkpoint_manifests', 'operations', 'content_chunks'];
const BOOK_TABLES = ['book_upload_refs', 'book_uploads', 'book_read_refs', 'book_reads', 'book_refs', 'book_blocks', 'book_heads', ...LEGACY_TABLES, 'leases'];
const ROW_BATCH = 200;

/** Migration uses the ordinary verified save protocol and an expiring editing lease. */
async function migrateBook(env, project, helpers) {
  const now = Date.now();
  const leaseId = `migration-${crypto.randomUUID()}`;
  const deviceId = 'echo8-maintenance';
  const claimed = await env.DB.prepare(`INSERT INTO leases(project_id, lease_id, device_id, expires_at, updated_at)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM book_heads WHERE project_id=?)
    ON CONFLICT(project_id) DO UPDATE SET lease_id=excluded.lease_id, device_id=excluded.device_id, expires_at=excluded.expires_at,
    updated_at=excluded.updated_at WHERE leases.expires_at<=?`)
    .bind(project.id, leaseId, deviceId, now + 90_000, now, project.id, project.id, now).run();
  if (!claimed.meta?.changes) return false;
  try {
    const bootstrap = await helpers.legacyBootstrap(project.id, env);
    if (!bootstrap.checkpoint && !bootstrap.operations.length) return false;
    const chunks = new Map(bootstrap.chunks.map(chunk => [chunk.id, chunk.value]));
    const document = structuredClone(bootstrap.checkpoint?.document ?? { revision: 0, namespaces: {} });
    document.namespaces=Object.assign(Object.create(null),document.namespaces);
    for(const namespace of Object.keys(document.namespaces))document.namespaces[namespace]=Object.assign(Object.create(null),document.namespaces[namespace]);
    document.namespaces.textContentChunk = Object.fromEntries([...chunks].filter(([id]) => bootstrap.checkpoint?.contentChunkIds.includes(id)));
    let expected = bootstrap.checkpointRevision;
    for (const operation of bootstrap.operations) {
      if (operation.revision !== ++expected) throw new Error('迁移源操作序列不完整');
      for (const patch of operation.commit.forward) {
        if (patch.domain !== 'document') continue;
        document.namespaces[patch.namespace] ??= {};
        if (patch.op === 'delete') delete document.namespaces[patch.namespace][patch.key];
        else {
          const id = patch.value?.__echo8ContentChunkRef;
          if (id && !chunks.has(id)) throw new Error('迁移源正文分块缺失');
          document.namespaces[patch.namespace][patch.key] = id ? chunks.get(id) : patch.value;
        }
      }
      document.revision++;
    }
    if (expected !== bootstrap.project.headRevision) throw new Error('迁移源尚未完整读取');
    const source = { document, plugins: bootstrap.checkpoint?.plugins ?? [] };
    const plan = await planBook(source);
    // Verify an actual round trip before allowing any legacy data collection.
    const verified = await inspectBook(plan.rootHash, async hash => plan.blocks.get(hash), new Set(plan.hashes));
    const restored = await restoreBook(verified, async hash => plan.blocks.get(hash));
    for (const [namespace, records] of Object.entries(source.document.namespaces)) for (const [key, value] of Object.entries(records)) {
      if (JSON.stringify(restored.document.namespaces[namespace]?.[key]) !== JSON.stringify(value)) throw new Error('迁移还原校验失败');
    }
    const saveId = `migration-save-${crypto.randomUUID()}`;
    const staged = await stageUpload(env, project, { saveId, rootHash: plan.rootHash, hashes: plan.hashes, baseRevision: Number(project.head_revision), deviceId, leaseId });
    for (let offset = 0; offset < staged.missing.length; offset += 16) await uploadBlocks(env, project.id, {
      saveId, deviceId, leaseId, blocks: staged.missing.slice(offset, offset + 16).map(hash => plan.blocks.get(hash)),
    });
    await commitUpload(env, project, { saveId, deviceId, leaseId });
    return true;
  } finally {
    await env.DB.prepare('DELETE FROM leases WHERE project_id=? AND lease_id=?').bind(project.id, leaseId).run();
  }
}

/** Format-2 data is rewritten without reading or copying unchanged large records. */
async function compactCurrentBook(env, project, head, budget) {
  const rootBlock = (await readBlocks(env, project.id, [head.root_hash]))[0];
  const root = JSON.parse(new TextDecoder().decode(await decodeBlock(rootBlock)));
  if (root.formatVersion !== 2 || budget.remaining <= 0) return false;
  const now = Date.now(), leaseId = `compaction-${crypto.randomUUID()}`, deviceId = 'echo8-maintenance';
  const claimed = await env.DB.prepare(`INSERT INTO leases(project_id,lease_id,device_id,expires_at,updated_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM book_heads WHERE project_id=? AND root_hash=?)
    ON CONFLICT(project_id) DO UPDATE SET lease_id=excluded.lease_id,device_id=excluded.device_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at
      WHERE leases.expires_at<=?`).bind(project.id,leaseId,deviceId,now+90_000,now,project.id,project.id,head.root_hash,now).run();
  if (!claimed.meta?.changes) return false;
  budget.remaining--;
  const saveId = `compact-save-${crypto.randomUUID()}`;
  const cache = new Map([[head.root_hash, rootBlock]]);
  const get = async hash => cache.get(hash) ?? (await readBlocks(env,project.id,[hash]))[0];
  get.prefetch = hashes => prefetchBookBlocks(env,project.id,hashes,cache);
  try {
    if (!Array.isArray(root.pages) || root.pages.length > 2000) throw new Error('旧目录无效');
    await get.prefetch(root.pages);
    const old = await inspectBook(head.root_hash,get);
    const next = await planBook({document:{revision:old.root.documentRevision,namespaces:{}},plugins:old.root.plugins},old,[],get);
    if (next.blocks.size > 256) return false; // Large rewrites use the resumable client upload path.
    await verifyBookRepack(old,next,get,hash=>next.blocks.get(hash)??get(hash));
    const staged = await stageUpload(env,project,{saveId,rootHash:next.rootHash,hashes:next.hashes,baseRevision:Number(head.revision),deviceId,leaseId});
    if (staged.missing.some(hash => !next.blocks.has(hash))) throw new Error('原书籍缺少分块，停止合并');
    await uploadPlannedBlocks(env,project.id,{saveId,deviceId,leaseId,blocks:staged.missing.map(hash=>next.blocks.get(hash))});
    await commitUpload(env,project,{saveId,deviceId,leaseId});
    return true;
  } finally {
    cache.clear();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM book_upload_refs WHERE project_id=? AND save_id=?').bind(project.id,saveId),
      env.DB.prepare('DELETE FROM book_uploads WHERE project_id=? AND save_id=?').bind(project.id,saveId),
      env.DB.prepare('DELETE FROM leases WHERE project_id=? AND lease_id=?').bind(project.id,leaseId),
    ]);
  }
}

export async function maintainProject(env, project, helpers, budget = {remaining:1}) {
  let removed = 0;
  if (project.deleted_at != null) {
    // Recheck the tombstone in each bounded statement, including interrupted retries.
    const statements = BOOK_TABLES.map(table => env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE project_id=? LIMIT ${ROW_BATCH}) AND EXISTS (SELECT 1 FROM projects WHERE id=? AND deleted_at IS NOT NULL)`)
      .bind(project.id, project.id));
    for (const result of await env.DB.batch(statements)) removed += Number(result.meta?.changes ?? 0);
    const remaining = await env.DB.prepare(`SELECT ${BOOK_TABLES.map(table => `(SELECT COUNT(*) FROM ${table} WHERE project_id=?)`).join('+')} AS count`)
      .bind(...BOOK_TABLES.map(() => project.id)).first();
    if (!Number(remaining.count)) await env.DB.prepare('DELETE FROM projects WHERE id=? AND deleted_at IS NOT NULL').bind(project.id).run();
    return removed;
  }
  const head = await readHead(env, project.id);
  if (!head) {
    await migrateBook(env, project, helpers);
  } else await compactCurrentBook(env,project,head,budget);
  // A head can only exist after the root, every referenced block and record
  // lengths have passed the normal atomic save validation.
  const statements = LEGACY_TABLES.map(table => env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN
    (SELECT rowid FROM ${table} WHERE project_id=? LIMIT ${ROW_BATCH}) AND EXISTS (SELECT 1 FROM book_heads WHERE project_id=?)`)
    .bind(project.id, project.id));
  statements.push(env.DB.prepare(`DELETE FROM book_upload_refs WHERE project_id=? AND save_id IN
    (SELECT save_id FROM book_uploads WHERE project_id=? AND expires_at<=?)`).bind(project.id, project.id, Date.now()));
  statements.push(env.DB.prepare('DELETE FROM book_uploads WHERE project_id=? AND expires_at<=?').bind(project.id, Date.now()));
  statements.push(env.DB.prepare('DELETE FROM book_reads WHERE project_id=? AND expires_at<=?').bind(project.id, Date.now()));
  statements.push(env.DB.prepare(`DELETE FROM book_blocks WHERE project_id=? AND hash IN
    (SELECT b.hash FROM book_blocks b WHERE b.project_id=? AND b.updated_at<?
      AND NOT EXISTS (SELECT 1 FROM book_refs r WHERE r.project_id=b.project_id AND r.hash=b.hash)
      AND NOT EXISTS (SELECT 1 FROM book_read_refs r JOIN book_reads active ON active.project_id=r.project_id AND active.reader_id=r.reader_id
        WHERE r.project_id=b.project_id AND r.hash=b.hash AND active.expires_at>?)
      AND NOT EXISTS (SELECT 1 FROM book_upload_refs r JOIN book_uploads u ON u.project_id=r.project_id AND u.save_id=r.save_id
        WHERE r.project_id=b.project_id AND r.hash=b.hash AND r.action='add' AND u.expires_at>?) LIMIT ${ROW_BATCH})`)
    .bind(project.id, project.id, Date.now() - 60_000, Date.now(),Date.now()));
  for (const result of await env.DB.batch(statements)) removed += Number(result.meta?.changes ?? 0);
  return removed;
}

/** Small, resumable jobs; no book bodies, keys or unbounded event logs in diagnostics. */
export async function runMaintenance(env, helpers, force = false) {
  if (env.STORAGE_MODE === 'r2') return { skipped: 'legacy-r2' };
  const owner = crypto.randomUUID();
  const now = Date.now();
  const status = await env.DB.prepare("SELECT * FROM maintenance_status WHERE id='latest'").first();
  if (!force && now - Number(status?.last_run_at ?? 0) < 60_000) return { skipped: 'recent' };
  const lock = await env.DB.prepare(`INSERT INTO maintenance_lock(id,owner,expires_at) VALUES ('global',?,?)
    ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at WHERE maintenance_lock.expires_at<=?`)
    .bind(owner, now + 120_000, now).run();
  if (!lock.meta?.changes) return { skipped: 'busy' };
  let removed = 0;
  let errors = 0;
  const compactionBudget = { remaining: 1 };
  try {
    const projects = await env.DB.prepare(`SELECT p.* FROM projects p LEFT JOIN book_maintenance m ON m.project_id=p.id
      ORDER BY m.checked_at IS NOT NULL, m.checked_at ASC, p.deleted_at IS NULL, p.id LIMIT 2`).all();
    for (const project of projects.results) {
      let error;
      try { removed += await maintainProject(env, project, helpers, compactionBudget); }
      catch { errors++; error = '自动维护未完成，数据已保留，稍后重试'; }
      await env.DB.prepare(`INSERT INTO book_maintenance(project_id,checked_at,removed_rows,error)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM projects WHERE id=?)
        ON CONFLICT(project_id) DO UPDATE SET checked_at=excluded.checked_at, removed_rows=excluded.removed_rows, error=excluded.error`)
        .bind(project.id, now, removed, error ?? null, project.id).run();
    }
    await env.DB.prepare(`INSERT INTO maintenance_status(id,last_run_at,removed_rows,error_count) VALUES ('latest',?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at, removed_rows=excluded.removed_rows,error_count=excluded.error_count`)
      .bind(now, removed, errors).run();
    return { checkedAt: now, removedRows: removed, errors };
  } finally {
    await env.DB.prepare('DELETE FROM maintenance_lock WHERE id=? AND owner=?').bind('global', owner).run();
  }
}

export async function maintenanceStatus(env) {
  const row = await env.DB.prepare("SELECT * FROM maintenance_status WHERE id='latest'").first();
  return row ? { checkedAt: Number(row.last_run_at), removedRows: Number(row.removed_rows), errors: Number(row.error_count) } : undefined;
}

export { readBlocks };
