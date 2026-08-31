DROP TRIGGER IF EXISTS scientific_object_versions_immutable_delete;

DELETE FROM scientific_object_versions
WHERE snapshot_id IN (SELECT current_snapshot_id FROM projects)
  AND lower(path) LIKE '%.xls'
  AND NOT EXISTS (
  SELECT 1
  FROM claim_dependency_versions dependency
  WHERE dependency.source_object_id = scientific_object_versions.object_id
    AND dependency.source_snapshot_id = scientific_object_versions.snapshot_id
);

CREATE TRIGGER scientific_object_versions_immutable_delete
BEFORE DELETE ON scientific_object_versions BEGIN
  SELECT RAISE(ABORT, 'scientific object versions are immutable');
END;

DELETE FROM snapshot_object_indexes
WHERE snapshot_id IN (
  SELECT DISTINCT project.current_snapshot_id
  FROM projects project
  JOIN snapshot_files file ON file.snapshot_id = project.current_snapshot_id
  WHERE lower(file.path) LIKE '%.xls'
);

INSERT INTO schema_migrations(version, applied_at)
VALUES (9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
