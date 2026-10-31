// Renders an evaluation spec (scripts/agent-eval/SPEC.md) into real files and
// indexes them with the app, so Lasso is measured on what it would see on a
// person's disk: text PDFs with pages, headings and tables set as text, Word
// documents with heading styles and tables, workbooks, Markdown.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../../src/server.js';
import { storedZip } from '../../test/fixtures/workbook.js';

const LINE_CHARS = 92;
const PAGE_LINES = 48;

const wrap = (text, width = LINE_CHARS) => {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
};

/** A table as a text layer has it: the caption, then the header and each row, columns spaced apart. */
function tableLines(table) {
  const columns = table.header.map((_, index) => Math.max(...[table.header, ...table.rows].map((row) => String(row[index] ?? '').length)));
  const row = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(columns[index])).join('    ').trimEnd();
  return [...(table.caption ? wrap(table.caption) : []), row(table.header), ...table.rows.map(row)];
}

function blockLines(block) {
  if (block.heading) return ['', block.heading, ''];
  if (block.paragraph) return [...wrap(block.paragraph), ''];
  if (block.table) return ['', ...tableLines(block.table), ''];
  return [];
}

/** A text PDF: each spec page's blocks set as lines, a long page continued on the next. */
export function pdfFile(title, pages) {
  const escape = (text) => text.replace(/[\\()]/g, (character) => `\\${character}`);
  const physical = [];
  for (const blocks of pages) {
    const lines = blocks.flatMap(blockLines);
    while (lines.length && !lines[0]) lines.shift();
    for (let start = 0; start < lines.length || start === 0; start += PAGE_LINES) physical.push(lines.slice(start, start + PAGE_LINES));
  }
  const fontId = 3 + physical.length * 2;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${physical.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${physical.length} >>`];
  physical.forEach((lines, index) => {
    const stream = `BT /F1 10 Tf 14 TL 60 750 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });
  // Text is written one byte a character in the font's WinAnsi encoding, so "°" or "é" reads back as itself.
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', `<< /Title (${escape(title)}) >>`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => { offsets[index + 1] = Buffer.byteLength(pdf, 'latin1'); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A Word document: headings with Word's heading styles, paragraphs, and tables as Word tables. */
export function docxFile(title, blocks) {
  const paragraph = (text, style = null) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  const body = blocks.map((block) => {
    if (block.heading) return paragraph(block.heading, 'Heading1');
    if (block.paragraph) return paragraph(block.paragraph);
    if (block.table) {
      const row = (cells) => `<w:tr>${cells.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`;
      return `${block.table.caption ? paragraph(block.table.caption, 'Caption') : ''}<w:tbl>${row(block.table.header)}${block.table.rows.map(row).join('')}</w:tbl>`;
    }
    return '';
  }).join('');
  return storedZip({
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>${body}</w:body></w:document>`,
    'docProps/core.xml': `<?xml version="1.0"?><cp:coreProperties xmlns:cp="cp" xmlns:dc="dc"><dc:title>${xml(title)}</dc:title></cp:coreProperties>`,
  });
}

/** A workbook, one worksheet per sheet, values as numbers where they are numbers. */
export function xlsxFile(sheets) {
  const cell = (value, reference) => (/^-?\d+(?:\.\d+)?$/.test(String(value))
    ? `<c r="${reference}"><v>${value}</v></c>` : `<c r="${reference}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`);
  const column = (index) => (index < 26 ? String.fromCharCode(65 + index) : `${String.fromCharCode(64 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`);
  const files = {
    'xl/workbook.xml': `<workbook><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
  };
  sheets.forEach((sheet, index) => {
    const rows = [sheet.header, ...sheet.rows].map((cells, row) => `<row r="${row + 1}">${cells.map((value, at) => cell(value, `${column(at)}${row + 1}`)).join('')}</row>`);
    files[`xl/worksheets/sheet${index + 1}.xml`] = `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`;
  });
  return storedZip(files);
}

export function markdownFile(title, blocks) {
  const lines = [`# ${title}`, ''];
  for (const block of blocks) {
    if (block.heading) lines.push(`## ${block.heading}`, '');
    else if (block.paragraph) lines.push(block.paragraph, '');
    else if (block.table) {
      if (block.table.caption) lines.push(block.table.caption, '');
      lines.push(`| ${block.table.header.join(' | ')} |`, `| ${block.table.header.map(() => '---').join(' | ')} |`,
        ...block.table.rows.map((row) => `| ${row.join(' | ')} |`), '');
    }
  }
  return lines.join('\n');
}

/** The text a file-reading agent gets from converting a document: its blocks in order, tables as rows. */
export function plainText(document) {
  if (document.type === 'xlsx') return document.sheets.map((sheet) => [sheet.header, ...sheet.rows].map((row) => row.join(',')).join('\n')).join('\n\n');
  const blocks = document.type === 'pdf' ? document.pages.flat() : document.blocks;
  return blocks.map((block) => block.heading ?? block.paragraph ?? (block.table ? tableLines(block.table).join('\n') : '')).join('\n\n');
}

export function renderSpec(spec, root) {
  for (const document of spec.documents) {
    const target = path.join(root, ...document.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const title = document.title ?? path.basename(document.path, path.extname(document.path));
    const data = document.type === 'pdf' ? pdfFile(title, document.pages)
      : document.type === 'docx' ? docxFile(title, document.blocks)
        : document.type === 'xlsx' ? xlsxFile(document.sheets)
          : markdownFile(title, document.blocks ?? []);
    fs.writeFileSync(target, data);
  }
}

/** The spec's files, added to a fresh library and indexed. */
export async function prepareSpecLibrary(spec) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-eval-')));
  renderSpec(spec, root);
  const folders = [...new Set(spec.documents.map((document) => document.path.split('/')[0]))];
  const dataDir = path.join(root, 'library');
  const app = createApplication({ dataDir, watchProjects: false, port: 0 });
  const actor = { id: 'human:eval', displayName: 'Evaluation', actorType: 'HUMAN_SELF' };
  await app.workspace.add(folders.map((name) => path.join(root, name)), actor);
  for (const directory of app.workspace.state().directories) app.dependencies.ensureIndex(directory.id);
  return { root, dataDir, app, close: async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
