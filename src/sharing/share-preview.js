// Small table preview for the public share page. Reuses the same spreadsheet
// extraction and header detection as the workspace so the cited cell is
// identified identically in both places.

import path from 'node:path';
import { columnLetter, tableContext } from '../dependencies/table-preview.js';
import { extractDocxFullText, extractPdfFullText, extractSpreadsheetTables } from '../dependencies/document-extraction.js';
import { extractDrawingDocument } from '../dependencies/drawing-extraction.js';
import { tabularLayout } from '../dependencies/service.js';
import { parseDelimited } from '../history/diff.js';

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
export function buildInspectorPreview(file, anchor = {}, metadata = {}, label = '', objectType = '') {
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
  const isText = FULL_TEXT_EXTENSIONS.has(extension)
    || ['dockerfile', 'makefile'].includes(path.basename(file.path).toLowerCase());
  if (isText || extension === '.docx') {
    const text = extension === '.docx' ? extractDocxFullText(file.content) : file.content.toString('utf8');
    if (!text) return null;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let selected = Number(anchor.lineStart ?? anchor.line) - 1;
    if (!Number.isInteger(selected) || selected < 0 || selected >= lines.length) {
      selected = label ? lines.findIndex((line) => line.toLowerCase().includes(String(label).toLowerCase())) : -1;
    }
    const start = Math.max(0, (selected < 0 ? 0 : selected) - 8);
    const end = Math.min(lines.length, Math.max(start + 24, Number(anchor.lineEnd) + 8 || 0));
    return { kind: 'text', extracted: extension === '.docx', lines: lines.slice(start, end).map((value, index) => ({
      value, lineNumber: start + index + 1,
      cited: selected >= 0 && start + index >= selected && start + index < Math.max(selected + 1, Number(anchor.lineEnd) || 0),
    })) };
  }
  return null;
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
export function buildFullShareDocument(file, { visualPdf = false } = {}) {
  if (!file?.content || !file?.path) return null;
  const extension = path.extname(file.path).toLowerCase();

  try {
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
