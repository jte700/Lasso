-- Unchanged files and objects are carried forward instead of copied into every
-- snapshot. A snapshot stores file rows and object versions only for what
-- changed since the snapshot it builds on, and these tables record what it
-- removed and which index it builds on. Like the rows they complete, they
-- never change once written, so every recorded version resolves the same way
-- forever. Snapshots written before this keep their full copies and resolve
-- on their own.

CREATE TABLE IF NOT EXISTS snapshot_file_removals (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  project_file_id TEXT NOT NULL REFERENCES project_files(id),
  PRIMARY KEY(snapshot_id, project_file_id)
);

CREATE TABLE IF NOT EXISTS object_index_bases (
  snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id),
  base_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS object_index_bases_base_idx ON object_index_bases(base_snapshot_id);

CREATE TABLE IF NOT EXISTS scientific_object_removals (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  object_id TEXT NOT NULL REFERENCES scientific_objects(id) ON DELETE CASCADE,
  PRIMARY KEY(snapshot_id, object_id)
);

CREATE INDEX IF NOT EXISTS scientific_object_removals_object_idx ON scientific_object_removals(object_id);

CREATE TRIGGER IF NOT EXISTS snapshot_file_removals_immutable_update
BEFORE UPDATE ON snapshot_file_removals BEGIN SELECT RAISE(ABORT, 'snapshot file removals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_file_removals_immutable_delete
BEFORE DELETE ON snapshot_file_removals BEGIN SELECT RAISE(ABORT, 'snapshot file removals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS object_index_bases_immutable_update
BEFORE UPDATE ON object_index_bases BEGIN SELECT RAISE(ABORT, 'object index bases are immutable'); END;
CREATE TRIGGER IF NOT EXISTS object_index_bases_immutable_delete
BEFORE DELETE ON object_index_bases BEGIN SELECT RAISE(ABORT, 'object index bases are immutable'); END;
CREATE TRIGGER IF NOT EXISTS scientific_object_removals_immutable_update
BEFORE UPDATE ON scientific_object_removals BEGIN SELECT RAISE(ABORT, 'scientific object removals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS scientific_object_removals_immutable_delete
BEFORE DELETE ON scientific_object_removals BEGIN SELECT RAISE(ABORT, 'scientific object removals are immutable'); END;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
