// Small table preview for the public share page. Reuses the same spreadsheet
// extraction and header detection as the workspace so the cited cell is
// identified identically in both places.

import path from 'node:path';
import { columnLetter, tableContext } from '../dependencies/table-preview.js';
import { extractDocxFullText, extractPdfFullText, extractSpreadsheetTables } from '../dependencies/document-extraction.js';
import { extractDrawingDocument } from '../dependencies/drawing-extraction.js';
import { tabularLayout } from '../dependencies/service.js';
import { parseDelimited } from '../history/diff.js';
import { MARKDOWN_LAYOUT, isMarkdownPath, markdownBlocks, markdownPlainText } from './markdown.js';
import { LINE_LAYOUT, fullTextLayout } from './text-layout.js';
import { isPresentationPath, presentationOutline, readPresentation, slideAtLine } from '../dependencies/presentation-extraction.js';
import { isCodePath } from '../history/file-types.js';

/// Legacy paragraph blocks are used when any stored text redaction predates
/// the file's structured layout; otherwise the structured layout is used.
export function usesStructuredLayout(redactions = [], layout = null) {
  return !redactions.some((entry) => entry.kind === 'BLOCK' && entry.layout !== layout);
}

/// Cell redactions made before semicolon files were recognised address the
/// comma reading of the file, so that reading is kept for them.
export function detectsCsvDelimiter(redactions = []) {
  return !redactions.some((entry) => entry.kind === 'CELL' && entry.delimiter !== ';');
}

const FULL_TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.qmd', '.rmd', '.rst', '.txt', '.tex', '.bib', '.ris', '.enw', '.nbib', '.log',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.r', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.kt', '.kts', '.sh', '.zsh', '.fish', '.sql',
  '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.toml', '.ini', '.env',
  '.json', '.geojson', '.yaml', '.yml', '.xml', '.rtf', '.ipynb',
]);


/**
 * Builds a few rows of context around the cited cell, or with `columnRows`
 * up to that many rows of a cited column (see tableContext).
 * Returns null for sources that are not tabular. A table too large to read
 * here arrives as `window`, its header and nearby rows from the table index.
 */
export function buildSharePreview(file, anchor = {}, metadata = {}, radius = 2, objectType = '', { display = false, columnRows = 0, window = null } = {}) {
  if (!file?.content || !file?.path) return null;
  if (window) anchor = window.anchor;
  const extension = path.extname(file.path).toLowerCase();
  if (extension === '.pdf') {
    const selectedText = String(anchor.selectedText ?? metadata.rawText
      ?? (metadata.componentType ? metadata.textExcerpt : '') ?? '').trim();
    // A whole-document reference has no cited passage. Its private viewport
    // still shows the page, but a public excerpt must be selected explicitly.
    if (!selectedText) return null;
    const pageNumber = Math.max(1, Number(anchor.pageNumber ?? metadata.pageNumber) || 1);
    return { kind: 'text-context', text: selectedText, citedText: selectedText,
      selectedText, pageNumber, bbox: anchor.bbox ?? metadata.bbox ?? null };
  }
  const isSpreadsheet = ['.xlsx', '.xls'].includes(extension);
  const isDelimited = ['.csv', '.tsv'].includes(extension);
  if (!isSpreadsheet && !isDelimited) return null;

  let rawRows = null;
  let delimitedText = null;
  let selectedTable = null;
  try {
    if (window) {
      selectedTable = window.table;
      rawRows = window.table.rows;
    } else if (isSpreadsheet) {
      const sheetName = anchor.sheet ?? metadata.sheet ?? null;
      const tables = extractSpreadsheetTables(file.content);
      const table = tables.find((sheet) => !sheetName || sheet.name === sheetName) ?? tables[0];
      rawRows = table?.rows ?? null;
      selectedTable = table;
    } else {
      delimitedText = file.content.toString('utf8');
      rawRows = parseDelimited(delimitedText, extension === '.tsv' ? '\t' : ',');
    }
  } catch {
    return null;
  }
  if (!rawRows?.length) return null;

  const layout = tabularLayout(rawRows);
  if (!layout.headers.length) return null;

  const table = selectedTable ?? { rows: rawRows };
  const context = tableContext(table, anchor, radius, layout.headerRowIndex, { display, columnRows });
  if (!context || !objectType) return context;

  // Local suggestions identify the word/value that was inserted. Public shares
  // retain their original column/data scope and do not pass an object type.
  const selection = inspectorTableSelection(table, anchor, context, layout, objectType);
  const rows = [...context.rows];
  if (selection.kind === 'header' && !rows.some((row) => row.rowNumber === selection.row)) {
    const index = selection.numbers.indexOf(selection.row);
    rows.unshift({ rowNumber: selection.row, cells: context.columns.map((column) => ({
      value: shownCell(table, index, spreadsheetColumnIndex(column), display).trim(), cited: false,
    })) });
  }
  return { ...context, location: selection.location, columnCitation: selection.kind === 'column',
    openAt: tableOpenAt(table, selection, delimitedText),
    rows: rows.map((row) => ({ ...row, cells: row.cells.map((cell, index) => ({ ...cell,
      cited: selection.cites(row.rowNumber, spreadsheetColumnIndex(context.columns[index]), cell.value),
    })) })) };
}

