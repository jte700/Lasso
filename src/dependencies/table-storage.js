import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rowTerms } from './table-terms.js';

// How the table index stores rows so that a file's versions share the rows
// they have in common. A row (its cells and how they display) is stored once,
// keyed by a short hash of what it holds, with the names it is found by. A
// table is a list of chunks: runs of consecutive rows, each stored once as the
// packed ids of its rows and the gaps between their row numbers. A chunk ends
// after a row whose hash meets a condition, so where chunks end depends on the
// rows themselves: an edited or inserted row changes the chunk it falls in,
// and perhaps the next, while every other chunk is the same as before and is
// shared. A new version of a file writes its new rows, a chunk or two, and its
// list of chunks.

// The layout of tables.sqlite, kept as its user_version. 0 is the layout that
// stored every row once per table. An index in any other layout is emptied
// and its tables read again from their files; all of it is derived data.
export const TABLE_LAYOUT = 2;
// A chunk ends after a row whose hash has these bits clear: one row in 128.
const CHUNK_CUT_MASK = 127;
// No chunk is shorter than this unless the table or its run of rows ends.
export const MIN_CHUNK_ROWS = 32;
// Nor longer than this, so rows whose hashes never meet the condition still end one.
export const MAX_CHUNK_ROWS = 1_024;
// A varint holds seven bits per byte; the high bit says another byte follows.
const VARINT_BASE = 128;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_hash TEXT NOT NULL,
    sheet TEXT NOT NULL,
    position INTEGER NOT NULL,
    version INTEGER NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    shape_json TEXT,
    extras_json TEXT NOT NULL DEFAULT '{}',
    complete INTEGER NOT NULL DEFAULT 0,
    touched_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(content_hash, sheet, version)
  );
  CREATE TABLE IF NOT EXISTS table_row_bodies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash INTEGER UNIQUE,
    cells_json TEXT NOT NULL,
    display_json TEXT,
    -- The columns of the row that hold a formula, as a JSON array; NULL for none.
    formula_columns TEXT,
    term_columns TEXT,
    refs INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS table_row_bodies_unused_idx ON table_row_bodies(id) WHERE refs <= 0;
  CREATE TABLE IF NOT EXISTS table_row_terms (
    label_column INTEGER NOT NULL,
    term TEXT NOT NULL,
    row_id INTEGER NOT NULL,
    PRIMARY KEY (label_column, term, row_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS table_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash INTEGER UNIQUE,
    row_count INTEGER NOT NULL,
    entries BLOB NOT NULL,
    refs INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS table_chunks_unused_idx ON table_chunks(id) WHERE refs <= 0;
  CREATE TABLE IF NOT EXISTS table_parts (
    table_id INTEGER NOT NULL,
    first_ordinal INTEGER NOT NULL,
    first_row_number INTEGER NOT NULL,
    chunk_id INTEGER NOT NULL,
    PRIMARY KEY (table_id, first_ordinal)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS dropped_tables (table_id INTEGER PRIMARY KEY);`;

/** Runs `callback` in one write transaction, taken at its start so readers and the worker queue behind it. */
export function immediately(db, callback) {
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

/**
 * Empties an index in another layout and creates this one. Every connection
 * opening the file runs it; the first to take the write lock does the work
 * and the others find it done.
 */
function upgrade(db) {
  const upgraded = immediately(db, () => {
    if (db.prepare('PRAGMA user_version').get().user_version === TABLE_LAYOUT) return false;
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all();
    for (const { name } of names) db.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${TABLE_LAYOUT}`);
    return names.length > 0;
  });
  // The earlier layout could hold many copies of each table; give the disk back.
  if (upgraded) {
    try { db.exec('VACUUM'); } catch (error) { console.error('Compacting the table index failed:', error.message); }
  }
}

