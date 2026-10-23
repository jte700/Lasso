-- Third-party apps (mail, calendars, notes) connected to Lasso. Each one
-- mirrors its items into a folder Lasso manages, indexed as a project, so it
-- is searched and switched on or off like a work directory. Credentials are
-- kept apart from this database, in a file only this user can read.
CREATE TABLE IF NOT EXISTS app_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'connecting'
    CHECK (status IN ('connecting', 'syncing', 'ready', 'error')),
  item_count INTEGER NOT NULL DEFAULT 0,
  -- Which file holds each mirrored item, so a sync rewrites only what changed.
  sync_state_json TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_connections_project_idx ON app_connections(project_id);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (24, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
