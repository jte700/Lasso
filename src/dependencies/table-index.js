import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { normalizedRowSearch, rowSearchAliases } from './row-names.js';
import { dictionaryColumns, spreadsheetLayout, tableShape, tabularLayout } from './tabular.js';

// Every row of a large table, kept once per file content so a writer can name
// any of them without the indexer holding them all. Rows are found through
// their names: each name is stored whole and from each of its words on, so a
// prefix of what was typed is a range in a B-tree rather than a pass over
// every cell. Like the text store this is derived data, separate from
// history, and is rebuilt from the file if it is missing.

// Bumped when what the index stores for the same bytes changes.
export const TABLE_INDEX_VERSION = 1;
// The rows the indexer reads a table's shape from, as objectsFromTabular does.
export const SHAPE_ROWS = 1_000;
// The last rows of a table, kept for the notes written under it.
export const TAIL_ROWS = 64;
const MAX_TERM_LENGTH = 64;
const BATCH_ROWS = 2_000;
// A worker reading a table is stopped past this, so one damaged file cannot
// take the server's memory with it.
const WORKER_MEMORY_MB = 512;
// A worker reports progress at least once per megabyte it reads. One silent
// for this long has stopped, and a caller waiting for it stops waiting.
const SILENT_WORKER_MS = 60_000;

