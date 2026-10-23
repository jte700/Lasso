// How a table's rows and columns are read: which row heads it, which column
// names its rows, and whether it is a data dictionary. The indexer reads the
// first rows of a table with these, and so does the table index worker for a
// table too large to hold, so both agree on every row's name and key.

import { normalizedRowSearch } from './row-names.js';

export function normalizedVariable(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function humanVariable(value) {
  return String(value ?? '').replace(/[_./-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

export function dictionaryColumns(filePath, headers) {
  const names = headers.map((header) => humanVariable(header));
  const variableIndex = names.findIndex((name) => /^(?:variable(?: name)?|var|field(?: name)?|column(?: name)?|code|item|name)$/.test(name));
  const descriptionIndex = names.findIndex((name) => /(?:description|definition|meaning|label|question|concept|long name)/.test(name));
  const pathLooksLikeDictionary = /(?:data[_ -]?(?:dictionary|dict)|codebook|variable[_ -]?(?:definitions?|labels?)|metadata|schema|layout)/i.test(filePath);
  return {
    dictionary: (variableIndex >= 0 && descriptionIndex >= 0) || pathLooksLikeDictionary,
    variableIndex: variableIndex >= 0 ? variableIndex : pathLooksLikeDictionary ? 0 : -1,
    descriptionIndex: descriptionIndex >= 0 ? descriptionIndex
      : pathLooksLikeDictionary ? Math.min(1, Math.max(0, headers.length - 1)) : -1,
    unitIndex: names.findIndex((name) => /^(?:unit|units|format|type|allowed values?|coding)$/.test(name)),
  };
}

export function tabularLayout(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  if (!rows.length) return { headers: [], rows: [], headerRowIndex: 0 };
  const candidates = rows.slice(0, 20).map((row, index) => {
    const cells = row.map((cell) => String(cell ?? '').trim());
    const present = cells.filter(Boolean);
    const alphabetic = present.filter((cell) => /[A-Za-z]/.test(cell));
    const unique = new Set(present.map((cell) => cell.toLowerCase())).size;
    const knownHeaders = present.filter((cell) => /^(?:sample(?: id)?|subject(?: id)?|participant(?: id)?|patient(?: id)?|group|variable|metric|measure|outcome|parameter|feature|marker|analyte|description|definition|units?)$/i.test(cell)).length;
    const following = rows.slice(index + 1, index + 4);
    const compatibleRows = following.filter((next) => next.filter((cell) => String(cell ?? '').trim()).length
      >= Math.max(1, Math.floor(present.length * 0.6))).length;
    const duplicates = Math.max(0, present.length - unique);
    const score = alphabetic.length * 3 + unique * 0.35 + knownHeaders * 8
      + compatibleRows * 1.5 - duplicates * 1.5;
    return { index, cells, present: present.length, alphabetic: alphabetic.length, score };
  }).filter((candidate) => candidate.present >= 2 && candidate.alphabetic >= 1)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = candidates[0] ?? { index: 0, cells: rows[0].map((cell) => String(cell ?? '').trim()) };
  return {
    headers: selected.cells,
    rows: rows.slice(selected.index + 1),
    headerRowIndex: selected.index,
  };
}

// Financial worksheets often indent account labels across several columns and
// place year headings above values. Preserve physical cell coordinates while
// treating those labels as rows, not as measured columns.
export function spreadsheetLayout(sheet) {
  const yearHeader = sheet.rows.slice(0, 20).findIndex(row =>
    row.filter(cell => /^(?:19|20)\d{2}$/.test(String(cell ?? '').trim())).length >= 2
      && row.some(cell => /\b(?:revenue|expenses?|income|account|sales|balance|assets?|liabilit|cash|profit)\b/i.test(String(cell ?? ''))));
  const base = tabularLayout(sheet.rows);
  if (yearHeader < 0) return { ...base, rowNumbers: sheet.rowNumbers?.slice(base.headerRowIndex + 1) };
  const header = sheet.rows[yearHeader];
  const yearColumns = [...header.keys()].filter(index => /^(?:19|20)\d{2}$/.test(String(header[index] ?? '').trim()));
  const labelColumns = Array.from({ length: yearColumns[0] }, (_, index) => index);
  const headers = Array.from({ length: yearColumns.at(-1) + 1 }, (_, index) => yearColumns.includes(index) ? String(header[index]) : '');
  // The year row can also be a section heading (Revenue, Expenses…).
  const rows = sheet.rows.slice(yearHeader);
  return { headers, rows, headerRowIndex: yearHeader - 1, labelColumns,
    rowNumbers: sheet.rowNumbers?.slice(yearHeader), statement: true };
}

/**
 * Which column names a table's rows, read from its first data rows (at most
 * the first 1,000), and whether those rows are variables a writer names.
 */
export function tableShape(headers, data, options = {}) {
  // Which column names the rows. Usually the first, but a statement or
  // budget template commonly indents its line items behind one or two narrow
  // spacer columns, leaving column A empty or holding only a stray mark. A
  // column that does not read as row labels cannot name a row, so the first
  // one that does is used instead; a sheet whose labels are already in column
  // A is unaffected, because that column is tested first. Notes under the
  // table still count here, as they did when the rows' keys were first made:
  // leaving them out could move the label column and rename every row.
  const looksNumeric = (value) => /^[-+(]?[$]?[\d][\d.,\s%$]*\)?$/.test(value);
  // Why a column reads as the one that names the rows, or null if it does not.
  const columnNamesRows = (column) => {
    const values = data.map((row) => String(row[column] ?? '').trim());
    const named = values.filter(Boolean);
    if (named.length < Math.max(1, Math.ceil(data.length * 0.45))) return null;
    const unique = named.length === data.length
      && new Set(named.map(normalizedRowSearch)).size === named.length;
    const header = humanVariable(headers[column]);
    if (unique) return 'unique';
    if (!header) return 'unheaded';
    if (/^(?:row|label|name|account|item|category|variable|metric|measure|outcome|parameter|feature|marker|analyte|sample|subject|participant|patient|id)$/i.test(header)) {
      return 'named-heading';
    }
    // A column of words with the figures to its right is naming those figures,
    // whatever its heading says. Statements and budgets rarely head that
    // column at all, and a heading read off the wrong row should not cost the
    // sheet its line-item names.
    const words = named.filter((value) => !looksNumeric(value)).length;
    const toTheRight = data.flatMap((row) => row.slice(column + 1)
      .map((cell) => String(cell ?? '').trim()).filter(Boolean));
    const figures = toTheRight.filter(looksNumeric).length;
    const namesFigures = words >= Math.ceil(named.length * 0.7)
      && toTheRight.length > 0 && figures >= Math.ceil(toTheRight.length * 0.6);
    return namesFigures ? 'words-beside-figures' : null;
  };
  const widestRow = data.reduce((widest, row) => Math.max(widest, row.length), 0);
  const searchLimit = Math.min(widestRow, 4);
  let labelColumn = 0;
  let labelReason = null;
  while (labelColumn < searchLimit) {
    labelReason = columnNamesRows(labelColumn);
    if (labelReason) break;
    labelColumn += 1;
  }
  const firstColumnActsAsRowLabels = options.statement || Boolean(labelReason);
  if (!firstColumnActsAsRowLabels) labelColumn = 0;
  const firstHeader = humanVariable(headers[labelColumn]);
  const rowDescribesVariable = options.statement || firstColumnActsAsRowLabels
    && (!firstHeader
      || /^(?:account|item|category|variable|metric|measure|outcome|parameter|feature|marker|analyte)$/i.test(firstHeader)
      // Line items named beside their figures are variables in every sense
      // that matters here: they are what a writer refers to by name.
      || labelReason === 'words-beside-figures');
  return { labelColumn, firstColumnActsAsRowLabels: Boolean(firstColumnActsAsRowLabels), rowDescribesVariable: Boolean(rowDescribesVariable) };
}
