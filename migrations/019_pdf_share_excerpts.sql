-- A manually selected PDF excerpt belongs to the grant, not the source object.
ALTER TABLE object_share_grants ADD COLUMN excerpt_json TEXT;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (19, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
