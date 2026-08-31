CREATE TABLE document_edit_layer_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_file_id TEXT NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  source_content_hash TEXT NOT NULL,
  source_format TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  UNIQUE(project_file_id, snapshot_id)
);

CREATE INDEX document_edit_layer_lookup_idx
ON document_edit_layer_versions(project_file_id, snapshot_id);

CREATE TABLE dependency_share_grants (
  id TEXT PRIMARY KEY,
  dependency_id TEXT NOT NULL REFERENCES claim_dependencies(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  access_scope TEXT NOT NULL CHECK (access_scope IN ('CONTEXT', 'FULL')),
  recipient_label TEXT,
  context_radius INTEGER NOT NULL DEFAULT 1 CHECK (context_radius BETWEEN 0 AND 5),
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX dependency_share_grant_idx
ON dependency_share_grants(dependency_id, revoked_at, created_at DESC);

CREATE TRIGGER document_edit_layer_versions_immutable_update
BEFORE UPDATE ON document_edit_layer_versions BEGIN
  SELECT RAISE(ABORT, 'document edit layer versions are immutable');
END;

CREATE TRIGGER document_edit_layer_versions_immutable_delete
BEFORE DELETE ON document_edit_layer_versions BEGIN
  SELECT RAISE(ABORT, 'document edit layer versions are immutable');
END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
