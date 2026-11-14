-- A file read again and found to hold the bytes already recorded writes no
-- new snapshot record, and snapshot records are immutable, so the record keeps
-- the stat values the file was first seen with. This keeps the stat values
-- those bytes were last confirmed under, so a file that was only touched, or
-- recorded before change times were kept, is not read whole at every launch.
CREATE TABLE IF NOT EXISTS verified_file_stats (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  -- The bytes that were read, as the snapshot names them.
  content_hash TEXT NOT NULL,
  -- device:inode:size:mtime:ctime, in nanoseconds, as the scanner compares them.
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (32, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