/** The names a row can be found by: its label whole, from each word on, and as a numbered reference. */
export function rowTerms(label) {
  const text = String(label ?? '').trim();
  if (!text || text.length > 180) return [];
  const terms = new Set(rowSearchAliases(text));
  const words = text.replace(/[_./-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let index = 1; index < words.length; index += 1) terms.add(words.slice(index).join(''));
  return [...terms].map((term) => term.slice(0, MAX_TERM_LENGTH)).filter((term) => term.length >= 2);
}

export function openTableDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 30000;
    PRAGMA journal_size_limit = 67108864;
    CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY,
      content_hash TEXT NOT NULL,
      sheet TEXT NOT NULL,
      position INTEGER NOT NULL,
      version INTEGER NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      shape_json TEXT,
      extras_json TEXT NOT NULL DEFAULT '{}',
      complete INTEGER NOT NULL DEFAULT 0,
      UNIQUE(content_hash, sheet, version)
    );
    CREATE TABLE IF NOT EXISTS table_rows (
      table_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      row_number INTEGER NOT NULL,
      cells_json TEXT NOT NULL,
      display_json TEXT,
      PRIMARY KEY (table_id, ordinal)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS table_rows_number_idx ON table_rows(table_id, row_number);
    CREATE TABLE IF NOT EXISTS table_terms (
      table_id INTEGER NOT NULL,
      term TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (table_id, term, ordinal)
    ) WITHOUT ROWID;`);
  return db;
}

/**
 * Where a table's data starts and which column names its rows, read from its
 * first rows as the indexer reads them. `rows` are its non-blank rows with
 * their sheet or file row numbers; a delimited file's `physicalRows` also
 * keep its blank lines, which its header search counts.
 */
export function shapeOf({ rows, rowNumbers, sheet, physicalRows = null }) {
  const layout = sheet != null ? spreadsheetLayout({ rows, rowNumbers }) : tabularLayout(physicalRows ?? rows);
  // A statement's row names depend on its sections, and a data dictionary's
  // rows define variables; both stay with the indexer, which reads them whole.
  const statement = Boolean(layout.statement);
  const dictionary = dictionaryColumns('', layout.headers).dictionary;
  // A worksheet's rows are its non-blank rows, as its layout counts them; a
  // delimited file's header is counted among all its lines.
  let dataStart = sheet != null ? layout.headerRowIndex + 1
    : rowNumbers.findIndex((number) => number > layout.headerRowIndex);
  if (dataStart < 0) dataStart = rows.length;
  const data = rows.slice(dataStart, dataStart + SHAPE_ROWS);
  const { labelColumn, firstColumnActsAsRowLabels, rowDescribesVariable } = tableShape(layout.headers, data, { statement });
  return {
    headers: layout.headers.slice(0, 80).map((header) => String(header ?? '')),
    dataStart, labelColumn, firstColumnActsAsRowLabels, rowDescribesVariable,
    searchable: !statement && !dictionary && firstColumnActsAsRowLabels,
  };
}

/**
 * Writes one table's rows a batch at a time. The table is read only once it
 * is finished, so one cut short by a failure or a restart is built again.
 */
export class TableWriter {
  constructor(db, contentHash, sheet, position) {
    this.db = db;
    this.ordinal = 0;
    this.shape = null;
    this.tail = [];
    // A table's name column is known after its first rows, so they wait here.
    this.pending = [];
    this.physical = [];
    this.sheet = sheet;
    const previous = db.prepare('SELECT id FROM tables WHERE content_hash = ? AND sheet = ? AND version = ?')
      .get(contentHash, sheet ?? '', TABLE_INDEX_VERSION);
    if (previous) this.remove(previous.id);
    this.id = Number(db.prepare(`INSERT INTO tables(content_hash, sheet, position, version) VALUES (?, ?, ?, ?)`)
      .run(contentHash, sheet ?? '', position, TABLE_INDEX_VERSION).lastInsertRowid);
    this.insertRow = db.prepare('INSERT INTO table_rows(table_id, ordinal, row_number, cells_json, display_json) VALUES (?, ?, ?, ?, ?)');
    this.insertTerm = db.prepare('INSERT OR IGNORE INTO table_terms(table_id, term, ordinal) VALUES (?, ?, ?)');
  }

  remove(tableId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of ['DELETE FROM table_terms WHERE table_id = ?', 'DELETE FROM table_rows WHERE table_id = ?',
        'DELETE FROM tables WHERE id = ?']) this.db.prepare(statement).run(tableId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * `rows` are { rowNumber, cells, display }. A delimited file passes its
   * blank lines too, as `blank: true`, so its header is found as the indexer
   * finds it; they are not stored.
   */
  add(rows) {
    for (const row of rows) {
      if (this.physical) this.physical.push(row.blank ? [] : row.cells);
      if (row.blank) continue;
      this.pending.push(row);
    }
    if (!this.shape && this.pending.length < SHAPE_ROWS + 80) return;
    this.flush();
  }

  /**
   * A table whose rows have no names cannot be asked for one of them, so
   * past its first rows only its last few are kept, and every row counted.
   */
  flush() {
    if (!this.pending.length) return;
    if (!this.shape) {
      this.shape = shapeOf({ rows: this.pending.map((row) => row.cells), rowNumbers: this.pending.map((row) => row.rowNumber),
        sheet: this.sheet, physicalRows: this.sheet == null ? this.physical : null });
      this.physical = null;
      this.headRows = this.shape.searchable ? Infinity : this.shape.dataStart + SHAPE_ROWS + 80;
    }
    const head = [];
    for (const row of this.pending) {
      const ordinal = this.ordinal++;
      if (ordinal < this.headRows) {
        head.push({ ...row, ordinal });
      } else {
        this.tail.push({ ...row, ordinal });
        if (this.tail.length > TAIL_ROWS) this.tail.shift();
      }
    }
    this.pending = [];
    this.write(head);
  }

  write(rows) {
    const { dataStart, labelColumn, searchable } = this.shape;
    for (let start = 0; start < rows.length; start += BATCH_ROWS) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows.slice(start, start + BATCH_ROWS)) {
          const shown = row.display && Object.keys(row.display).length ? JSON.stringify(row.display) : null;
          this.insertRow.run(this.id, row.ordinal, row.rowNumber, JSON.stringify(row.cells), shown);
          if (!searchable || row.ordinal < dataStart) continue;
          for (const term of rowTerms(row.cells[labelColumn])) this.insertTerm.run(this.id, term, row.ordinal);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  finish(extras = {}) {
    this.flush();
    this.write(this.tail);
    this.tail = [];
    this.db.prepare('UPDATE tables SET complete = 1, row_count = ?, shape_json = ?, extras_json = ? WHERE id = ?')
      .run(this.ordinal, JSON.stringify(this.shape ?? shapeOf({ rows: [], rowNumbers: [], sheet: this.sheet, physicalRows: [] })),
        JSON.stringify(extras), this.id);
    return this.id;
  }

  abandon() {
    try { this.remove(this.id); } catch { /* A later build replaces it. */ }
  }
}

/** Writes rows read in memory, as streamed rows are written. */
export function writeTable(db, contentHash, { sheet = null, position = 0, rows, rowNumbers, displayRows = [], merges = [] }) {
  const writer = new TableWriter(db, contentHash, sheet, position);
  try {
    writer.add(rows.map((cells, index) => {
      const blank = sheet == null && !cells.some((cell) => String(cell ?? '').trim());
      return { rowNumber: rowNumbers[index], cells, display: displayRows[index] ? { ...displayRows[index] } : null, blank };
    }));
    return writer.finish({ merges });
  } catch (error) {
    writer.abandon();
    throw error;
  }
}

const parse = (row) => ({ ordinal: row.ordinal, rowNumber: row.row_number, cells: JSON.parse(row.cells_json),
  display: row.display_json ? JSON.parse(row.display_json) : null });

/** Reads the table index; builds of large files run in a worker. */
export class TableIndex {
  constructor(root) {
    this.file = path.join(root, 'tables.sqlite');
    this.db = openTableDatabase(this.file);
    this.metas = new Map();
    this.statements = {
      table: this.db.prepare(`SELECT * FROM tables WHERE content_hash = ? AND sheet = ? AND version = ? AND complete = 1`),
      sheets: this.db.prepare(`SELECT * FROM tables WHERE content_hash = ? AND version = ? AND complete = 1 ORDER BY position`),
      range: this.db.prepare(`SELECT * FROM table_rows WHERE table_id = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal`),
      row: this.db.prepare('SELECT * FROM table_rows WHERE table_id = ? AND ordinal = ?'),
      numbered: this.db.prepare('SELECT * FROM table_rows WHERE table_id = ? AND row_number = ? ORDER BY ordinal LIMIT 1'),
      before: this.db.prepare('SELECT * FROM table_rows WHERE table_id = ? AND row_number <= ? ORDER BY row_number DESC LIMIT ?'),
      search: this.db.prepare(`SELECT DISTINCT ordinal FROM table_terms WHERE table_id = ? AND term >= ? AND term < ? LIMIT ?`),
    };
  }

  close() {
    this.metas.clear();
    try { this.db.close(); } catch { /* already closed */ }
  }

  meta(row) {
    if (!row) return null;
    return { id: row.id, contentHash: row.content_hash, sheet: row.sheet, position: row.position, rowCount: row.row_count,
      shape: JSON.parse(row.shape_json ?? 'null'), extras: JSON.parse(row.extras_json ?? '{}') };
  }

  /** A finished table of a file, by its content and sheet ('' for a delimited file). */
  table(contentHash, sheet = '') {
    const key = `${contentHash}\u0000${sheet ?? ''}`;
    if (this.metas.has(key)) return this.metas.get(key);
    const meta = this.meta(this.statements.table.get(contentHash, sheet ?? '', TABLE_INDEX_VERSION));
    if (meta) {
      if (this.metas.size > 256) this.metas.delete(this.metas.keys().next().value);
      this.metas.set(key, meta);
    }
    return meta;
  }

  /** A file's finished tables in sheet order. */
  sheets(contentHash) {
    return this.statements.sheets.all(contentHash, TABLE_INDEX_VERSION).map((row) => this.meta(row));
  }

  has(contentHash) {
    return this.sheets(contentHash).length > 0;
  }

  forget(contentHash) {
    for (const key of this.metas.keys()) if (key.startsWith(`${contentHash}\u0000`)) this.metas.delete(key);
  }

  rows(tableId, from, to) {
    return this.statements.range.all(tableId, from, to).map(parse);
  }

  row(tableId, ordinal) {
    const row = this.statements.row.get(tableId, ordinal);
    return row ? parse(row) : null;
  }

  rowNumbered(tableId, rowNumber) {
    const row = this.statements.numbered.get(tableId, rowNumber);
    return row ? parse(row) : null;
  }

  /** Up to `count` rows at or above a sheet row, nearest first. */
  rowsBefore(tableId, rowNumber, count) {
    return this.statements.before.all(tableId, rowNumber, count).map(parse);
  }

  /**
   * The rows whose name begins with what was typed, or has a word that does.
   * A range scan over the name terms, bounded by `limit`; exact names sort
   * first, as the shortest term with that prefix.
   */
  search(tableId, typed, limit = 32) {
    const query = normalizedRowSearch(typed);
    if (query.length < 2) return [];
    const ordinals = this.statements.search.all(tableId, query, `${query}￿`, limit).map((row) => row.ordinal);
    if (!ordinals.length) return [];
    return ordinals.map((ordinal) => this.row(tableId, ordinal)).filter(Boolean);
  }

  /**
   * Reads a large file's tables into the index in a worker. `kind` is
   * 'spreadsheet' or 'delimited'. Resolves with what the worker read;
   * `onProgress(share)` reports how far it got.
   */
  build(request, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./table-index-worker.js', import.meta.url), {
        workerData: { ...request, databasePath: this.file }, resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
      });
      let settled = false;
      worker.on('message', (message) => {
        if (message.progress != null) onProgress(message.progress);
        if (message.done) { settled = true; this.forget(request.contentHash); resolve(message); }
        if (message.error) { settled = true; reject(new Error(message.error)); }
      });
      worker.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
      worker.on('exit', (code) => { if (!settled) { settled = true; reject(new Error(`The table reader stopped (${code}).`)); } });
    });
  }

  /**
   * The same, for a caller that must have the result now: it waits for the
   * worker rather than reading the file on this thread, so the reading and
   * its memory use are the same either way.
   */
  buildBlocking(request) {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL('./table-index-worker.js', import.meta.url), {
      workerData: { ...request, databasePath: this.file, flag, port: port2 }, transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
    });
    worker.unref();
    let heard = Date.now();
    let result = null;
    while (!result) {
      const finished = Atomics.wait(flag, 0, 0, 1_000) !== 'timed-out' || Atomics.load(flag, 0) === 1;
      for (let message = receiveMessageOnPort(port1); message; message = receiveMessageOnPort(port1)) {
        heard = Date.now();
        if (message.message.done || message.message.error) result = message.message;
      }
      if (finished) result ??= { error: 'The table reader stopped.' };
      else if (!result && Date.now() - heard > SILENT_WORKER_MS) {
        worker.terminate();
        result = { error: 'The table reader stopped responding.' };
      }
    }
    port1.close();
    this.forget(request.contentHash);
    if (result.error) throw new Error(result.error);
    return result;
  }
}