const spreadsheetColumnIndex = (value) => [...value]
  .reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;

/** A cell as the sheet shows it ($129,950) when `display` is on, else its stored value (129950). */
const shownCell = (table, rowIndex, column, display = true) =>
  String((display ? table.displayRows?.[rowIndex]?.[column] : null) ?? table.rows[rowIndex]?.[column] ?? '');

/** The text line a delimited record starts on: a quoted field can span lines. */
function recordLine(text, recordNumber) {
  let record = 1, line = 1, quoted = false;
  for (let index = 0; index < text.length && record < recordNumber; index += 1) {
    if (text[index] === '"') quoted = !quoted;
    else if (text[index] === '\n') {
      line += 1;
      if (!quoted) record += 1;
    }
  }
  return record === recordNumber ? line : null;
}

/** Where "Open file" lands in a table: its sheet and cell, and a delimited file's text line for editors. */
function tableOpenAt(table, selection, delimitedText = null) {
  const openAt = { sheet: table.name ?? null, cell: selection.cell };
  const row = Number(selection.cell?.match(/\d+$/)?.[0]);
  const line = delimitedText != null && row ? recordLine(delimitedText, row) : null;
  return line ? { ...openAt, line } : openAt;
}

function inspectorTableSelection(table, anchor, context, layout, objectType) {
  const numbers = table.rowNumbers ?? table.rows.map((_, index) => index + 1);
  let row = context.rows.find((entry) => entry.cells.some((cell) => cell.cited))?.rowNumber;
  let column = Number.isInteger(anchor.columnIndex) ? anchor.columnIndex
    : layout.headers.findIndex((header) => header === anchor.column);
  let kind = context.columnCitation ? 'column' : column < 0 ? 'row' : 'cell';
  if (objectType === 'VARIABLE' && context.columnCitation) {
    // A variable name is represented by its heading, although its stored anchor
    // describes the column for profiling and intentional data sharing.
    row = context.headerRowNumbers.at(-1) ?? numbers[layout.headerRowIndex];
    kind = 'header';
  } else if (objectType === 'DATASET_ROW' && anchor.rowKey != null) {
    const labelColumn = table.rows[numbers.indexOf(row)]?.findIndex((value) =>
      String(value ?? '').trim() === String(anchor.rowKey).trim()) ?? -1;
    if (labelColumn >= 0) {
      column = labelColumn;
      kind = 'cell';
    }
  }
  const position = kind === 'column' ? `Column ${columnLetter(column)} (all values)`
    : kind === 'row' ? `Row ${row} (all values)`
      : row ? `${columnLetter(column)}${row}${kind === 'header' ? ' (column header)' : ''}` : '';
  // The one worksheet cell "Open file" selects: a whole-column citation lands on
  // its heading, a whole-row citation on the row's first shown cell.
  const cellRow = kind === 'column' ? context.headerRowNumbers.at(-1) ?? row : row;
  const cellColumn = column >= 0 ? columnLetter(column) : context.columns[0];
  return { numbers, row, column, kind,
    location: [table.name, position].filter(Boolean).join(' · '),
    cell: cellRow && cellColumn ? `${cellColumn}${cellRow}` : null,
    cites: (rowNumber, columnIndex, value) => kind === 'column'
      ? columnIndex === column && Boolean(value)
      : rowNumber === row && (column < 0 || columnIndex === column),
  };
}

