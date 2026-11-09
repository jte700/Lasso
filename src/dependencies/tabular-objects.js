// The objects a table or worksheet yields: its variables, rows, cells and notes.

import { columnLetter } from './table-preview.js';
import { dictionaryColumns, humanVariable, normalizedVariable, tableShape } from './tabular.js';
import { MAX_INDEXED_TABLE_ROWS } from './constants.js';
import { objectDescriptor } from './object-descriptors.js';
import { numericDescriptor } from './value-match.js';

const MAX_TABLE_CELLS = 1_500;

function variableProfile(column, values) {
  const present = values.map((value) => String(value ?? '').trim()).filter(Boolean);
  const numeric = present.map((value) => Number(value.replaceAll(',', ''))).filter(Number.isFinite);
  const numericShare = present.length ? numeric.length / present.length : 0;
  const samples = [...new Set(present)].slice(0, 6);
  const dataType = numericShare >= 0.8 ? 'numeric' : new Set(present.map((value) => value.toLowerCase())).size <= 12 ? 'categorical' : 'text';
  const range = dataType === 'numeric' && numeric.length
    ? { min: Math.min(...numeric), max: Math.max(...numeric) } : null;
  const inferredMeaning = `${humanVariable(column)}; inferred ${dataType} variable${range ? `; observed range ${range.min} to ${range.max}` : ''}${samples.length ? `; examples ${samples.join(', ')}` : ''}`;
  return { dataType, range, samples, inferredMeaning };
}

