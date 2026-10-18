-- Which reader produced a snapshot's indexed objects.
--
-- 0 means a build that did not record one, so its reading cannot be vouched
-- for. `index reindex` re-reads the files into a new snapshot rather than
-- rewriting this one: recorded evidence never changes.
--
-- Numbered 18 because a development build shipped a different migration 17,
-- the way two branches once shipped different 014s. Stores carrying that one
-- must still receive this column.
ALTER TABLE snapshot_object_indexes ADD COLUMN extractor_version INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_migrations(version, applied_at)
VALUES (18, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
