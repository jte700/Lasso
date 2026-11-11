-- A passage is keyed by its own words, so an edited sentence is recorded as a
-- new passage and the old one as removed. When the new one is mostly the old
-- one's words, in the same file, this records that it replaces that version,
-- so its history can reach back through the earlier wording.
CREATE TABLE IF NOT EXISTS passage_successions (
  snapshot_id TEXT NOT NULL,
  -- The passage added at this snapshot.
  object_id TEXT NOT NULL,
  -- The version of the removed passage it replaces.
  replaces_version_id TEXT NOT NULL,
  PRIMARY KEY (object_id, snapshot_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS passage_successions_snapshot_idx ON passage_successions(snapshot_id);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
