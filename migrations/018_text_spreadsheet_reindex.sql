-- Add missing text and namespaced spreadsheet objects to current indexes.
-- Existing source versions and their pinned references remain immutable.
DELETE FROM snapshot_object_indexes
WHERE snapshot_id IN (
  SELECT p.current_snapshot_id FROM projects p
  JOIN snapshot_files f ON f.snapshot_id = p.current_snapshot_id
  WHERE lower(f.path) LIKE '%.txt' OR lower(f.path) LIKE '%.xlsx'
);

INSERT INTO schema_migrations(version, applied_at)
VALUES (18, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
