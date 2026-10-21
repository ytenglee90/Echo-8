import type { CloudAccountSummary, CloudInstallationSummary } from '../../cloud/contracts.ts';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oauth_grants (user_id TEXT PRIMARY KEY, token_encrypted TEXT NOT NULL, accounts_json TEXT NOT NULL, expires_at INTEGER, updated_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS installations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL, worker_name TEXT NOT NULL, worker_url TEXT, d1_database_id TEXT, r2_bucket_name TEXT, worker_version INTEGER NOT NULL DEFAULT 1, signing_secret_encrypted TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id, account_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS installations_user ON installations(user_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch() * 1000)`,
];

const initialized = new WeakSet<D1Database>();

export interface StoredOAuthGrant {
  userId: string;
  tokenEncrypted: string;
  accounts: CloudAccountSummary[];
  expiresAt?: number;
}

export interface StoredInstallation extends Omit<CloudInstallationSummary, 'latestWorkerVersion' | 'upgradeAvailable'> {
  userId: string;
  workerName: string;
  d1DatabaseId?: string;
  r2BucketName?: string;
  signingSecretEncrypted: string;
}

export async function ensureControlSchema(db: D1Database): Promise<void> {
  if (initialized.has(db)) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  const columns = await db.prepare('PRAGMA table_info(installations)').all<{ name: string }>();
  if (!(columns.results ?? []).some((column) => column.name === 'worker_version')) {
    await db.prepare('ALTER TABLE installations ADD COLUMN worker_version INTEGER NOT NULL DEFAULT 1').run();
  }
  await db.prepare(
    'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, unixepoch() * 1000)',
  ).run();
  initialized.add(db);
}

export async function upsertUser(
  db: D1Database,
  user: { id: string; email?: string; name?: string },
): Promise<void> {
  await ensureControlSchema(db);
  const now = Date.now();
  await db.prepare(
    `INSERT INTO users(id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, updated_at=excluded.updated_at`,
  ).bind(user.id, user.email ?? null, user.name ?? null, now, now).run();
}

export async function readUser(db: D1Database, userId: string): Promise<{ id: string; email?: string; name?: string } | undefined> {
  await ensureControlSchema(db);
  const row = await db.prepare('SELECT id, email, name FROM users WHERE id = ?').bind(userId).first<{
    id: string; email: string | null; name: string | null;
  }>();
  return row ? { id: row.id, email: row.email ?? undefined, name: row.name ?? undefined } : undefined;
}

export async function writeOAuthGrant(db: D1Database, grant: StoredOAuthGrant): Promise<void> {
  await ensureControlSchema(db);
  await db.prepare(
    `INSERT INTO oauth_grants(user_id, token_encrypted, accounts_json, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET token_encrypted=excluded.token_encrypted,
       accounts_json=excluded.accounts_json, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
  ).bind(grant.userId, grant.tokenEncrypted, JSON.stringify(grant.accounts), grant.expiresAt ?? null, Date.now()).run();
}

export async function readOAuthGrant(db: D1Database, userId: string): Promise<StoredOAuthGrant | undefined> {
  await ensureControlSchema(db);
  const row = await db.prepare(
    'SELECT user_id, token_encrypted, accounts_json, expires_at FROM oauth_grants WHERE user_id = ?',
  ).bind(userId).first<{ user_id: string; token_encrypted: string; accounts_json: string; expires_at: number | null }>();
  if (!row) return undefined;
  return {
    userId: row.user_id,
    tokenEncrypted: row.token_encrypted,
    accounts: JSON.parse(row.accounts_json) as CloudAccountSummary[],
    expiresAt: row.expires_at ?? undefined,
  };
}

export async function listInstallations(db: D1Database, userId: string): Promise<StoredInstallation[]> {
  await ensureControlSchema(db);
  const result = await db.prepare(
    `SELECT id, user_id, account_id, account_name, worker_name, worker_url, d1_database_id,
      r2_bucket_name, worker_version, signing_secret_encrypted, status, error
     FROM installations WHERE user_id = ? ORDER BY updated_at DESC`,
  ).bind(userId).all<Record<string, string | number | null>>();
  return (result.results ?? []).map(installationFromRow);
}

export async function readInstallation(db: D1Database, userId: string, id: string): Promise<StoredInstallation | undefined> {
  await ensureControlSchema(db);
  const row = await db.prepare(
    `SELECT id, user_id, account_id, account_name, worker_name, worker_url, d1_database_id,
      r2_bucket_name, worker_version, signing_secret_encrypted, status, error
     FROM installations WHERE user_id = ? AND id = ?`,
  ).bind(userId, id).first<Record<string, string | number | null>>();
  return row ? installationFromRow(row) : undefined;
}

export async function writeInstallation(db: D1Database, value: StoredInstallation): Promise<void> {
  await ensureControlSchema(db);
  const now = Date.now();
  await db.prepare(
    `INSERT INTO installations(id, user_id, account_id, account_name, worker_name, worker_url, d1_database_id,
      r2_bucket_name, worker_version, signing_secret_encrypted, status, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, account_id) DO UPDATE SET worker_name=excluded.worker_name,
       worker_url=excluded.worker_url, d1_database_id=excluded.d1_database_id,
       r2_bucket_name=excluded.r2_bucket_name, worker_version=excluded.worker_version,
       signing_secret_encrypted=excluded.signing_secret_encrypted,
       status=excluded.status, error=excluded.error, updated_at=excluded.updated_at`,
  ).bind(
    value.id, value.userId, value.accountId, value.accountName, value.workerName,
    value.workerUrl || null, value.d1DatabaseId ?? null, value.r2BucketName ?? null,
    value.workerVersion, value.signingSecretEncrypted, value.status, value.error ?? null, now, now,
  ).run();
}

function installationFromRow(row: Record<string, string | number | null>): StoredInstallation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    accountId: String(row.account_id),
    accountName: String(row.account_name),
    workerName: String(row.worker_name),
    workerUrl: String(row.worker_url ?? ''),
    d1DatabaseId: optionalText(row.d1_database_id),
    r2BucketName: optionalText(row.r2_bucket_name),
    workerVersion: positiveInteger(row.worker_version, 1),
    signingSecretEncrypted: String(row.signing_secret_encrypted),
    status: String(row.status) as StoredInstallation['status'],
    error: optionalText(row.error),
  };
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