/** Local file viewport, preserving source rows, blank columns and line breaks. */
export function buildInspectorPreview(file, anchor = {}, metadata = {}, label = '', objectType = '', options = {}) {
  if (!file?.content || !file?.path) return null;
  const extension = path.extname(file.path).toLowerCase();
  if (options.window) anchor = options.window.anchor;
  if (['.xlsx', '.xls', '.csv', '.tsv'].includes(extension)) {
    try {
      const table = options.window ? options.window.table : ['.xlsx', '.xls'].includes(extension)
        ? (() => {
          const tables = extractSpreadsheetTables(file.content);
          const sheet = anchor.sheet ?? metadata.sheet;
          return tables.find((entry) => entry.name === sheet) ?? tables[0];
        })()
        : { rows: parseDelimited(file.content.toString('utf8'), extension === '.tsv' ? '\t' : ','),
          delimitedText: file.content.toString('utf8') };
      if (!table?.rows?.length) return null;
      const layout = tabularLayout(table.rows);
      const context = tableContext(table, anchor, 6, layout.headerRowIndex, { display: true });
      if (!context?.rows?.length) return null;
      const selection = inspectorTableSelection(table, anchor, context, layout, objectType);
      const numbers = selection.numbers;
      let firstRow = Math.max(Math.min(context.rows[0].rowNumber, selection.row ?? Infinity), (selection.row ?? 1) - 8);
      const headerRow = context.headerRowNumbers[0];
      if (headerRow && firstRow - headerRow < 12) firstRow = headerRow;
      // A window is contiguous in the original file, including empty rows.
      const lastRow = Math.min(context.rows.at(-1).rowNumber, firstRow + 80);
      const firstColumn = spreadsheetColumnIndex(context.columns[0]);
      const lastColumn = spreadsheetColumnIndex(context.columns.at(-1));
      const rows = Array.from({ length: lastRow - firstRow + 1 }, (_, index) => {
        const rowNumber = firstRow + index;
        const sourceIndex = numbers.indexOf(rowNumber);
        return { rowNumber, cells: Array.from({ length: lastColumn - firstColumn + 1 }, (_, offset) => {
          const column = firstColumn + offset;
          const merge = table.merges?.find((entry) => rowNumber >= entry.firstRow && rowNumber <= entry.lastRow
            && column >= entry.firstColumn && column <= entry.lastColumn);
          const startRow = merge ? Math.max(firstRow, merge.firstRow) : rowNumber;
          const startColumn = merge ? Math.max(firstColumn, merge.firstColumn) : column;
          const covered = Boolean(merge && (rowNumber !== startRow || column !== startColumn));
          const value = merge ? shownCell(table, numbers.indexOf(merge.firstRow), merge.firstColumn)
            : shownCell(table, sourceIndex, column);
          const cited = selection.cites(rowNumber, column, value);
          return { value, cited, covered,
            rowSpan: merge ? Math.min(lastRow, merge.lastRow) - startRow + 1 : 1,
            colSpan: merge ? Math.min(lastColumn, merge.lastColumn) - startColumn + 1 : 1 };
        }) };
      });
      return { kind: 'table', columns: Array.from({ length: lastColumn - firstColumn + 1 }, (_, index) => columnLetter(firstColumn + index)),
        rows, sheet: table.name ?? null, location: selection.location,
        openAt: tableOpenAt(table, selection, table.delimitedText) };
    } catch { return null; }
  }
  if (extension === '.pdf') {
    const page = Math.max(1, Number(anchor.pageNumber ?? metadata.pageNumber) || 1);
    const selectedText = String(anchor.selectedText ?? metadata.rawText
      ?? (metadata.componentType ? metadata.textExcerpt : '') ?? '').trim();
    const pageText = extractDrawingDocument(file.content).pages.find(entry => entry.pageNumber === page)?.text;
    const text = selectedText || String(pageText ?? metadata.textExcerpt ?? extractPdfFullText(file.content)).slice(0, 4000);
    return { kind: 'pdf', page, pageNumber: page, selectedText,
      hasExcerpt: Boolean(selectedText), bbox: anchor.bbox ?? metadata.bbox ?? null, text, openAt: { page } };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) return { kind: 'image' };
  if (isPresentationPath(file.path)) {
    const outline = presentationOutline(readPresentation(file.content));
    if (!outline.slides.length) return null;
    return buildTextPreview(file.path, outline.text, anchor, metadata, label, objectType, { ...options, outline });
  }
  if (isTextPreviewPath(file.path)) {
    const text = extension === '.docx' ? extractDocxFullText(file.content) : file.content.toString('utf8');
    if (!text) return null;
    return buildTextPreview(file.path, text, anchor, metadata, label, objectType, options);
  }
  return null;
}

