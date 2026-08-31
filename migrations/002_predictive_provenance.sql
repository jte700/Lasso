PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS provenance_from_idx;
ALTER TABLE provenance_links RENAME TO provenance_links_v1;

CREATE TABLE provenance_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  from_path TEXT NOT NULL,
  from_anchor_json TEXT,
  relation TEXT NOT NULL CHECK (relation IN (
    'DEPENDS_ON', 'DERIVED_FROM', 'GENERATED_BY', 'USES_DATASET', 'USED', 'USED_IN_FIGURE',
    'SUPPORTS', 'PROPOSED_BY', 'APPROVED_BY', 'REPLACED_BY', 'IDENTIFIED_BY'
  )),
  to_snapshot_id TEXT REFERENCES snapshots(id),
  to_path TEXT,
  to_anchor_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by_event_id TEXT REFERENCES timeline_events(id),
  created_at TEXT NOT NULL
);

INSERT INTO provenance_links
SELECT * FROM provenance_links_v1;
DROP TABLE provenance_links_v1;
CREATE INDEX provenance_from_idx ON provenance_links(project_id, from_snapshot_id, from_path);

CREATE TABLE scientific_objects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  object_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, object_key)
);

CREATE TABLE scientific_object_versions (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES scientific_objects(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  path TEXT NOT NULL,
  anchor_json TEXT,
  label TEXT NOT NULL,
  value_text TEXT,
  search_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(object_id, snapshot_id)
);

CREATE INDEX scientific_object_snapshot_idx ON scientific_object_versions(snapshot_id);
CREATE INDEX scientific_object_search_idx ON scientific_object_versions(snapshot_id, search_text);

CREATE TABLE snapshot_object_indexes (
  snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id),
  indexed_at TEXT NOT NULL,
  object_count INTEGER NOT NULL
);

CREATE TABLE claim_dependencies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_project_file_id TEXT NOT NULL REFERENCES project_files(id),
  created_at TEXT NOT NULL
);

CREATE TABLE claim_dependency_versions (
  id TEXT PRIMARY KEY,
  dependency_id TEXT NOT NULL REFERENCES claim_dependencies(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  document_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  document_path TEXT NOT NULL,
  document_anchor_json TEXT NOT NULL,
  span_text TEXT NOT NULL,
  source_object_id TEXT NOT NULL REFERENCES scientific_objects(id),
  source_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  source_value_text TEXT,
  selection_method TEXT NOT NULL CHECK (selection_method IN ('PREDICTED_ACCEPTED', 'MANUAL', 'SYSTEM_LINKED', 'IMPORTED')),
  confidence REAL,
  status TEXT NOT NULL CHECK (status IN ('PREDICTED', 'LINKED', 'NEEDS_REVIEW', 'STALE', 'BROKEN')),
  status_details_json TEXT NOT NULL DEFAULT '{}',
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  is_removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(dependency_id, snapshot_id)
);

CREATE INDEX claim_dependency_document_idx ON claim_dependencies(project_id, document_project_file_id);
CREATE INDEX claim_dependency_version_idx ON claim_dependency_versions(dependency_id, created_at DESC);

CREATE TABLE dependency_changes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  dependency_id TEXT NOT NULL REFERENCES claim_dependencies(id),
  before_version_id TEXT REFERENCES claim_dependency_versions(id),
  after_version_id TEXT REFERENCES claim_dependency_versions(id),
  change_type TEXT NOT NULL CHECK (change_type IN (
    'DEPENDENCY_LINKED', 'DEPENDENCY_CHANGED', 'DEPENDENCY_REMOVED',
    'DEPENDENCY_STALE', 'DEPENDENCY_REVIEWED'
  )),
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX dependency_changes_event_idx ON dependency_changes(event_id);

CREATE TRIGGER scientific_object_versions_immutable_update
BEFORE UPDATE ON scientific_object_versions BEGIN SELECT RAISE(ABORT, 'scientific object versions are immutable'); END;
CREATE TRIGGER scientific_object_versions_immutable_delete
BEFORE DELETE ON scientific_object_versions BEGIN SELECT RAISE(ABORT, 'scientific object versions are immutable'); END;
CREATE TRIGGER claim_dependency_versions_immutable_update
BEFORE UPDATE ON claim_dependency_versions BEGIN SELECT RAISE(ABORT, 'claim dependency versions are immutable'); END;
CREATE TRIGGER claim_dependency_versions_immutable_delete
BEFORE DELETE ON claim_dependency_versions BEGIN SELECT RAISE(ABORT, 'claim dependency versions are immutable'); END;
CREATE TRIGGER dependency_changes_immutable_update
BEFORE UPDATE ON dependency_changes BEGIN SELECT RAISE(ABORT, 'dependency changes are immutable'); END;
CREATE TRIGGER dependency_changes_immutable_delete
BEFORE DELETE ON dependency_changes BEGIN SELECT RAISE(ABORT, 'dependency changes are immutable'); END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA foreign_keys = ON;
