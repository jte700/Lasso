// The objects a file yields, by format: documents, PDF and text passages,
// slides, code lines, JSON values and a paper's citation details.

import path from 'node:path';
import { diffInternals } from '../history/diff.js';
import {
  extractDocxDocument, extractPdfDocument, extractPdfPassages, extractTaggedReferences,
} from './document-extraction.js';
import { markdownPassages } from '../sharing/markdown.js';
import { firstAuthorFamily } from './authors.js';
import { drawingDescriptors, isDesignFile } from './drawing-objects.js';
import { normalizedVariable } from './tabular.js';
import { recordFields } from './record-fields.js';
import {
  presentationOutline, presentationPlainText, readPresentation, slideAtLine, slideHeading,
} from './presentation-extraction.js';
import { codeOfLines, fileLines, linesLabel } from './code-lines.js';
import { isCodeType } from '../history/file-types.js';
import { sha } from './basics.js';
import { CODE_LINES_KEY } from './constants.js';
import { objectDescriptor } from './object-descriptors.js';
import { numericDescriptor } from './value-match.js';

export function dependencyFilePriority(file) {
  const source = String(file.path ?? '').toLowerCase();
  if (/(^|\/)(results?|outputs?|references?|papers?|literature|readings?|articles?|publications?)(\/|$)/.test(source)) return 5;
  if (/(^|\/)(analysis|models?|figures?|tables?|data|datasets?|runs?)(\/|$)/.test(source)) return 4;
  if (/(^|\/)manuscripts?(\/|$)/.test(source)) return 2;
  return 1;
}

