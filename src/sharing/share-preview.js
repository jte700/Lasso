// Small table preview for the public share page. Reuses the same spreadsheet
// extraction and header detection as the workspace so the cited cell is
// identified identically in both places.

import path from 'node:path';
import { extractSpreadsheetTables } from '../dependencies/document-extraction.js';
import { tabularLayout } from '../dependencies/service.js';

function parseDelimited(text, delimiter) {
  return text.split(/\r?\n/).filter((line) => line.length).map((line) => line.split(delimiter));
}

/**
 * Builds a few rows of context around the cited cell.
 * Returns null for sources that are not tabular.
 */
export function buildSharePreview(file, anchor = {}, metadata = {}, radius = 2) {
  if (!file?.content || !file?.path) return null;
  const extension = path.extname(file.path).toLowerCase();
  const isSpreadsheet = ['.xlsx', '.xls'].includes(extension);
  const isDelimited = ['.csv', '.tsv'].includes(extension);
  if (!isSpreadsheet && !isDelimited) return null;

  let rawRows = null;
  try {
    if (isSpreadsheet) {
      const sheetName = anchor.sheet ?? metadata.sheet ?? null;
      const tables = extractSpreadsheetTables(file.content);
      const table = tables.find((sheet) => !sheetName || sheet.name === sheetName) ?? tables[0];
      rawRows = table?.rows ?? null;
    } else {
      rawRows = parseDelimited(file.content.toString('utf8'), extension === '.tsv' ? '\t' : ',');
    }
  } catch {
    return null;
  }
  if (!rawRows?.length) return null;

  const layout = tabularLayout(rawRows);
  if (!layout.headers.length) return null;

  const citedRow = Number.isInteger(anchor.rowIndex)
    ? anchor.rowIndex - layout.headerRowIndex - 1
    : layout.rows.findIndex((row) => String(row?.[0] ?? '').trim() === String(anchor.rowKey ?? '').trim());
  if (citedRow < 0 || citedRow >= layout.rows.length) return null;

  const start = Math.max(0, citedRow - radius);
  const end = Math.min(layout.rows.length, citedRow + radius + 1);
  const window = layout.rows.slice(start, end);

  // Spreadsheet rows arrive sparse: blank spacer columns are holes, and Array
  // methods skip holes. Densify first so column indexes stay meaningful.
  const width = Math.max(layout.headers.length, ...window.map((row) => row?.length ?? 0));
  const dense = (row) => Array.from({ length: width }, (_, column) => String(row?.[column] ?? '').trim());
  const headers = dense(layout.headers);
  const rows = window.map(dense);

  const citedColumn = Number.isInteger(anchor.columnIndex)
    ? anchor.columnIndex
    : anchor.column != null
      ? headers.findIndex((header) => header === String(anchor.column))
      : -1;

  // Drop the workbook's empty spacer columns, keeping any column that carries a
  // header or a value — the row labels live in a column with no header.
  const keep = [];
  for (let column = 0; column < width; column += 1) {
    if (headers[column] || rows.some((row) => row[column])) keep.push(column);
  }
  if (!keep.length) return null;

  return {
    headers: keep.map((column) => headers[column]),
    rows: rows.map((row, offset) => ({
      cells: keep.map((column) => ({
        value: row[column],
        // Row references highlight the whole row; cell references one cell.
        cited: start + offset === citedRow && (citedColumn < 0 || column === citedColumn),
      })),
    })),
  };
}
