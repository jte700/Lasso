// Reading a file into source objects, and the objects an index records for it.

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { transaction } from '../db.js';
import { csvDelimiter, parseDelimited } from '../history/diff.js';
import { MAX_IN_MEMORY_PART_BYTES, MAX_WORKBOOK_SHEETS, extractSpreadsheetTables, isLargeSpreadsheet } from './document-extraction.js';
import { sheetSignatures } from './workbook-parts.js';
import { readerFor } from './readers.js';
import { runSync } from '../history/work.js';
import { BlobReleasedError } from '../history/errors.js';
import { spreadsheetLayout, tabularLayout } from './tabular.js';
import { fileLines } from './code-lines.js';
import { isCodeType } from '../history/file-types.js';
import { CODE_LINES_KEY, PDF_TEXT_VERSION } from './constants.js';
import { codeLinesDescriptor, objectsFromFile } from './file-objects.js';
import { applyVariableDefinitions, worksheetCoordinates } from './index-state.js';
import { freezeIndexedValue, mapObjectRow, objectDescriptor } from './object-descriptors.js';
import { objectsFromTabular } from './tabular-objects.js';
import { pooled } from '../worker-pool.js';

/** Where a sheet's objects are kept between readings of its file: by file, path and the sheet's part signature. */
const sheetCacheKey = (file, signature) => `${file.projectFileId}|${file.path}|${signature}`;

