-- Persist the exact privacy boundary selected in the native share composer.
-- DOCUMENT keeps the pinned original downloadable. INDEXED publishes only the
-- indexed context. REDACTED publishes that context with explicit safe masks.

ALTER TABLE object_share_grants
ADD COLUMN access_scope TEXT NOT NULL DEFAULT 'DOCUMENT'
CHECK (access_scope IN ('DOCUMENT', 'INDEXED', 'REDACTED'));

ALTER TABLE object_share_grants
ADD COLUMN redactions_json TEXT NOT NULL DEFAULT '[]';

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (15, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
