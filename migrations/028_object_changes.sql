-- What each index changed since the one before it, one row per object it added,
-- modified, moved or removed. Version rows are named by their TEXT id, never
-- by rowid: these tables' rowids are implicit, and VACUUM may renumber them.
-- A folder's first index and an upgrade pass record none.
CREATE TABLE IF NOT EXISTS object_changes (
  snapshot_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'modified', 'removed', 'moved')),
  -- NULL for an object added here.
  before_version_id TEXT,
  -- NULL for an object removed here.
  after_version_id TEXT,
  PRIMARY KEY (object_id, snapshot_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS object_changes_snapshot_idx ON object_changes(snapshot_id);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (28, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
