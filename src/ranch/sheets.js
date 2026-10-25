// A workbook's cells for The Ranch's sheet view: each sheet's rows as the
// sheet shows them, with the row numbers the app would show beside them.
// Only what Lasso's reader already reads is shown; nothing is computed.

import { extractSpreadsheetTables } from '../dependencies/document-extraction.js';

const MAX_SHEETS = 40;
const MAX_COLUMNS = 200;
const MAX_ROWS = 5_000;
/** Past this many cells a sheet is cut short, so the window stays quick. */
const MAX_CELLS = 250_000;

/** A cell as the sheet shows it ($129,950), else its stored value. Binary
 * workbooks store floating-point residue (493.3000000000002) no app shows. */
export function shownCell(display, stored) {
  if (display != null && display !== '') return String(display);
  if (stored == null) return '';
  const text = String(stored);
  return /^-?\d+\.\d{12,}$/.test(text) ? String(Number(Number(text).toPrecision(12))) : text;
}

export function spreadsheetView(buffer) {
  const tables = extractSpreadsheetTables(buffer);
  const sheets = tables.slice(0, MAX_SHEETS).map((table) => {
    const widest = table.rows.reduce((width, row) => Math.max(width, row?.length ?? 0), 0);
    const columns = Math.min(widest, MAX_COLUMNS);
    const rowCount = Math.min(table.rows.length, MAX_ROWS, Math.floor(MAX_CELLS / Math.max(1, columns)));
    return {
      name: table.name,
      columns,
      rows: table.rows.slice(0, rowCount).map((row, index) => Array.from({ length: columns },
        (_, column) => shownCell(table.displayRows?.[index]?.[column], row?.[column]))),
      rowNumbers: (table.rowNumbers ?? table.rows.map((_, index) => index + 1)).slice(0, rowCount),
      truncated: rowCount < table.rows.length || columns < widest,
    };
  });
  return { sheets, skipped: [...(tables.skipped ?? []), ...tables.slice(MAX_SHEETS).map((table) => table.name)] };
}
