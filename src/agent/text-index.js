// A full-text index of the library's object versions, for agents: BM25
// ranking (SQLite FTS5) over each version's own text, its label, and its
// context (file, title, section, sheet, column, part or room). Rare words
// count for more than common ones, long passages are not favoured for their
// length, and no word is required, so a passage that matches most of a
// question still ranks.
//
// It is derived data, like the app's other derived indexes: kept beside the
// library in derived/agent-text.sqlite, filled on demand from the version
// records the app writes, never written by the app, and safe to delete. Each
// version is indexed once; a query keeps only the versions its folders'
// current snapshots hold.
//
// A PDF's or Word document's headings and a PDF's table rows are not object
// versions (a heading or a row is too short to be a passage), so they are
// indexed beside them as parts of the file revision, read once per content
// hash by `readStructure`: without them a section's name and a table's
// figures could not be searched, and a word that is only a heading would be
// reported as in no file.

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = 2;
const STRUCTURED = /\.(?:pdf|docx)$/i;
const BATCH = 2000;

/** The words a version is found by besides its own text: where it is and what it belongs to. */
function contextOf(row, metadata) {
  return [row.path, metadata.title, metadata.parentTitle, metadata.section, metadata.slideTitle, metadata.sheet, metadata.column,
    metadata.row, metadata.entityName, String(metadata.entityType ?? '').replace(/^IFC/i, ''), metadata.roomName, metadata.storey]
    .filter((value) => typeof value === 'string' && value).join(' ');
}