function parseBibtex(text) {
  const entries = [];
  const pattern = /@(article|book|inproceedings|misc|techreport)\s*\{\s*([^,]+),([\s\S]*?)(?=\n@|$)/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const fields = {};
    for (const field of match[3].matchAll(/(title|author|year|doi|pmid)\s*=\s*[\{"]([^\}"]+)[\}"]/gi)) {
      fields[field[1].toLowerCase()] = field[2].replace(/\s+/g, ' ').trim();
    }
    entries.push({ key: match[2].trim(), ...fields });
  }
  return entries;
}

function titleFromFileName(fileName) {
  return String(fileName).replace(/[_-]+/g, ' ').replace(/\b(?:19|20)\d{2}[a-z]?\b/gi, '')
    .replace(/\s+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// A file name names an author only in citation form: "Johnson_2023" or
// "smith-et-al-2019-title". "Orchard-Services-Agreement" must not become a
// citation written by "Orchard".
const CITATION_FILE_NAME = /^([A-Za-z][A-Za-z'’]+)(?:[_ -]+et[_ -]?al\.?)?[_ -]+(?:19|20)\d{2}(?!\d)/i;

function paperMetadata(fileName) {
  const year = fileName.match(/\b(?:19|20)\d{2}[a-z]?\b/i)?.[0] ?? null;
  const authorToken = fileName.match(CITATION_FILE_NAME)?.[1] ?? '';
  const author = authorToken ? authorToken[0].toUpperCase() + authorToken.slice(1) : '';
  const title = titleFromFileName(fileName) || fileName;
  return {
    author: author || null,
    year,
    title,
    label: author ? `${author} et al.${year ? `, ${year}` : ''}` : title,
  };
}

function referenceLikePath(filePath) {
  return /(^|\/)(references?|papers?|literature|readings?|articles?|publications?)(\/|$)/i.test(filePath);
}

function flattenJson(value, prefix = '$', output = []) {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) flattenJson(child, `${prefix}.${key}`, output);
  } else if (value != null) output.push({ path: prefix, value: String(value) });
  return output;
}

// "Figure 2", "Table S1", "Fig. 3b", "Table A" and "Figure IV" name document
// components. Ordinary prose such as "a figure found only there" does not.
export function isComponentIdentifier(value) {
  const identifier = String(value ?? '');
  return /\d/.test(identifier) || /^[A-Z]$/.test(identifier) || /^[IVXL]{1,6}$/.test(identifier);
}

function documentComponentDescriptors(file, sourceText, parentMetadata, base) {
  const text = String(sourceText ?? '').replace(/\r\n/g, '\n');
  const descriptors = [];
  const seen = new Set();
  for (const match of text.matchAll(/\b(Table|Figure|Fig\.?)\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)/gi)) {
    const type = /^table$/i.test(match[1]) ? 'TABLE' : 'FIGURE';
    const identifier = match[2];
    if (!isComponentIdentifier(identifier)) continue;
    const componentLabel = `${type === 'TABLE' ? 'Table' : 'Figure'} ${identifier}`;
    const key = `${type}:${identifier.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lineEnd = text.indexOf('\n', match.index);
    const afterLabel = match.index + match[0].length;
    const captionSeparator = text.slice(afterLabel).match(/^\s*[.:—-]\s*/)?.[0].length ?? 0;
    const sentenceStart = afterLabel + captionSeparator;
    const sentenceOffset = text.slice(sentenceStart, sentenceStart + 520).search(/[.!?](?:\s|$)/);
    const sentenceEnd = sentenceOffset >= 0 ? sentenceStart + sentenceOffset + 1 : -1;
    const endCandidates = [lineEnd, sentenceEnd]
      .filter((value) => value > match.index);
    const end = Math.min(...(endCandidates.length ? endCandidates : [Math.min(text.length, match.index + 320)]));
    const context = text.slice(match.index, Math.min(end, match.index + 420)).replace(/\s+/g, ' ').trim();
    descriptors.push(objectDescriptor({
      key: `${base}:component:${type.toLowerCase()}:${normalizedVariable(identifier)}`,
      type,
      path: file.path,
      anchor: {
        kind: type === 'TABLE' ? 'document-table' : 'document-figure',
        identifier,
        start: match.index,
        end,
      },
      label: componentLabel,
      value: context || componentLabel,
      contentHash: file.contentHash,
      metadata: {
        componentType: type,
        componentLabel,
        identifier,
        parentTitle: parentMetadata.title ?? parentMetadata.heading ?? null,
        parentAuthor: parentMetadata.author ?? null,
        parentYear: parentMetadata.year ?? null,
        textExcerpt: context || null,
      },
    }));
  }
  return descriptors;
}

function pdfPassageDescriptors(file, buffer, parentMetadata) {
  const repeats = new Map();
  return extractPdfPassages(buffer).map(passage => {
    const fingerprint = sha(`${passage.excerptType}|${passage.selectedText.toLowerCase()}`).slice(0, 24);
    const occurrence = repeats.get(fingerprint) ?? 0;
    repeats.set(fingerprint, occurrence + 1);
    return objectDescriptor({
      key: `${file.projectFileId}:pdf-excerpt:${fingerprint}:${occurrence}`, type: 'DOCUMENT',
      path: file.path, contentHash: file.contentHash,
      label: passage.selectedText.length > 110 ? `${passage.selectedText.slice(0, 107)}…` : passage.selectedText,
      value: passage.selectedText,
      anchor: { kind: 'pdf-excerpt', pageNumber: passage.pageNumber, selectedText: passage.selectedText,
        start: passage.start, end: passage.end, bbox: passage.bbox },
      metadata: { format: 'PDF', componentType: 'PDF_EXCERPT', excerptType: passage.excerptType,
        rawText: passage.selectedText, textExcerpt: passage.selectedText, pageNumber: passage.pageNumber,
        parentTitle: parentMetadata.title ?? null, parentAuthor: parentMetadata.author ?? null,
        parentYear: parentMetadata.year ?? null },
    });
  });
}

/**
 * `outline` is a deck's slide outline, when `text` is one: each passage then
 * also names the slide it is on.
 */
function textPassageDescriptors(file, text, parentMetadata, outline = null) {
  const markdown = file.fileType === 'markdown' || Boolean(outline);
  const repeats = new Map();
  return markdownPassages(text, { plain: !markdown }).map(passage => {
    const slide = outline ? slideAtLine(outline, passage.lineStart) : null;
    const fingerprint = sha(`${passage.excerptType}|${passage.selectedText.toLowerCase()}`).slice(0, 24);
    const occurrence = repeats.get(fingerprint) ?? 0;
    repeats.set(fingerprint, occurrence + 1);
    return objectDescriptor({
      key: `${file.projectFileId}:text-excerpt:${fingerprint}:${occurrence}`, type: 'DOCUMENT',
      path: file.path, contentHash: file.contentHash,
      label: passage.selectedText.length > 110 ? `${passage.selectedText.slice(0, 107)}…` : passage.selectedText,
      value: passage.selectedText,
      anchor: { kind: 'text-excerpt', selectedText: passage.selectedText, start: passage.start, end: passage.end,
        lineStart: passage.lineStart, lineEnd: passage.lineEnd, ...(slide ? { slideNumber: slide.number } : {}) },
      metadata: { format: parentMetadata.format, componentType: 'TEXT_EXCERPT', excerptType: passage.excerptType,
        rawText: passage.selectedText, textExcerpt: passage.selectedText,
        lineStart: passage.lineStart, lineEnd: passage.lineEnd, section: passage.section ?? null,
        ...(slide ? { slideNumber: slide.number, slideTitle: slide.title } : {}),
        parentTitle: parentMetadata.title ?? null, parentAuthor: null, parentYear: null },
    });
  });
}

/**
 * @param {(code: string, reason: string) => void} report receives a problem
 *   that keeps some or all of the file out of suggestions, so it can be shown
 *   in the indexing issues instead of disappearing silently
 */
export function objectsFromFile(file, buffer, report = () => {}) {
  const objects = [];
  const base = file.projectFileId;
  const fileName = path.posix.basename(file.path, path.posix.extname(file.path));
  const text = buffer.subarray(0, 5_000_000).toString('utf8').replace(/\r\n/g, '\n');

  if (file.fileType === 'pdf' || isDesignFile(file)) {
    const { drawing, descriptors } = drawingDescriptors(file, buffer);
    if (drawing.isDrawing) return [
      ...descriptors.map(objectDescriptor),
      ...(file.fileType === 'pdf' ? pdfPassageDescriptors(file, buffer, { title: drawing.pages[0]?.title ?? fileName }) : []),
    ];
  }

  // Tables and workbooks are read by tableObjectSteps, which can index them whole,
  // and videos by videoObjectSteps, from their transcripts (video-extraction.js).
  if (isCodeType(file.fileType)) {
    objects.push(objectDescriptor({
      key: `${base}:code`, type: /model|analysis/i.test(fileName) ? 'MODEL' : 'CODE_BLOCK', path: file.path,
      label: fileName, contentHash: file.contentHash,
      // The whole file, nameable while writing; its lines follow it.
      metadata: { file: file.path, codeFile: true, lineCount: fileLines(text).length },
    }));
    text.split('\n').slice(0, 4000).forEach((line, index) => {
      const symbol = line.match(/^\s*(?:def|function|class)\s+([A-Za-z_][\w]*)|^\s*([A-Za-z_][\w.]*)\s*(?:=|<-)/);
      const method = line.match(/mixed[- ]effects?|random intercept|sctransform|normaliz(?:e|ed|ation)|regression|cox model/i);
      if (!symbol && !method) return;
      const label = symbol?.[1] ?? symbol?.[2] ?? method[0];
      objects.push(objectDescriptor({
        key: `${base}:line:${index + 1}`,
        type: method ? 'METHOD' : /model|formula/i.test(label) ? 'MODEL' : 'CODE_LINE',
        path: file.path,
        anchor: { kind: 'line', line: index + 1 },
        label,
        value: line.trim(),
        contentHash: file.contentHash,
        metadata: { line: index + 1, symbol: label },
      }));
    });
  } else if (file.fileType === 'notebook') {
    try {
      for (const [index, cell] of diffInternals.notebookCells(text).entries()) {
        objects.push(objectDescriptor({
          key: `${base}:cell:${cell.id}`, type: 'NOTEBOOK_CELL', path: file.path,
          anchor: { kind: 'notebook-cell', cellId: cell.id, cellIndex: index },
          label: `${fileName} · cell ${index + 1}`, value: cell.source.slice(0, 400),
          contentHash: file.contentHash, metadata: { cellId: cell.id, cellType: cell.type },
        }));
      }
    } catch {
      // Malformed notebooks are preserved in history but not indexed.
      report('UNREADABLE_CONTENT', 'This notebook could not be parsed, so its cells are not suggested.');
    }
  } else if (file.fileType === 'image') {
    objects.push(objectDescriptor({
      key: `${base}:figure`, type: 'FIGURE', path: file.path, label: fileName,
      contentHash: file.contentHash, metadata: file.metadata,
    }));
  } else if (file.fileType === 'json') {
    try {
      const dictionaryLike = /(?:data[_ -]?(?:dictionary|dict)|codebook|variable[_ -]?(?:definitions?|labels?)|metadata|schema)/i.test(file.path);
      for (const leaf of flattenJson(JSON.parse(text)).slice(0, 3000)) {
        const variable = leaf.path.split('.').at(-1);
        objects.push(objectDescriptor({
          key: `${base}:json:${leaf.path}`,
          type: dictionaryLike ? 'VARIABLE'
            : numericDescriptor(leaf.value) ? /(^|\/)results?\//i.test(file.path) ? 'RESULT' : 'VALUE' : 'PARAMETER',
          path: file.path, anchor: { kind: 'json-path', path: leaf.path }, label: leaf.path,
          value: leaf.value, contentHash: file.contentHash,
          metadata: {
            jsonPath: leaf.path,
            ...(dictionaryLike ? { variable, description: leaf.value, dictionary: true } : {}),
          },
        }));
      }
    } catch {
      // The line diff remains available in history.
      report('UNREADABLE_CONTENT', 'This JSON file could not be parsed, so its values are not suggested.');
    }
  } else if (file.fileType === 'pdf' || file.fileType === 'document') {
    const fallback = paperMetadata(fileName);
    const extracted = file.fileType === 'pdf' ? extractPdfDocument(buffer) : extractDocxDocument(buffer);
    if (extracted.extraction === 'DOCX_UNREADABLE') {
      report('UNREADABLE_CONTENT', 'This document could not be opened. It may be password-protected or damaged.');
    } else if (extracted.extraction === 'PDF_METADATA') {
      report('UNREADABLE_CONTENT', 'No text could be read from this PDF. It may be a scan without a text layer, password-protected or damaged.');
    }
    const author = extracted.author || fallback.author;
    const family = firstAuthorFamily(author);
    const year = extracted.year || fallback.year;
    const title = extracted.title || fallback.title;
    const referenceLike = file.fileType === 'pdf' || referenceLikePath(file.path) || Boolean(extracted.doi);
    const multipleAuthors = (extracted.authors?.length ?? 0) > 1 || /\s+(?:and|&)\s+|;/.test(author ?? '');
    const label = family ? `${family}${multipleAuthors ? ' et al.' : ''}${year ? `, ${year}` : ''}` : title;
    const parentMetadata = {
      ...extracted, author: author || null, year: year || null, title,
      format: file.fileType.toUpperCase(), fileName: path.posix.basename(file.path),
    };
    objects.push(objectDescriptor({
      key: `${base}:${referenceLike ? 'paper' : 'document'}`,
      type: referenceLike ? 'PAPER' : 'DOCUMENT', path: file.path,
      label, value: title, contentHash: file.contentHash,
      metadata: parentMetadata,
    }));
    objects.push(...documentComponentDescriptors(file, extracted.textExcerpt, parentMetadata, base));
    if (file.fileType === 'pdf') objects.push(...pdfPassageDescriptors(file, buffer, parentMetadata));
  } else if (file.fileType === 'presentation') {
    objects.push(...presentationDescriptors(file, buffer, fileName, report));
  } else if (file.fileType === 'markdown' || (file.fileType === 'text' && path.extname(file.path).toLowerCase() === '.txt')) {
    const referenceLike = referenceLikePath(file.path);
    const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    // A note written as a record (a title, then labelled fields, as connected
    // apps write mail, events and pages) offers its fields after its title.
    const record = file.fileType === 'markdown' && !referenceLike ? recordFields(text) : null;
    const parentMetadata = { format: file.fileType === 'markdown' ? 'MARKDOWN' : 'TXT',
      heading: heading ?? null, title: heading ?? fileName,
      ...(file.fileType === 'text' ? { textExcerpt: text.slice(0, 20_000) } : {}),
      ...(record ? { recordFields: record.fields.map((field) => field.label) } : {}) };
    objects.push(objectDescriptor({
      key: `${base}:document`, type: referenceLike ? 'PAPER' : 'DOCUMENT', path: file.path,
      label: heading || fileName, value: heading || text.slice(0, 240), contentHash: file.contentHash,
      metadata: parentMetadata,
    }));
    objects.push(...documentComponentDescriptors(file, text, parentMetadata, base));
    // A field's line is that field, not a passage of prose.
    const fieldLines = new Set(record?.fields.map((field) => field.line));
    objects.push(...textPassageDescriptors(file, text, parentMetadata)
      .filter((passage) => !fieldLines.has(passage.anchor.lineStart)));
    const labels = new Map();
    for (const field of record?.fields ?? []) {
      const key = normalizedVariable(field.label);
      const occurrence = labels.get(key) ?? 0;
      labels.set(key, occurrence + 1);
      objects.push(objectDescriptor({
        key: `${base}:record-field:${key}${occurrence ? `:${occurrence}` : ''}`, type: 'VALUE', path: file.path,
        label: `${record.title} · ${field.label}`, value: field.text, contentHash: file.contentHash,
        anchor: { kind: 'text-excerpt', selectedText: field.value, start: field.start, end: field.end,
          lineStart: field.line, lineEnd: field.line },
        metadata: { format: 'MARKDOWN', componentType: 'RECORD_FIELD', field: field.label, role: field.role,
          record: record.title, rawText: field.value, lineStart: field.line, lineEnd: field.line,
          parentTitle: record.title },
      }));
    }
  }

  if (path.extname(file.path).toLowerCase() === '.bib') {
    for (const reference of parseBibtex(text)) {
      const author = firstAuthorFamily(reference.author) || reference.key;
      const label = `${author}${reference.author?.match(/\s+and\s+/i) ? ' et al.' : ''}${reference.year ? `, ${reference.year}` : ''}`;
      objects.push(objectDescriptor({
        key: `${base}:reference:${reference.key}`, type: 'REFERENCE', path: file.path,
        anchor: { kind: 'reference-entry', key: reference.key }, label,
        value: reference.title ?? label, contentHash: file.contentHash,
        metadata: { citationKey: reference.key, ...reference },
      }));
    }
  }

  if (['.ris', '.enw', '.nbib'].includes(path.extname(file.path).toLowerCase())) {
    for (const reference of extractTaggedReferences(text)) {
      const author = firstAuthorFamily(reference.author) || reference.key;
      const label = `${author}${reference.authors?.length > 1 ? ' et al.' : ''}${reference.year ? `, ${reference.year}` : ''}`;
      objects.push(objectDescriptor({
        key: `${base}:reference:${reference.key}`, type: 'REFERENCE', path: file.path,
        anchor: { kind: 'reference-entry', key: reference.key }, label,
        value: reference.title ?? label, contentHash: file.contentHash,
        metadata: { ...reference },
      }));
    }
  }

  if (/run[_-]?\d|analysis[_-]?run/i.test(fileName)) {
    objects.push(objectDescriptor({
      key: `${base}:run`, type: 'ANALYSIS_RUN', path: file.path, label: fileName,
      contentHash: file.contentHash, metadata: { file: file.path },
    }));
  }
  return objects;
}

/**
 * A deck: the whole deck, nameable by its title or file name, and the
 * sentences and paragraphs of its slides, each knowing its slide. They cite
 * lines of the deck's slide outline, which previews and shares read the same way.
 */
function presentationDescriptors(file, buffer, fileName, report) {
  const deck = readPresentation(buffer);
  if (deck.extraction === 'PPTX_UNREADABLE') {
    report('UNREADABLE_CONTENT', 'This presentation could not be opened. It may be password-protected or damaged.');
  }
  const outline = presentationOutline(deck);
  const title = deck.title || deck.slides.find((slide) => slide.title)?.title || titleFromFileName(fileName);
  const parentMetadata = {
    format: 'PPTX', title, author: deck.author, subject: deck.subject, keywords: deck.keywords,
    slideCount: deck.slideCount, fileName: path.posix.basename(file.path), textExcerpt: presentationPlainText(deck),
  };
  const withSlide = (descriptor) => {
    const line = descriptor.anchor?.lineStart ?? (Number.isInteger(descriptor.anchor?.start)
      ? outline.text.slice(0, descriptor.anchor.start).split('\n').length : null);
    const slide = line ? slideAtLine(outline, line) : null;
    return slide ? { ...descriptor, anchor: { ...descriptor.anchor, slideNumber: slide.number },
      metadata: { ...descriptor.metadata, slideNumber: slide.number, slideTitle: slide.title } } : descriptor;
  };
  const passages = textPassageDescriptors(file, outline.text, parentMetadata, outline);
  return [
    objectDescriptor({
      key: `${file.projectFileId}:document`, type: 'DOCUMENT', path: file.path,
      label: title, value: title, contentHash: file.contentHash, metadata: parentMetadata,
    }),
    ...documentComponentDescriptors(file, outline.text, parentMetadata, file.projectFileId).map(withSlide),
    ...passages,
    ...slideTextDescriptors(file, outline, parentMetadata, passages),
  ];
}

// A slide's title, short line or table row needs this many words to be offered.
const MIN_SLIDE_TEXT_WORDS = 2;
// ...and completes what is being written once it is this long.
export const SLIDE_SENTENCE_LIMITS = Object.freeze({ minLength: 8, minWords: MIN_SLIDE_TEXT_WORDS });
const SLIDE_TEXT_EXCERPTS = Object.freeze({ title: 'title', row: 'row', item: 'line', paragraph: 'line' });
const comparableText = (value) => String(value ?? '').toLowerCase().replace(/[\W_]+/g, ' ').trim();

/**
 * What is on a deck's slides that its sentences and paragraphs leave out:
 * titles, lines too short to be sentences, and table and chart rows. Each is
 * offered as written and cites its line of the slide outline, so the card and
 * shares show the slide it is on.
 */
function slideTextDescriptors(file, outline, parentMetadata, passages) {
  const offered = new Set(passages.map((passage) => comparableText(passage.value)));
  const lineStarts = [0];
  for (let index = outline.text.indexOf('\n'); index >= 0; index = outline.text.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  const slides = new Map(outline.slides.map((slide) => [slide.number, slide]));
  const repeats = new Map();
  return outline.texts.flatMap((entry) => {
    const text = entry.text.replace(/\s+/g, ' ').trim();
    if ((text.match(/\p{L}+/gu)?.length ?? 0) < MIN_SLIDE_TEXT_WORDS || offered.has(comparableText(text))) return [];
    const excerptType = SLIDE_TEXT_EXCERPTS[entry.kind];
    const fingerprint = sha(`${excerptType}|${text.toLowerCase()}`).slice(0, 24);
    const occurrence = repeats.get(fingerprint) ?? 0;
    repeats.set(fingerprint, occurrence + 1);
    const start = lineStarts[entry.line - 1] ?? 0;
    const end = (lineStarts[entry.line] ?? outline.text.length + 1) - 1;
    const slide = slides.get(entry.slide);
    return [objectDescriptor({
      key: `${file.projectFileId}:slide-text:${fingerprint}:${occurrence}`, type: 'DOCUMENT',
      path: file.path, contentHash: file.contentHash,
      label: text.length > 110 ? `${text.slice(0, 107)}…` : text,
      value: text,
      anchor: { kind: 'text-excerpt', selectedText: text, start, end,
        lineStart: entry.line, lineEnd: entry.line, slideNumber: entry.slide },
      metadata: { format: 'PPTX', componentType: 'TEXT_EXCERPT', excerptType,
        rawText: text, textExcerpt: text, lineStart: entry.line, lineEnd: entry.line,
        section: slide ? slideHeading(slide) : null, slideNumber: entry.slide, slideTitle: slide?.title ?? null,
        parentTitle: parentMetadata.title ?? null, parentAuthor: null, parentYear: null },
    })];
  });
}

/** Lines `first` through `last` of a code file as an object, or null when the file has no such lines. */
export function codeLinesDescriptor(file, lines, first, last) {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > lines.length) return null;
  const code = codeOfLines(lines, first, last);
  if (!code.trim()) return null;
  return objectDescriptor({
    key: `${file.projectFileId}:${CODE_LINES_KEY}:${first}-${last}`, type: 'CODE_LINE', path: file.path,
    anchor: { kind: 'line-range', lineStart: first, lineEnd: last },
    label: linesLabel(first, last), value: code, contentHash: file.contentHash,
    metadata: { lineStart: first, lineEnd: last, lineReference: true },
  });
}
