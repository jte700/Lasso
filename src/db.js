import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const BUSY_TIMEOUT_MS = 5000;
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export function openDatabase(config) {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new DatabaseSync(config.databasePath);
  // Wait briefly for a lock instead of failing at once if another connection
  // (such as a server that has not finished shutting down) is still writing.
  // A large index write grows the write-ahead log, and SQLite keeps the file
  // at its largest size unless told otherwise. One re-read left it at 650 MB.
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);

  const hasMigrations = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  let currentVersion = hasMigrations
    ? (db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()?.version ?? 0)
    : 0;

  const migrationDirectory = fileURLToPath(new URL('../migrations', import.meta.url));
  // Two development branches shipped different migration 014s. A database
  // carrying the share-scope columns already applied the local UI branch.
  // Install the idempotent ranking schema, then acknowledge its scope schema
  // as migration 015 without trying to add the same columns a second time.
  if (currentVersion === 14) {
    const shareColumns = new Set(db.prepare('PRAGMA table_info(object_share_grants)').all().map(column => column.name));
    if (shareColumns.has('access_scope') && shareColumns.has('redactions_json')) {
      transaction(db, () => {
        db.exec(fs.readFileSync(path.join(migrationDirectory, '014_recommendation_usage.sql'), 'utf8'));
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(15, new Date().toISOString());
      });
      currentVersion = 15;
    }
  }

  // Both development branches shipped migration 016. Normalize either shape
  // transactionally, preserving existing history and directory choices.
  if (currentVersion === 16) {
    transaction(db, () => {
      const projectColumns = db.prepare('PRAGMA table_info(projects)').all();
      if (!projectColumns.some(column => column.name === 'workspace_active')) {
        db.exec('ALTER TABLE projects ADD COLUMN workspace_active INTEGER NOT NULL DEFAULT 1 CHECK (workspace_active IN (0, 1))');
      }
      const indexColumns = db.prepare('PRAGMA table_info(snapshot_object_indexes)').all();
      if (!indexColumns.some(column => column.name === 'drawing_index_version')) {
        db.exec('ALTER TABLE snapshot_object_indexes ADD COLUMN drawing_index_version INTEGER NOT NULL DEFAULT 0');
      }
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString());
    });
    currentVersion = 17;
  }

  // The external-drives branch shipped drawing index, spreadsheet coordinates
  // and removable drives as 016-018; they are now 017, 021 and 022. Its
  // databases (at 17 or 18) lack 016's workspace column, and one at 18 also
  // skipped 018's text and spreadsheet re-index, so both are applied here.
  // The runner below records 021 and 022 when their schema already exists.
  const columnsOf = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if ((currentVersion === 17 || currentVersion === 18) && !columnsOf('projects').has('workspace_active')
    && columnsOf('snapshot_object_indexes').has('spreadsheet_index_version')) {
    transaction(db, () => {
      db.exec('ALTER TABLE projects ADD COLUMN workspace_active INTEGER NOT NULL DEFAULT 1 CHECK (workspace_active IN (0, 1))');
      // That branch's index version 2 meant STEP models; here 2 means PDF
      // passages. Step it back so the next pass adds what those indexes lack.
      db.exec('UPDATE snapshot_object_indexes SET drawing_index_version = 1 WHERE drawing_index_version = 2');
      if (currentVersion === 18) {
        db.exec(`DELETE FROM snapshot_object_indexes WHERE snapshot_id IN (
          SELECT p.current_snapshot_id FROM projects p JOIN snapshot_files f ON f.snapshot_id = p.current_snapshot_id
          WHERE lower(f.path) LIKE '%.txt' OR lower(f.path) LIKE '%.xlsx')`);
      }
    });
  }
  const alreadyApplied = {
    21: () => columnsOf('snapshot_object_indexes').has('spreadsheet_index_version'),
    22: () => hasTable('removable_drives'),
  };

  // Two branches shipped different migration 018s. A store from the Windows
  // companion's branch is at 18 with a reader column (extractor_version) but
  // without Alpha's 016 folder toggle or 018 text and spreadsheet re-index.
  // Apply both here; 019 onwards then upgrade it like any other store, and
  // the reader column is added idempotently below for everyone else.
  if (currentVersion === 18) {
    const indexColumns = db.prepare('PRAGMA table_info(snapshot_object_indexes)').all();
    if (indexColumns.some(column => column.name === 'extractor_version')) {
      transaction(db, () => {
        const projectColumns = db.prepare('PRAGMA table_info(projects)').all();
        if (!projectColumns.some(column => column.name === 'workspace_active')) {
          db.exec('ALTER TABLE projects ADD COLUMN workspace_active INTEGER NOT NULL DEFAULT 1 CHECK (workspace_active IN (0, 1))');
        }
        db.exec(fs.readFileSync(path.join(migrationDirectory, '018_text_spreadsheet_reindex.sql'), 'utf8')
          .replace(/INSERT INTO schema_migrations[\s\S]*$/, ''));
      });
    }
  }

  const migrations = fs.readdirSync(migrationDirectory)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .map((name) => ({ name, version: Number(name.split('_')[0]) }))
    .filter((migration) => migration.version > currentVersion)
    .sort((a, b) => a.version - b.version);
  // Each migration applies completely or not at all, so an interrupted upgrade
  // cannot leave a half-built schema that fails on every later start.
  for (const migration of migrations) {
    if (alreadyApplied[migration.version]?.()) {
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationDirectory, migration.name), 'utf8');
    // A table rebuild turns foreign keys off, which SQLite ignores inside a
    // transaction. Switch them around the transaction instead.
    const rebuildsTables = /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql);
    if (rebuildsTables) db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => db.exec(sql));
    } finally {
      if (rebuildsTables) db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Directory identity columns are added idempotently, because maintenance
  // and upgrade paths replay numbered migrations over an existing schema.
  // Removing a folder from the menu keeps its history for re-adding; a
  // folder renamed in place keeps its inode, which follows it to the new name.
  const projectColumns = new Set(db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name));
  if (!projectColumns.has('workspace_removed')) {
    db.exec('ALTER TABLE projects ADD COLUMN workspace_removed INTEGER NOT NULL DEFAULT 0 CHECK (workspace_removed IN (0, 1))');
  }
  if (!projectColumns.has('root_inode')) db.exec('ALTER TABLE projects ADD COLUMN root_inode TEXT');
  // Which reader produced a snapshot's indexed objects; 0 is a build that did
  // not record one. `index reindex` re-reads the files into a new snapshot
  // rather than rewriting this one, so recorded evidence never changes.
  const objectIndexColumns = new Set(db.prepare('PRAGMA table_info(snapshot_object_indexes)').all().map((column) => column.name));
  if (!objectIndexColumns.has('extractor_version')) {
    db.exec('ALTER TABLE snapshot_object_indexes ADD COLUMN extractor_version INTEGER NOT NULL DEFAULT 0');
  }
  // A file's change time moves on every write, even one that restores its
  // modification time. With it, reopening a folder after a restart reuses
  // unchanged files' recorded hashes instead of reading every file again.
  const snapshotFileColumns = new Set(db.prepare('PRAGMA table_info(snapshot_files)').all().map((column) => column.name));
  if (!snapshotFileColumns.has('ctime_ms')) db.exec('ALTER TABLE snapshot_files ADD COLUMN ctime_ms REAL');
  // A snapshot with a file base stores only the files that changed since that
  // base (see migration 020). Existing snapshots read NULL: they hold every file.
  const snapshotColumns = new Set(db.prepare('PRAGMA table_info(snapshots)').all().map((column) => column.name));
  if (!snapshotColumns.has('files_base_snapshot_id')) {
    db.exec('ALTER TABLE snapshots ADD COLUMN files_base_snapshot_id TEXT REFERENCES snapshots(id)');
  }
  // A carried-forward object version spans many snapshots, so a share records
  // the one it was made from. Existing shares read NULL and use their version's.
  const shareColumns = new Set(db.prepare('PRAGMA table_info(object_share_grants)').all().map((column) => column.name));
  if (!shareColumns.has('snapshot_id')) db.exec('ALTER TABLE object_share_grants ADD COLUMN snapshot_id TEXT REFERENCES snapshots(id)');
  // The sentence a share backs, and whether a cited cell brings its nearby rows.
  if (!shareColumns.has('context_json')) db.exec('ALTER TABLE object_share_grants ADD COLUMN context_json TEXT');
  allowMarkedShares(db);
  // Rows and cells of large tables become objects only when they are offered
  // or linked (see dependencies/table-index.js). Each later reading of their
  // file reads these keys again, so a link to one survives a new version.
  db.exec(`CREATE TABLE IF NOT EXISTS table_objects (
    key_prefix TEXT NOT NULL,
    object_key TEXT NOT NULL,
    PRIMARY KEY (key_prefix, object_key)
  ) WITHOUT ROWID`);
  // Resolving an index groups its versions by object. With the object beside
  // the snapshot in one index that reads the index alone, not every version
  // row; on a large history the difference was seconds per resolution. It
  // serves every lookup by snapshot, so the narrower index is dropped.
  db.exec(`CREATE INDEX IF NOT EXISTS scientific_object_versions_snapshot_object_idx
    ON scientific_object_versions(snapshot_id, object_id); DROP INDEX IF EXISTS scientific_object_snapshot_idx;`);
  // The first duplicates UNIQUE(snapshot_id, path); search text is matched in
  // memory, never in SQL, so its index only stored the text a second time.
  // Dropped here rather than in a migration, which replaying 001 would undo.
  db.exec('DROP INDEX IF EXISTS snapshot_files_path_idx; DROP INDEX IF EXISTS scientific_object_search_idx;');

  return db;
}