/** Plain XML formats with no drawable geometry; their preview is the cited element in context. */
const XML_PREVIEW_EXTENSIONS = new Set(['.landxml']);

export function isTextPreviewPath(filePath) {
  const extension = path.extname(String(filePath ?? '')).toLowerCase();
  return FULL_TEXT_EXTENSIONS.has(extension) || XML_PREVIEW_EXTENSIONS.has(extension) || extension === '.docx'
    || isPresentationPath(filePath) || isCodePath(filePath);
}

const WHOLE_DOCUMENT_TYPES = new Set(['DOCUMENT', 'PAPER']);

/** Word searches at most 255 characters; a shorter phrase leaves room for its escape codes. */
const WORD_SEARCH_LENGTH = 200;

/**
 * The words Word searches for: the longest cited line, shortened at a word to
 * fit its search, and which match of them is the cited one, since a heading
 * such as "Fees" can also appear earlier, in a table of contents.
 */
function wordSearch(text, lines, range, excerpt) {
  const cited = (excerpt ? excerpt.split('\n') : lines.slice(range[0] - 1, range[1])).map((line) => line.trim());
  const longest = cited.reduce((best, line) => (line.length > best.length ? line : best), '');
  if (!longest) return {};
  const words = longest.length <= WORD_SEARCH_LENGTH ? longest
    : longest.slice(0, WORD_SEARCH_LENGTH + 1).replace(/\s+\S*$/, '');
  const citedStart = lines.slice(0, range[0] - 1).reduce((offset, line) => offset + line.length + 1, 0);
  const at = text.indexOf(words, citedStart);
  if (at < 0) return { text: words };
  let occurrence = 1;
  for (let index = text.indexOf(words); index >= 0 && index < at; index = text.indexOf(words, index + words.length)) occurrence += 1;
  return { text: words, occurrence };
}

