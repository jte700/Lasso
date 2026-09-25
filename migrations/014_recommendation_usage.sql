-- Intentional actions only. One action of each kind per file and session prevents
-- repeated clicks or suggestion rendering from manufacturing popularity.
CREATE TABLE IF NOT EXISTS recommendation_usage (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_file_id TEXT NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('accept', 'open')),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 160),
  document_project_file_id TEXT REFERENCES project_files(id) ON DELETE SET NULL,
  occurred_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id, project_file_id, kind, session_id)
);

CREATE INDEX IF NOT EXISTS recommendation_usage_project_time_idx
ON recommendation_usage(project_id, occurred_at_ms DESC);

-- A session can intentionally use the same source with several documents, while
-- contributing only once to that source's frequency score.
CREATE TABLE IF NOT EXISTS recommendation_document_usage (
  project_id TEXT NOT NULL,
  project_file_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT NOT NULL,
  document_project_file_id TEXT NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, project_file_id, kind, session_id, document_project_file_id),
  FOREIGN KEY (project_id, project_file_id, kind, session_id)
    REFERENCES recommendation_usage(project_id, project_file_id, kind, session_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (14, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
