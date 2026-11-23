// Files compared on the spot with Lasso's own readers, nothing indexed:
// two versions of a file (two copies on disk, or a file and its last
// commit), cell by cell for a workbook or CSV, line by line for text, and
// passage by passage for Word, PDF and PowerPoint. Also the values a set of
// files holds, for checking a document's numbers against them.

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { detectFileType } from '../history/file-types.js';
import { sheetDiff, sheetGrids, cellAddress, MAX_COMPARED_BYTES } from '../review/sheet-diff.js';
import { lineDiff, linesOf, MAX_COMPARED_TEXT } from '../review/text-diff.js';
import { extractDocxFullText, extractPdfFullText } from '../dependencies/document-extraction.js';
import { deckText, numberKey, numbersIn, sha256File } from './provenance.js';
import { tilde } from './format.js';

/** A Word, PDF or deck larger than this is not read here. */
const MAX_DOCUMENT_BYTES = 160 * 1024 * 1024;
/** Files read for values when verifying against a folder. */
const MAX_SOURCE_FILES = 40;

const SHEETS = new Set(['spreadsheet', 'table']);
const DOCUMENTS = new Set(['document', 'pdf', 'presentation']);

/** How a file is compared: as sheets, as a document's passages, as text, or only by its bytes. */
export function comparisonKind(filePath) {
  const type = detectFileType(filePath);
  if (SHEETS.has(type)) return 'sheet';
  if (DOCUMENTS.has(type)) return 'document';
  if (['markdown', 'text', 'code', 'json', 'yaml', 'xml', 'notebook'].includes(type)) return 'text';
  return 'bytes';
}

const fileFacts = (file) => {
  const stats = fs.statSync(file);
  return { path: file, shown: tilde(file), name: path.basename(file), size: stats.size, modified: stats.mtime.toISOString() };
};

/** Two files on disk, older first as given: { before, after, identical, reading, sheet | lines, note }. */
export function compareFiles(beforePath, afterPath) {
  const before = fileFacts(beforePath);
  const after = fileFacts(afterPath);
  const identical = before.size === after.size && sha256File(beforePath) === sha256File(afterPath);
  if (identical) return { before, after, identical, reading: comparisonKind(afterPath) };
  const kind = comparisonKind(beforePath) === comparisonKind(afterPath) ? comparisonKind(afterPath) : 'bytes';
  const limit = kind === 'sheet' ? MAX_COMPARED_BYTES : kind === 'text' ? MAX_COMPARED_TEXT : kind === 'document' ? MAX_DOCUMENT_BYTES : 0;
  if (kind === 'bytes' || before.size > limit || after.size > limit) {
    return { before, after, identical, reading: 'bytes', note: kind === 'bytes' ? null : 'too large to compare here' };
  }
  return { before, after, identical, ...compareBuffers(fs.readFileSync(beforePath), fs.readFileSync(afterPath), afterPath, beforePath) };
}

/** Two versions' bytes compared as `filePath` reads: { reading: 'sheet', sheet }, { reading, lines } or { reading: 'bytes' }. */
export function compareBuffers(beforeBuffer, afterBuffer, filePath, beforePath = filePath) {
  const kind = comparisonKind(filePath);
  if (kind === 'sheet') {
    const type = detectFileType(filePath);
    if (detectFileType(beforePath) !== type) return { reading: 'bytes' };
    return { reading: kind, sheet: sheetDiff({ beforeBuffer, afterBuffer, fileType: type, filePath }) };
  }
  if (kind === 'document') return { reading: kind, lines: lineDiff(documentLines(beforeBuffer, beforePath), documentLines(afterBuffer, filePath)) };
  if (kind === 'text') return { reading: kind, lines: lineDiff(linesOf(beforeBuffer), linesOf(afterBuffer)) };
  return { reading: 'bytes' };
}

