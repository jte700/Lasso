-- Correct formatted XLSX extraction lazily, retaining all pinned versions.
ALTER TABLE snapshot_object_indexes ADD COLUMN spreadsheet_index_version INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_migrations(version, applied_at)
VALUES (17, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
