// A workbook's or CSV's changes between two versions as a reviewer reads
// them: the rows around each change as a small grid, with the sheet's own
// column letters and row numbers, each changed cell holding what it was and
// what it is now. Rows are matched as lines of text are, so a row inserted
// above others is one added row, not a change to every row below it. A
// formula cell that changed is marked as recalculated.

import path from 'node:path';
import { extractSpreadsheetTables } from '../dependencies/document-extraction.js';
import { parseDelimited } from '../history/diff.js';
import { sequenceOperations } from '../history/sequence-diff.js';
import { shownCell } from '../ranch/sheets.js';

/** Unchanged rows shown either side of a change. */
export const SHEET_CONTEXT = 2;
/** Columns one grid shows; a wider sheet shows its first and those around each change. */
export const MAX_GRID_COLUMNS = 10;
/** Rows shown in one file; past this the view says it was cut short. */
export const MAX_GRID_ROWS = 400;
/** A workbook larger than this is not compared here. */
export const MAX_COMPARED_BYTES = 30 * 1024 * 1024;

/** The letters a sheet names column `index` (from 0) by: A, B, ... Z, AA. */
export function columnLetter(index) {
  let letters = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
    letters = String.fromCharCode(65 + ((number - 1) % 26)) + letters;
  }
  return letters;
}

/** A cell's address as its file names it: "Budget!B2", or "B2" in a CSV. */
export function cellAddress(sheet, row, column, csv = false) {
  return `${csv || !sheet ? '' : `${sheet}!`}${columnLetter(column)}${row}`;
}

const isCsv = (fileType) => fileType === 'table';

/**
 * The sheets of a workbook or delimited file as shown values:
 * [{ name, rows: string[][], rowNumbers, formulas: Map(row number → Set(column)) }].
 */
export function sheetGrids(buffer, fileType, filePath) {
  if (!buffer || buffer.length > MAX_COMPARED_BYTES) return [];
  if (isCsv(fileType)) {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const rows = parseDelimited(text, filePath.toLowerCase().endsWith('.tsv') ? '\t' : ',');
    while (rows.length && rows.at(-1).every((cell) => cell === '')) rows.pop();
    return [{ name: path.posix.basename(filePath), rows, rowNumbers: rows.map((_, index) => index + 1), formulas: new Map() }];
  }
  return extractSpreadsheetTables(buffer).map((table) => ({
    name: table.name,
    rows: table.rows.map((row, index) => Array.from(row ?? [], (cell, column) => shownCell(table.displayRows?.[index]?.[column], cell) ?? '')),
    rowNumbers: table.rowNumbers ?? table.rows.map((_, index) => index + 1),
    formulas: table.formulas ?? new Map(),
  }));
}

const trimmed = (row) => {
  let end = row.length;
  while (end > 0 && (row[end - 1] ?? '') === '') end -= 1;
  return row.slice(0, end).map((cell) => cell ?? '');
};

/**
 * One sheet's rows from before to after, in order: { kind: same | modified |
 * added | removed, before, after, beforeNumber, afterNumber, changed (columns) }.
 * Removed rows followed by added ones are paired as modified, in order.
 */
export function rowChanges(before, after) {
  const beforeRows = (before?.rows ?? []).map(trimmed);
  const afterRows = (after?.rows ?? []).map(trimmed);
  const operations = sequenceOperations(beforeRows.map((row) => JSON.stringify(row)), afterRows.map((row) => JSON.stringify(row)));
  const numberBefore = (line) => before.rowNumbers?.[line - 1] ?? line;
  const numberAfter = (line) => after.rowNumbers?.[line - 1] ?? line;
  const rows = [];
  let removed = [];
  let added = [];
  const flush = () => {
    const paired = Math.min(removed.length, added.length);
    for (let index = 0; index < paired; index += 1) {
      const [was, now] = [beforeRows[removed[index].beforeLine - 1], afterRows[added[index].afterLine - 1]];
      const width = Math.max(was.length, now.length);
      const changed = [];
      for (let column = 0; column < width; column += 1) if ((was[column] ?? '') !== (now[column] ?? '')) changed.push(column);
      rows.push({ kind: 'modified', before: was, after: now, beforeNumber: numberBefore(removed[index].beforeLine),
        afterNumber: numberAfter(added[index].afterLine), changed });
    }
    for (const operation of removed.slice(paired)) {
      rows.push({ kind: 'removed', before: beforeRows[operation.beforeLine - 1], after: null, beforeNumber: numberBefore(operation.beforeLine), afterNumber: null, changed: [] });
    }
    for (const operation of added.slice(paired)) {
      rows.push({ kind: 'added', before: null, after: afterRows[operation.afterLine - 1], beforeNumber: null, afterNumber: numberAfter(operation.afterLine), changed: [] });
    }
    removed = [];
    added = [];
  };
  for (const operation of operations) {
    if (operation.kind === 'remove') { if (added.length) flush(); removed.push(operation); continue; }
    if (operation.kind === 'add') { added.push(operation); continue; }
    flush();
    rows.push({ kind: 'same', before: beforeRows[operation.beforeLine - 1], after: afterRows[operation.afterLine - 1],
      beforeNumber: numberBefore(operation.beforeLine), afterNumber: numberAfter(operation.afterLine), changed: [] });
  }
  flush();
  return rows;
}

