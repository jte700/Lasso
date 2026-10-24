// One slide of a PowerPoint deck as a deck of its own, for a share of that
// slide. The copy holds exactly what the slide needs to open in PowerPoint or
// Keynote as it looks: the slide, its pictures, charts and embedded objects,
// its layout, master and theme. What belongs to the rest of the deck stays out,
// and so does what was never meant for an audience: other slides and their
// pictures, speaker notes, review comments and who wrote them, section and
// custom show names, the thumbnail of the first slide, the document properties
// that list every slide's title, and the record of past edits.
import path from 'node:path';
import { readZip, writeZip, zipBytes } from '../dependencies/zip-archive.js';
import {
  relationships, relationshipsPart, relationshipTarget, slideParts,
} from '../dependencies/presentation-extraction.js';

const MAX_PART_BYTES = 5_000_000;
const PRESENTATION_PART = 'ppt/presentation.xml';
const PROPERTIES_PART = 'ppt/presProps.xml';
const CONTENT_TYPES = '[Content_Types].xml';
const ROOT_RELATIONSHIPS = '_rels/.rels';
const OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
// Relationship types that never travel with one slide, matched on the end of the type.
const LEFT_OUT = ['/notesSlide', '/comments', '/commentAuthors', '/authors', '/customXml', '/viewProps',
  '/vbaProject', '/thumbnail', '/changesInfo', '/revisionInfo', '/extended-properties', '/core-properties',
  '/custom-properties'];
const SLIDE = '/relationships/slide';
const SECTIONS_EXTENSION = /<p:ext\b[^>]*uri="\{521415D9-36F7-43E2-AB2F-B90AF26B5E84\}"[^>]*>[\s\S]*?<\/p:ext>/g;

const escapeAttribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function relationshipsXml(list) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    list.map((relation) => `<Relationship Id="${escapeAttribute(relation.id)}" Type="${escapeAttribute(relation.type)}" Target="${
      escapeAttribute(relation.target)}"${relation.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
}

/**
 * The deck's `slideNumber`th slide (counted as PowerPoint shows them) as a
 * one-slide .pptx, or null when the deck or the slide cannot be read.
 * @param {Buffer} buffer
 * @param {number} slideNumber
 * @returns {Buffer|null}
 */
export function singleSlidePresentation(buffer, slideNumber) {
  const zip = readZip(buffer);
  if (!zip?.has(PRESENTATION_PART) || !zip.has(CONTENT_TYPES)) return null;
  const slides = slideParts(zip);
  const chosen = slides[slideNumber - 1];
  if (!chosen || !zip.has(chosen.part)) return null;
  const text = (part) => zipBytes(zip.get(part), MAX_PART_BYTES)?.toString('utf8') ?? '';

  const kept = new Set();
  const written = new Map();
  const visit = (part) => {
    if (kept.has(part) || !zip.has(part)) return;
    kept.add(part);
    const relationsPart = relationshipsPart(part);
    if (!zip.has(relationsPart)) return;
    const declared = relationships(text(relationsPart));
    const travelling = declared.flatMap((relation) => {
      if (LEFT_OUT.some((suffix) => relation.type.endsWith(suffix))) return [];
      if (!relation.type.endsWith(SLIDE) || relation.external) return [relation];
      // The deck lists only the chosen slide; a link to another slide jumps to this one.
      if (part === PRESENTATION_PART) return relation.id === chosen.relationshipId ? [relation] : [];
      return [{ ...relation, target: path.posix.relative(path.posix.dirname(part), chosen.part) }];
    });
    const changed = travelling.length !== declared.length
      || travelling.some((relation, index) => relation.target !== declared[index].target);
    if (changed) written.set(relationsPart, relationshipsXml(travelling));
    kept.add(relationsPart);
    for (const relation of travelling) {
      if (!relation.external) visit(relationshipTarget(part, relation.target));
    }
  };

  const root = relationships(text(ROOT_RELATIONSHIPS)).filter((relation) => relation.type === OFFICE_DOCUMENT);
  if (!root.length) return null;
  written.set(ROOT_RELATIONSHIPS, relationshipsXml(root));
  kept.add(ROOT_RELATIONSHIPS);
  visit(PRESENTATION_PART);

  const chosenId = text(PRESENTATION_PART).match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)?.[1]
    .match(new RegExp(`<p:sldId\\b[^>]*\\sr:id="${chosen.relationshipId}"[^>]*?(?:/>|>[\\s\\S]*?</p:sldId>)`))?.[0];
  if (!chosenId) return null;
  written.set(PRESENTATION_PART, text(PRESENTATION_PART)
    .replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${chosenId}</p:sldIdLst>`)
    .replace(/<p:custShowLst>[\s\S]*?<\/p:custShowLst>/, '')
    .replace(SECTIONS_EXTENSION, ''));
  if (kept.has(PROPERTIES_PART)) {
    // A slide show set to a custom show or a range of slides would point past the one slide.
    written.set(PROPERTIES_PART, text(PROPERTIES_PART).replace(/<p:(?:custShow|sldRg)\b[^>]*\/>/g, ''));
  }
  written.set(CONTENT_TYPES, text(CONTENT_TYPES).replace(/<Override\b[^>]*\/>/g, (override) => {
    const name = override.match(/PartName="\/?([^"]+)"/)?.[1];
    return name && kept.has(decodeURIComponent(name)) ? override : '';
  }));
  kept.add(CONTENT_TYPES);

  // Parts keep their names and the order the deck stored them in.
  return writeZip([...zip.values()].filter((entry) => kept.has(entry.name)).map((entry) => (written.has(entry.name)
    ? { name: entry.name, content: Buffer.from(written.get(entry.name), 'utf8') } : entry)));
}