/**
 * A share can be a copy with markings drawn on its pages (MARKED), its
 * strokes kept in redactions_json. SQLite cannot change a CHECK constraint in
 * place, so a table made before then is rebuilt once with the same rows.
 * Done here, after the columns above, because a numbered migration runs
 * before them on a new store.
 */
function allowMarkedShares(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'object_share_grants'").get()?.sql ?? '';
  if (!table || table.includes("'MARKED'")) return;
  const scopes = /CHECK\s*\(\s*access_scope\s+IN\s*\(([^)]*)\)\s*\)/i;
  if (!scopes.test(table)) return;
  const rebuilt = table
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?object_share_grants"?/i, 'CREATE TABLE object_share_grants_rebuilt')
    .replace(scopes, (_, listed) => `CHECK (access_scope IN (${listed.trim()}, 'MARKED'))`);
  const columns = db.prepare('PRAGMA table_info(object_share_grants)').all().map((column) => `"${column.name}"`).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => db.exec(`${rebuilt};
      INSERT INTO object_share_grants_rebuilt (${columns}) SELECT ${columns} FROM object_share_grants;
      DROP TABLE object_share_grants;
      ALTER TABLE object_share_grants_rebuilt RENAME TO object_share_grants;
      CREATE INDEX IF NOT EXISTS object_share_grant_object_idx ON object_share_grants(object_id, revoked_at, created_at DESC);`));
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function json(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
