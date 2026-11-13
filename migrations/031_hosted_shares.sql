-- The public URL never contains the capability needed to delete it.
CREATE TABLE IF NOT EXISTS object_share_publications (
  share_id TEXT PRIMARY KEY REFERENCES object_share_grants(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  revoke_secret TEXT NOT NULL,
  published_at TEXT
);
INSERT INTO schema_migrations(version, applied_at)
VALUES (31, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
