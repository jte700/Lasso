import path from 'node:path';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { BoundedCache } from '../cache.js';
import { normalizedRowSearch } from './row-names.js';
import { dictionaryColumns, spreadsheetLayout, tableShape, tabularLayout } from './tabular.js';
import { CLEANUP_BATCH_ROWS, cleanupBatch, dropTable } from './table-cleanup.js';
import { lowerBound, placeOfOrdinal, placeOfRowNumber, placesBefore, placesOf, readTableMap } from './table-map.js';
import { MAX_CHUNK_ROWS, MIN_CHUNK_ROWS, TableChunkStore, contentKey, openTableDatabase } from './table-storage.js';
import { rowTerms } from './table-terms.js';

export { nameTerm, rowTerms } from './table-terms.js';
export { openTableDatabase } from './table-storage.js';

// Every row of a large table, kept per file content so a writer can name any
// of them without the indexer holding them all. A file's versions share the
// rows they have in common (see table-storage.js). Rows are found through
// their names: each name is stored whole and from each of its words on, so a
// prefix of what was typed is a range in a B-tree rather than a pass over
// every cell. Like the text store this is derived data, separate from
// history, and is rebuilt from the file if it is missing.

// Bumped when what the index stores for the same bytes changes.
export const TABLE_INDEX_VERSION = 2;
// The rows the indexer reads a table's shape from, as objectsFromTabular does.
export const SHAPE_ROWS = 1_000;
// The last rows of a table, kept for the notes written under it.
export const TAIL_ROWS = 64;
const BATCH_ROWS = 2_000;
// A worker reading a table is stopped past this, so one damaged file cannot
// take the server's memory with it.
const WORKER_MEMORY_MB = 512;
// A worker reports progress at least once per megabyte it reads. One silent
// for this long has stopped, and a caller waiting for it stops waiting.
const SILENT_WORKER_MS = 60_000;
// The most rows' lists of a table held in memory at once, across tables.
const MAPPED_ROWS = 2_000_000;
// The most stored names one search reads. Names are shared by every version
// of a file the index keeps, and by other files' rows, so this bounds a
// search when a name is common to many rows outside the table searched.
const MAX_TERM_ROWS = 20_000;
// The same for rows read under one exact name; past it the table's own rows
// are read instead, so the answer stays exact.
const MAX_NAMED_TERM_ROWS = 50_000;

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
    // Rows of the chunk being filled, and chunks waiting to be written.
    this.chunk = [];
    this.ready = [];
    this.readyRows = 0;
    this.replaced = false;
    this.store = new TableChunkStore(db);
    const previous = db.prepare('SELECT id FROM tables WHERE content_hash = ? AND sheet = ? AND version = ?')
      .get(contentHash, sheet ?? '', TABLE_INDEX_VERSION);
    if (previous) this.remove(previous.id);
    this.id = Number(db.prepare(`INSERT INTO tables(content_hash, sheet, position, version, touched_at) VALUES (?, ?, ?, ?, ?)`)
      .run(contentHash, sheet ?? '', position, TABLE_INDEX_VERSION, Date.now()).lastInsertRowid);
  }

  /** Takes a table out of the index at once; cleanup removes its rows later. */
  remove(tableId) {
    dropTable(this.db, tableId);
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

  /** A row as it is stored, with its content key and, past a named table's header, the column its names are read from. */
  stored(row) {
    const { dataStart, labelColumn, searchable } = this.shape;
    const cellsJson = JSON.stringify(row.cells);
    const displayJson = row.display && Object.keys(row.display).length ? JSON.stringify(row.display) : null;
    const { key, cut } = contentKey(`${TABLE_INDEX_VERSION}\u0000${cellsJson}\u0000${displayJson ?? ''}`);
    const named = searchable && row.ordinal >= dataStart && Number.isInteger(labelColumn);
    return { ordinal: row.ordinal, rowNumber: row.rowNumber, cellsJson, displayJson, key, cut,
      termColumn: named ? labelColumn : null, label: named ? row.cells[labelColumn] : null };
  }

  /**
   * Adds rows to chunks. A chunk ends where a row's content says so, at its
   * longest, and where the stored rows skip ordinals (before a table's last
   * rows), so a chunk always holds consecutive rows.
   */
  write(rows) {
    for (const row of rows) {
      const entry = this.stored(row);
      if (this.chunk.length && entry.ordinal !== this.chunk[this.chunk.length - 1].ordinal + 1) this.endChunk();
      this.chunk.push(entry);
      if (this.chunk.length >= MAX_CHUNK_ROWS || (entry.cut && this.chunk.length >= MIN_CHUNK_ROWS)) this.endChunk();
      if (this.readyRows >= BATCH_ROWS) this.writeChunks();
    }
    this.writeChunks();
  }

  endChunk() {
    if (!this.chunk.length) return;
    this.ready.push(this.chunk);
    this.readyRows += this.chunk.length;
    this.chunk = [];
  }

  /** Writes the chunks ready; once a newer build has replaced this table, they are let go instead. */
  writeChunks() {
    if (this.ready.length && !this.replaced) this.replaced = !this.store.write(this.id, this.ready);
    this.ready = [];
    this.readyRows = 0;
  }

  finish(extras = {}) {
    this.flush();
    this.write(this.tail);
    this.tail = [];
    this.endChunk();
    this.writeChunks();
    this.db.prepare('UPDATE tables SET complete = 1, row_count = ?, shape_json = ?, extras_json = ?, touched_at = ? WHERE id = ?')
      .run(this.ordinal, JSON.stringify(this.shape ?? shapeOf({ rows: [], rowNumbers: [], sheet: this.sheet, physicalRows: [] })),
        JSON.stringify(extras), Date.now(), this.id);
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

const parse = (body, place, map) => ({ ordinal: map.ordinals[place], rowNumber: map.rowNumbers[place],
  cells: JSON.parse(body.cells_json), display: body.display_json ? JSON.parse(body.display_json) : null });

/** Reads the table index; builds of large files run in a worker. */
export class TableIndex {
  /** `keep(hashes)` returns which of these file contents some snapshot still needs (see cleanup). */
  constructor(root, { keep = null } = {}) {
    this.file = path.join(root, 'tables.sqlite');
    this.db = openTableDatabase(this.file);
    this.keep = keep;
    this.metas = new Map();
    // A finished table's list of rows never changes, so it is read once while it is in use.
    this.maps = new BoundedCache({ maxEntries: 32, maxWeight: MAPPED_ROWS, weight: (map) => map.ordinals.length });
    this.statements = {
      table: this.db.prepare(`SELECT * FROM tables WHERE content_hash = ? AND sheet = ? AND version = ? AND complete = 1`),
      sheets: this.db.prepare(`SELECT * FROM tables WHERE content_hash = ? AND version = ? AND complete = 1 ORDER BY position`),
      mapTable: this.db.prepare('SELECT content_hash, complete, shape_json FROM tables WHERE id = ?'),
      mapParts: this.db.prepare(`SELECT p.first_ordinal, p.first_row_number, c.row_count, c.entries FROM table_parts p
        JOIN table_chunks c ON c.id = p.chunk_id WHERE p.table_id = ? ORDER BY p.first_ordinal`),
      body: this.db.prepare('SELECT id, cells_json, display_json FROM table_row_bodies WHERE id = ?'),
      bodies: this.db.prepare('SELECT id, cells_json, display_json FROM table_row_bodies WHERE id IN (SELECT value FROM json_each(?))'),
      search: this.db.prepare(`SELECT term, row_id FROM table_row_terms
        WHERE label_column = ? AND term >= ? AND term < ? ORDER BY term, row_id LIMIT ?`),
      named: this.db.prepare('SELECT row_id FROM table_row_terms WHERE label_column = ? AND term = ? LIMIT ?'),
    };
  }

  close() {
    this.metas.clear();
    this.maps.clear();
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
    for (const [tableId, entry] of this.maps.entries) if (entry.value.contentHash === contentHash) this.maps.delete(tableId);
  }

  /** A table's list of rows; an unfinished one is read again each time. */
  mapOf(tableId) {
    const cached = this.maps.get(tableId);
    if (cached) return cached;
    const map = readTableMap(this.statements, tableId);
    if (map.complete) this.maps.set(tableId, map);
    return map;
  }

  /** The rows at these places in a table's list, in the order given. */
  rowsAt(map, places) {
    if (!places.length) return [];
    const ids = places.map((place) => map.rowIds[place]);
    const found = ids.length === 1 ? [this.statements.body.get(ids[0])].filter(Boolean)
      : this.statements.bodies.all(JSON.stringify([...new Set(ids)]));
    const bodies = new Map(found.map((body) => [body.id, body]));
    return places.flatMap((place) => {
      const body = bodies.get(map.rowIds[place]);
      return body ? [parse(body, place, map)] : [];
    });
  }

  rows(tableId, from, to) {
    const map = this.mapOf(tableId);
    const start = lowerBound(map.ordinals, from);
    const end = Math.max(start, lowerBound(map.ordinals, to));
    return this.rowsAt(map, Array.from({ length: end - start }, (_, index) => start + index));
  }

  row(tableId, ordinal) {
    const map = this.mapOf(tableId);
    const place = placeOfOrdinal(map, ordinal);
    return place < 0 ? null : this.rowsAt(map, [place])[0] ?? null;
  }

  rowNumbered(tableId, rowNumber) {
    const map = this.mapOf(tableId);
    const place = placeOfRowNumber(map, rowNumber);
    return place < 0 ? null : this.rowsAt(map, [place])[0] ?? null;
  }

  /**
   * Up to `limit` rows stored under exactly this name term (see nameTerm),
   * with ordinals from `from` up to `to`, in table order: an index range,
   * never a pass over the table, unless the name is stored for so many rows
   * that reading the table's own rows is the bounded way to answer exactly.
   */
  rowsNamed(tableId, term, from, to = Number.MAX_SAFE_INTEGER, limit = 64) {
    if (!term) return [];
    const map = this.mapOf(tableId);
    if (map.termColumn == null) return [];
    const low = Math.max(from, map.dataStart);
    const named = this.statements.named.all(map.termColumn, term, MAX_NAMED_TERM_ROWS + 1);
    if (named.length > MAX_NAMED_TERM_ROWS) return this.rowsNamedByReading(map, term, low, to, limit);
    const places = named.flatMap(({ row_id: rowId }) => placesOf(map, rowId))
      .filter((place) => map.ordinals[place] >= low && map.ordinals[place] < to)
      .sort((left, right) => left - right).slice(0, limit);
    return this.rowsAt(map, places);
  }

  /** The same answer as rowsNamed, from the table's rows in order. */
  rowsNamedByReading(map, term, low, to, limit) {
    const found = [];
    const end = lowerBound(map.ordinals, to);
    for (let start = lowerBound(map.ordinals, low); start < end && found.length < limit; start += BATCH_ROWS) {
      const places = Array.from({ length: Math.min(BATCH_ROWS, end - start) }, (_, index) => start + index);
      for (const row of this.rowsAt(map, places)) {
        if (found.length < limit && rowTerms(row.cells[map.termColumn]).includes(term)) found.push(row);
      }
    }
    return found;
  }

  /** Up to `count` rows at or above a sheet row, nearest first. */
  rowsBefore(tableId, rowNumber, count) {
    const map = this.mapOf(tableId);
    return this.rowsAt(map, placesBefore(map, rowNumber, count));
  }

  /**
   * The rows whose name begins with what was typed, or has a word that does.
   * A range scan over the name terms, bounded by `limit` and by how many
   * stored names it reads; exact names sort first, as the shortest term with
   * that prefix, and rows under one term in table order.
   */
  search(tableId, typed, limit = 32) {
    const query = normalizedRowSearch(typed);
    if (query.length < 2) return [];
    const map = this.mapOf(tableId);
    if (map.termColumn == null) return [];
    const places = [];
    const seen = new Set();
    let group = [];
    const take = () => {
      for (const place of group.sort((left, right) => left - right)) {
        if (places.length >= limit) break;
        if (!seen.has(place)) { seen.add(place); places.push(place); }
      }
      group = [];
    };
    let term = null;
    for (const row of this.statements.search.iterate(map.termColumn, query, `${query}￿`, MAX_TERM_ROWS)) {
      if (row.term !== term) {
        take();
        if (places.length >= limit) break;
        term = row.term;
      }
      for (const place of placesOf(map, row.row_id)) if (map.ordinals[place] >= map.dataStart) group.push(place);
    }
    take();
    return this.rowsAt(map, places);
  }

  /**
   * Removes one bounded batch of what the index no longer needs (see
   * table-cleanup.js): tables of file contents `keep` does not keep, then
   * the chunks and rows nothing uses. Returns how many of each it removed;
   * all zero when nothing is left.
   */
  cleanup({ budget = CLEANUP_BATCH_ROWS, now = Date.now() } = {}) {
    const { dropped, ...removed } = cleanupBatch(this.db, { keep: this.keep, version: TABLE_INDEX_VERSION, now, budget });
    for (const table of dropped) {
      this.maps.delete(table.id);
      this.forget(table.content_hash);
    }
    return removed;
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
