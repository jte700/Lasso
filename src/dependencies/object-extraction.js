// Reading a file into source objects, and the objects an index records for it.

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { transaction } from '../db.js';
import { csvDelimiter, parseDelimited } from '../history/diff.js';
import { MAX_IN_MEMORY_PART_BYTES, extractSpreadsheetTables, isLargeSpreadsheet } from './document-extraction.js';
import { runSync } from '../history/work.js';
import { spreadsheetLayout, tabularLayout } from './tabular.js';
import { fileLines } from './code-lines.js';
import { isCodeType } from '../history/file-types.js';
import { CODE_LINES_KEY, EXTRACTOR_VERSION } from './constants.js';
import { codeLinesDescriptor, objectsFromFile } from './file-objects.js';
import { applyVariableDefinitions, worksheetCoordinates } from './index-state.js';
import { freezeIndexedValue, mapObjectRow, objectDescriptor } from './object-descriptors.js';
import { objectsFromTabular } from './tabular-objects.js';

export const objectExtractionMethods = {
  extractedObjects(file) {
    return runSync(this.extractedObjectSteps(file));
  },

  /** The same as steps: a table too large to hold is read off this thread. */
  *extractedObjectSteps(file) {
    const key = JSON.stringify([file.projectFileId, file.path, file.fileType, file.contentHash]);
    let extracted = this.extractionCache.get(key);
    if (!extracted) {
      let problem = null;
      const report = (code, reason) => { problem ??= { code, reason }; };
      const buffer = this.timeline.blobs.get(file.contentHash);
      const objects = ['table', 'spreadsheet'].includes(file.fileType)
        ? yield* this.tableObjectSteps(file, buffer, report)
        : objectsFromFile(file, buffer, report);
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
    if (isLargeSpreadsheet(buffer)) {
      const read = yield* this.tableBuildSteps(file, { kind: 'spreadsheet' });
      metas = this.tables.sheets(file.contentHash);
      readable = read.readable || metas.length > 0;
      skipped = metas[0]?.extras.skipped ?? read.skipped ?? [];
    } else {
      sheets = extractSpreadsheetTables(buffer);
      // A readable workbook lists the sheets it had to skip; a failed one does not.
      readable = Array.isArray(sheets.skipped);
      skipped = sheets.skipped ?? [];
    }
    const count = metas ? metas.length : sheets.length;
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
        for (const [position, sheet] of sheets.entries()) {
          const layout = spreadsheetLayout(sheet);
          const sheetObjects = objectsFromTabular(file, fileName, layout.headers, layout.rows, {
            format, sheet: sheet.name, ...layout, rowOffset: layout.headerRowIndex + 1,
          });
          objects.push(...sheetObjects);
          if (sheetObjects.deep) {
            this.indexTableRows(file.contentHash, { sheet: sheet.name, position, rows: sheet.rows,
              rowNumbers: sheet.rowNumbers, displayRows: sheet.displayRows, merges: sheet.merges });
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
  recordedDescriptors(file, read) {
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
    return new Promise((resolve) => {
      const worker = new Worker(new URL('./pdf-text-worker.js', import.meta.url), {
        workerData: { root: this.textStore.root, readerVersion: EXTRACTOR_VERSION, items },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      worker.on('message', (message) => {
        if (message.progress != null) report?.(message.progress);
        if (message.done) resolve(true);
      });
      worker.on('error', () => resolve(false));
      worker.on('exit', () => resolve(false));
    });
  },
};
