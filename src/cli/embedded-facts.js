// What a file says about itself inside its own bytes: an Office file's
// document properties (who made it, who saved it last, the app and how
// long it was edited), a Word document's tracked changes and comments with
// their authors, and a PDF's information dictionary. Office files are read
// a part at a time from disk, so a large deck is never held in memory.

import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { decodeXml } from '../dependencies/document-extraction.js';

const OFFICE = /\.(docx|docm|dotx|xlsx|xlsm|xltx|pptx|pptm|potx)$/i;
const WORD = /\.(docx|docm|dotx)$/i;
/** A part larger than this is not read. */
const MAX_PART = 64 * 1024 * 1024;
const MAX_TRACKED = 200;

/** { properties, tracked, pdf } for a file, each null where the file has none. */
export function embeddedFacts(absolute) {
  if (OFFICE.test(absolute)) {
    const parts = readZipParts(absolute, ['docProps/core.xml', 'docProps/app.xml',
      ...(WORD.test(absolute) ? ['word/document.xml', 'word/comments.xml'] : [])]);
    if (!parts) return { properties: null, tracked: null, pdf: null };
    return { properties: officeProperties(parts.get('docProps/core.xml'), parts.get('docProps/app.xml')),
      tracked: WORD.test(absolute) ? trackedChanges(parts.get('word/document.xml'), parts.get('word/comments.xml')) : null, pdf: null };
  }
  if (/\.pdf$/i.test(absolute)) return { properties: null, tracked: null, pdf: pdfInformation(absolute) };
  return { properties: null, tracked: null, pdf: null };
}

// ── Office ───────────────────────────────────────────────────────────────

/** The properties Word, Excel and PowerPoint write into every file. */
export function officeProperties(core, app) {
  const field = (xml, name) => {
    const match = String(xml ?? '').match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
    const value = match ? decodeXml(match[1]).trim() : '';
    return value || null;
  };
  const properties = {
    title: field(core, 'dc:title'),
    createdBy: field(core, 'dc:creator'),
    lastSavedBy: field(core, 'cp:lastModifiedBy'),
    created: dateOrNull(field(core, 'dcterms:created')),
    saved: dateOrNull(field(core, 'dcterms:modified')),
    printed: dateOrNull(field(core, 'cp:lastPrinted')),
    revision: field(core, 'cp:revision'),
    app: [field(app, 'Application'), field(app, 'AppVersion')].filter(Boolean).join(' ') || null,
    company: field(app, 'Company'),
    template: field(app, 'Template'),
    editingMinutes: Number(field(app, 'TotalTime')) || null,
  };
  return Object.values(properties).some((value) => value !== null) ? properties : null;
}

const dateOrNull = (value) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

