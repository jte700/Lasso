// PowerPoint (.pptx) decks. A deck is read slide by slide in the order
// PowerPoint shows them, and written out as one outline: a heading for each
// slide, then its text, bullets and tables. Everything that cites, previews or
// shares a deck works from that outline, so a passage's line and slide mean
// the same thing on the suggestion card, in the share dialog and on the page
// a recipient opens. A chart's titles and data are read with its slide, as
// SmartArt's words are. Speaker notes and review comments are not read.
import path from 'node:path';
import { decodeXml } from './document-extraction.js';
import { readZip, zipBytes } from './zip-archive.js';

const MAX_PART_BYTES = 5_000_000;
const MAX_SLIDES = 2_000;
const MAX_TEXT_EXCERPT = 20_000;
const PRESENTATION_PART = 'ppt/presentation.xml';
const RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const DIAGRAM_DATA = `${RELATIONSHIP}diagramData`;
const CHART = `${RELATIONSHIP}chart`;
// A chart's data is read as a table of at most this many categories.
const MAX_CHART_ROWS = 200;
// PowerPoint's default slide, 13.333 by 7.5 inches, in EMUs.
const DEFAULT_SLIDE_SIZE = Object.freeze({ width: 12_192_000, height: 6_858_000 });
// Placeholders PowerPoint repeats on every slide; they are not what a slide says.
const BOILERPLATE_PLACEHOLDERS = new Set(['dt', 'ftr', 'sldNum', 'hdr']);
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle']);

export function isPresentationPath(filePath) {
  return path.extname(String(filePath ?? '')).toLowerCase() === '.pptx';
}

const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

/** The relationships a part's .rels file declares. */
export function relationships(xml) {
  return [...String(xml ?? '').matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => ({
    id: attribute(tag, 'Id'), type: attribute(tag, 'Type') ?? '', target: decodeXml(attribute(tag, 'Target') ?? ''),
    external: attribute(tag, 'TargetMode') === 'External',
  }));
}

