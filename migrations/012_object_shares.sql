-- Externally shareable source objects.
--
-- Distinct from dependency_share_grants: those share a claim recorded inside a
-- manuscript, while these share an indexed source object directly, which is what
-- the system-wide overlay inserts into other applications.
--
-- The grant pins object_version_id, so a share always resolves to the source
-- exactly as it was when shared, even if the file changes afterwards.

CREATE TABLE IF NOT EXISTS object_share_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES scientific_objects(id) ON DELETE CASCADE,
  object_version_id TEXT NOT NULL REFERENCES scientific_object_versions(id),
  token TEXT NOT NULL UNIQUE,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS object_share_grant_object_idx
ON object_share_grants(object_id, revoked_at, created_at DESC);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (12, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
