// The edits a review makes to a file when a suggestion is applied or an AI
// is asked to make a change: lines of a text or code file, a cell of a CSV,
// and cell values of an .xlsx workbook. Only values are written, never a
// formula, and everything else in the file is left byte for byte as it was.
// Excel works every formula out again the next time it opens the workbook.

import { workbookSheetList } from '../dependencies/document-extraction.js';
import { readZip, writeZip, zipBytes } from '../dependencies/zip-archive.js';
import { csvDelimiter, parseDelimited } from '../history/diff.js';
import { HttpError } from '../history/errors.js';
import { columnLetter } from './sheet-diff.js';

const MAX_PART_BYTES = 64 * 1024 * 1024;

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * `text` with lines `from` to `to` (counted from 1, inclusive) replaced by
 * `lines`. `to` of `from - 1` inserts before `from`. Line breaks keep the
 * file's own style, and a final line break stays if there was one.
 */
export function replaceLines(text, edits) {
  const eol = eolOf(text);
  const ended = /\r?\n$/.test(text);
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  if (text === '') lines.length = 0;
  const sorted = [...edits].sort((left, right) => right.from - left.from);
  sorted.forEach((edit, index) => {
    if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < 1 || edit.to < edit.from - 1 || edit.to > lines.length) {
      throw new HttpError(422, 'The edit names lines the file does not have.');
    }
    const next = sorted[index - 1];
    if (next && next.from <= edit.to) throw new HttpError(422, 'The edits overlap.');
    lines.splice(edit.from - 1, edit.to - edit.from + 1, ...edit.lines.map((line) => String(line)));
  });
  return lines.join(eol) + (ended || text === '' ? eol : '');
}

