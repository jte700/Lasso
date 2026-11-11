// Which sheets of a workbook changed between two versions, read from the zip
// central directory alone (each part's checksum and size), so an edit to one
// sheet re-reads only that sheet.

import path from 'node:path';
import { readZip, zipBytes } from './zip-archive.js';

// Parts every sheet reads: the sheet list and order, the shared strings that
// hold its text, and the styles that hold its number formats. A change to any
// of them changes every sheet's signature.
const SHARED_PARTS = ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml'];
// The workbook part is read only to list sheets; one larger than this is not.
const MAX_WORKBOOK_BYTES = 4 * 1024 * 1024;

const attribute = (tag, name) => tag.match(new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`))?.[1] ?? '';
const elements = (xml, name) => [...xml.matchAll(new RegExp(`<${name}\\b([^>]*)/?>`, 'g'))].map((match) => match[1]);

const partStamp = (entries, name) => {
  const entry = entries.get(name);
  return entry ? `${name}:${entry.crc}:${entry.size}` : `${name}:-`;
};

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
  const targets = new Map(elements(rels, 'Relationship').map((tag) => [attribute(tag, 'Id'), attribute(tag, 'Target')]));
  const shared = SHARED_PARTS.map((name) => partStamp(entries, name)).join('|');
  return elements(workbook, 'sheet').map((tag, position) => {
    const name = attribute(tag, 'name') || `Sheet ${position + 1}`;
    const target = targets.get(attribute(tag, 'r:id'));
    const entry = target ? path.posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`)
      : `xl/worksheets/sheet${position + 1}.xml`;
    // A sheet's tables and other related parts sit beside its relationships part.
    const relsName = `${path.posix.dirname(entry)}/_rels/${path.posix.basename(entry)}.rels`;
    const related = [...entries.keys()].filter((part) => part.startsWith('xl/tables/')).sort();
    const own = [entry, relsName, ...related].map((part) => partStamp(entries, part)).join('|');
    return { name, position, entry, signature: `${position}|${name}|${own}|${shared}` };
  });
}
