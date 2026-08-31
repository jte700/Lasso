-- Rebuild existing snapshot indexes so papers and documents gain table/figure objects.
DELETE FROM snapshot_object_indexes;

INSERT INTO schema_migrations(version, applied_at)
VALUES (11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
