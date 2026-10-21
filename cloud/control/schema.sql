CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  user_id TEXT PRIMARY KEY,
  token_encrypted TEXT NOT NULL,
  accounts_json TEXT NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  worker_url TEXT,
  d1_database_id TEXT,
  r2_bucket_name TEXT,
  worker_version INTEGER NOT NULL DEFAULT 1,
  signing_secret_encrypted TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, account_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS installations_user ON installations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, unixepoch() * 1000);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (2, unixepoch() * 1000);
