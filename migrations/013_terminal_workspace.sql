-- Terminal workspace: the operational layer over the dependency graph.
--
-- Nothing here duplicates the graph. Aliases name existing indexed objects,
-- rules describe deterministic reactions to changes the graph already records,
-- and the index tables record what the indexer could not or was told not to
-- read. The graph itself stays in scientific_objects / claim_dependencies.

CREATE TABLE IF NOT EXISTS dependency_aliases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  target_path TEXT NOT NULL,
  target_locator TEXT,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS dependency_alias_object_idx
ON dependency_aliases(project_id, object_key);

-- WHEN <trigger> THEN <action>. Deliberately a fixed vocabulary rather than an
-- automation language: every rule is one trigger and one action, both drawn
-- from enumerations the executor understands.
CREATE TABLE IF NOT EXISTS terminal_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN (
    'SOURCE_PATH_PREFIX', 'DEPENDENCY_NAME', 'SHARED_SOURCE_CHANGED'
  )),
  trigger_value TEXT NOT NULL DEFAULT '',
  action_kind TEXT NOT NULL CHECK (action_kind IN (
    'FLAG_DEPENDENTS', 'EXCLUDE_FROM_AUTOCOMPLETE', 'MARK_SHARE_STALE'
  )),
  action_value TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

-- What a rule flagged, so the editor and terminal read the same flags.
CREATE TABLE IF NOT EXISTS terminal_rule_flags (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES terminal_rules(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('DEPENDENCY', 'OBJECT', 'SHARE')),
  subject_key TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  cleared_at TEXT,
  UNIQUE(rule_id, subject_kind, subject_key)
);

CREATE INDEX IF NOT EXISTS terminal_rule_flag_idx
ON terminal_rule_flags(project_id, cleared_at, subject_kind);

-- Directories the user has told the indexer to leave alone.
CREATE TABLE IF NOT EXISTS index_exclusions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path_prefix TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, path_prefix)
);

-- Files the indexer reached but could not read or parse. Recorded per scan so
-- `index failures` reports what actually happened rather than a guess.
CREATE TABLE IF NOT EXISTS index_failures (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  code TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(project_id, path)
);

CREATE INDEX IF NOT EXISTS index_failure_idx
ON index_failures(project_id, resolved_at, detected_at DESC);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (13, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
