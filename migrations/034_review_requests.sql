-- Reviews someone asks for by name, as a pull request is: a title, a note,
-- the files to look at and the people asked to review them. Reviewers are
-- recorded only; nothing is sent to them.
CREATE TABLE IF NOT EXISTS review_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Counted per folder, from 1: "Review 3".
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  requested_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by_actor_id TEXT REFERENCES actors(id)
);
CREATE INDEX IF NOT EXISTS review_requests_project_idx ON review_requests(project_id, number);

CREATE TABLE IF NOT EXISTS review_request_files (
  request_id TEXT NOT NULL REFERENCES review_requests(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (request_id, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS review_request_reviewers (
  request_id TEXT NOT NULL REFERENCES review_requests(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (request_id, email)
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (34, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
