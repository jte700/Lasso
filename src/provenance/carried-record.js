// An AI record carried inside a Word document, so another Mac's Lasso can
// show which parts an AI wrote. It is a custom XML part of the .docx, the
// kind Word keeps through its own saves, related from the document part and
// invisible in the document. The part holds the record as JSON and the
// signature of that JSON by the Lasso that wrote it, with its public key,
// so a record changed by hand reads as changed. Every other part of the
// document is copied byte for byte.

import crypto from 'node:crypto';
import path from 'node:path';
import { readZip, writeZip, zipBytes } from '../dependencies/zip-archive.js';
import { fingerprintOf, verifySignature } from './record-identity.js';

export const RECORD_NAMESPACE = 'https://mylasso.ca/ns/ai-record/1';
export const RECORD_FORMAT = 'lasso-ai-record';

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOCUMENT = /\/officeDocument$/;
const CUSTOM_XML = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const CUSTOM_XML_PROPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps';
const PROPS_TYPE = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml';
const RELS_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';
const RELATIONSHIP_ID = 'rIdLassoAiRecord';
const LONGEST_PART = 4 * 1024 * 1024;
const ITEM = /^customXml\/item(\d+)\.xml$/i;

/** JSON with every character past ASCII escaped, so however a writer re-encodes the part, the signed text reads back the same. */
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' }[lower] ?? whole;
  });
}

/** The custom XML part's text for a signed record. */
export function recordXml(payloadText, { publicKey, signature }) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<aiRecord xmlns="${RECORD_NAMESPACE}" version="1"><payload>${escapeXml(payloadText)}</payload>`
    + `<signature key="${publicKey}">${signature}</signature></aiRecord>`;
}

/** The signed JSON, signature and key from a record part, whatever prefixes a writer gave its elements. */
export function parseRecordXml(xml) {
  if (!xml.includes(RECORD_NAMESPACE)) return null;
  const payload = xml.match(/<(?:[\w.-]+:)?payload\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?payload>/);
  const signature = xml.match(/<(?:[\w.-]+:)?signature\b[^>]*\bkey="([^"]*)"[^>]*>([^<]*)<\/(?:[\w.-]+:)?signature>/);
  if (!payload || !signature) return null;
  return { payloadText: unescapeXml(payload[1]).trim(), publicKey: signature[1].trim(), signature: signature[2].trim() };
}

/**
 * The record a Word document carries, or null: { payload, payloadText,
 * payloadHash, signer: { name, key }, valid }. A record is valid when its
 * signature is its key's and the key is the one it names.
 */
export function readCarried(buffer) {
  const entries = readZip(buffer);
  if (!entries) return null;
  for (const [name, entry] of entries) {
    if (!ITEM.test(name)) continue;
    let xml;
    try { xml = zipBytes(entry, LONGEST_PART)?.toString('utf8'); } catch { continue; }
    const parts = xml ? parseRecordXml(xml) : null;
    if (!parts) continue;
    let payload = null;
    try { payload = JSON.parse(parts.payloadText); } catch { /* not a record */ }
    if (payload?.format !== RECORD_FORMAT) continue;
    const valid = verifySignature(parts.payloadText, parts.signature, parts.publicKey)
      && payload.signer?.key === fingerprintOf(parts.publicKey);
    return {
      payload, payloadText: parts.payloadText, part: name, valid,
      payloadHash: crypto.createHash('sha256').update(parts.payloadText).digest('hex'),
      signer: { name: String(payload.signer?.name ?? 'Someone'), key: fingerprintOf(parts.publicKey) },
    };
  }
  return null;
}

/** The record's own part, or null. */
function recordPart(entries) {
  for (const [name, entry] of entries) {
    if (!ITEM.test(name)) continue;
    try {
      if (zipBytes(entry, LONGEST_PART)?.toString('utf8').includes(RECORD_NAMESPACE)) return name;
    } catch { /* another program's part */ }
  }
  return null;
}

const text = (entries, name) => {
  const entry = entries.get(name);
  return entry ? zipBytes(entry, LONGEST_PART)?.toString('utf8') ?? null : null;
};

/** Where the main document part is, from the package's relationships. */
function mainDocument(entries) {
  const rels = text(entries, '_rels/.rels') ?? '';
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const type = match[0].match(/\bType="([^"]*)"/)?.[1] ?? '';
    const target = match[0].match(/\bTarget="([^"]*)"/)?.[1];
    if (OFFICE_DOCUMENT.test(type) && target) return target.replace(/^\//, '');
  }
  return 'word/document.xml';
}

/** `xml` with `addition` placed before its closing root tag, or inside a root written as one empty tag. */
function within(xml, root, addition) {
  const closing = `</${root}>`;
  if (xml.includes(closing)) return xml.replace(closing, `${addition}${closing}`);
  const empty = new RegExp(`<${root}(\\b[^>]*?)\\s*/>`);
  if (empty.test(xml)) return xml.replace(empty, `<${root}$1>${addition}${closing}`);
  return null;
}

/**
 * The document with `xml` as its record part: written over the record it
 * carries, or added as a new custom XML part related from the document. Every
 * other part is copied as it was stored. Null when the package is not one Lasso can add to.
 */
export function withRecord(buffer, xml) {
  const entries = readZip(buffer);
  if (!entries) return null;
  const replaced = new Map();
  const existing = recordPart(entries);
  if (existing) {
    replaced.set(existing, Buffer.from(xml, 'utf8'));
  } else {
    const used = [...entries.keys()].map((name) => Number(name.match(ITEM)?.[1] ?? 0));
    const number = Math.max(0, ...used) + 1;
    const item = `customXml/item${number}.xml`;
    const props = `customXml/itemProps${number}.xml`;
    const document = mainDocument(entries);
    const documentRels = path.posix.join(path.posix.dirname(document), '_rels', `${path.posix.basename(document)}.rels`);
    const target = path.posix.relative(path.posix.dirname(document), item);
    const relationship = `<Relationship Id="${RELATIONSHIP_ID}" Type="${CUSTOM_XML}" Target="${target}"/>`;
    const rels = text(entries, documentRels);
    let nextRels;
    if (rels == null) {
      nextRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELATIONSHIPS}">${relationship}</Relationships>`;
    } else {
      if (rels.includes(`Id="${RELATIONSHIP_ID}"`)) return null;
      nextRels = within(rels, 'Relationships', relationship);
    }
    let types = text(entries, '[Content_Types].xml');
    if (nextRels == null || types == null) return null;
    if (!/Extension="xml"/i.test(types)) types = within(types, 'Types', '<Default Extension="xml" ContentType="application/xml"/>');
    if (types && !/Extension="rels"/i.test(types)) types = within(types, 'Types', `<Default Extension="rels" ContentType="${RELS_TYPE}"/>`);
    if (types) types = within(types, 'Types', `<Override PartName="/${props}" ContentType="${PROPS_TYPE}"/>`);
    if (types == null) return null;
    const itemId = `{${crypto.randomUUID().toUpperCase()}}`;
    replaced.set('[Content_Types].xml', Buffer.from(types, 'utf8'));
    replaced.set(documentRels, Buffer.from(nextRels, 'utf8'));
    replaced.set(item, Buffer.from(xml, 'utf8'));
    replaced.set(props, Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
      + `<ds:datastoreItem ds:itemID="${itemId}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml">`
      + `<ds:schemaRefs><ds:schemaRef ds:uri="${RECORD_NAMESPACE}"/></ds:schemaRefs></ds:datastoreItem>`, 'utf8'));
    replaced.set(`customXml/_rels/item${number}.xml.rels`, Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + `<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${CUSTOM_XML_PROPS}" Target="itemProps${number}.xml"/></Relationships>`, 'utf8'));
  }
  const written = [...entries.values()].map((entry) => (replaced.has(entry.name)
    ? { name: entry.name, content: replaced.get(entry.name) } : entry));
  for (const [name, content] of replaced) if (!entries.has(name)) written.push({ name, content });
  return writeZip(written);
}

