-- Reviews of what changed in a folder since it was last approved, in The
-- Ranch: comments pinned to a line, a cell or a passage of a changed file,
-- suggested changes, which files were looked at, and the approvals.

-- A folder approved up to one of its versions; the next review shows what
-- changed after it. Undo keeps the row and marks it undone.
CREATE TABLE IF NOT EXISTS review_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  approved_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS review_approvals_project_idx ON review_approvals(project_id, approved_at);

-- A conversation about one place in one file.
CREATE TABLE IF NOT EXISTS review_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  -- Where it is pinned, as JSON: { kind: 'line', line, text }, { kind: 'cell',
  -- sheet, row, column, value }, { kind: 'value', place, label, value } or { kind: 'file' }.
  anchor_json TEXT NOT NULL,
  -- The folder's version the place was read from.
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_actor_id TEXT REFERENCES actors(id),
  -- Its suggestion made it into the file: applied here, or found in a later save.
  applied_at TEXT,
  applied_by_actor_id TEXT REFERENCES actors(id)
);
CREATE INDEX IF NOT EXISTS review_threads_file_idx ON review_threads(project_id, path);

CREATE TABLE IF NOT EXISTS review_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  -- The person who asked, when an AI wrote it.
  initiated_by_actor_id TEXT REFERENCES actors(id),
  body TEXT NOT NULL,
  -- A suggested change, as JSON: { before, after }, what the place reads and should read.
  suggestion_json TEXT,
  -- What a backslash prompt asked an AI to do, and the edit it made.
  prompt_text TEXT,
  agent_execution_id TEXT REFERENCES agent_executions(id),
  created_at TEXT NOT NULL,
  -- The approval that sent it. Until one does, the comment is pending.
  approval_id TEXT REFERENCES review_approvals(id)
);
CREATE INDEX IF NOT EXISTS review_comments_thread_idx ON review_comments(thread_id, created_at);

-- A file marked as looked at, for the bytes it had then: a later save
-- leaves it to be looked at again.
CREATE TABLE IF NOT EXISTS review_views (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  content_hash TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, path, actor_id)
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (33, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