const attributes = (text) => Object.fromEntries([...String(text).matchAll(/([\w:]+)="([^"]*)"/g)].map(([, name, value]) => [name, decodeXml(value)]));
const runText = (xml, tag) => decodeXml([...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((match) => match[1]).join(''));

/**
 * A Word document's tracked insertions and deletions and its comments,
 * each with who made it and when, in document order, and a tally by author.
 */
export function trackedChanges(documentXml, commentsXml) {
  const items = [];
  for (const match of String(documentXml ?? '').matchAll(/<w:(ins|del)\s([^>]*)>([\s\S]*?)<\/w:\1>/g)) {
    const attrs = attributes(match[2]);
    const text = match[1] === 'ins' ? runText(match[3], 'w:t') : runText(match[3], 'w:delText');
    if (!text.trim()) continue;
    items.push({ kind: match[1] === 'ins' ? 'inserted' : 'deleted', author: attrs['w:author'] || null, at: dateOrNull(attrs['w:date']), text });
  }
  for (const match of String(commentsXml ?? '').matchAll(/<w:comment\s([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const attrs = attributes(match[1]);
    items.push({ kind: 'comment', author: attrs['w:author'] || null, at: dateOrNull(attrs['w:date']), text: runText(match[2], 'w:t') });
  }
  if (!items.length) return null;
  const authors = new Map();
  for (const item of items) {
    const name = item.author ?? 'Unknown';
    const entry = authors.get(name) ?? { name, inserted: 0, deleted: 0, comment: 0, last: null };
    entry[item.kind] += 1;
    if (item.at && (!entry.last || item.at > entry.last)) entry.last = item.at;
    authors.set(name, entry);
  }
  return { items: items.slice(0, MAX_TRACKED), total: items.length,
    authors: [...authors.values()].sort((a, b) => (b.inserted + b.deleted + b.comment) - (a.inserted + a.deleted + a.comment)) };
}

/**
 * The named parts of a zip archive on disk, read from its central
 * directory and those parts' own bytes only. Null when it is not a zip
 * Lasso reads (a 64-bit archive, or a password-protected Office file).
 */
export function readZipParts(file, names) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      const got = fs.readSync(handle, buffer, 0, length, position);
      return buffer.subarray(0, got);
    };
    const tailLength = Math.min(size, 65_557);
    const tail = read(size - tailLength, tailLength);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) { end = index; break; }
    }
    if (end < 0) return null;
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (directoryOffset === 0xffffffff || directorySize > 64 * 1024 * 1024) return null;
    const directory = read(directoryOffset, directorySize);
    const wanted = new Set(names);
    const parts = new Map();
    let offset = 0;
    for (let entry = 0; entry < count && offset + 46 <= directory.length; entry += 1) {
      if (directory.readUInt32LE(offset) !== 0x02014b50) return null;
      const method = directory.readUInt16LE(offset + 10);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const localOffset = directory.readUInt32LE(offset + 42);
      const name = directory.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      offset += 46 + nameLength + extraLength + commentLength;
      if (!wanted.has(name) || uncompressedSize > MAX_PART) continue;
      const header = read(localOffset, 30);
      if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) continue;
      const start = localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const stored = read(start, compressedSize);
      const bytes = method === 0 ? stored : method === 8 ? inflateRawSync(stored, { maxOutputLength: MAX_PART }) : null;
      if (bytes) parts.set(name, bytes.toString('utf8'));
    }
    return parts;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// ── PDF ──────────────────────────────────────────────────────────────────

const PDF_KEYS = { Title: 'title', Author: 'author', Creator: 'creator', Producer: 'producer', CreationDate: 'created', ModDate: 'modified' };
const PDF_EDGE = 512 * 1024;

/**
 * A PDF's information dictionary and XMP: its title, author, the app that
 * made it (Creator), the one that wrote the PDF (Producer) and its dates.
 * Read from the file's first and last half megabyte, where they sit unless
 * compressed into an object stream.
 */
export function pdfInformation(file) {
  let text;
  try {
    const handle = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(handle).size;
      const head = Buffer.alloc(Math.min(size, PDF_EDGE));
      fs.readSync(handle, head, 0, head.length, 0);
      const tail = Buffer.alloc(Math.min(Math.max(0, size - head.length), PDF_EDGE));
      fs.readSync(handle, tail, 0, tail.length, size - tail.length);
      text = Buffer.concat([head, tail]).toString('latin1');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
  if (!text.startsWith('%PDF')) return null;
  const info = {};
  for (const match of text.matchAll(/\/(Title|Author|Creator|Producer|CreationDate|ModDate)\s*(\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/g)) {
    const key = PDF_KEYS[match[1]];
    if (info[key]) continue;
    const value = pdfString(match[2]);
    if (value) info[key] = key === 'created' || key === 'modified' ? pdfDate(value) ?? value : value;
  }
  const xmp = (name) => text.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1]?.trim() ?? null;
  info.creator ??= xmp('xmp:CreatorTool');
  info.producer ??= xmp('pdf:Producer');
  info.created ??= dateOrNull(xmp('xmp:CreateDate'));
  info.modified ??= dateOrNull(xmp('xmp:ModifyDate'));
  const kept = Object.fromEntries(Object.entries(info).filter(([, value]) => value));
  return Object.keys(kept).length ? kept : null;
}

/** A PDF string's text: literal "(…)" with its escapes, or hex "<FEFF…>", either in UTF-16 when it starts with a byte order mark. */
function pdfString(token) {
  let bytes;
  if (token.startsWith('<')) bytes = Buffer.from(token.slice(1, -1).replace(/\s+/g, ''), 'hex');
  else {
    const body = token.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_, escape) => {
      if (/^[0-7]+$/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
      return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[escape] ?? (/\n/.test(escape) ? '' : escape);
    });
    bytes = Buffer.from(body, 'latin1');
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    return swapped.toString('utf16le').replace(/\0+$/, '').trim();
  }
  return bytes.toString('latin1').replace(/\0+$/, '').trim();
}

/** "D:20240131093000-05'00'" as an ISO time. */
function pdfDate(value) {
  const match = String(value).match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/);
  if (!match) return null;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', zone = 'Z'] = match;
  const offset = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.replace(/'/g, '').slice(3, 5) || '00'}`;
  return dateOrNull(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
}

export const isOfficeFile = (file) => OFFICE.test(path.basename(file));
export const isWordFile = (file) => WORD.test(path.basename(file));