/** The columns one grid shows: all of a narrow sheet; else the first and those around each change. */
function gridColumns(rows) {
  const width = rows.reduce((widest, row) => Math.max(widest, row.before?.length ?? 0, row.after?.length ?? 0), 1);
  if (width <= MAX_GRID_COLUMNS) return Array.from({ length: width }, (_, index) => index);
  const changed = [...new Set(rows.flatMap((row) => row.kind === 'modified' ? row.changed : []))];
  const wanted = new Set([0, ...changed]);
  for (const column of changed) for (const near of [column - 1, column + 1]) if (near >= 0 && near < width && wanted.size < MAX_GRID_COLUMNS) wanted.add(near);
  for (let column = 1; column < width && wanted.size < MAX_GRID_COLUMNS; column += 1) wanted.add(column);
  return [...wanted].sort((left, right) => left - right).slice(0, Math.max(MAX_GRID_COLUMNS, changed.length + 1));
}

/** The row a sheet's column headings sit in: the first with two or more words in it. */
function headingRow(sheet) {
  const index = (sheet?.rows ?? []).findIndex((row) => (row ?? []).filter((cell) => cell && Number.isNaN(Number(cell))).length >= 2);
  return index < 0 ? null : { number: sheet.rowNumbers?.[index] ?? index + 1, cells: trimmed(sheet.rows[index]) };
}

/**
 * The changes from `beforeBuffer` to `afterBuffer` as grids: { sheets: [{ name,
 * hunks: [{ heading, columns: [{ index, letter }], rows: [{ number, kind, cells }] }] }],
 * counts: { cells, recalculated, rowsAdded, rowsRemoved }, truncated }. `pinned`
 * is a set of "sheet\0row" kept in view, for comments on rows that did not change.
 */
export function sheetDiff({ beforeBuffer, afterBuffer, fileType, filePath, pinned = new Set() }) {
  const before = new Map(sheetGrids(beforeBuffer, fileType, filePath).map((sheet) => [sheet.name, sheet]));
  const after = sheetGrids(afterBuffer, fileType, filePath);
  const names = [...after.map((sheet) => sheet.name), ...[...before.keys()].filter((name) => !after.some((sheet) => sheet.name === name))];
  const counts = { cells: 0, recalculated: 0, rowsAdded: 0, rowsRemoved: 0 };
  let shown = 0;
  let truncated = false;
  const sheets = [];
  for (const name of names) {
    const was = before.get(name) ?? { rows: [], rowNumbers: [] };
    const now = after.find((sheet) => sheet.name === name) ?? { rows: [], rowNumbers: [], formulas: new Map() };
    const rows = rowChanges(was, now);
    const keep = rows.map(() => false);
    rows.forEach((row, index) => {
      const marked = pinned.has(`${name}\u0000${row.afterNumber}`);
      if (row.kind === 'same' && !marked) return;
      const reach = row.kind === 'same' ? 1 : SHEET_CONTEXT;
      for (let near = Math.max(0, index - reach); near <= Math.min(rows.length - 1, index + reach); near += 1) keep[near] = true;
    });
    const groups = [];
    let current = null;
    rows.forEach((row, index) => {
      if (!keep[index]) { current = null; return; }
      if (!current) { current = []; groups.push(current); }
      current.push(row);
    });
    const heading = headingRow(now.rows.length ? now : was);
    const hunks = [];
    for (const group of groups) {
      if (shown >= MAX_GRID_ROWS) { truncated = true; break; }
      const columns = gridColumns(group);
      const formulas = now.formulas ?? new Map();
      const out = group.slice(0, MAX_GRID_ROWS - shown).map((row) => {
        const cells = columns.map((column) => {
          const value = (row.after ?? row.before)?.[column] ?? '';
          if (row.kind !== 'modified' || !row.changed.includes(column)) return { value };
          const recalculated = formulas.get(row.afterNumber)?.has(column) === true;
          return { value, before: row.before[column] ?? '', changed: true, ...(recalculated ? { recalculated } : {}) };
        });
        return { number: row.afterNumber ?? row.beforeNumber, kind: row.kind, cells };
      });
      shown += out.length;
      const first = out[0]?.number;
      hunks.push({
        ...(heading && first != null && heading.number < first
          ? { heading: { number: heading.number, cells: columns.map((column) => heading.cells[column] ?? '') } } : {}),
        columns: columns.map((index) => ({ index, letter: columnLetter(index) })), rows: out,
      });
    }
    for (const row of rows) {
      if (row.kind === 'added') counts.rowsAdded += 1;
      if (row.kind === 'removed') counts.rowsRemoved += 1;
      if (row.kind !== 'modified') continue;
      counts.cells += row.changed.length;
      counts.recalculated += row.changed.filter((column) => now.formulas?.get(row.afterNumber)?.has(column)).length;
    }
    if (hunks.length) sheets.push({ name, hunks });
  }
  return { sheets, counts, truncated, csv: isCsv(fileType) };
}

/** A cell's shown value in a version, or null when the sheet or cell is not there. */
export function cellValue(buffer, fileType, filePath, { sheet, row, column }) {
  const grid = sheetGrids(buffer, fileType, filePath).find((candidate) => candidate.name === sheet)
    ?? (isCsv(fileType) ? sheetGrids(buffer, fileType, filePath)[0] : null);
  if (!grid) return null;
  const index = grid.rowNumbers.indexOf(row);
  return index < 0 ? null : (grid.rows[index]?.[column] ?? '');
}
