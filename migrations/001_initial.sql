PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN_SELF', 'HUMAN_COLLABORATOR', 'AI_AGENT', 'SYSTEM')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  current_snapshot_id TEXT,
  watcher_enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  parent_snapshot_id TEXT REFERENCES snapshots(id),
  manifest_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version)
);

CREATE TABLE IF NOT EXISTS snapshot_files (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  project_file_id TEXT NOT NULL REFERENCES project_files(id),
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  file_type TEXT NOT NULL,
  device TEXT,
  inode TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(snapshot_id, project_file_id),
  UNIQUE(snapshot_id, path)
);

CREATE INDEX IF NOT EXISTS snapshot_files_path_idx ON snapshot_files(snapshot_id, path);
CREATE INDEX IF NOT EXISTS snapshot_files_hash_idx ON snapshot_files(content_hash);

CREATE TABLE IF NOT EXISTS agent_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_actor_id TEXT NOT NULL REFERENCES actors(id),
  initiated_by_actor_id TEXT REFERENCES actors(id),
  request_text TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'APPLIED', 'REJECTED', 'CONFLICT')),
  proposal_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  previous_snapshot_id TEXT REFERENCES snapshots(id),
  resulting_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  initiated_by_actor_id TEXT REFERENCES actors(id),
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  agent_execution_id TEXT REFERENCES agent_executions(id),
  UNIQUE(resulting_snapshot_id)
);

CREATE INDEX IF NOT EXISTS timeline_events_project_time_idx ON timeline_events(project_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  project_file_id TEXT NOT NULL REFERENCES project_files(id),
  path_before TEXT,
  path_after TEXT,
  change_type TEXT NOT NULL CHECK (change_type IN ('ADDED', 'DELETED', 'RENAMED', 'MOVED', 'MODIFIED')),
  content_hash_before TEXT,
  content_hash_after TEXT,
  structured_diff_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS file_changes_event_idx ON file_changes(event_id);

CREATE TABLE IF NOT EXISTS provenance_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  from_path TEXT NOT NULL,
  from_anchor_json TEXT,
  relation TEXT NOT NULL CHECK (relation IN ('DERIVED_FROM', 'GENERATED_BY', 'USES_DATASET', 'USED_IN_FIGURE', 'SUPPORTS', 'PROPOSED_BY', 'APPROVED_BY', 'REPLACED_BY')),
  to_snapshot_id TEXT REFERENCES snapshots(id),
  to_path TEXT,
  to_anchor_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by_event_id TEXT REFERENCES timeline_events(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS provenance_from_idx ON provenance_links(project_id, from_snapshot_id, from_path);

CREATE TRIGGER IF NOT EXISTS snapshots_immutable_update
BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS snapshots_immutable_delete
BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_files_immutable_update
BEFORE UPDATE ON snapshot_files BEGIN SELECT RAISE(ABORT, 'snapshot files are immutable'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_files_immutable_delete
BEFORE DELETE ON snapshot_files BEGIN SELECT RAISE(ABORT, 'snapshot files are immutable'); END;
CREATE TRIGGER IF NOT EXISTS timeline_events_immutable_update
BEFORE UPDATE ON timeline_events BEGIN SELECT RAISE(ABORT, 'timeline events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS timeline_events_immutable_delete
BEFORE DELETE ON timeline_events BEGIN SELECT RAISE(ABORT, 'timeline events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS file_changes_immutable_update
BEFORE UPDATE ON file_changes BEGIN SELECT RAISE(ABORT, 'file changes are immutable'); END;
CREATE TRIGGER IF NOT EXISTS file_changes_immutable_delete
BEFORE DELETE ON file_changes BEGIN SELECT RAISE(ABORT, 'file changes are immutable'); END;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
