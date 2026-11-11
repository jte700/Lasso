// How a worksheet shows a cell's stored value. Excel stores 18400 and shows
// it as 18,400 (or $18,400.00) by the cell's number format; indexed and
// inserted values keep the stored number, but change lines and captions show
// the value as the sheet does. A CSV has no formats, so its values stay as
// written, as do cells of sheets read only in pieces.

import { BoundedCache } from '../cache.js';
import { spreadsheetCellFormats } from './document-extraction.js';
import { displaySpreadsheetNumber } from './spreadsheet-number-format.js';

const WORKBOOK = /\.xls[xm]$/i;
const EMPTY = new Map();
// About what one cell's format entry takes in memory, for the cache budget.
const FORMAT_ENTRY_BYTES = 96;

export const cellDisplayMethods = {
  /**
   * The text the workbook with `contentHash` at `filePath` shows for `value`
   * in the cell `anchor` names, or null when it shows the value as stored.
   */
  shownCellValue(filePath, contentHash, anchor, value) {
    if (value == null || !contentHash || !WORKBOOK.test(String(filePath ?? '')) || anchor?.kind !== 'table-cell'
      || anchor.sheet == null || !Number.isInteger(anchor.rowIndex) || !Number.isInteger(anchor.columnIndex)) return null;
    const code = this.cellFormats(contentHash).get(`${anchor.sheet}\u0000${anchor.rowIndex}\u0000${anchor.columnIndex}`);
    if (!code) return null;
    const shown = displaySpreadsheetNumber(value, code);
    return shown && shown !== String(value) ? shown : null;
  },

  /** A workbook's cell formats by file content, read once (spreadsheetCellFormats); empty when there are none to read. */
  cellFormats(contentHash) {
    this.cellFormatCache ??= new BoundedCache({ maxEntries: 32, budget: this.timeline.memoryBudget,
      bytes: (formats) => formats.size * FORMAT_ENTRY_BYTES });
    const known = this.cellFormatCache.get(contentHash);
    if (known) return known;
    let formats = EMPTY;
    try {
      formats = spreadsheetCellFormats(this.timeline.blobs.get(contentHash)) ?? EMPTY;
    } catch {
      // Bytes released or missing: the values are shown as stored.
    }
    this.cellFormatCache.set(contentHash, formats);
    return formats;
  },

  /** { previousDisplay, currentDisplay } for a change of a worksheet cell, each only when it differs from the stored value. */
  changeDisplay(object, previousValue, currentValue) {
    const shown = (value) => this.shownCellValue(object?.path, object?.contentHash, object?.anchor, value);
    const previousDisplay = shown(previousValue);
    const currentDisplay = shown(currentValue);
    return { ...(previousDisplay ? { previousDisplay } : {}), ...(currentDisplay ? { currentDisplay } : {}) };
  },
};
