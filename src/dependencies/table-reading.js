// Large tables: reading them whole into the table index, and the rows and
// windows answered from it.

import path from 'node:path';
import { MAX_IN_MEMORY_PART_BYTES, isLargeSpreadsheet } from './document-extraction.js';
import { TAIL_ROWS, nameTerm, writeTable } from './table-index.js';
import { normalizedVariable, spreadsheetLayout, tabularLayout } from './tabular.js';
import { MAX_INDEXED_TABLE_ROWS } from './constants.js';
import { worksheetCoordinates } from './index-state.js';
import { labelIdentity, withOccurrence } from './row-identity.js';
import { objectsFromTabular, tableRowObjects, trailingTableNotes } from './tabular-objects.js';

// The last rows of a large table read for the notes written under it.
const TABLE_TAIL_ROWS = TAIL_ROWS;
// The most rows sharing a row's name term read to tell which of the equally
// named rows it is. Past it the row is left out rather than misnamed.
const MAX_NAME_MATCHES = 4_096;

// A recorded row or cell key after its table's prefix: "row:rent#2", "cell:rent#2:Q1".
const LABEL_KEY = /^(?:row:([^:]+)$|cell:([^:]+):)/s;
// The same, as readers before version 9 keyed it by row number: "row:12:rent", "cell:12:rent:Q1".
const ROW_NUMBER_KEY = /^(?:row|cell):(\d+):[a-z0-9]+(?::|$)/;

/** The key a reader before version 9 gave a large table's row or cell: its row number and label. */
function rowNumberKey(keyPrefix, descriptor) {
  const { rowIndex, rowKey } = descriptor.anchor;
  const row = `${rowIndex}:${normalizedVariable(rowKey) || 'row'}`;
  if (descriptor.type === 'DATASET_ROW') return `${keyPrefix}:row:${row}`;
  const column = descriptor.key.slice(keyPrefix.length + 1).replace(/^cell:[^:]+:/, '');
  return `${keyPrefix}:cell:${row}:${column}`;
}

