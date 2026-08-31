PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS claim_dependency_versions_immutable_update;
DROP TRIGGER IF EXISTS claim_dependency_versions_immutable_delete;
DROP TRIGGER IF EXISTS dependency_changes_immutable_update;
DROP TRIGGER IF EXISTS dependency_changes_immutable_delete;
DROP INDEX IF EXISTS claim_dependency_version_idx;
DROP INDEX IF EXISTS dependency_changes_event_idx;

ALTER TABLE dependency_changes RENAME TO dependency_changes_v2;
ALTER TABLE claim_dependency_versions RENAME TO claim_dependency_versions_v2;

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
  selection_method TEXT NOT NULL CHECK (selection_method IN (
    'AUTOCOMPLETE', 'PREDICTED_ACCEPTED', 'MANUAL', 'SYSTEM_LINKED', 'IMPORTED'
  )),
  confidence REAL,
  status TEXT NOT NULL CHECK (status IN ('PREDICTED', 'LINKED', 'NEEDS_REVIEW', 'STALE', 'BROKEN')),
  status_details_json TEXT NOT NULL DEFAULT '{}',
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  is_removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(dependency_id, snapshot_id)
);

INSERT INTO claim_dependency_versions
SELECT * FROM claim_dependency_versions_v2;

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

INSERT INTO dependency_changes
SELECT * FROM dependency_changes_v2;

DROP TABLE dependency_changes_v2;
DROP TABLE claim_dependency_versions_v2;

CREATE INDEX claim_dependency_version_idx ON claim_dependency_versions(dependency_id, created_at DESC);
CREATE INDEX dependency_changes_event_idx ON dependency_changes(event_id);

CREATE TRIGGER claim_dependency_versions_immutable_update
BEFORE UPDATE ON claim_dependency_versions BEGIN SELECT RAISE(ABORT, 'claim dependency versions are immutable'); END;
CREATE TRIGGER claim_dependency_versions_immutable_delete
BEFORE DELETE ON claim_dependency_versions BEGIN SELECT RAISE(ABORT, 'claim dependency versions are immutable'); END;
CREATE TRIGGER dependency_changes_immutable_update
BEFORE UPDATE ON dependency_changes BEGIN SELECT RAISE(ABORT, 'dependency changes are immutable'); END;
CREATE TRIGGER dependency_changes_immutable_delete
BEFORE DELETE ON dependency_changes BEGIN SELECT RAISE(ABORT, 'dependency changes are immutable'); END;

DELETE FROM snapshot_object_indexes;

INSERT INTO schema_migrations(version, applied_at)
VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA foreign_keys = ON;
