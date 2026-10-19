import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BUSY_TIMEOUT_MS = 5000;

export function openDatabase(config) {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new DatabaseSync(config.databasePath);
  // Wait briefly for a lock instead of failing at once if another connection
  // (such as a server that has not finished shutting down) is still writing.
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);

  const hasMigrations = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  let currentVersion = hasMigrations
    ? (db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()?.version ?? 0)
    : 0;

  const migrationDirectory = path.resolve('migrations');
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

  const migrations = fs.readdirSync(migrationDirectory)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .map((name) => ({ name, version: Number(name.split('_')[0]) }))
    .filter((migration) => migration.version > currentVersion)
    .sort((a, b) => a.version - b.version);
  // Each migration applies completely or not at all, so an interrupted upgrade
  // cannot leave a half-built schema that fails on every later start.
  for (const migration of migrations) {
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
  // A file's change time moves on every write, even one that restores its
  // modification time. With it, reopening a folder after a restart reuses
  // unchanged files' recorded hashes instead of reading every file again.
  const snapshotFileColumns = new Set(db.prepare('PRAGMA table_info(snapshot_files)').all().map((column) => column.name));
  if (!snapshotFileColumns.has('ctime_ms')) db.exec('ALTER TABLE snapshot_files ADD COLUMN ctime_ms REAL');

  return db;
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