export function openTableDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 30000;
    PRAGMA journal_size_limit = 67108864;`);
  if (db.prepare('PRAGMA user_version').get().user_version !== TABLE_LAYOUT) upgrade(db);
  addFormulaColumns(db);
  return db;
}

// An index made before rows recorded their formulas gains the column; its
// rows are read again by the newer table version before they are used.
function addFormulaColumns(db) {
  const has = () => db.prepare('PRAGMA table_info(table_row_bodies)').all().some((column) => column.name === 'formula_columns');
  if (has()) return;
  immediately(db, () => {
    if (!has()) db.exec('ALTER TABLE table_row_bodies ADD COLUMN formula_columns TEXT');
  });
}

/** A short key for stored content, and whether a chunk ends after the row it belongs to. */
export function contentKey(text) {
  const digest = crypto.createHash('sha1').update(text).digest();
  return { key: digest.readBigInt64BE(0), cut: (digest.readUInt32BE(8) & CHUNK_CUT_MASK) === 0 };
}

const zigzag = (value) => (value >= 0 ? value * 2 : -value * 2 - 1);
const unzigzag = (value) => (value % 2 === 0 ? value / 2 : -(value + 1) / 2);

function pushVarint(bytes, value) {
  let rest = value;
  while (rest >= VARINT_BASE) {
    bytes.push((rest % VARINT_BASE) + VARINT_BASE);
    rest = Math.floor(rest / VARINT_BASE);
  }
  bytes.push(rest);
}

/** A chunk's rows as bytes: each row id and row number as the difference from the row before it. */
export function encodeChunk(rowIds, rowNumbers) {
  const bytes = [];
  for (let index = 0; index < rowIds.length; index += 1) {
    pushVarint(bytes, zigzag(rowIds[index] - (index ? rowIds[index - 1] : 0)));
    pushVarint(bytes, zigzag(rowNumbers[index] - (index ? rowNumbers[index - 1] : rowNumbers[0])));
  }
  return Buffer.from(bytes);
}

/**
 * Reads a chunk's rows into a table's arrays from `offset`: consecutive
 * ordinals from `firstOrdinal`, row numbers from `firstRowNumber`.
 */
export function decodeChunk(entries, count, { firstOrdinal, firstRowNumber, offset, ordinals, rowIds, rowNumbers }) {
  let at = 0;
  const next = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = entries[at++];
      value += (byte % VARINT_BASE) * scale;
      if (byte < VARINT_BASE) return value;
      scale *= VARINT_BASE;
    }
  };
  let rowId = 0;
  let rowNumber = firstRowNumber;
  for (let index = 0; index < count; index += 1) {
    rowId += unzigzag(next());
    rowNumber += unzigzag(next());
    ordinals[offset + index] = firstOrdinal + index;
    rowIds[offset + index] = rowId;
    rowNumbers[offset + index] = rowNumber;
  }
}

/** The row ids a chunk holds, in order. */
export function chunkRowIds(entries, count) {
  const arrays = { ordinals: new Float64Array(count), rowIds: new Float64Array(count), rowNumbers: new Float64Array(count) };
  decodeChunk(entries, count, { firstOrdinal: 0, firstRowNumber: 0, offset: 0, ...arrays });
  return arrays.rowIds;
}

const hasColumn = (columns, column) => Boolean(columns?.includes(`,${column},`));
const withColumn = (columns, column) => `${columns ?? ','}${column},`;

/**
 * Writes a table's chunks, sharing every row and chunk already stored. Each
 * row id a chunk holds counts towards that row's refs, and each part of a
 * table that uses a chunk towards the chunk's, so cleanup removes a row or a
 * chunk once nothing uses it.
 */
export class TableChunkStore {
  constructor(db) {
    this.db = db;
    this.statements = {
      body: db.prepare('SELECT id, cells_json, display_json, formula_columns, term_columns FROM table_row_bodies WHERE hash = ?'),
      insertBody: db.prepare('INSERT INTO table_row_bodies(hash, cells_json, display_json, formula_columns) VALUES (?, ?, ?, ?)'),
      termColumns: db.prepare('UPDATE table_row_bodies SET term_columns = ? WHERE id = ?'),
      term: db.prepare('INSERT OR IGNORE INTO table_row_terms(label_column, term, row_id) VALUES (?, ?, ?)'),
      chunk: db.prepare('SELECT id, entries FROM table_chunks WHERE hash = ?'),
      insertChunk: db.prepare('INSERT INTO table_chunks(hash, row_count, entries) VALUES (?, ?, ?)'),
      useBody: db.prepare('UPDATE table_row_bodies SET refs = refs + 1 WHERE id = ?'),
      useChunk: db.prepare('UPDATE table_chunks SET refs = refs + 1 WHERE id = ?'),
      part: db.prepare('INSERT INTO table_parts(table_id, first_ordinal, first_row_number, chunk_id) VALUES (?, ?, ?, ?)'),
      touch: db.prepare('UPDATE tables SET touched_at = ? WHERE id = ?'),
    };
  }

  /**
   * Writes chunks of one table in one short transaction. A table taken out of
   * the index meanwhile, by a newer build of the same content, gets nothing
   * more, so cleanup that already removed its parts finds none added later.
   * Returns whether the table is still there.
   */
  write(tableId, chunks) {
    if (!chunks.length) return true;
    return immediately(this.db, () => {
      if (!Number(this.statements.touch.run(Date.now(), tableId).changes)) return false;
      for (const chunk of chunks) this.writeChunk(tableId, chunk);
      return true;
    });
  }

  /** `rows` are consecutive: { ordinal, rowNumber, cellsJson, displayJson, formulaJson, key, label, termColumn }. */
  writeChunk(tableId, rows) {
    const rowIds = rows.map((row) => this.rowId(row));
    const entries = encodeChunk(rowIds, rows.map((row) => row.rowNumber));
    const chunkId = this.chunkId(entries, rowIds);
    this.statements.useChunk.run(chunkId);
    this.statements.part.run(tableId, rows[0].ordinal, rows[0].rowNumber, chunkId);
  }

  rowId(row) {
    const found = this.statements.body.get(row.key);
    const same = found && found.cells_json === row.cellsJson && found.display_json === row.displayJson
      && (found.formula_columns ?? null) === (row.formulaJson ?? null);
    // Two different rows with one key cannot share it; the second is stored without one.
    const id = same ? found.id : Number(this.statements.insertBody.run(found ? null : row.key, row.cellsJson, row.displayJson,
      row.formulaJson ?? null).lastInsertRowid);
    const columns = same ? found.term_columns : null;
    if (row.termColumn != null && !hasColumn(columns, row.termColumn)) {
      for (const term of rowTerms(row.label)) this.statements.term.run(row.termColumn, term, id);
      this.statements.termColumns.run(withColumn(columns, row.termColumn), id);
    }
    return id;
  }

  chunkId(entries, rowIds) {
    const { key } = contentKey(entries);
    const found = this.statements.chunk.get(key);
    if (found && Buffer.from(found.entries).equals(entries)) return found.id;
    const id = Number(this.statements.insertChunk.run(found ? null : key, rowIds.length, entries).lastInsertRowid);
    for (const rowId of rowIds) this.statements.useBody.run(rowId);
    return id;
  }
}

/** Row terms to remove with a row: those of each column its names were stored under. */
export function storedTerms(cellsJson, termColumns) {
  if (!termColumns) return [];
  const cells = JSON.parse(cellsJson);
  return termColumns.split(',').filter(Boolean).map(Number)
    .flatMap((column) => rowTerms(cells[column]).map((term) => [column, term]));
}
