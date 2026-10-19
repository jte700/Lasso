CREATE TABLE removable_drives (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  connected INTEGER NOT NULL DEFAULT 0,
  pending_action TEXT CHECK (pending_action IN ('connected', 'disconnected')),
  updated_at TEXT NOT NULL
);
CREATE TABLE drive_projects (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  drive_id TEXT NOT NULL REFERENCES removable_drives(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  UNIQUE(drive_id, relative_path)
);
CREATE INDEX drive_projects_drive_idx ON drive_projects(drive_id);
INSERT INTO schema_migrations(version, applied_at)
VALUES (18, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
