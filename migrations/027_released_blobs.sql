-- Old versions whose stored bytes were released on purpose to save room (see
-- src/history/retention.js). The version's snapshot, object versions and
-- events stay; only its bytes are gone. A row here tells a blob that was
-- released apart from one that is missing through damage. A hash whose bytes
-- are stored again (the file went back to that content) keeps its row, which
-- is only consulted when the bytes are absent.
CREATE TABLE IF NOT EXISTS released_blobs (
  content_hash TEXT PRIMARY KEY,
  released_at TEXT NOT NULL,
  -- The room the bytes took on disk when they were released.
  stored_bytes INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Retention reads one file's versions at a time, to know which are its newest
-- and when each stopped being its content.
CREATE INDEX IF NOT EXISTS file_changes_file_idx ON file_changes(project_file_id);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (27, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