const quoted = (value, delimiter) => (value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** A delimited file with one cell (row counted from 1, column from 0) set to `value`. */
export function setDelimitedCell(text, { row, column, value }, filePath = '') {
  const delimiter = filePath.toLowerCase().endsWith('.tsv') ? '\t' : csvDelimiter(text);
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const rows = parseDelimited(text, delimiter, { detect: false });
  const filled = (list) => list.filter((entry) => (Array.isArray(entry) ? entry.some((cell) => cell !== '') : entry !== '')).length;
  // A quoted cell holding a line break makes rows and lines disagree; such a row is changed in its own app.
  if (filled(rows) !== filled(lines)) throw new HttpError(409, 'This file has cells that span lines. Change it in its own app.');
  if (!Number.isInteger(row) || row < 1 || row > lines.length) throw new HttpError(422, 'That row is not in the file.');
  const cells = parseDelimited(lines[row - 1], delimiter, { detect: false })[0] ?? [];
  while (cells.length <= column) cells.push('');
  cells[column] = String(value);
  lines[row - 1] = cells.map((cell) => quoted(cell, delimiter)).join(delimiter);
  return lines.join(eol);
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const columnOf = (reference) => {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? 'A';
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
};

function cellXml(prefix, reference, style, value) {
  const tag = `${prefix}c`;
  const styled = style ? ` s="${style}"` : '';
  if (value === '') return `<${tag} r="${reference}"${styled}/>`;
  if (NUMBER.test(value)) return `<${tag} r="${reference}"${styled}><${prefix}v>${value}</${prefix}v></${tag}>`;
  return `<${tag} r="${reference}"${styled} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${escapeXml(value)}</${prefix}t></${prefix}is></${tag}>`;
}

/** A worksheet part's XML with one cell set to `value`, adding the cell or its row when missing. */
export function setSheetCell(xml, row, column, value) {
  const prefix = /<([A-Za-z_][\w.-]*:)?sheetData\b/.exec(xml)?.[1] ?? '';
  const reference = `${columnLetter(column)}${row}`;
  const cellPattern = new RegExp(`<${prefix}c\\b([^>]*?)\\br="${reference}"([^>]*?)(?:/>|>([\\s\\S]*?)</${prefix}c>)`);
  const found = cellPattern.exec(xml);
  if (found) {
    if (new RegExp(`<${prefix}f[\\s>/]`).test(found[3] ?? '')) {
      throw new HttpError(409, `${reference} holds a formula. Change the cells it works from instead.`);
    }
    const style = /\bs="(\d+)"/.exec(found[1] + found[2])?.[1] ?? null;
    return xml.slice(0, found.index) + cellXml(prefix, reference, style, value) + xml.slice(found.index + found[0].length);
  }
  const fresh = cellXml(prefix, reference, null, value);
  const rowPattern = new RegExp(`<${prefix}row\\b([^>]*?)\\br="${row}"([^>]*?)(/>|>([\\s\\S]*?)</${prefix}row>)`);
  const rowFound = rowPattern.exec(xml);
  if (rowFound) {
    if (rowFound[3] === '/>') {
      const opened = `<${prefix}row${rowFound[1]}r="${row}"${rowFound[2]}>${fresh}</${prefix}row>`;
      return xml.slice(0, rowFound.index) + opened + xml.slice(rowFound.index + rowFound[0].length);
    }
    const inner = rowFound[4] ?? '';
    const cells = [...inner.matchAll(new RegExp(`<${prefix}c\\b[^>]*?\\br="([A-Z]+)\\d+"`, 'g'))];
    const after = cells.find((cell) => columnOf(cell[1]) > column);
    const at = after ? after.index : inner.length;
    const start = rowFound.index + rowFound[0].length - inner.length - `</${prefix}row>`.length;
    return xml.slice(0, start + at) + fresh + xml.slice(start + at);
  }
  const rows = [...xml.matchAll(new RegExp(`<${prefix}row\\b[^>]*?\\br="(\\d+)"`, 'g'))];
  const later = rows.find((candidate) => Number(candidate[1]) > row);
  const newRow = `<${prefix}row r="${row}">${fresh}</${prefix}row>`;
  if (later) return xml.slice(0, later.index) + newRow + xml.slice(later.index);
  const closing = xml.search(new RegExp(`</${prefix}sheetData>`));
  if (closing >= 0) return xml.slice(0, closing) + newRow + xml.slice(closing);
  const empty = new RegExp(`<${prefix}sheetData\\s*/>`).exec(xml);
  if (!empty) throw new HttpError(422, 'This worksheet could not be read.');
  return xml.slice(0, empty.index) + `<${prefix}sheetData>${newRow}</${prefix}sheetData>` + xml.slice(empty.index + empty[0].length);
}

/** The workbook part asking Excel to work every formula out again when it opens the file. */
export function recalculateOnOpen(xml) {
  const prefix = /<([A-Za-z_][\w.-]*:)?workbook\b/.exec(xml)?.[1] ?? '';
  const calc = new RegExp(`<${prefix}calcPr\\b([^>]*?)(/?)>`).exec(xml);
  if (calc) {
    if (/\bfullCalcOnLoad="(1|true)"/.test(calc[1])) return xml;
    const attributes = calc[1].replace(/\s*\bfullCalcOnLoad="[^"]*"/, '');
    return xml.slice(0, calc.index) + `<${prefix}calcPr${attributes} fullCalcOnLoad="1"${calc[2]}>` + xml.slice(calc.index + calc[0].length);
  }
  // calcPr follows these in a workbook part; Excel reads its parts in order.
  const ends = ['sheets', 'functionGroups', 'externalReferences', 'definedNames']
    .map((name) => {
      const tag = `</${prefix}${name}>`;
      const at = xml.lastIndexOf(tag);
      return at < 0 ? -1 : at + tag.length;
    });
  const at = Math.max(...ends);
  if (at < 0) throw new HttpError(422, 'This workbook could not be read.');
  return `${xml.slice(0, at)}<${prefix}calcPr fullCalcOnLoad="1"/>${xml.slice(at)}`;
}

/** An .xlsx workbook with cells set: edits are { sheet, row, column, value }. */
export function setWorkbookCells(buffer, edits) {
  const entries = readZip(buffer);
  const text = (name) => zipBytes(entries?.get(name), MAX_PART_BYTES)?.toString('utf8') ?? null;
  const workbook = text('xl/workbook.xml');
  if (!entries || !workbook) throw new HttpError(422, 'This workbook could not be read.');
  const sheets = workbookSheetList(workbook, text('xl/_rels/workbook.xml.rels') ?? '');
  const changed = new Map();
  for (const edit of edits) {
    const sheet = sheets.find((candidate) => candidate.name === edit.sheet) ?? (sheets.length === 1 && !edit.sheet ? sheets[0] : null);
    if (!sheet) throw new HttpError(422, `The workbook has no sheet named ${edit.sheet}.`);
    const xml = changed.get(sheet.entry) ?? text(sheet.entry);
    if (xml == null) throw new HttpError(422, `Sheet ${sheet.name} could not be read.`);
    changed.set(sheet.entry, setSheetCell(xml, edit.row, edit.column, String(edit.value ?? '')));
  }
  changed.set('xl/workbook.xml', recalculateOnOpen(workbook));
  return writeZip([...entries.values()].map((entry) => (changed.has(entry.name)
    ? { name: entry.name, content: Buffer.from(changed.get(entry.name), 'utf8') } : entry)));
}
