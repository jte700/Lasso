// Small table preview for the public share page. Reuses the same spreadsheet
// extraction and header detection as the workspace so the cited cell is
// identified identically in both places.

import path from 'node:path';
import { columnLetter, tableContext } from '../dependencies/table-preview.js';
import { extractDocxFullText, extractPdfFullText, extractSpreadsheetTables } from '../dependencies/document-extraction.js';
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
export function buildSharePreview(file, anchor = {}, metadata = {}, radius = 2) {
  if (!file?.content || !file?.path) return null;
  const extension = path.extname(file.path).toLowerCase();
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

  return tableContext(selectedTable ?? {rows:rawRows}, anchor, radius, layout.headerRowIndex);
}

/** Local file viewport, preserving source rows, blank columns and line breaks. */
export function buildInspectorPreview(file, anchor = {}, metadata = {}, label = '') {
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
      const numbers = table.rowNumbers ?? table.rows.map((_, index) => index + 1);
      const citedRow = context.rows.find((row) => row.cells.some((cell) => cell.cited))?.rowNumber;
      let firstRow = Math.max(context.rows[0].rowNumber, (citedRow ?? 1) - 8);
      const headerRow = context.headerRowNumbers[0];
      if (headerRow && firstRow - headerRow < 12) firstRow = headerRow;
      // A window is contiguous in the original file, including empty rows.
      const lastRow = Math.min(context.rows.at(-1).rowNumber, firstRow + 80);
      const columnIndex = (value) => [...value].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      const firstColumn = columnIndex(context.columns[0]);
      const lastColumn = columnIndex(context.columns.at(-1));
      const selectedColumn = Number.isInteger(anchor.columnIndex) ? anchor.columnIndex
        : layout.headers.findIndex((header) => header === anchor.column);
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
          const cited = context.columnCitation ? column === selectedColumn && Boolean(value)
            : rowNumber === citedRow && (selectedColumn < 0 || column === selectedColumn);
          return { value, cited, covered,
            rowSpan: merge ? Math.min(lastRow, merge.lastRow) - startRow + 1 : 1,
            colSpan: merge ? Math.min(lastColumn, merge.lastColumn) - startColumn + 1 : 1 };
        }) };
      });
      const position = context.columnCitation ? `Column ${columnLetter(selectedColumn)}`
        : citedRow ? `${selectedColumn < 0 ? 'Row ' : columnLetter(selectedColumn)}${citedRow}` : '';
      return { kind: 'table', columns: Array.from({ length: lastColumn - firstColumn + 1 }, (_, index) => columnLetter(firstColumn + index)),
        rows, sheet: table.name ?? null, location: [table.name, position].filter(Boolean).join(' · ') };
    } catch { return null; }
  }
  if (extension === '.pdf') return { kind: 'pdf', page: Math.max(1, Number(anchor.pageNumber ?? metadata.pageNumber) || 1) };
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
export function buildFullShareDocument(file) {
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
    return blocks.length ? { kind: 'text', blocks } : null;
  } catch {
    return null;
  }
}