/** Line range [first, last] (1-based) that an indexed object or matched passage cites. */
function citedLineRange(text, lines, anchor, metadata, label, matchText) {
  const lineAt = (offset) => text.slice(0, Math.max(0, offset)).split('\n').length;
  const first = Number(anchor.lineStart ?? anchor.line);
  if (Number.isInteger(first) && first >= 1 && first <= lines.length) {
    const last = Number(anchor.lineEnd);
    return [first, Number.isInteger(last) && last >= first ? Math.min(lines.length, last) : first];
  }
  if (Number.isInteger(anchor.start) && anchor.start >= 0 && anchor.start < text.length) {
    const end = Number.isInteger(anchor.end) && anchor.end > anchor.start ? Math.min(text.length, anchor.end) : anchor.start + 1;
    return [lineAt(anchor.start), lineAt(end - 1)];
  }
  // Structured sources (such as a LandXML element) record the exact text they cite.
  for (const candidate of [matchText, anchor.selectedText, metadata.rawText]) {
    const found = findPassage(text, candidate);
    if (found) return [lineAt(found.start), lineAt(found.end - 1)];
  }
  const needle = String(label ?? '').trim().toLowerCase();
  if (needle) {
    const index = lines.findIndex((line) => line.toLowerCase().includes(needle));
    if (index >= 0) return [index + 1, index + 1];
  }
  return null;
}

/** Locates a passage while tolerating Markdown markers and line breaks between its words. */
export function findPassage(text, passage) {
  const words = String(passage ?? '').match(/[\p{L}\p{N}]+/gu)?.slice(0, 30) ?? [];
  if (!words.length || words.join('').length < 3) return null;
  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^\\p{L}\\p{N}]{1,12}'), 'iu');
  const match = pattern.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/**
 * Text viewport for the native assist card, the source inspector and the share
 * composer. Markdown is returned as structured blocks so every surface renders
 * headings, lists and emphasis instead of the raw syntax.
 */
export function buildTextPreview(filePath, value, anchor = {}, metadata = {}, label = '', objectType = '', { matchText = '', outline = null } = {}) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const range = citedLineRange(text, lines, anchor ?? {}, metadata ?? {}, label, matchText);
  if (outline) {
    // The deck itself cites no line; its title is found in the first slide's heading.
    const located = matchText || Number.isInteger(anchor?.lineStart) || Number.isInteger(anchor?.start);
    return slidePreview(text, outline, located ? range : null, anchor ?? {}, metadata ?? {});
  }
  const wholeDocument = WHOLE_DOCUMENT_TYPES.has(objectType) && !matchText
    && !Number.isInteger(anchor?.start) && !Number.isInteger(anchor?.lineStart ?? anchor?.line);
  const lineLabel = range ? (range[1] > range[0] ? `Lines ${range[0]}–${range[1]}` : `Line ${range[0]}`) : '';
  const extension = path.extname(filePath).toLowerCase();
  // An indexed sentence or paragraph is the cited text itself, not its whole block.
  const excerpt = !matchText && anchor?.kind === 'text-excerpt' ? String(anchor.selectedText ?? '').trim() : '';
  // Where "Open file" lands. Word cannot go to a line, so it finds the cited words.
  const openAt = !range || wholeDocument ? null
    : extension === '.docx' ? { line: range[0], ...wordSearch(text, lines, range, excerpt) } : { line: range[0] };

  if (isMarkdownPath(filePath)) {
    const blocks = markdownBlocks(text);
    const cited = (block) => Boolean(range) && block.lineStart <= range[1] && block.lineEnd >= range[0];
    const firstCited = blocks.findIndex(cited);
    let lastCited = firstCited;
    while (lastCited >= 0 && lastCited + 1 < blocks.length && cited(blocks[lastCited + 1])) lastCited += 1;
    const start = firstCited < 0 ? 0 : Math.max(0, firstCited - 12);
    const end = Math.min(blocks.length, (lastCited < 0 ? 0 : lastCited) + 40);
    const section = firstCited < 0 ? null
      : blocks.slice(0, firstCited + 1).reverse().find((block) => block.type === 'heading');
    const citedText = firstCited < 0 ? '' : blocks.slice(firstCited, lastCited + 1)
      .map((block) => markdownPlainText(block.text)).join('\n');
    return {
      kind: 'text', format: 'markdown', extracted: false, openAt,
      location: wholeDocument ? 'Entire document'
        : [section ? markdownPlainText(section.text) : '', lineLabel].filter(Boolean).join(' · '),
      text: (excerpt || citedText).slice(0, 1200),
      firstBlock: start, blockCount: blocks.length,
      blocks: blocks.slice(start, end).map(({ source, ...block }, index) => ({
        ...block, cited: firstCited >= 0 && start + index >= firstCited && start + index <= lastCited,
      })),
    };
  }

  const selected = range ? range[0] - 1 : -1;
  const startLine = Math.max(0, (selected < 0 ? 0 : selected) - 8);
  const endLine = Math.min(lines.length, Math.max(startLine + 24, (range?.[1] ?? 0) + 8));
  return {
    kind: 'text', format: extension === '.docx' ? 'document' : 'plain', extracted: extension === '.docx',
    openAt,
    location: wholeDocument ? 'Entire document' : lineLabel,
    text: excerpt ? excerpt.slice(0, 1200) : range ? lines.slice(range[0] - 1, range[1]).join('\n').trim().slice(0, 1200) : '',
    lines: lines.slice(startLine, endLine).map((line, index) => ({
      value: line, lineNumber: startLine + index + 1,
      cited: Boolean(range) && startLine + index + 1 >= range[0] && startLine + index + 1 <= range[1],
    })),
  };
}

