// The sheet the cell picker shows when fn+Tab is pressed on a spreadsheet or
// CSV suggestion: the cells as the sheet shows them, numbered and lettered as
// in Excel, with the cited cell, row or column highlighted to start from. It
// only reads a table as it was indexed.

import { columnLetter } from '../dependencies/table-preview.js';
import { spreadsheetLayout, tabularLayout } from '../dependencies/tabular.js';

// The most rows one picker shows; a longer sheet is cut around the cited row.
export const MAX_SHEET_ROWS = 5_000;

/**
 * @typedef {{ number: number, cells: string[] }} SheetRow
 * @typedef {{ top: number, bottom: number, left: number, right: number }} SheetRange
 *   Rows by their sheet numbers, columns from 0 (A).
 * @typedef {{ name: string, sheet: string | null, sheets: string[], columns: string[], rows: SheetRow[],
 *   headerRow: number | null, selection: SheetRange | null, truncated: boolean }} SheetDocument
 */

/**
 * The picker's sheet for a table read from a file.
 * @param {{ name: string, table: { name?: string | null, rows: unknown[][], rowNumbers?: number[],
 *   displayRows?: unknown[][] }, anchor?: object, sheets?: string[], delimited?: boolean }} input
 * @returns {SheetDocument}
 */
export function sheetDocument({ name, table, anchor = {}, sheets = [], delimited = false }) {
  const raw = Array.isArray(table?.rows) ? table.rows : [];
  const numbers = raw.map((_, index) => table.rowNumbers?.[index] ?? index + 1);
  const layout = delimited ? tabularLayout(raw) : spreadsheetLayout({ ...table, rows: raw });
  const headerIndex = raw.length ? Math.max(0, layout.headerRowIndex) : -1;
  const sheet = delimited ? null : table?.name ?? null;
  const citedSheet = delimited || anchor?.sheet == null || anchor.sheet === sheet;
  const width = Math.max(0, ...raw.map((row) => row.length));
  const cited = citedSheet ? citedRange(anchor, raw, numbers, headerIndex, width) : null;
  const { from, to } = shownRows(raw.length, cited ? numbers.indexOf(cited.top) : 0);
  const rows = raw.slice(from, to).map((row, offset) => ({
    number: numbers[from + offset],
    cells: Array.from({ length: width }, (_, column) => shownCell(table, from + offset, column)),
  }));
  return {
    name,
    sheet,
    sheets: delimited ? [] : sheets,
    columns: Array.from({ length: width }, (_, column) => columnLetter(column)),
    rows,
    headerRow: headerIndex >= 0 ? numbers[headerIndex] : null,
    selection: cited,
    truncated: to - from < raw.length,
  };
}

/** A cell as the sheet shows it ($129,950), or as stored when it has no format. */
function shownCell(table, index, column) {
  const shown = table.displayRows?.[index]?.[column];
  return String(shown ?? table.rows[index]?.[column] ?? '').trim();
}

/** The rows shown, around the cited one when the sheet is too long to show whole. */
function shownRows(count, center) {
  if (count <= MAX_SHEET_ROWS) return { from: 0, to: count };
  const from = Math.min(Math.max(0, center - MAX_SHEET_ROWS / 2), count - MAX_SHEET_ROWS);
  return { from, to: from + MAX_SHEET_ROWS };
}

/** Where a suggestion's anchor sits in the rows: a cell, a whole row, or a column below its header. */
function citedRange(anchor, raw, numbers, headerIndex, width) {
  if (!anchor?.kind || !width) return null;
  const column = citedColumn(anchor, raw[headerIndex] ?? []);
  if (anchor.kind === 'table-column') {
    if (column < 0 || headerIndex + 1 >= raw.length) return null;
    return { top: numbers[headerIndex + 1], bottom: numbers.at(-1), left: column, right: column };
  }
  const index = citedRowIndex(anchor, raw, numbers);
  if (index < 0) return null;
  const number = numbers[index];
  if (anchor.kind === 'table-row') return { top: number, bottom: number, left: 0, right: width - 1 };
  if (anchor.kind !== 'table-cell' || column < 0) return null;
  return { top: number, bottom: number, left: column, right: column };
}

function citedColumn(anchor, header) {
  if (Number.isInteger(anchor.columnIndex)) return anchor.columnIndex;
  if (anchor.column == null) return -1;
  return header.findIndex((cell) => String(cell ?? '').trim() === String(anchor.column).trim());
}

/**
 * A worksheet anchor names its sheet row; any other counts rows from the top
 * of the table as it was read. A row that moved is found by its name.
 */
function citedRowIndex(anchor, raw, numbers) {
  if (Number.isInteger(anchor.rowIndex)) {
    const index = anchor.rowCoordinate === 'worksheet' ? numbers.indexOf(anchor.rowIndex) : anchor.rowIndex;
    if (index >= 0 && index < raw.length) return index;
  }
  const key = String(anchor.rowKey ?? '').trim();
  if (!key) return -1;
  return raw.findIndex((row) => row.some((cell) => String(cell ?? '').trim() === key));
}