export const objectExtractionMethods = {
  /** Reads a workbook's sheets, or with `only` just those; a method so tests can see which were read. */
  readWorkbookSheets(buffer, only = null) {
    return extractSpreadsheetTables(buffer, only);
  },

  extractedObjects(file) {
    return runSync(this.extractedObjectSteps(file));
  },

  /**
   * The same as steps: a table too large to hold is read off this thread. A
   * file whose bytes were released reads as no objects and says so
   * (`bytesReleased`); an index that already recorded it keeps what it has.
   */
  *extractedObjectSteps(file) {
    const reader = readerFor(file);
    const key = JSON.stringify([file.projectFileId, file.path, file.fileType, file.contentHash, reader.id, reader.version]);
    let extracted = this.extractionCache.get(key);
    if (!extracted) {
      let problem = null;
      const report = (code, reason) => { problem ??= { code, reason }; };
      let objects;
      try {
        // Each kind of file is read by its reader (readers.js). A video is heard
        // from its file where it lies; its bytes are not read into memory.
        objects = reader.extract === 'video' ? yield* this.videoObjectSteps(file, report)
          : reader.extract === 'table'
            ? yield* this.tableObjectSteps(file, this.timeline.blobs.get(file.contentHash), report)
            : objectsFromFile(file, this.timeline.blobs.get(file.contentHash), report);
      } catch (error) {
        if (!(error instanceof BlobReleasedError)) throw error;
        // Not cached: the bytes come back if the file goes back to this content.
        return { objects: [], problem: { code: 'BYTES_RELEASED', reason: error.message }, bytesReleased: true, bytes: 0 };
      }
      extracted = { objects, problem, bytes: JSON.stringify(objects).length * 2 };
      this.extractionCache.set(key, extracted);
    }
    return extracted;
  },

  /**
   * A table file's objects. Its first rows are read as they always were. A
   * table with more rows or cells than those is also written to the table
   * index whole, which answers for the rest; one too large to read in memory
   * is read into the index by a worker, and its first rows come from there.
   */
  *tableObjectSteps(file, buffer, report) {
    const fileName = path.posix.basename(file.path, path.posix.extname(file.path));
    const format = path.extname(file.path).slice(1).toUpperCase();
    if (file.fileType === 'table') {
      const tsv = path.extname(file.path).toLowerCase() === '.tsv';
      if (buffer.length <= MAX_IN_MEMORY_PART_BYTES) {
        const rows = parseDelimited(buffer.toString('utf8').replace(/\r\n/g, '\n'), tsv ? '\t' : ',');
        const layout = tabularLayout(rows);
        const objects = objectsFromTabular(file, fileName, layout.headers, layout.rows, {
          format, rowOffset: layout.headerRowIndex + 1,
        });
        if (objects.deep) this.indexTableRows(file.contentHash, { rows, rowNumbers: rows.map((_, index) => index) });
        return objects;
      }
      const head = buffer.subarray(0, MAX_IN_MEMORY_PART_BYTES).toString('utf8').replace(/\r\n/g, '\n');
      const read = yield* this.tableBuildSteps(file, { kind: 'delimited', delimiter: tsv ? '\t' : csvDelimiter(head) });
      const meta = read.readable ? this.tables.table(file.contentHash, '') : null;
      if (!meta) {
        report('UNREADABLE_CONTENT', 'This table could not be read.');
        return [];
      }
      return this.indexedTableObjects(file, fileName, meta, { format });
    }
    const objects = [];
    const base = file.projectFileId;
    let sheets = null;
    let metas = null;
    let readable;
    let skipped;
    let signatures = null;
    const carried = new Map();
    if (isLargeSpreadsheet(buffer)) {
      const read = yield* this.tableBuildSteps(file, { kind: 'spreadsheet' });
      metas = this.tables.sheets(file.contentHash);
      readable = read.readable || metas.length > 0;
      skipped = metas[0]?.extras.skipped ?? read.skipped ?? [];
    } else {
      // Sheets whose parts did not change since the file's last reading keep
      // the objects they were read as; only the others are read again.
      signatures = sheetSignatures(buffer)?.slice(0, MAX_WORKBOOK_SHEETS) ?? null;
      for (const sheet of signatures ?? []) {
        const known = this.sheetObjectCache.get(sheetCacheKey(file, sheet.signature));
        if (known) carried.set(sheet.name, known);
      }
      const only = carried.size ? new Set(signatures.filter((sheet) => !carried.has(sheet.name)).map((sheet) => sheet.name)) : null;
      sheets = this.readWorkbookSheets(buffer, only);
      // A readable workbook lists the sheets it had to skip; a failed one does not.
      readable = Array.isArray(sheets.skipped) || carried.size > 0;
      skipped = sheets.skipped ?? [];
    }
    const count = metas ? metas.length : sheets.length + carried.size;
    if (skipped.length) {
      report('PARTIALLY_INDEXED', `${skipped.length === 1 ? 'Sheet' : 'Sheets'} ${skipped.map((name) => `“${name}”`).join(', ')} could not be read (damaged). The other sheets are indexed.`);
    }
    if (!count && format === 'ODS') {
      report('UNREADABLE_CONTENT', 'OpenDocument spreadsheets are not indexed yet. Save a copy as .xlsx or .csv to use its values.');
    } else if (!count && (!readable || skipped.length)) {
      report('UNREADABLE_CONTENT', 'This workbook could not be read. It may be password-protected or damaged.');
    }
    if (count) {
      if (metas) {
        for (const meta of metas) objects.push(...this.indexedTableObjects(file, fileName, meta, { format, sheet: meta.sheet }));
      } else {
        // Sheets in workbook order, each read now or carried from the last reading.
        const parsed = new Map(sheets.map((sheet) => [sheet.name, sheet]));
        const ordered = signatures ? signatures.flatMap((sheet) => carried.has(sheet.name) || parsed.has(sheet.name)
          ? [{ name: sheet.name, signature: sheet.signature }] : []) : sheets.map((sheet) => ({ name: sheet.name }));
        for (const [position, { name, signature }] of ordered.entries()) {
          if (carried.has(name)) {
            objects.push(...carried.get(name).map((object) => ({ ...object, contentHash: file.contentHash })));
            continue;
          }
          const sheet = parsed.get(name);
          const layout = spreadsheetLayout(sheet);
          const sheetObjects = objectsFromTabular(file, fileName, layout.headers, layout.rows, {
            format, sheet: sheet.name, ...layout, rowOffset: layout.headerRowIndex + 1, formulaCells: sheet.formulas,
          });
          objects.push(...sheetObjects);
          // A sheet the table index answers for is read again with its file, so its index stays whole.
          if (signature && !sheetObjects.deep) this.sheetObjectCache.set(sheetCacheKey(file, signature), sheetObjects);
          if (sheetObjects.deep) {
            this.indexTableRows(file.contentHash, { sheet: sheet.name, position, rows: sheet.rows,
              rowNumbers: sheet.rowNumbers, displayRows: sheet.displayRows, merges: sheet.merges, formulas: sheet.formulas });
          }
        }
      }
      for (const object of objects) worksheetCoordinates(object);
    } else {
      objects.push(objectDescriptor({
        key: `${base}:spreadsheet`, type: 'TABLE', path: file.path, label: fileName,
        contentHash: file.contentHash, metadata: { format, binary: true },
      }));
      objects.push(objectDescriptor({
        key: `${base}:spreadsheet-dataset`, type: 'DATASET', path: file.path, label: fileName,
        contentHash: file.contentHash, metadata: { format, binary: true },
      }));
    }
    return objects;
  },

  /** What each reading of a file records again besides what its reader finds: table rows and code lines offered before. */
  recordedDescriptors(file, read, { bytesReleased = false } = {}) {
    // Without the bytes nothing can be read again; what was recorded stays recorded.
    if (bytesReleased) return [];
    return [...this.recordedTableDescriptors(file, read), ...this.recordedLineDescriptors(file, read)];
  },

  /**
   * The code lines this folder has offered from a file, read again from this
   * version of it, so a link to "line 42" keeps following line 42.
   */
  recordedLineDescriptors(file, read) {
    if (!isCodeType(file.fileType)) return [];
    const prefix = `${file.projectFileId}:${CODE_LINES_KEY}`;
    const keys = this.db.prepare('SELECT object_key FROM table_objects WHERE key_prefix = ?').all(prefix)
      .map((row) => row.object_key);
    if (!keys.length) return [];
    const readKeys = new Set(read.map((descriptor) => descriptor.key));
    const lines = fileLines(this.timeline.blobs.get(file.contentHash)?.toString('utf8') ?? '');
    return keys.flatMap((key) => {
      if (readKeys.has(key)) return [];
      const [first, last] = key.slice(prefix.length + 1).split('-').map(Number);
      return codeLinesDescriptor(file, lines, first, last) ?? [];
    });
  },

  /** A snapshot's data dictionary definitions, as the indexer applies them to every variable it reads. */
  dictionaryDefinitions(projectId, snapshotId) {
    return this.objectsAt(projectId, snapshotId, ['VARIABLE']).filter((object) => object.metadata.dictionary)
      .map((object) => ({ type: 'VARIABLE', path: object.path, label: object.label, value: object.valueText, metadata: object.metadata }));
  },

  /**
   * Records rows and cells of a large table as objects of a snapshot, the
   * first time they are offered, and returns them as offered objects. They
   * are the objects a reading of the whole table would have recorded, and
   * each later reading of the file records them again (table_objects).
   */
  indexedObjects(projectId, snapshotId, table, descriptors) {
    const found = new Map();
    const missing = [];
    for (const descriptor of descriptors) {
      const cached = this.deepObjects.get(`${snapshotId}|${descriptor.key}`);
      if (cached) found.set(descriptor.key, cached);
      else if (!missing.some((other) => other.key === descriptor.key)) missing.push({ ...descriptor, metadata: { ...descriptor.metadata } });
    }
    if (missing.length) {
      applyVariableDefinitions(missing, this.dictionaryDefinitions(projectId, snapshotId));
      const versions = this.timeline.objectVersions;
      let entries = [];
      transaction(this.db, () => {
        entries = this.indexEntries(projectId, missing);
        const added = versions.addAt(snapshotId, entries);
        if (added.length) {
          this.db.prepare('UPDATE snapshot_object_indexes SET object_count = object_count + ? WHERE snapshot_id = ?')
            .run(added.length, snapshotId);
        }
        const record = this.db.prepare('INSERT OR IGNORE INTO table_objects(key_prefix, object_key) VALUES (?, ?)');
        for (const descriptor of missing) record.run(table.keyPrefix, descriptor.key);
      });
      for (const { object, descriptor } of entries) {
        const row = versions.at(snapshotId, object.id);
        if (!row) continue;
        const mapped = freezeIndexedValue(mapObjectRow(row));
        this.deepObjects.set(`${snapshotId}|${descriptor.key}`, mapped);
        found.set(descriptor.key, mapped);
      }
      // The ranker offers only objects it knows the snapshot holds.
      this.ranking.noteObjects(snapshotId, [...found.values()]);
    }
    return descriptors.map((descriptor) => found.get(descriptor.key)).filter(Boolean);
  },

  /** Has a worker read PDFs' text into the text store. Resolves once it has, or has failed. */
  readPdfTexts(items, report) {
    return pooled(({ signal, heard }) => new Promise((resolve) => {
      const worker = new Worker(new URL('./pdf-text-worker.js', import.meta.url), {
        workerData: { root: this.textStore.root, readerVersion: PDF_TEXT_VERSION, items },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      // A worker silent too long is stopped; the server reads those PDFs itself when asked.
      signal.addEventListener('abort', () => { void worker.terminate(); resolve(false); }, { once: true });
      worker.on('message', (message) => {
        heard();
        if (message.progress != null) report?.(message.progress);
        if (message.done) resolve(true);
      });
      worker.on('error', () => resolve(false));
      worker.on('exit', () => resolve(false));
    })).catch(() => false);
  },
};