export const tableReadingMethods = {
  /**
   * The tables of a file the table index answers for: plain tables whose rows
   * are named, with what their objects' keys and labels are made from.
   */
  indexedTables(file) {
    if (!['table', 'spreadsheet'].includes(file.fileType)) return [];
    const fileName = path.posix.basename(file.path, path.posix.extname(file.path));
    return this.tables.sheets(file.contentHash).filter((meta) => meta.shape?.searchable).map((meta) => {
      const sheet = file.fileType === 'spreadsheet' ? meta.sheet : null;
      const keyPrefix = sheet ? `${file.projectFileId}:xlsx-v2:sheet:${sheet}` : file.projectFileId;
      return { file, meta, sheet, keyPrefix,
        context: { file, fileName, keyPrefix, sheet, headers: meta.shape.headers, labelColumn: meta.shape.labelColumn,
          firstColumnActsAsRowLabels: meta.shape.firstColumnActsAsRowLabels,
          rowDescribesVariable: meta.shape.rowDescribesVariable, statement: false } };
    });
  },

  /** Every indexed table of a snapshot's files. */
  snapshotTables(projectId, snapshotId) {
    if (this.snapshotTableCache.has(snapshotId)) return this.snapshotTableCache.get(snapshotId);
    const tables = this.timeline.snapshotFiles(snapshotId)
      .filter((file) => ['table', 'spreadsheet'].includes(file.fileType))
      .flatMap((file) => this.indexedTables(file));
    this.snapshotTableCache.set(snapshotId, tables);
    return tables;
  },

  /**
   * A stored row's objects, the ones the indexer would have made had it read
   * that far. The lines of notes under a table are not rows of it.
   */
  indexedRowObjects(table, row) {
    const { meta, context, sheet } = table;
    const rowIndex = row.ordinal - meta.shape.dataStart;
    if (rowIndex < 0) return [];
    table.notes ??= new Set([...trailingTableNotes(this.tables.rows(meta.id, Math.max(0, meta.rowCount - TABLE_TAIL_ROWS), meta.rowCount)
      .map((stored) => ({ row: stored.cells, number: stored.rowNumber, ordinal: stored.ordinal })))
      .keys()].map((index) => Math.max(0, meta.rowCount - TABLE_TAIL_ROWS) + index));
    if (table.notes.has(row.ordinal)) return [];
    const rowLabel = String(row.cells[meta.shape.labelColumn] ?? '').trim();
    // A row without a name is known through the file's previous version,
    // which only the indexer reads; such rows are never looked up by name.
    if (!rowLabel) return [];
    const occurrence = this.rowOccurrence(table, row, rowLabel);
    if (occurrence == null) return [];
    const formulaCells = row.formulas?.length ? new Map([[row.rowNumber, new Set(row.formulas)]]) : null;
    const { rowObject, cells } = tableRowObjects({ ...context, formulaCells }, { row: row.cells, rowIndex, rowNumber: row.rowNumber,
      rowLabel, identity: withOccurrence(labelIdentity(rowLabel), occurrence) });
    const objects = rowObject ? [rowObject, ...cells] : cells;
    return sheet != null ? objects.map(worksheetCoordinates) : objects;
  },

  /**
   * Which of the table's equally named rows a stored row is, counted from its
   * first row as the indexer counts them: 1 for the first, 2 for the second.
   * The rows before it come from the table index under its name. A name it
   * stores no term for is counted among the rows the indexer reads itself,
   * which are the only ones such a row can be reached from; past those, or
   * when too many rows share the name's term, null.
   */
  rowOccurrence(table, row, label) {
    const { meta } = table;
    const { dataStart, labelColumn } = meta.shape;
    const base = labelIdentity(label);
    const sameName = (other) => labelIdentity(String(other.cells[labelColumn] ?? '').trim()) === base;
    const term = nameTerm(label);
    if (term) {
      const earlier = this.tables.rowsNamed(meta.id, term, dataStart, row.ordinal, MAX_NAME_MATCHES + 1);
      return earlier.length > MAX_NAME_MATCHES ? null : earlier.filter(sameName).length + 1;
    }
    if (row.ordinal >= dataStart + MAX_INDEXED_TABLE_ROWS) return null;
    return this.tables.rows(meta.id, dataStart, row.ordinal).filter(sameName).length + 1;
  },

  /** The stored row a recorded identity ("rent#2") names: the second row named "Rent", or null. */
  namedRow(table, identity) {
    const at = identity.lastIndexOf('#');
    const base = at < 0 ? identity : identity.slice(0, at);
    const occurrence = at < 0 ? 1 : Number(identity.slice(at + 1));
    // Only a name the table index stores a term for can have been offered from it.
    const term = /^[a-z0-9]+$/.test(base) ? nameTerm(base) : '';
    if (!term || !Number.isInteger(occurrence) || occurrence < 1) return null;
    const { meta } = table;
    const { dataStart, labelColumn } = meta.shape;
    let seen = 0;
    for (const row of this.tables.rowsNamed(meta.id, term, dataStart, undefined, MAX_NAME_MATCHES)) {
      if (labelIdentity(String(row.cells[labelColumn] ?? '').trim()) !== base) continue;
      seen += 1;
      if (seen === occurrence) return row;
    }
    return null;
  },

  /**
   * The keys of a table's objects that a reading must record again when its
   * reader does not reach them: the rows offered from the table index, and
   * any row or cell a claim is linked to. A linked cell among the rows the
   * indexer reads itself is pushed past them by rows inserted above it; its
   * key still names its row, so it is found again by that name.
   */
  recordedTableKeys(keyPrefix) {
    const offered = this.db.prepare('SELECT object_key FROM table_objects WHERE key_prefix = ?').all(keyPrefix);
    // The links are few, so they are read first and their objects looked up by id.
    const linked = this.db.prepare(`
      SELECT DISTINCT o.object_key FROM claim_dependency_versions v CROSS JOIN scientific_objects o ON o.id = v.source_object_id
      WHERE substr(o.object_key, 1, length(?)) = ?
    `).all(`${keyPrefix}:`, `${keyPrefix}:`);
    return new Set([...offered, ...linked].map((row) => row.object_key));
  },

  /**
   * The rows and cells of large tables this folder has recorded or linked,
   * read again from this version of their file, so a link to one survives
   * the file being read again. `read` are the objects the indexer read
   * itself. Recorded keys name a row by its label and occurrence; one
   * recorded by a reader before version 9 names it by row number, and is
   * read again under its new key, which is recorded too so later readings
   * follow the row.
   */
  recordedTableDescriptors(file, read) {
    const tables = this.indexedTables(file);
    if (!tables.length) return [];
    const readKeys = new Set(read.map((descriptor) => descriptor.key));
    const remember = this.db.prepare('INSERT OR IGNORE INTO table_objects(key_prefix, object_key) VALUES (?, ?)');
    const output = [];
    const group = (groups, name, key) => groups.set(name, (groups.get(name) ?? new Set()).add(key));
    for (const table of tables) {
      const byName = new Map();
      const byNumber = new Map();
      for (const key of this.recordedTableKeys(table.keyPrefix)) {
        if (readKeys.has(key)) continue;
        const rest = key.slice(table.keyPrefix.length + 1);
        // A key can read both ways; each reading below keeps only exact keys.
        const named = LABEL_KEY.exec(rest);
        if (named) group(byName, named[1] ?? named[2], key);
        const numbered = ROW_NUMBER_KEY.exec(rest);
        if (numbered) group(byNumber, Number(numbered[1]), key);
      }
      const found = new Set();
      for (const [identity, keys] of byName) {
        const row = this.namedRow(table, identity);
        if (!row) continue;
        for (const descriptor of this.indexedRowObjects(table, row)) {
          if (keys.has(descriptor.key) && !found.has(descriptor.key)) { found.add(descriptor.key); output.push(descriptor); }
        }
      }
      for (const [rowNumber, keys] of byNumber) {
        const row = this.tables.rowNumbered(table.meta.id, rowNumber);
        if (!row) continue;
        for (const descriptor of this.indexedRowObjects(table, row)) {
          if (!keys.has(rowNumberKey(table.keyPrefix, descriptor)) || readKeys.has(descriptor.key)) continue;
          remember.run(table.keyPrefix, descriptor.key);
          if (!found.has(descriptor.key)) { found.add(descriptor.key); output.push(descriptor); }
        }
      }
    }
    return output;
  },

  /** Whether a table file is too large to read whole for a preview, so its rows come from the table index. */
  isLargeTable(file, buffer) {
    if (file.fileType === 'table') return file.size > MAX_IN_MEMORY_PART_BYTES;
    return file.fileType === 'spreadsheet' && isLargeSpreadsheet(buffer);
  },

  /**
   * A large table's header rows and the rows around a cited one, from the
   * table index, for a preview; null for a table read whole as before. A
   * delimited file's rows read as worksheet rows here, numbered from 1, so a
   * preview finds the cited row among them as it would on a worksheet.
   */
  tableWindow(file, buffer, anchor = {}, { before = 2, after = 2, sheet = null } = {}) {
    if (!this.isLargeTable(file, buffer)) return null;
    const metas = this.tables.sheets(file.contentHash);
    const wanted = sheet ?? anchor.sheet ?? null;
    const meta = metas.find((candidate) => wanted == null || candidate.sheet === wanted) ?? metas[0];
    if (!meta) return null;
    const delimited = file.fileType === 'table';
    const { dataStart } = meta.shape;
    const target = Number.isInteger(anchor.rowIndex) ? this.tables.rowNumbered(meta.id, anchor.rowIndex) : null;
    const center = Math.max(dataStart, target?.ordinal ?? dataStart);
    const from = Math.max(dataStart, center - before);
    const rows = [...this.tables.rows(meta.id, 0, dataStart), ...this.tables.rows(meta.id, from, center + after + 1)];
    return {
      table: { name: delimited ? null : meta.sheet, rows: rows.map((row) => row.cells),
        rowNumbers: rows.map((row) => (delimited ? row.rowNumber + 1 : row.rowNumber)),
        displayRows: rows.map((row) => row.display ?? []), merges: meta.extras.merges ?? [], tables: [] },
      anchor: delimited && Number.isInteger(anchor.rowIndex) ? { ...anchor, rowIndex: anchor.rowIndex + 1, rowCoordinate: 'worksheet' } : anchor,
      sheets: metas.map((candidate) => candidate.sheet),
      headerRows: dataStart,
      firstRow: from - dataStart,
      totalRows: meta.rowCount - dataStart,
    };
  },

  /** Writes a table read in memory to the table index, once per file content. */
  indexTableRows(contentHash, table) {
    if (this.tables.table(contentHash, table.sheet ?? '')) return;
    writeTable(this.tables.db, contentHash, table);
    this.tables.forget(contentHash);
  },

  /**
   * Has a worker read a large table file into the index, unless it already is.
   * A caller in slices waits for it without holding the thread; one that must
   * have the answer now waits for it here. Either way the reading is the same.
   */
  *tableBuildSteps(file, request) {
    if (this.tables.has(file.contentHash)) return { readable: true };
    const known = this.tableReadings.get(file.contentHash);
    if (known) return known;
    const job = { ...request, contentHash: file.contentHash, blobPath: this.timeline.blobs.rawPath(file.contentHash) };
    let read = yield { share: 0, offThread: (report) => this.buildTable(job, report) };
    if (!read) {
      try { read = this.tables.buildBlocking(job); }
      catch (error) { read = { readable: false, error: error.message, skipped: [] }; }
    }
    this.tableReadings.set(file.contentHash, read);
    return read;
  },

  /** One worker per file content; a second request waits for the first. */
  buildTable(job, report) {
    let pending = this.tableBuilds.get(job.contentHash);
    if (!pending) {
      pending = this.tables.build(job, report)
        .catch((error) => ({ readable: false, error: error.message, skipped: [] }))
        .finally(() => this.tableBuilds.delete(job.contentHash));
      this.tableBuilds.set(job.contentHash, pending);
    }
    return pending;
  },

  /**
   * A table's objects read from the table index: all its rows when there are
   * few, as the in-memory reader would read them, otherwise its first rows,
   * how many it has, and its last rows for the notes under it.
   */
  indexedTableObjects(file, fileName, meta, { format, sheet = null }) {
    const { dataStart } = meta.shape;
    const limit = dataStart + MAX_INDEXED_TABLE_ROWS;
    const whole = meta.rowCount <= limit + TABLE_TAIL_ROWS;
    const stored = this.tables.rows(meta.id, 0, whole ? meta.rowCount : limit);
    const window = whole ? null : {
      filledRows: meta.rowCount - dataStart,
      tail: this.tables.rows(meta.id, meta.rowCount - TABLE_TAIL_ROWS, meta.rowCount)
        .map((row) => ({ row: row.cells, number: row.rowNumber })),
    };
    if (sheet != null) {
      const layout = spreadsheetLayout({ name: sheet, rows: stored.map((row) => row.cells), rowNumbers: stored.map((row) => row.rowNumber) });
      const formulaCells = new Map(stored.filter((row) => row.formulas?.length).map((row) => [row.rowNumber, new Set(row.formulas)]));
      return objectsFromTabular(file, fileName, layout.headers, layout.rows, {
        format, sheet, ...layout, rowOffset: layout.headerRowIndex + 1, formulaCells, ...(window ? { window } : {}),
      });
    }
    // A delimited file's blank lines are not stored; its rows keep their places.
    const rows = [];
    for (const row of stored) {
      while (rows.length < row.rowNumber) rows.push(['']);
      rows.push(row.cells);
    }
    const layout = tabularLayout(rows);
    return objectsFromTabular(file, fileName, layout.headers, layout.rows, {
      format, rowOffset: layout.headerRowIndex + 1, ...(window ? { window } : {}),
    });
  },
};