/** What a record says, without when or by whom it was written: two records saying the same are one. */
export function recordContent(payload) {
  const marks = [...(payload?.marks ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({ marks, spans: payload?.spans ?? [], text: payload?.text?.sha256 ?? null });
}

/**
 * Where a record's spans are in a document's text now: each span's words
 * found where they were, or wherever they are with the same words either
 * side, or alone where they appear once. Spans whose words are gone are left out.
 * @returns {Array<{ m: string, s: number, e: number }>}
 */
export function locateSpans(documentText, spans) {
  const found = [];
  for (const span of spans ?? []) {
    const words = String(span.text ?? '');
    if (!words || typeof span.mark !== 'string') continue;
    const start = Number(span.start);
    if (documentText.slice(start, start + words.length) === words) {
      found.push({ m: span.mark, s: start, e: start + words.length });
      continue;
    }
    const at = [];
    for (let index = documentText.indexOf(words); index !== -1 && at.length < 50; index = documentText.indexOf(words, index + 1)) at.push(index);
    if (!at.length) continue;
    const prefix = String(span.prefix ?? '');
    const suffix = String(span.suffix ?? '');
    const score = (index) => (prefix && documentText.slice(Math.max(0, index - prefix.length), index) === prefix ? 2 : 0)
      + (suffix && documentText.slice(index + words.length, index + words.length + suffix.length) === suffix ? 2 : 0);
    const best = at.map((index) => ({ index, score: score(index) }))
      .sort((a, b) => b.score - a.score || Math.abs(a.index - start) - Math.abs(b.index - start));
    if (best[0].score === 0 && at.length > 1) continue;
    found.push({ m: span.mark, s: best[0].index, e: best[0].index + words.length });
  }
  return found.sort((a, b) => a.s - b.s).filter((span, index, all) => index === 0 || span.s >= all[index - 1].e);
}