/** Where a part's relationships live: ppt/slides/slide1.xml → ppt/slides/_rels/slide1.xml.rels. */
export function relationshipsPart(part) {
  return path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`);
}

/** The part a relationship of `part` points at, as a name inside the archive. */
export function relationshipTarget(part, target) {
  const resolved = target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(part), target);
  return path.posix.normalize(resolved);
}

function partText(zip, part) {
  return zipBytes(zip.get(part), MAX_PART_BYTES)?.toString('utf8') ?? '';
}

function runText(xml) {
  const structured = xml.replace(/<a:(?:br|tab)\b[^>]*\/>/g, ' ');
  return [...structured.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:t\s[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXml(match[1] ?? match[2])).join('').replace(/\s+/g, ' ').trim();
}

function paragraphs(xml) {
  return [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\s[^>]*>([\s\S]*?)<\/a:p>/g)].map((match) => {
    const body = match[1] ?? match[2];
    const properties = body.match(/<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/)?.[0] ?? '';
    const level = Number(attribute(properties.match(/<a:pPr\b[^>]*>/)?.[0] ?? '', 'lvl') ?? 0);
    const bullet = /<a:buNone\b/.test(properties) ? false
      : /<a:bu(?:Char|AutoNum|Blip)\b/.test(properties) ? true : null;
    return { text: runText(body), level: Number.isInteger(level) ? Math.min(level, 8) : 0, bullet,
      ordered: /<a:buAutoNum\b/.test(properties) };
  }).filter((paragraph) => paragraph.text);
}

function shapeBlocks(shape) {
  const placeholder = shape.match(/<p:ph\b[^>]*>/)?.[0] ?? null;
  const type = placeholder ? attribute(placeholder, 'type') ?? 'body' : null;
  if (BOILERPLATE_PLACEHOLDERS.has(type)) return [];
  const body = shape.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/)?.[1] ?? '';
  const title = TITLE_PLACEHOLDERS.has(type);
  // A body placeholder lists bullets unless a paragraph turns its bullet off;
  // a text box or subtitle is prose unless one turns a bullet on.
  const listed = ['body', 'obj'].includes(type);
  return paragraphs(body).map((paragraph) => ({
    type: title ? 'title' : (paragraph.bullet ?? listed) ? 'item' : 'paragraph',
    text: paragraph.text, level: paragraph.level, ordered: paragraph.ordered,
  }));
}

function tableBlock(rows) {
  return rows.some((row) => row.some(Boolean)) ? [{ type: 'table', rows }] : [];
}

function tableRows(table) {
  return [...table.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((row) =>
    [...row[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>|<a:tc\b[^>]*\/>/g)]
      .map((cell) => paragraphs(cell[1] ?? '').map((paragraph) => paragraph.text).join(' ')));
}

/** SmartArt keeps its words in a data part of its own; each is a bullet of the slide. */
function diagramBlocks(zip, slidePart, slideRelationships) {
  return slideRelationships.filter((relation) => relation.type === DIAGRAM_DATA && !relation.external)
    .flatMap((relation) => {
      const data = partText(zip, relationshipTarget(slidePart, relation.target));
      return [...data.matchAll(/<dgm:t>([\s\S]*?)<\/dgm:t>/g)]
        .flatMap((match) => paragraphs(match[1]).map((paragraph) => ({ type: 'item', text: paragraph.text, level: 0 })));
    });
}

/** The values a chart caches for a series, category list or title, by their index; a lone value is index 0. */
function chartValues(xml) {
  const text = String(xml ?? '');
  const clean = (value) => decodeXml(value).replace(/\s+/g, ' ').trim();
  const points = [...text.matchAll(/<c:pt\b[^>]*\bidx="(\d+)"[^>]*>\s*<c:v>([\s\S]*?)<\/c:v>/g)]
    .map((match) => ({ index: Number(match[1]), value: clean(match[2]) }));
  if (points.length) return points;
  const lone = text.match(/<c:v>([\s\S]*?)<\/c:v>/)?.[1];
  return lone ? [{ index: 0, value: clean(lone) }] : [];
}

/** A chart's titles, then its data as a table: a row per category, a column per series. */
function chartPartBlocks(xml) {
  // A title is written out, or taken from a cell whose value the chart keeps.
  const titles = [...xml.matchAll(/<c:title>([\s\S]*?)<\/c:title>/g)]
    .map((match) => paragraphs(match[1]).map((paragraph) => paragraph.text).join(' ') || chartValues(match[1])[0]?.value)
    .filter(Boolean).map((text) => ({ type: 'paragraph', text, level: 0 }));
  const series = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map(([, body]) => ({
    name: chartValues(body.match(/<c:tx>([\s\S]*?)<\/c:tx>/)?.[1])[0]?.value ?? '',
    categories: chartValues(body.match(/<c:(?:cat|xVal)>([\s\S]*?)<\/c:(?:cat|xVal)>/)?.[1]),
    values: chartValues(body.match(/<c:(?:val|yVal)>([\s\S]*?)<\/c:(?:val|yVal)>/)?.[1]),
  }));
  const categories = series.find((entry) => entry.categories.length)?.categories ?? [];
  const count = Math.min(MAX_CHART_ROWS, Math.max(categories.length, ...series.map((entry) => entry.values.length), 0));
  if (!count) return titles;
  const named = (list, index) => list.find((entry) => entry.index === index)?.value ?? '';
  const rows = [['', ...series.map((entry) => entry.name)],
    ...Array.from({ length: count }, (_, index) => [named(categories, index), ...series.map((entry) => named(entry.values, index))])];
  return [...titles, ...tableBlock(rows)];
}

/** Charts keep their words and numbers in parts of their own, which the slide links to. */
function chartBlocks(zip, slidePart, slideRelationships) {
  return slideRelationships.filter((relation) => relation.type === CHART && !relation.external)
    .flatMap((relation) => chartPartBlocks(partText(zip, relationshipTarget(slidePart, relation.target))));
}

function slideBlocks(zip, part) {
  // Alternate content repeats a shape for older readers; the first choice is enough.
  const xml = partText(zip, part).replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '');
  const blocks = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>|<a:tbl\b[\s\S]*?<\/a:tbl>/g)]
    .flatMap(([element]) => element.startsWith('<a:tbl') ? tableBlock(tableRows(element)) : shapeBlocks(element));
  const own = relationships(partText(zip, relationshipsPart(part)));
  return { blocks: [...blocks, ...diagramBlocks(zip, part, own), ...chartBlocks(zip, part, own)],
    hidden: /<p:sld\b[^>]*\sshow="0"/.test(xml) };
}

function coreProperty(xml, name) {
  const value = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
  return value ? decodeXml(value).replace(/\s+/g, ' ').trim() || null : null;
}

/** The slide parts of a deck, in the order its slide list gives them. */
export function slideParts(zip) {
  const presentation = partText(zip, PRESENTATION_PART);
  const byId = new Map(relationships(partText(zip, relationshipsPart(PRESENTATION_PART)))
    .map((relation) => [relation.id, relation]));
  const list = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)?.[1] ?? '';
  return [...list.matchAll(/<p:sldId\b[^>]*>/g)].flatMap(([tag]) => {
    const relation = byId.get(attribute(tag, 'r:id'));
    return relation && !relation.external
      ? [{ id: attribute(tag, 'id'), relationshipId: relation.id, part: relationshipTarget(PRESENTATION_PART, relation.target) }] : [];
  });
}

const UNREADABLE = Object.freeze({ title: null, author: null, subject: null, keywords: null, created: null,
  slideCount: 0, slides: [], slideSize: DEFAULT_SLIDE_SIZE, extraction: 'PPTX_UNREADABLE' });

/** The shape every slide of the deck has, in EMUs. */
function slideSize(presentation) {
  const tag = presentation.match(/<p:sldSz\b[^>]*>/)?.[0] ?? '';
  const width = Number(attribute(tag, 'cx'));
  const height = Number(attribute(tag, 'cy'));
  return width > 0 && height > 0 ? { width, height } : DEFAULT_SLIDE_SIZE;
}

/**
 * A deck's slides with their text, and its document properties. A deck that
 * is not a readable zip (a password-protected file is not) is unreadable.
 * @param {Buffer} buffer
 */
export function readPresentation(buffer) {
  try {
    const zip = readZip(buffer);
    if (!zip?.has(PRESENTATION_PART)) return UNREADABLE;
    const parts = slideParts(zip);
    const slides = parts.slice(0, MAX_SLIDES).map(({ part }, index) => {
      const { blocks, hidden } = slideBlocks(zip, part);
      const title = blocks.find((block) => block.type === 'title')?.text ?? null;
      return { number: index + 1, title, hidden, blocks };
    });
    const core = partText(zip, 'docProps/core.xml');
    return {
      title: coreProperty(core, 'dc:title'), author: coreProperty(core, 'dc:creator'),
      subject: coreProperty(core, 'dc:subject'), keywords: coreProperty(core, 'cp:keywords'),
      created: coreProperty(core, 'dcterms:created'), slideCount: parts.length, slides,
      slideSize: slideSize(partText(zip, PRESENTATION_PART)), extraction: 'PPTX_OOXML',
    };
  } catch {
    return UNREADABLE;
  }
}

// Slide text is written as Markdown, so its own punctuation is escaped.
const escapeInline = (text) => text.replace(/[\\`*_[\]|~]/g, '\\$&');
// A line must not read as a heading, list item or quote: "1. Scope" stays prose.
const escapeLine = (text) => escapeInline(text).replace(/^[#+>-]/, '\\$&').replace(/^(\d{1,9})([.)])/, '$1\\$2');
const tableCell = (text) => escapeInline(text.replace(/\|/g, '∣'));

/** "Slide 3 · Revenue", the heading each slide's outline starts with. */
export function slideHeading(slide) {
  return `Slide ${slide.number}${slide.title ? ` · ${slide.title}` : ''}`;
}

/**
 * A deck as one Markdown outline, the lines each slide's part of it covers,
 * and every piece of text on a slide with the line it is written on: its
 * title, each bullet, paragraph and table row. Suggestions offer each of them,
 * however short, citing its line.
 * @returns {{ text: string, slides: Array<{ number: number, title: string|null, lineStart: number, lineEnd: number }>,
 *   texts: Array<{ text: string, line: number, kind: 'title'|'item'|'paragraph'|'row', slide: number }>,
 *   slideSize: { width: number, height: number } }}
 */
export function presentationOutline(deck) {
  const lines = [];
  const slides = [];
  const texts = [];
  for (const slide of deck.slides) {
    const lineStart = lines.length + 1;
    const written = (kind, text) => texts.push({ text, line: lines.length, kind, slide: slide.number });
    lines.push(`## Slide ${slide.number}${slide.title ? ` · ${escapeInline(slide.title)}` : ''}`);
    if (slide.title) written('title', slide.title);
    let titled = Boolean(slide.title);
    let previous = 'heading';
    let numbers = [];
    for (const block of slide.blocks) {
      // The first title is the heading; another title box reads as prose.
      if (block.type === 'title' && titled && block.text === slide.title) { titled = false; continue; }
      if (block.type !== 'item' || previous !== 'item') lines.push('');
      if (block.type === 'table') {
        const width = Math.max(...block.rows.map((row) => row.length));
        const padded = block.rows.map((row) => Array.from({ length: width }, (_, index) => tableCell(row[index] ?? '')));
        padded.forEach((row, index) => {
          lines.push(`| ${row.join(' | ')} |`);
          const cells = block.rows[index].map((cell) => cell.trim()).filter(Boolean);
          if (cells.length) written('row', cells.join(' · '));
          if (index === 0) lines.push(`| ${row.map(() => '---').join(' | ')} |`);
        });
      } else if (block.type === 'item') {
        numbers = numbers.slice(0, block.level + 1);
        numbers[block.level] = (previous === 'item' ? numbers[block.level] ?? 0 : 0) + 1;
        const marker = block.ordered ? `${numbers[block.level]}.` : '-';
        lines.push(`${'  '.repeat(block.level)}${marker} ${escapeInline(block.text)}`);
        written('item', block.text);
      } else {
        lines.push(escapeLine(block.text));
        written('paragraph', block.text);
      }
      previous = block.type;
    }
    slides.push({ number: slide.number, title: slide.title, lineStart, lineEnd: lines.length });
    lines.push('');
  }
  return { text: lines.join('\n'), slides, texts, slideSize: deck.slideSize ?? DEFAULT_SLIDE_SIZE };
}

/**
 * What a slide menu lists, and the shape of every slide (width over height),
 * so a slide not yet drawn is given its place.
 */
export function deckSummary(outline) {
  const size = outline.slideSize ?? DEFAULT_SLIDE_SIZE;
  return { slides: outline.slides.map(({ number, title }) => ({ number, title })),
    aspect: Math.round((size.width / size.height) * 10_000) / 10_000 };
}

/** The slide whose part of the outline holds a line. */
export function slideAtLine(outline, line) {
  return outline.slides.find((slide) => line >= slide.lineStart && line <= slide.lineEnd) ?? null;
}

/** A deck's words without Markdown, for search: each slide's title, then its text. */
export function presentationPlainText(deck, limit = MAX_TEXT_EXCERPT) {
  return deck.slides.map((slide) => slide.blocks.map((block) => (block.type === 'table'
    ? block.rows.map((row) => row.filter(Boolean).join(' · ')).join('\n') : block.text)).join('\n'))
    .join('\n\n').slice(0, limit);
}
