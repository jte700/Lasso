// Small table preview for the public share page. Reuses the same spreadsheet
// extraction and header detection as the workspace so the cited cell is
// identified identically in both places.

import path from 'node:path';
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
  try {
    if (isSpreadsheet) {
      const sheetName = anchor.sheet ?? metadata.sheet ?? null;
      const tables = extractSpreadsheetTables(file.content);
      const table = tables.find((sheet) => !sheetName || sheet.name === sheetName) ?? tables[0];
      rawRows = table?.rows ?? null;
    } else {
      rawRows = parseDelimited(file.content.toString('utf8'), extension === '.tsv' ? '\t' : ',');
    }
  } catch {
    return null;
  }
  if (!rawRows?.length) return null;

  const layout = tabularLayout(rawRows);
  if (!layout.headers.length) return null;

  const citedRow = Number.isInteger(anchor.rowIndex)
    ? anchor.rowIndex - layout.headerRowIndex - 1
    : layout.rows.findIndex((row) => String(row?.[0] ?? '').trim() === String(anchor.rowKey ?? '').trim());
  if (citedRow < 0 || citedRow >= layout.rows.length) return null;

  const start = Math.max(0, citedRow - radius);
  const end = Math.min(layout.rows.length, citedRow + radius + 1);
  const window = layout.rows.slice(start, end);

  // Spreadsheet rows arrive sparse: blank spacer columns are holes, and Array
  // methods skip holes. Densify first so column indexes stay meaningful.
  const width = Math.max(layout.headers.length, ...window.map((row) => row?.length ?? 0));
  const dense = (row) => Array.from({ length: width }, (_, column) => String(row?.[column] ?? '').trim());
  const headers = dense(layout.headers);
  const rows = window.map(dense);

  const citedColumn = Number.isInteger(anchor.columnIndex)
    ? anchor.columnIndex
    : anchor.column != null
      ? headers.findIndex((header) => header === String(anchor.column))
      : -1;

  // Drop the workbook's empty spacer columns, keeping any column that carries a
  // header or a value — the row labels live in a column with no header.
  const keep = [];
  for (let column = 0; column < width; column += 1) {
    if (headers[column] || rows.some((row) => row[column])) keep.push(column);
  }
  if (!keep.length) return null;

  return {
    columns: keep.map((column) => {
      let value = '';
      for (let current = column; current >= 0; current = Math.floor(current / 26) - 1) {
        value = String.fromCharCode(65 + (current % 26)) + value;
      }
      return value;
    }),
    headers: keep.map((column) => headers[column]),
    rows: rows.map((row, offset) => ({
      rowNumber: layout.headerRowIndex + start + offset + 2,
      cells: keep.map((column) => ({
        value: row[column],
        // Row references highlight the whole row; cell references one cell.
        cited: start + offset === citedRow && (citedColumn < 0 || column === citedColumn),
      })),
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
