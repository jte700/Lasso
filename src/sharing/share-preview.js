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

/// Legacy paragraph blocks are used when any stored text redaction predates
/// the Markdown layout; otherwise the structured layout is used.
export function usesMarkdownLayout(redactions = []) {
  return !redactions.some((entry) => entry.kind === 'BLOCK' && entry.layout !== MARKDOWN_LAYOUT);
}

const FULL_TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.qmd', '.rmd', '.rst', '.txt', '.tex', '.bib', '.ris', '.enw', '.nbib', '.log',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.r', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.kt', '.kts', '.sh', '.zsh', '.fish', '.sql',
  '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.toml', '.ini', '.env',
  '.json', '.geojson', '.yaml', '.yml', '.xml', '.rtf', '.ipynb',
]);


/**
 * Builds a few rows of context around the cited cell.
 * Returns null for sources that are not tabular.
 */
export function buildSharePreview(file, anchor = {}, metadata = {}, radius = 2, objectType = '') {
  if (!file?.content || !file?.path) return null;
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
  let selectedTable = null;
  try {
    if (isSpreadsheet) {
      const sheetName = anchor.sheet ?? metadata.sheet ?? null;
      const tables = extractSpreadsheetTables(file.content);
      const table = tables.find((sheet) => !sheetName || sheet.name === sheetName) ?? tables[0];
      rawRows = table?.rows ?? null;
      selectedTable = table;
    } else {
      rawRows = parseDelimited(file.content.toString('utf8'), extension === '.tsv' ? '\t' : ',');
    }
  } catch {
    return null;
  }
  if (!rawRows?.length) return null;

  const layout = tabularLayout(rawRows);
  if (!layout.headers.length) return null;

  const table = selectedTable ?? { rows: rawRows };
  const context = tableContext(table, anchor, radius, layout.headerRowIndex);
  if (!context || !objectType) return context;

  // Local suggestions identify the word/value that was inserted. Public shares
  // retain their original column/data scope and do not pass an object type.
  const selection = inspectorTableSelection(table, anchor, context, layout, objectType);
  const rows = [...context.rows];
  if (selection.kind === 'header' && !rows.some((row) => row.rowNumber === selection.row)) {
    const source = table.rows[selection.numbers.indexOf(selection.row)] ?? [];
    rows.unshift({ rowNumber: selection.row, cells: context.columns.map((column) => ({
      value: String(source[spreadsheetColumnIndex(column)] ?? '').trim(), cited: false,
    })) });
  }
  return { ...context, location: selection.location, columnCitation: selection.kind === 'column',
    rows: rows.map((row) => ({ ...row, cells: row.cells.map((cell, index) => ({ ...cell,
      cited: selection.cites(row.rowNumber, spreadsheetColumnIndex(context.columns[index]), cell.value),
    })) })) };
}

const spreadsheetColumnIndex = (value) => [...value]
  .reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;

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
  return { numbers, row, column, kind,
    location: [table.name, position].filter(Boolean).join(' · '),
    cites: (rowNumber, columnIndex, value) => kind === 'column'
      ? columnIndex === column && Boolean(value)
      : rowNumber === row && (column < 0 || columnIndex === column),
  };
}

/** Local file viewport, preserving source rows, blank columns and line breaks. */
export function buildInspectorPreview(file, anchor = {}, metadata = {}, label = '', objectType = '', options = {}) {
  if (!file?.content || !file?.path) return null;
  const extension = path.extname(file.path).toLowerCase();
  if (['.xlsx', '.xls', '.csv', '.tsv'].includes(extension)) {
    try {
      const table = ['.xlsx', '.xls'].includes(extension)
        ? (() => {
          const tables = extractSpreadsheetTables(file.content);
          const sheet = anchor.sheet ?? metadata.sheet;
          return tables.find((entry) => entry.name === sheet) ?? tables[0];
        })()
        : { rows: parseDelimited(file.content.toString('utf8'), extension === '.tsv' ? '\t' : ',') };
      if (!table?.rows?.length) return null;
      const layout = tabularLayout(table.rows);
      const context = tableContext(table, anchor, 6, layout.headerRowIndex);
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
          const value = String(merge ? table.rows[numbers.indexOf(merge.firstRow)]?.[merge.firstColumn] ?? ''
            : table.rows[sourceIndex]?.[column] ?? '');
          const cited = selection.cites(rowNumber, column, value);
          return { value, cited, covered,
            rowSpan: merge ? Math.min(lastRow, merge.lastRow) - startRow + 1 : 1,
            colSpan: merge ? Math.min(lastColumn, merge.lastColumn) - startColumn + 1 : 1 };
        }) };
      });
      return { kind: 'table', columns: Array.from({ length: lastColumn - firstColumn + 1 }, (_, index) => columnLetter(firstColumn + index)),
        rows, sheet: table.name ?? null, location: selection.location };
    } catch { return null; }
  }
  if (extension === '.pdf') {
    const page = Math.max(1, Number(anchor.pageNumber ?? metadata.pageNumber) || 1);
    const selectedText = String(anchor.selectedText ?? metadata.rawText
      ?? (metadata.componentType ? metadata.textExcerpt : '') ?? '').trim();
    const pageText = extractDrawingDocument(file.content).pages.find(entry => entry.pageNumber === page)?.text;
    const text = selectedText || String(pageText ?? metadata.textExcerpt ?? extractPdfFullText(file.content)).slice(0, 4000);
    return { kind: 'pdf', page, pageNumber: page, selectedText,
      hasExcerpt: Boolean(selectedText), bbox: anchor.bbox ?? metadata.bbox ?? null, text };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) return { kind: 'image' };
  if (isTextPreviewPath(file.path)) {
    const text = extension === '.docx' ? extractDocxFullText(file.content) : file.content.toString('utf8');
    if (!text) return null;
    return buildTextPreview(file.path, text, anchor, metadata, label, objectType, options);
  }
  return null;
}

