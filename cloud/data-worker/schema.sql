CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  head_revision INTEGER NOT NULL DEFAULT 0,
  checkpoint_revision INTEGER NOT NULL DEFAULT 0,
  checkpoint_key TEXT,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS operations (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  commit_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  PRIMARY KEY (project_id, revision),
  UNIQUE (project_id, commit_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS operations_project_revision
  ON operations(project_id, revision);

CREATE TABLE IF NOT EXISTS leases (
  project_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS content_chunks (
  project_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  body_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, chunk_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS checkpoint_manifests (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, revision),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS checkpoint_parts (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  part_index INTEGER NOT NULL,
  body_text TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (project_id, revision, part_index),
  FOREIGN KEY (project_id, revision)
    REFERENCES checkpoint_manifests(project_id, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, unixepoch() * 1000);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (2, unixepoch() * 1000);

CREATE TABLE IF NOT EXISTS book_blocks (
  project_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  encoding TEXT NOT NULL,
  body_text TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, hash),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS book_heads (
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  root_hash TEXT NOT NULL,
  save_id TEXT NOT NULL,
  document_revision INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS book_refs (
  project_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (project_id, hash),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS book_refs_hash ON book_refs(project_id, hash);
CREATE TABLE IF NOT EXISTS book_reads (
  project_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, reader_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS book_read_refs (
  project_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (project_id, reader_id, hash),
  FOREIGN KEY (project_id, reader_id) REFERENCES book_reads(project_id, reader_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS book_read_refs_hash ON book_read_refs(project_id, hash);
CREATE TABLE IF NOT EXISTS book_uploads (
  project_id TEXT NOT NULL,
  save_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  root_hash TEXT NOT NULL,
  device_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, save_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS book_upload_refs (
  project_id TEXT NOT NULL,
  save_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'add',
  PRIMARY KEY (project_id, save_id, hash),
  FOREIGN KEY (project_id, save_id) REFERENCES book_uploads(project_id, save_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS book_upload_refs_hash ON book_upload_refs(project_id, hash);
CREATE TABLE IF NOT EXISTS book_maintenance (
  project_id TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  removed_rows INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS maintenance_lock (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS maintenance_status (
  id TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL,
  removed_rows INTEGER NOT NULL,
  error_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_shortcuts (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (3, unixepoch() * 1000);
CREATE TABLE IF NOT EXISTS account_preferences (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (4, unixepoch() * 1000);
