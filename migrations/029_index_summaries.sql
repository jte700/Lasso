-- What a later index needs to carry a snapshot's unchanged files forward
-- without reading them again: how many objects each file gave, the problems
-- reading it raised, and the folder's data dictionary. A summary built on an
-- earlier one stores only the files whose entry changed; a file it no longer
-- has is stored with a NULL count. Without these, a restart forgot them and
-- the first edit after it read the whole folder again.
CREATE TABLE IF NOT EXISTS snapshot_index_summaries (
  snapshot_id TEXT PRIMARY KEY,
  -- The summary this one was stored as differences from; NULL for a full one.
  base_snapshot_id TEXT,
  -- How many summaries resolve through before a full one.
  depth INTEGER NOT NULL DEFAULT 0,
  -- The data dictionary's definitions, in index order; NULL when it has none.
  definitions_json TEXT
);

CREATE TABLE IF NOT EXISTS snapshot_index_files (
  snapshot_id TEXT NOT NULL,
  path TEXT NOT NULL,
  -- NULL for a file the snapshot no longer has.
  object_count INTEGER,
  problems_json TEXT,
  PRIMARY KEY (snapshot_id, path)
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (29, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