export function isTextPreviewPath(filePath) {
  const extension = path.extname(String(filePath ?? '')).toLowerCase();
  return FULL_TEXT_EXTENSIONS.has(extension) || extension === '.docx'
    || ['dockerfile', 'makefile'].includes(path.basename(String(filePath ?? '')).toLowerCase());
}

const WHOLE_DOCUMENT_TYPES = new Set(['DOCUMENT', 'PAPER']);

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
  for (const candidate of [matchText, anchor.selectedText]) {
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
export function buildTextPreview(filePath, value, anchor = {}, metadata = {}, label = '', objectType = '', { matchText = '' } = {}) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const range = citedLineRange(text, lines, anchor ?? {}, metadata ?? {}, label, matchText);
  const wholeDocument = WHOLE_DOCUMENT_TYPES.has(objectType) && !matchText
    && !Number.isInteger(anchor?.start) && !Number.isInteger(anchor?.lineStart ?? anchor?.line);
  const lineLabel = range ? (range[1] > range[0] ? `Lines ${range[0]}–${range[1]}` : `Line ${range[0]}`) : '';
  const extension = path.extname(filePath).toLowerCase();
  // An indexed sentence or paragraph is the cited text itself, not its whole block.
  const excerpt = !matchText && anchor?.kind === 'text-excerpt' ? String(anchor.selectedText ?? '').trim() : '';

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
      kind: 'text', format: 'markdown', extracted: false,
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
    location: wholeDocument ? 'Entire document' : lineLabel,
    text: excerpt ? excerpt.slice(0, 1200) : range ? lines.slice(range[0] - 1, range[1]).join('\n').trim().slice(0, 1200) : '',
    lines: lines.slice(startLine, endLine).map((line, index) => ({
      value: line, lineNumber: startLine + index + 1,
      cited: Boolean(range) && startLine + index + 1 >= range[0] && startLine + index + 1 <= range[1],
    })),
  };
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
export function buildFullShareDocument(file, { visualPdf = false, markdownLayout = true } = {}) {
  if (!file?.content || !file?.path) return null;
  const extension = path.extname(file.path).toLowerCase();

  try {
    // Markdown sections follow the document's own structure. Redacted shares
    // created before this layout keep the paragraph blocks they were made with.
    if (markdownLayout && isMarkdownPath(file.path)) {
      const blocks = markdownBlocks(file.content.toString('utf8'));
      return blocks.length ? {
        kind: 'text', format: 'markdown', layout: MARKDOWN_LAYOUT,
        blocks: blocks.map((block) => block.source),
        styles: blocks.map(({ source, lineStart, lineEnd, ...style }) => style),
      } : null;
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
          rows: parseDelimited(file.content.toString('utf8'), delimiter)
            .map((row) => row.map((cell) => String(cell ?? ''))),
        }],
      };
    }

    let text = '';
    if (extension === '.pdf') text = extractPdfFullText(file.content);
    else if (extension === '.docx') text = extractDocxFullText(file.content);
    else if (FULL_TEXT_EXTENSIONS.has(extension)
      || ['dockerfile', 'makefile'].includes(path.basename(file.path).toLowerCase())) {
      text = file.content.toString('utf8');
    }
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