const filledColumns = (row) => [...row.keys()].filter((column) => String(row[column] ?? '').trim());
// A sentence, or a line that introduces one ("Source: ...", "Blue values = inputs").
// Labels such as "Rent" or "Cost of goods sold" read as neither.
const readsAsProse = (text) => /[.!?]["')\]]?$|:\s|\s=\s/.test(text);

/**
 * Notes written under a table ("Source: Budget-vs-Actual.csv", "Blue values =
 * inputs") follow its last row of figures after at least one blank row, one
 * line of text per row, and at least one of those lines is prose. They
 * describe the table rather than belong to it. Returns them by their index in
 * `filled`, or none when anything after that blank row is not such a line.
 * Rows directly under the table, section headings that rows of figures still
 * follow ("Expenses" after a blank row), and line items whose figures are not
 * filled in yet are never notes, so they stay rows of the table.
 *
 * @param {{ row: unknown[], number: number }[]} filled the table's non-blank
 *   rows with the sheet row each came from, so blank rows show as gaps
 */
export function trailingTableNotes(filled) {
  const lastTableRow = filled.findLastIndex(({ row }) => filledColumns(row).length > 1);
  if (lastTableRow < 0) return new Map();
  const first = filled.findIndex((entry, index) => index > lastTableRow && entry.number - filled[index - 1].number > 1);
  if (first < 0) return new Map();
  const notes = new Map();
  for (const [index, { row }] of filled.entries()) {
    if (index < first) continue;
    const columns = filledColumns(row);
    const text = String(row[columns[0]] ?? '').trim();
    if (columns.length !== 1 || !/\p{L}/u.test(text)) return new Map();
    notes.set(index, { column: columns[0], text });
  }
  return [...notes.values()].some((note) => readsAsProse(note.text)) ? notes : new Map();
}

export function objectsFromTabular(file, fileName, headers, rawRows, options = {}) {
  const objects = [];
  const sheet = options.sheet ?? null;
  const keyPrefix = sheet ? `${file.projectFileId}:xlsx-v2:sheet:${sheet}` : file.projectFileId;
  const labelPrefix = sheet ? `${fileName} · ${sheet}` : fileName;
  const rowOffset = options.rowOffset ?? 1;
  // A worksheet's rows leave its blank rows out, and `rowNumbers` says which
  // sheet row each one is; a delimited file keeps its blank lines as rows.
  const filled = rawRows.flatMap((row, index) => row.some((cell) => String(cell ?? '').trim())
    ? [{ row, index, number: options.rowNumbers?.[index] ?? rowOffset + index + 1 }] : []);
  // A table read from the table index arrives as its first rows (`window`),
  // with how many rows it has and its last few, where notes sit. Its notes
  // are past the rows read here, so they only change the count.
  const notes = options.window ? new Map() : trailingTableNotes(filled);
  // Only the first rows are indexed, but the row count reports the table as
  // it is: inserting "n = 1000" for a larger table would state a false fact.
  const filledRows = filled.map((entry) => entry.row);
  const data = filled.slice(0, MAX_INDEXED_TABLE_ROWS).map((entry) => entry.row);
  const bodyRows = data.filter((_, rowIndex) => !notes.has(rowIndex));
  const rowCount = options.window ? options.window.filledRows - trailingTableNotes(options.window.tail).size
    : filledRows.length - notes.size;
  // Anchors name a worksheet row by its sheet row number, and a delimited
  // file's row by its index among the file's rows, as previews look them up.
  const rowNumber = (rowIndex) => options.rowNumbers?.[filled[rowIndex].index] ?? rowOffset + filled[rowIndex].index;
  const rowLabelFor = row => options.labelColumns
    ? options.labelColumns.map(index => String(row[index] ?? '').trim()).filter(value => /[A-Za-z]/.test(value)).at(-1) ?? ''
    : String(row[0] ?? '').trim();
  objects.push(objectDescriptor({
    key: `${keyPrefix}:dataset`, type: 'DATASET', path: file.path, label: labelPrefix,
    contentHash: file.contentHash, metadata: { format: options.format, sheet },
  }));
  objects.push(objectDescriptor({
    key: `${keyPrefix}:row-count`, type: 'RESULT', path: file.path,
    anchor: { kind: 'table-summary', metric: 'row-count', sheet },
    label: `${labelPrefix} · included rows`, value: `n = ${rowCount}`,
    contentHash: file.contentHash, metadata: { dataset: fileName, sheet, metric: 'row-count', rows: rowCount,
      indexedRows: bodyRows.length },
  }));

  const dictionary = dictionaryColumns(file.path, headers);
  if (dictionary.dictionary && dictionary.variableIndex >= 0 && dictionary.descriptionIndex >= 0) {
    for (const [rowIndex, row] of data.entries()) {
      const variable = String(row[dictionary.variableIndex] ?? '').trim();
      const description = String(row[dictionary.descriptionIndex] ?? '').trim();
      if (!variable || !description || notes.has(rowIndex)) continue;
      const units = dictionary.unitIndex >= 0 ? String(row[dictionary.unitIndex] ?? '').trim() : '';
      objects.push(objectDescriptor({
        key: `${keyPrefix}:variable-definition:${normalizedVariable(variable)}`,
        type: 'VARIABLE', path: file.path,
        anchor: { kind: 'table-cell', rowIndex: rowNumber(rowIndex), rowKey: variable, columnIndex: dictionary.descriptionIndex, column: headers[dictionary.descriptionIndex], sheet },
        label: variable, value: description, contentHash: file.contentHash,
        metadata: { variable, description, units: units || null, dictionary: true, dataset: fileName, sheet },
      }));
    }
  } else if (!options.statement) {
    headers.slice(0, 80).forEach((column, columnIndex) => {
      if (!String(column ?? '').trim()) return;
      const profile = variableProfile(column, bodyRows.map((row) => row[columnIndex]));
      objects.push(objectDescriptor({
        key: `${keyPrefix}:variable:${columnIndex}:${normalizedVariable(column)}`,
        type: 'VARIABLE', path: file.path,
        anchor: { kind: 'table-column', column, columnIndex, sheet },
        label: String(column), value: profile.inferredMeaning, contentHash: file.contentHash,
        metadata: { variable: String(column), column: String(column), dictionary: false, dataset: fileName, sheet, ...profile },
      }));
    });
  }

  const shape = tableShape(headers, data, options);
  const { labelColumn, firstColumnActsAsRowLabels } = shape;
  const rowContext = { file, fileName, keyPrefix, sheet, headers, ...shape, statement: options.statement };
  let indexedCells = 0;
  let section = '';
  // Whether rows or cells were left for the table index to answer.
  let truncated = data.length < filled.length - notes.size || Boolean(options.window);
  tableRows: for (const [rowIndex, row] of data.entries()) {
    if (notes.has(rowIndex)) continue;
    const rowLabel = options.statement ? rowLabelFor(row) : String(row[labelColumn] ?? '').trim();
    if (options.statement && !rowLabel) continue;
    const sectionRow = Boolean(options.statement) && options.labelColumns.includes(row.findIndex(cell => /[A-Za-z]/.test(String(cell ?? ''))))
      && !String(row[options.labelColumns.at(-1)] ?? '').trim()
      && (row === rawRows[0] || !headers.some((header, index) => header && numericDescriptor(row[index])));
    if (sectionRow) section = rowLabel;
    const { rowObject, cells } = tableRowObjects(rowContext, { row, rowIndex, rowNumber: rowNumber(rowIndex), rowLabel, section, sectionRow });
    if (rowObject) objects.push(rowObject);
    for (const cell of cells) {
      objects.push(cell);
      indexedCells += 1;
      if (indexedCells >= MAX_TABLE_CELLS) {
        truncated = true;
        break tableRows;
      }
    }
  }
  // A note is read as a passage of text at its own cell, so it is found by its
  // words without claiming the table's headings or passing for one of its rows.
  for (const [rowIndex, note] of notes) {
    if (rowIndex >= data.length) break;
    const cellId = `${columnLetter(note.column)}${filled[rowIndex].number}`;
    // Its row index is the one its row would have, so previews find it the same way.
    const noteRow = rowNumber(rowIndex);
    objects.push(objectDescriptor({
      key: `${keyPrefix}:note:${noteRow}:${note.column}`, type: 'DOCUMENT',
      path: file.path, contentHash: file.contentHash,
      label: note.text.length > 110 ? `${note.text.slice(0, 107)}…` : note.text,
      value: note.text,
      anchor: { kind: 'sheet-note', sheet, cellId, rowIndex: noteRow, columnIndex: note.column,
        selectedText: note.text },
      metadata: { format: options.format, componentType: 'TEXT_EXCERPT', excerptType: 'note',
        rawText: note.text, textExcerpt: note.text, sheet, cell: cellId,
        parentTitle: labelPrefix, parentAuthor: null, parentYear: null },
    }));
  }
  // The table index answers for the rest of a plain table whose rows are named.
  const searchable = !options.statement && !dictionary.dictionary && firstColumnActsAsRowLabels;
  return Object.defineProperty(objects, 'deep', { value: truncated && searchable });
}

/**
 * One table row's objects: the row itself when its rows are named, and each
 * of its cells. The indexer makes them for a table's first rows; the table
 * index makes the same ones, under the same keys, for any row after those.
 */
export function tableRowObjects(context, { row, rowIndex, rowNumber, rowLabel, section = '', sectionRow = false }) {
  const { file, fileName, keyPrefix, sheet, headers, labelColumn, firstColumnActsAsRowLabels, rowDescribesVariable,
    statement } = context;
  const rowKey = firstColumnActsAsRowLabels && rowLabel ? rowLabel : `row:${rowIndex + 1}`;
  const rowIdentity = `${rowNumber}:${normalizedVariable(rowKey) || 'row'}`;
  const rowObject = firstColumnActsAsRowLabels && rowLabel ? objectDescriptor({
    key: `${keyPrefix}:row:${rowIdentity}`,
    type: 'DATASET_ROW', path: file.path,
    anchor: { kind: 'table-row', rowKey, rowIndex: rowNumber, sheet },
    label: rowKey, contentHash: file.contentHash,
    metadata: {
      row: rowKey,
      rowIndex: rowNumber,
      variable: rowDescribesVariable ? rowKey : null,
      columns: headers.slice(0, 80).map((header) => String(header ?? '')).filter(Boolean),
      orientation: 'ROW', section, sectionRow,
      dataset: fileName,
      sheet,
    },
  }) : null;
  const cells = [];
  for (const [columnIndex, column] of headers.slice(0, 80).entries()) {
    if (statement && (!column || sectionRow)) continue;
    // The label names the row; as a cell it would only repeat that name.
    // Column A stays unread as before when the labels sit further right, so
    // a stray mark there does not become a value of its row.
    if (!statement && firstColumnActsAsRowLabels && (columnIndex === labelColumn || columnIndex === 0)) continue;
    const value = String(row[columnIndex] ?? '').trim();
    if (!value || value.length > 180) continue;
    const numeric = numericDescriptor(value);
    const type = numeric ? /(^|\/)results?\//i.test(file.path) ? 'RESULT' : 'DATASET_VALUE' : 'TABLE';
    cells.push(objectDescriptor({
      key: `${keyPrefix}:cell:${rowIdentity}:${column || columnIndex}`,
      type, path: file.path,
      anchor: { kind: 'table-cell', rowKey, rowIndex: rowNumber, column: column || `column:${columnIndex + 1}`, columnIndex, sheet },
      label: `${rowKey} · ${column || `column ${columnIndex + 1}`}`,
      value, contentHash: file.contentHash,
      metadata: {
        row: rowKey,
        rowIndex: rowNumber,
        variable: rowDescribesVariable ? rowKey : column || columnIndex + 1,
        column: column || columnIndex + 1,
        orientation: rowDescribesVariable ? 'ROW' : 'COLUMN', section,
        dataset: fileName,
        sheet,
      },
    }));
  }
  return { rowObject, cells };
}
