// The document the passage picker shows when Tab is pressed on a passage:
// the cited file as plain text to highlight from, with where each part of it
// is (a video's words and their times, a deck's slides, a PDF's pages, a
// Word document's sections, a text file's lines) so the words chosen can be
// cited. It only reads a file and its transcript as they were indexed.

import path from 'node:path';
import { extractDocxFullText, extractDocxHeadings } from '../dependencies/document-extraction.js';
import { extractDrawingDocument } from '../dependencies/drawing-extraction.js';
import { isPresentationPath, readPresentation } from '../dependencies/presentation-extraction.js';
import { videoTimestamp } from '../dependencies/quoted-phrase.js';

// The most text one picker shows; a longer file is cut here.
const MAX_PICKER_TEXT = 400_000;
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v']);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text', '.rst', '.log']);
// A word that ends a sentence: terminal punctuation, then any closing quote or bracket.
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

/**
 * Which picker a file opens, or null when its passages are not picked from
 * a document (a table, a drawing, code).
 * @param {string} filePath
 * @returns {'video' | 'slides' | 'pdf' | 'word' | 'text' | null}
 */
export function passageKind(filePath) {
  const extension = path.extname(String(filePath ?? '')).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (isPresentationPath(filePath)) return 'slides';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'word';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return null;
}

/**
 * @typedef {{ start: number, end: number }} Range
 * @typedef {Range & { kind: 'time' | 'slide' | 'page' | 'section' | 'line', time?: number,
 *   number?: number, line?: number, title?: string | null }} Place
 * @typedef {{ name: string, kind: string, text: string, decorations: Range[], headings: Range[],
 *   places: Place[], lineBreaks: 'space' | 'keep', truncated: boolean, unavailable?: string }} PassageDocument
 */

/**
 * The picker's document for a file. Decorations (a slide's or page's label,
 * a sentence's timestamp, a bullet) are shown but never inserted.
 * @param {{ path: string, content?: Buffer | null, transcript?: { status?: string, segments?: object[] } | null }} file
 * @returns {PassageDocument}
 */
export function passageDocument({ path: filePath, content = null, transcript = null }) {
  const kind = passageKind(filePath);
  const name = path.posix.basename(String(filePath));
  const base = { name, kind };
  if (!kind) return unavailable(base, 'This file has no passages to pick from.');
  try {
    if (kind === 'video') return videoDocument(base, transcript);
    if (!content) return unavailable(base, 'This version of the file is no longer stored.');
    if (kind === 'slides') return slidesDocument(base, content);
    if (kind === 'pdf') return pdfDocument(base, content);
    if (kind === 'word') return wordDocument(base, content);
    return textDocument(base, content);
  } catch {
    return unavailable(base, 'This file could not be read.');
  }
}

function unavailable(base, reason) {
  return { ...base, text: '', decorations: [], headings: [], places: [], lineBreaks: 'keep', truncated: false, unavailable: reason };
}

/** Builds a document's text a part at a time, keeping where each part went. */
function documentWriter() {
  let text = '';
  let truncated = false;
  const decorations = [];
  const headings = [];
  const places = [];
  return {
    get length() { return text.length; },
    get full() { return truncated || text.length >= MAX_PICKER_TEXT; },
    /** Adds text; returns where it went, or null once the document is full. */
    write(part, { decoration = false, heading = false } = {}) {
      if (!part) return { start: text.length, end: text.length };
      if (text.length + part.length > MAX_PICKER_TEXT) { truncated = true; return null; }
      const range = { start: text.length, end: text.length + part.length };
      text += part;
      if (decoration) decorations.push(range);
      if (heading) headings.push(range);
      return range;
    },
    place(start, end, details) {
      if (end > start) places.push({ start, end, ...details });
    },
    done(fields) {
      return { ...fields, text, decorations, headings, places, truncated };
    },
  };
}

