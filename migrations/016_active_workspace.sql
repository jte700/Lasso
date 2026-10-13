-- Folder toggles control the live corpus, independently of retained history.
ALTER TABLE projects ADD COLUMN workspace_active INTEGER NOT NULL DEFAULT 1
CHECK (workspace_active IN (0, 1));

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (16, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
