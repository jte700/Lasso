// Large tables: reading them whole into the table index, and the rows and
// windows answered from it.

import path from 'node:path';
import { MAX_IN_MEMORY_PART_BYTES, isLargeSpreadsheet } from './document-extraction.js';
import { TAIL_ROWS, writeTable } from './table-index.js';
import { spreadsheetLayout, tabularLayout } from './tabular.js';
import { MAX_INDEXED_TABLE_ROWS } from './constants.js';
import { worksheetCoordinates } from './index-state.js';
import { objectsFromTabular, tableRowObjects, trailingTableNotes } from './tabular-objects.js';

// The last rows of a large table read for the notes written under it.
const TABLE_TAIL_ROWS = TAIL_ROWS;

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
    const { rowObject, cells } = tableRowObjects(context, { row: row.cells, rowIndex, rowNumber: row.rowNumber, rowLabel });
    const objects = rowObject ? [rowObject, ...cells] : cells;
    return sheet != null ? objects.map(worksheetCoordinates) : objects;
  },

  /**
   * The rows and cells of large tables this folder has recorded, read again
   * from this version of their file, so a link to one survives the file
   * being read again. `read` are the objects the indexer read itself.
   */
  recordedTableDescriptors(file, read) {
    const tables = this.indexedTables(file);
    if (!tables.length) return [];
    const readKeys = new Set(read.map((descriptor) => descriptor.key));
    const recorded = this.db.prepare('SELECT object_key FROM table_objects WHERE key_prefix = ?');
    const output = [];
    for (const table of tables) {
      const byRow = new Map();
      for (const { object_key: key } of recorded.all(table.keyPrefix)) {
        if (readKeys.has(key)) continue;
        // Keys name their row by its sheet or file row number: "row:12:ontario".
        const rowNumber = Number(key.slice(table.keyPrefix.length + 1).match(/^(?:row|cell):(\d+):/)?.[1]);
        if (!Number.isInteger(rowNumber)) continue;
        if (!byRow.has(rowNumber)) byRow.set(rowNumber, new Set());
        byRow.get(rowNumber).add(key);
      }
      for (const [rowNumber, keys] of byRow) {
        const row = this.tables.rowNumbered(table.meta.id, rowNumber);
        if (!row) continue;
        output.push(...this.indexedRowObjects(table, row).filter((descriptor) => keys.has(descriptor.key)));
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
    const job = { ...request, contentHash: file.contentHash, blobPath: this.timeline.blobs.pathFor(file.contentHash) };
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
      return objectsFromTabular(file, fileName, layout.headers, layout.rows, {
        format, sheet, ...layout, rowOffset: layout.headerRowIndex + 1, ...(window ? { window } : {}),
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
