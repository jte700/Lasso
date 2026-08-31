CREATE INDEX IF NOT EXISTS scientific_object_project_type_idx
ON scientific_objects(project_id, object_type);

INSERT INTO schema_migrations(version, applied_at)
VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
