-- What an AI wrote into the files of a folder, recorded when it wrote it,
-- never guessed from the words. A mark is one write: an edit Claude Code made
-- with its file tools (the file before and after), a command it ran (the
-- time it ran, files written then), an answer Lasso's writer typed, or text
-- copied from an AI app and pasted. Marks wait until a save of the file holds
-- what they wrote; then the characters they wrote are kept as spans of that
-- file's text, carried from version to version as people edit around them.
CREATE TABLE IF NOT EXISTS ai_marks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'command', 'writer', 'paste', 'agent')),
  agent_actor_id TEXT NOT NULL REFERENCES actors(id),
  initiated_by_actor_id TEXT REFERENCES actors(id),
  -- The model, when the tool says which (claude-opus-5-5).
  model TEXT,
  -- What wrote it: Claude Code, Lasso's writer, the ChatGPT app, chatgpt.com.
  tool TEXT,
  prompt TEXT,
  -- Where it was written, when the app could say.
  host_app TEXT,
  document_path TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT,
  -- An edit: the file's text before and after it.
  before_text TEXT,
  after_text TEXT,
  before_hash TEXT,
  after_hash TEXT,
  -- A command: what ran, and where.
  command TEXT,
  cwd TEXT,
  -- Words written or pasted.
  text TEXT,
  hook_key TEXT,
  session_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  -- Set once a save held what it wrote.
  matched_at TEXT,
  matched_snapshot_id TEXT,
  written_chars INTEGER
);
CREATE INDEX IF NOT EXISTS ai_marks_pending_idx ON ai_marks(matched_at, kind);
CREATE INDEX IF NOT EXISTS ai_marks_hook_idx ON ai_marks(hook_key);

-- The characters of one version of a file that an AI wrote, as runs over the
-- file's readable text (a text file's own text, a document's paragraphs one a
-- line): [{ s, e, m }] with m a mark id.
CREATE TABLE IF NOT EXISTS ai_spans (
  project_file_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  spans_json TEXT NOT NULL,
  PRIMARY KEY (project_file_id, content_hash)
) WITHOUT ROWID;

-- The last prompt and model of each Claude Code session, which its edits are recorded with.
CREATE TABLE IF NOT EXISTS ai_hook_sessions (
  session_id TEXT PRIMARY KEY,
  prompt TEXT,
  model TEXT,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (35, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
