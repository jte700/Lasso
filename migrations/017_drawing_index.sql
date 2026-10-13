-- Add drawing objects lazily without removing indexes or historical versions.
ALTER TABLE snapshot_object_indexes ADD COLUMN drawing_index_version INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_migrations(version, applied_at)
VALUES (17, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
