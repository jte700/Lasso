-- AI records that travel inside Word documents. A record says which parts of
-- the document an AI wrote, as the Lasso that wrote it into the file knew
-- them, signed with that Lasso's key. Marks read from another Mac's record
-- keep who recorded them; each mark also keeps who has edited inside what it
-- wrote since.
ALTER TABLE ai_marks ADD COLUMN recorded_by_name TEXT;
ALTER TABLE ai_marks ADD COLUMN recorded_by_key TEXT;
ALTER TABLE ai_marks ADD COLUMN editors_json TEXT;

-- The records this Lasso wrote into a file: the version before and after,
-- so the write itself is never mistaken for someone's edit.
CREATE TABLE IF NOT EXISTS ai_record_stamps (
  project_file_id TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  written_at TEXT NOT NULL,
  PRIMARY KEY (project_file_id, after_hash)
) WITHOUT ROWID;

-- Records a file brought with it that have been read into its spans, so the
-- same record is never laid over later edits again.
CREATE TABLE IF NOT EXISTS ai_carried_records (
  project_file_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (project_file_id, payload_hash)
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (36, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
