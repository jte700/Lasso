// Where a table's source objects sit, for following a link to one when its
// row or column moves, or when a newer reader keys it differently.

import { columnLetter } from './table-preview.js';

const TABLE_KINDS = new Set(['table-cell', 'table-row', 'table-column', 'sheet-note', 'table-summary']);

// What a reader that keys an object differently says about a source its new
// reading lacks: the evidence is intact, so a person re-points the claim.
export const READER_CHANGED = Object.freeze({
  status: 'NEEDS_REVIEW',
  reason: 'The current reader no longer produces this source object. Its recorded evidence is unchanged; re-point the claim at the new reading.',
});

export const REPOINTED = 'The current reader names this source differently. The link now follows the same source under its new name.';

// The first reader that keys a table's rows by label and its columns by name.
export const NAMED_TABLE_READER = 9;
// How readers before it keyed a table's rows, cells, columns and notes: by
// row number or column index ("row:12:rent", "cell:12:rent:Q1",
// "variable:3:amount", "note:14:0"), and before row labels by number alone.
const POSITIONAL_KEY = /:(?:row:\d+(?::[a-z0-9]+)?|cell:\d+:.+|variable:\d+:[a-z0-9]*|note:\d+:\d+)$/s;

export function isTableSource(anchor) {
  return TABLE_KINDS.has(anchor?.kind);
}

export function isPositionalTableKey(key) {
  return POSITIONAL_KEY.test(String(key ?? ''));
}

/** Where a table source sits, { sheet, row, column, worksheet }, or null for anything else. */
export function tablePosition(anchor) {
  if (!isTableSource(anchor)) return null;
  return {
    sheet: anchor.sheet ?? null,
    row: Number.isInteger(anchor.rowIndex) ? anchor.rowIndex : null,
    column: Number.isInteger(anchor.columnIndex) ? anchor.columnIndex : null,
    worksheet: anchor.rowCoordinate === 'worksheet',
  };
}

const samePosition = (left, right) => left.sheet === right.sheet && left.row === right.row && left.column === right.column;

/**
 * Words for a table source that moved from `previous` to `current`, such as
 * "Moved to row 152.", numbered as the sheet or file shows its rows; null
 * when it did not move. A delimited file's rows are counted from its first
 * line, a worksheet's are its own row numbers.
 */
export function describeMove(previous, current) {
  if (!previous || !current || samePosition(previous, current)) return null;
  const parts = [];
  if (current.row != null && current.row !== previous.row) parts.push(`row ${current.worksheet ? current.row : current.row + 1}`);
  if (current.column != null && current.column !== previous.column) parts.push(`column ${columnLetter(current.column)}`);
  return parts.length ? `Moved to ${parts.join(', ')}.` : null;
}

/**
 * Whether a table source's evidence changed. A table's objects record the
 * whole file's content hash, which any edit anywhere in the file changes,
 * so a cell is compared by its value (and a row by its name) instead; other
 * sources still compare the content they were read from.
 */
export function sourceChanged(current, linked) {
  if (isTableSource(linked.anchor)) {
    return (current.value_text ?? null) !== (linked.valueText ?? null)
      || (linked.anchor.kind === 'table-row' && current.label !== linked.label);
  }
  return current.content_hash !== linked.contentHash || current.value_text !== linked.valueText;
}

/** A table source's place, for telling whether two readings name the same cell; null for anything else. */
export function sourcePlace(anchor) {
  if (!isTableSource(anchor)) return null;
  const { kind, sheet, rowIndex, columnIndex, column, rowKey, metric, cellId } = anchor;
  return JSON.stringify([kind, sheet ?? null, rowIndex ?? null, columnIndex ?? null, column ?? null, rowKey ?? null,
    metric ?? null, cellId ?? null]);
}
