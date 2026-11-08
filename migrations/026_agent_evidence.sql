-- Evidence shown to an AI agent, by a short handle it can quote back instead
-- of repeating the evidence. A handle names one recorded object version, or a
-- range of lines at one file revision, never "whatever is current", so a later
-- capture cannot move what it points at.
CREATE TABLE IF NOT EXISTS agent_evidence (
  handle TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  project_file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  -- NULL for a range of lines, or a cell of a large table, read straight
  -- from the file revision.
  object_id TEXT,
  version_id TEXT,
  line_start INTEGER,
  line_end INTEGER,
  -- A large table's cell: { sheet, row, column, columnName, rowKey }.
  cell_json TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS agent_evidence_used_idx ON agent_evidence(last_used_at);

-- An agent's explicit choice of evidence for a named field of its task. The
-- actor comes from the transport the agent connected through, never from a
-- request field. These rows are kept apart from recommendation_usage, so what
-- an agent chooses never raises a source in a person's suggestions.
CREATE TABLE IF NOT EXISTS agent_bindings (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 160),
  field TEXT NOT NULL CHECK (length(field) BETWEEN 1 AND 160),
  handle TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  object_id TEXT,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  cell_json TEXT,
  -- The literal as recorded at that version, inserted exactly as written.
  value_text TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_bindings_task_idx ON agent_bindings(task_id, field, id);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (26, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
