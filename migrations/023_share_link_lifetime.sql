-- Share links stop working 48 hours after they are made. Links made before
-- the limit, including ones that never expired, close at the same point.
UPDATE object_share_grants
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+48 hours')
WHERE expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+48 hours');

UPDATE dependency_share_grants
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+48 hours')
WHERE expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+48 hours');

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (23, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