/**
 * A deck's preview: the slide the citation is on, as Markdown blocks with the
 * cited ones marked, or the first slide for the whole deck. Open file goes to
 * that slide.
 */
function slidePreview(text, outline, range, anchor, metadata) {
  const number = Number(anchor.slideNumber ?? metadata.slideNumber);
  const slide = outline.slides.find((entry) => entry.number === number)
    ?? (range ? slideAtLine(outline, range[0]) : null);
  const shown = slide ?? outline.slides[0];
  const document = slideDocument(text, shown, slide ? range : null);
  return {
    kind: 'text', format: 'markdown', extracted: true, slideNumber: slide?.number ?? null,
    slideCount: outline.slides.length, openAt: { slide: shown.number },
    location: slide ? slideLocation(slide) : 'Entire presentation',
    text: document.styles.filter((block) => block.cited).map((block) => markdownPlainText(block.text)).join('\n').slice(0, 1200),
    firstBlock: 0, blockCount: document.styles.length,
    blocks: document.styles,
  };
}

const slideLocation = (slide) => `Slide ${slide.number}${slide.title ? ` · ${slide.title}` : ''}`;

/** One slide of a deck's outline as Markdown blocks; `range` marks the cited lines of the outline. */
function slideDocument(text, slide, range) {
  const lines = text.split('\n').slice(slide.lineStart - 1, slide.lineEnd);
  const blocks = markdownBlocks(lines.join('\n'));
  const cited = (block) => Boolean(range) && block.lineStart + slide.lineStart - 1 <= range[1]
    && block.lineEnd + slide.lineStart - 1 >= range[0] && block.type !== 'heading';
  return {
    blocks: blocks.map((block) => block.source),
    styles: blocks.map(({ source, lineStart, lineEnd, ...style }) => ({ ...style, cited: cited({ ...style, lineStart, lineEnd }) })),
  };
}

/**
 * What a share of one slide shows: the slide a citation is on, whole, with the
 * cited passage marked. Null when the citation names no slide, as the whole
 * deck does: a deck is shared whole or one slide at a time.
 */
export function buildSlideShareDocument(file, anchor = {}, metadata = {}) {
  if (!file?.content || !isPresentationPath(file.path)) return null;
  const number = Number(anchor?.slideNumber ?? metadata?.slideNumber);
  if (!Number.isInteger(number) || number < 1) return null;
  const outline = presentationOutline(readPresentation(file.content));
  const slide = outline.slides.find((entry) => entry.number === number);
  if (!slide) return null;
  const first = Number(anchor?.lineStart ?? metadata?.lineStart);
  const last = Number(anchor?.lineEnd ?? metadata?.lineEnd);
  const range = Number.isInteger(first) ? [first, Number.isInteger(last) && last >= first ? last : first] : null;
  return { kind: 'text', format: 'markdown', layout: MARKDOWN_LAYOUT, ...slideDocument(outline.text, slide, range),
    slide: slide.number, citedSlide: true, location: slideLocation(slide) };
}

