-- Correct formatted XLSX extraction lazily, retaining all pinned versions.
ALTER TABLE snapshot_object_indexes ADD COLUMN spreadsheet_index_version INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (21, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