export class TextIndex {
  /**
   * `store` is the library's database, read here; `dataDir` the library's
   * folder; `readStructure(contentHash, path)` a file revision's
   * `{ headings: [{ page, start, line, text }], rows: [{ page, start, text, caption, header }] }`.
   */
  constructor(store, dataDir, readStructure = null) {
    this.store = store;
    this.readStructure = readStructure;
    const directory = path.join(dataDir, 'derived');
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'agent-text.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    if (this.db.prepare("SELECT value FROM state WHERE key = 'schema'").get()?.value !== SCHEMA) {
      this.db.exec('DROP TABLE IF EXISTS text; DROP TABLE IF EXISTS versions; DROP TABLE IF EXISTS parts; DROP TABLE IF EXISTS structured; DELETE FROM state;');
      this.db.prepare("INSERT INTO state (key, value) VALUES ('schema', ?)").run(SCHEMA);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS versions (rowid INTEGER PRIMARY KEY, version_id TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS text USING fts5(body, label, context, tokenize = 'porter unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS structured (content_hash TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE IF NOT EXISTS parts USING fts5(body, context, content_hash UNINDEXED, kind UNINDEXED, page UNINDEXED,
        start UNINDEXED, line UNINDEXED, caption UNINDEXED, header UNINDEXED, tokenize = 'porter unicode61 remove_diacritics 2');`);
    this.read = store.prepare('SELECT rowid, id, path, label, value_text, content_hash, metadata_json FROM scientific_object_versions WHERE rowid > ? ORDER BY rowid LIMIT ?');
    this.isStructured = this.db.prepare('SELECT 1 AS done FROM structured WHERE content_hash = ?');
    this.markStructured = this.db.prepare('INSERT OR IGNORE INTO structured (content_hash) VALUES (?)');
    this.insertPart = this.db.prepare('INSERT INTO parts (body, context, content_hash, kind, page, start, line, caption, header) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.last = store.prepare('SELECT max(rowid) AS last FROM scientific_object_versions');
    this.insertText = this.db.prepare('INSERT INTO text (rowid, body, label, context) VALUES (?, ?, ?, ?)');
    this.insertVersion = this.db.prepare('INSERT INTO versions (rowid, version_id) VALUES (?, ?)');
    this.setThrough = this.db.prepare("INSERT INTO state (key, value) VALUES ('through', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  }

  through() {
    return this.db.prepare("SELECT value FROM state WHERE key = 'through'").get()?.value ?? 0;
  }

  /**
   * Indexes the versions recorded since the last call, for at most `budgetMs`.
   * Returns whether every recorded version is now indexed.
   */
  sync(budgetMs = 2000) {
    const started = performance.now();
    const last = this.last.get().last ?? 0;
    // Rows removed from the end free their row ids for reuse: forget what was indexed past the store's last row.
    if (last < this.through()) {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('DELETE FROM text WHERE rowid > ?').run(last);
      this.db.prepare('DELETE FROM versions WHERE rowid > ?').run(last);
      this.setThrough.run(last);
      this.db.exec('COMMIT');
    }
    let through = this.through();
    while (through < last && performance.now() - started < budgetMs) {
      const rows = this.read.all(through, BATCH);
      if (!rows.length) break;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Another agent process may have indexed these meanwhile.
        const done = this.through();
        for (const row of rows) {
          if (row.rowid <= done) continue;
          const metadata = (() => { try { return JSON.parse(row.metadata_json ?? '{}'); } catch { return {}; } })();
          this.insertText.run(row.rowid, String(row.value_text ?? row.label ?? ''), String(row.label ?? ''), contextOf(row, metadata));
          this.insertVersion.run(row.rowid, row.id);
          if (this.readStructure && STRUCTURED.test(row.path) && !this.isStructured.get(row.content_hash)) this.addStructure(row.content_hash, row.path);
        }
        through = Math.max(done, rows.at(-1).rowid);
        this.setThrough.run(through);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    return through >= last;
  }

  /** A file revision's headings and table rows, as parts beside its versions. */
  addStructure(contentHash, filePath) {
    this.markStructured.run(contentHash);
    let structure;
    try { structure = this.readStructure(contentHash, filePath); } catch { return; }
    for (const heading of structure?.headings ?? []) {
      this.insertPart.run(heading.text, filePath, contentHash, 'heading', heading.page ?? 0, heading.start ?? 0, heading.line ?? 0, null, null);
    }
    for (const row of structure?.rows ?? []) {
      this.insertPart.run(row.text, `${filePath} ${row.caption ?? ''} ${row.header ?? ''}`, contentHash, 'row', row.page ?? 0, row.start ?? 0, 0,
        row.caption ?? null, row.header ?? null);
    }
  }

  /** A file revision's parts in reading order, or null when it has not been read for them. */
  partsOf(contentHash) {
    if (!this.isStructured.get(contentHash)) return null;
    return this.db.prepare('SELECT body, kind, page, start, line, caption, header FROM parts WHERE content_hash = ? ORDER BY page, line, start').all(contentHash);
  }

  /**
   * Parts ranked by BM25 for any of `terms` (every one with `all`):
   * `{ contentHash, kind, page, start, line, text, caption, header, score }`.
   */
  searchParts(terms, limit = 400, { all = false } = {}) {
    const quoted = [...new Set(terms.map((term) => String(term).replace(/"/g, ' ').trim()).filter(Boolean))].map((term) => `"${term}"`);
    if (!quoted.length) return [];
    return this.db.prepare(`SELECT body, content_hash, kind, page, start, line, caption, header, bm25(parts, 1.0, 0.3) AS rank
      FROM parts WHERE parts MATCH ? ORDER BY rank LIMIT ?`).all(quoted.join(all ? ' AND ' : ' OR '), limit)
      .map((row) => ({ contentHash: row.content_hash, kind: row.kind, page: row.page, start: row.start, line: row.line, text: row.body,
        caption: row.caption, header: row.header, score: -row.rank }));
  }

  /**
   * Versions ranked by BM25 for any of `terms` (a word, or a phrase of
   * several; every one with `all`): `{ versionId, score }`, best first, score
   * higher is better. Versions of any folder or snapshot come back; the
   * caller keeps its own.
   */
  search(terms, limit = 2000, { all = false } = {}) {
    const quoted = [...new Set(terms.map((term) => String(term).replace(/"/g, ' ').trim()).filter(Boolean))].map((term) => `"${term}"`);
    if (!quoted.length) return [];
    return this.db.prepare(`SELECT versions.version_id AS versionId, bm25(text, 1.0, 0.6, 0.3) AS rank
      FROM text JOIN versions ON versions.rowid = text.rowid WHERE text MATCH ? ORDER BY rank LIMIT ?`)
      .all(quoted.join(all ? ' AND ' : ' OR '), limit).map((row) => ({ versionId: row.versionId, score: -row.rank }));
  }

  /** How many versions and parts are indexed. */
  size() {
    return this.db.prepare('SELECT count(*) AS n FROM versions').get().n + this.db.prepare('SELECT count(*) AS n FROM parts').get().n;
  }

  /** How many indexed versions and parts have the word (or phrase), for weighting it by its rarity. */
  frequency(term) {
    const quoted = `"${String(term).replace(/"/g, ' ').trim()}"`;
    if (quoted === '""') return 0;
    return this.db.prepare('SELECT count(*) AS n FROM text WHERE text MATCH ?').get(quoted).n
      + this.db.prepare('SELECT count(*) AS n FROM parts WHERE parts MATCH ?').get(quoted).n;
  }

  close() {
    this.db.close();
  }
}