function fullTextBlocks(value) {
  const normalized = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const blocks = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/);
    if (words.length <= 70) blocks.push(paragraph);
    else {
      for (let index = 0; index < words.length; index += 70) {
        blocks.push(words.slice(index, index + 70).join(' '));
      }
    }
  }
  return blocks;
}

/**
 * A complete logical rendering of the pinned source used by selective sharing.
 * Unlike buildSharePreview, this never crops around the indexed object.
 */
export function buildFullShareDocument(file, { visualPdf = false, structuredLayout = true, detectCsvDelimiter = true } = {}) {
  if (!file?.content || !file?.path) return null;
  const extension = path.extname(file.path).toLowerCase();
  const layout = structuredLayout ? fullTextLayout(file.path) : null;

  try {
    // Markdown and XML sections follow the document's own structure. Redacted
    // shares created before these layouts keep the paragraph blocks they were made with.
    if (isPresentationPath(file.path)) {
      // A deck reads as its slide outline; it is shared whole or a slide at a time, never redacted.
      const blocks = markdownBlocks(presentationOutline(readPresentation(file.content)).text);
      return blocks.length ? {
        kind: 'text', format: 'markdown', layout: MARKDOWN_LAYOUT, presentation: true,
        blocks: blocks.map((block) => block.source),
        styles: blocks.map(({ source, lineStart, lineEnd, ...style }) => style),
      } : null;
    }
    if (layout === MARKDOWN_LAYOUT) {
      const blocks = markdownBlocks(file.content.toString('utf8'));
      return blocks.length ? {
        kind: 'text', format: 'markdown', layout: MARKDOWN_LAYOUT,
        blocks: blocks.map((block) => block.source),
        styles: blocks.map(({ source, lineStart, lineEnd, ...style }) => style),
      } : null;
    }
    if (layout === LINE_LAYOUT) {
      const blocks = file.content.toString('utf8').split(/\r\n?|\n/)
        .map((line) => line.trimEnd()).filter(Boolean);
      return blocks.length ? { kind: 'text', format: 'lines', layout: LINE_LAYOUT, blocks } : null;
    }
    if (['.xlsx', '.xls'].includes(extension)) {
      const sheets = extractSpreadsheetTables(file.content).map((sheet) => ({
        name: sheet.name,
        rows: sheet.rows.map((row) => Array.from(
          { length: row?.length ?? 0 }, (_, column) => String(row?.[column] ?? ''))),
      }));
      return sheets.length ? { kind: 'table', sheets } : null;
    }
    if (['.csv', '.tsv'].includes(extension)) {
      const delimiter = extension === '.tsv' ? '\t' : ',';
      return {
        kind: 'table',
        sheets: [{
          name: path.basename(file.path, extension),
          rows: parseDelimited(file.content.toString('utf8'), delimiter, { detect: detectCsvDelimiter })
            .map((row) => row.map((cell) => String(cell ?? ''))),
        }],
      };
    }

    let text = '';
    if (extension === '.pdf') text = extractPdfFullText(file.content);
    else if (extension === '.docx') text = extractDocxFullText(file.content);
    else if (isTextPreviewPath(file.path)) text = file.content.toString('utf8');
    const blocks = fullTextBlocks(text);
    // Full PDF shares and the private composer can display the pinned original.
    // Redacted shares keep the logical text document so original PDF bytes can
    // never be included in a selectively disclosed view or download.
    if (extension === '.pdf' && visualPdf) return { kind: 'pdf', blocks };
    return blocks.length ? { kind: 'text', blocks } : null;
  } catch {
    return null;
  }
}
