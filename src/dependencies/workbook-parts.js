// Which sheets of a workbook changed between two versions, from each part's
// checksum, size and stored bytes, without inflating any sheet, so an edit to
// one sheet re-reads only that sheet.

import path from 'node:path';
import { partStamp, readZip, zipBytes } from './zip-archive.js';
import { workbookSheetList } from './document-extraction.js';

// Parts every sheet reads: the sheet list and order, the shared strings that
// hold its text, and the styles that hold its number formats. A change to any
// of them changes every sheet's signature.
const SHARED_PARTS = ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml'];
// The workbook part is read only to list sheets; one larger than this is not.
const MAX_WORKBOOK_BYTES = 4 * 1024 * 1024;

/**
 * Each sheet of an .xlsx in workbook order, { name, position, entry,
 * signature }, where the signature changes exactly when anything the sheet is
 * read from changes: its own part, its relationships and table parts, or a
 * part every sheet reads. Null for anything that is not a readable .xlsx.
 */
export function sheetSignatures(buffer) {
  const entries = readZip(buffer);
  const workbook = entries ? zipBytes(entries.get('xl/workbook.xml'), MAX_WORKBOOK_BYTES)?.toString('utf8') : null;
  if (!workbook) return null;
  const rels = zipBytes(entries.get('xl/_rels/workbook.xml.rels'), MAX_WORKBOOK_BYTES)?.toString('utf8') ?? '';
  // The reader's own sheet list, so names and parts match what it reads.
  const sheets = workbookSheetList(workbook, rels);
  // No sheets found reads the workbook whole, as before sheets were carried.
  if (!sheets.length) return null;
  const shared = SHARED_PARTS.map((part) => partStamp(entries, part)).join('|');
  const tables = [...entries.keys()].filter((part) => part.startsWith('xl/tables/')).sort();
  return sheets.map(({ name, entry }, position) => {
    // A sheet's tables and other related parts sit beside its relationships part.
    const relsName = `${path.posix.dirname(entry)}/_rels/${path.posix.basename(entry)}.rels`;
    const own = [entry, relsName, ...tables].map((part) => partStamp(entries, part)).join('|');
    return { name, position, entry, signature: `${position}|${name}|${own}|${shared}` };
  });
}