/** A document's text as the lines a reader compares: paragraphs of Word, lines of a PDF, a deck's pieces of text. */
export function documentLines(buffer, filePath) {
  const type = detectFileType(filePath);
  const text = type === 'document' ? extractDocxFullText(buffer) : type === 'pdf' ? extractPdfFullText(buffer)
    : type === 'presentation' ? deckText(buffer) : buffer.toString('utf8');
  return String(text ?? '').split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// ── values in files, for verify ─────────────────────────────────────────

/**
 * The files a document is checked against: a file named, or the
 * spreadsheets, CSVs and documents in a folder named (and one level in),
 * without the document itself.
 */
export function sourceFiles(target, { cwd = process.cwd(), document = null } = {}) {
  const absolute = path.resolve(cwd, target);
  let stats;
  try { stats = fs.statSync(absolute); } catch { throw new HttpError(404, `There is nothing at ${target} to check against.`); }
  if (stats.isFile()) return [absolute];
  const found = [];
  const visit = (folder, depth) => {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_SOURCE_FILES || entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (depth < 1) visit(full, depth + 1); continue; }
      if (full === document || !entry.isFile()) continue;
      if (['sheet', 'document'].includes(comparisonKind(full)) || ['markdown', 'text'].includes(detectFileType(full))) found.push(full);
    }
  };
  visit(absolute, 0);
  return found;
}

/** The spreadsheets and CSVs beside a document, which it is checked against when nothing else is named. */
export function filesBeside(document) {
  return sourceFiles(path.dirname(document), { document }).filter((file) => comparisonKind(file) === 'sheet' && path.dirname(file) === path.dirname(document));
}

/**
 * Every number the files hold, as verify's index: { key: [{ path, label,
 * value, place, current: true }] }. A cell is named by its row's first
 * words and its column's heading; a number in a document by its sentence.
 */
export function valuesFrom(files, keys) {
  const index = new Map();
  const add = (key, entry) => {
    if (!keys.has(key)) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ objectId: null, folder: null, removed: false, current: true, ...entry, currentValue: entry.value });
  };
  const read = [];
  for (const file of files) {
    const shown = tilde(file);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { continue; }
    if (comparisonKind(file) === 'sheet') {
      if (size > MAX_COMPARED_BYTES) continue;
      const type = detectFileType(file);
      let values = 0;
      for (const sheet of sheetGrids(fs.readFileSync(file), type, file)) {
        const heading = sheet.rows.find((row) => row.filter((cell) => cell && Number.isNaN(Number(cell.replace(/[,$%]/g, '')))).length >= 2) ?? [];
        sheet.rows.forEach((row, rowIndex) => {
          // A row is named by its leading words: column A, and B when it holds words too.
          const leading = [];
          for (const cell of row) { if (!cell || numberKey(cell) !== null || leading.length >= 2) break; leading.push(cell); }
          const rowLabel = leading.join(' · ') || (row.find((cell) => cell && numberKey(cell) === null) ?? '');
          row.forEach((cell, column) => {
            const key = numberKey(cell);
            if (key === null) return;
            values += 1;
            const label = [rowLabel, heading[column] && heading[column] !== rowLabel ? heading[column] : ''].filter(Boolean).join(' · ');
            add(key, { path: path.basename(file), location: shown, label: label || cellAddress(sheet.name, sheet.rowNumbers[rowIndex], column, type === 'table'), value: cell,
              place: cellAddress(sheet.name, sheet.rowNumbers[rowIndex], column, type === 'table') });
          });
        });
      }
      read.push({ path: shown, values });
      continue;
    }
    if (size > MAX_DOCUMENT_BYTES) continue;
    let lines;
    try { lines = documentLines(fs.readFileSync(file), file); } catch { continue; }
    const claims = numbersIn(lines.join('\n'));
    for (const claim of claims) add(claim.key, { path: path.basename(file), location: shown, label: claim.sentence, value: claim.raw, place: `line ${claim.line}` });
    read.push({ path: shown, values: claims.length });
  }
  return { index, read };
}