/** A transcript a sentence per line, each line after the time it starts at, each word placed at its time. */
function videoDocument(base, transcript) {
  const segments = transcript?.segments ?? [];
  if (!segments.length) return unavailable(base, transcript ? 'No speech was heard in this video.' : 'This video has not been transcribed yet.');
  const words = segments.flatMap((segment) => (segment.words?.length ? segment.words : [{ text: segment.text, start: segment.start }])
    .map((word) => ({ text: String(word.text ?? '').trim(), start: Number(word.start) || 0 }))).filter((word) => word.text);
  const writer = documentWriter();
  let sentence = [];
  const flush = () => {
    if (!sentence.length || writer.full) { sentence = []; return; }
    writer.write(`${videoTimestamp(sentence[0].start)}  `, { decoration: true });
    sentence.forEach((word, index) => {
      if (index) writer.write(' ');
      const range = writer.write(word.text);
      if (range) writer.place(range.start, range.end, { kind: 'time', time: word.start });
    });
    writer.write('\n');
    sentence = [];
  };
  for (const word of words) {
    sentence.push(word);
    if (SENTENCE_END.test(word.text)) flush();
  }
  flush();
  return writer.done({ ...base, lineBreaks: 'space' });
}

/** A deck a slide at a time: its label, then its title, bullets, paragraphs and table rows a line each. */
function slidesDocument(base, content) {
  const deck = readPresentation(content);
  if (!deck.slides?.length) return unavailable(base, 'This deck has no slides to read.');
  const writer = documentWriter();
  for (const slide of deck.slides) {
    if (writer.full) break;
    if (writer.length) writer.write('\n');
    writer.write(`Slide ${slide.number}\n`, { decoration: true });
    const start = writer.length;
    const line = (text, options = {}) => {
      if (options.marker) writer.write(options.marker, { decoration: true });
      writer.write(text, { heading: options.heading });
      writer.write('\n');
    };
    let titled = false;
    for (const block of slide.blocks) {
      if (block.type === 'title' && !titled && block.text === slide.title) { titled = true; line(block.text, { heading: true }); continue; }
      if (block.type === 'table') {
        for (const row of block.rows) {
          const cells = row.map((cell) => String(cell ?? '').trim()).filter(Boolean);
          if (cells.length) line(cells.join(' · '));
        }
      } else if (block.type === 'item') {
        line(block.text, { marker: `${'  '.repeat(block.level ?? 0)}• ` });
      } else if (block.text) {
        line(block.text);
      }
    }
    writer.place(start, writer.length, { kind: 'slide', number: slide.number });
  }
  return writer.done({ ...base, lineBreaks: 'keep' });
}

/** A PDF a page at a time, after each page's label. */
function pdfDocument(base, content) {
  const pages = extractDrawingDocument(content).pages ?? [];
  const writer = documentWriter();
  pages.forEach((page, index) => {
    const text = String(page.text ?? '').trim();
    if (!text || writer.full) return;
    const number = Number.isInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : index + 1;
    if (writer.length) writer.write('\n\n');
    writer.write(`Page ${number}\n`, { decoration: true });
    const range = writer.write(text);
    if (range) writer.place(range.start, range.end, { kind: 'page', number });
  });
  if (!writer.length) return unavailable(base, 'This PDF has no text to select.');
  return writer.done({ ...base, lineBreaks: 'space' });
}

/**
 * A Word document a paragraph at a time, with a blank line between, as its
 * passages cite it: paragraph i is on line 1 + 2i. Each paragraph is in the
 * section of the heading above it.
 */
function wordDocument(base, content) {
  const paragraphs = extractDocxFullText(content).split('\n\n').filter(Boolean);
  if (!paragraphs.length) return unavailable(base, 'This document has no text to select.');
  const headings = new Map(extractDocxHeadings(content).map((heading) => [heading.line, heading.text]));
  const writer = documentWriter();
  let section = null;
  paragraphs.forEach((paragraph, index) => {
    if (writer.full) return;
    const line = 1 + index * 2;
    const heading = headings.has(line);
    if (heading) section = paragraph;
    if (index) writer.write('\n\n');
    const range = writer.write(paragraph, { heading });
    if (range) writer.place(range.start, range.end, { kind: 'section', line, title: section });
  });
  return writer.done({ ...base, lineBreaks: 'keep' });
}

/** A text or Markdown file as written, each line placed at its number. */
function textDocument(base, content) {
  const lines = content.toString('utf8').split(/\r\n?|\n/);
  const writer = documentWriter();
  lines.forEach((line, index) => {
    if (writer.full) return;
    if (index) writer.write('\n');
    const range = writer.write(line);
    if (range) writer.place(range.start, range.end, { kind: 'line', number: index + 1 });
  });
  if (!writer.length || !/\S/.test(content.toString('utf8'))) return unavailable(base, 'This file has no text to select.');
  return writer.done({ ...base, lineBreaks: 'keep' });
}
