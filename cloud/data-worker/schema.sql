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
