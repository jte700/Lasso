-- Files looked at in The Ranch, the native library window. Kept apart from
-- recommendation_usage so browsing the library never changes how suggestions
-- are ranked; it only brightens the file in the Ranch's network view.
CREATE TABLE IF NOT EXISTS source_visits (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_file_id TEXT NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  visit_count INTEGER NOT NULL DEFAULT 0 CHECK (visit_count >= 0),
  last_visited_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id, project_file_id)
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (25, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
