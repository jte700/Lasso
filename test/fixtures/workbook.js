// A minimal .xlsx built in memory: stored (uncompressed) zip entries with
// inline strings, enough for Lasso's spreadsheet reader.

import { deflateRawSync } from 'node:zlib';

export function storedZip(entries, { deflate = false } = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const raw = Buffer.from(value);
    const data = deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    if (deflate) local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    if (deflate) central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

/** One worksheet; `rows` maps a sheet row number to its cells from column A. */
export function workbook(sheetName, rows) {
  const rowXml = Object.entries(rows).map(([rowNumber, cells]) => `<row r="${rowNumber}">${cells.map((value, column) => {
    const reference = `${String.fromCharCode(65 + column)}${rowNumber}`;
    if (!value) return '';
    return /^-?\d+(?:\.\d+)?$/.test(value)
      ? `<c r="${reference}"><v>${value}</v></c>`
      : `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;
  }).join('')}</row>`).join('');
  return storedZip({
    'xl/workbook.xml': `<workbook><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rowXml}</sheetData></worksheet>`,
  });
}

/**
 * A deflated workbook with `rows` data rows under a header, as large as a
 * real export: `cells(row)` gives each row's cells from column A. Shared
 * strings hold the text, as Excel writes it.
 */
export function largeWorkbook(sheetName, header, rows, cells) {
  const strings = [];
  const index = new Map();
  const shared = (text) => {
    if (!index.has(text)) { index.set(text, strings.length); strings.push(text); }
    return index.get(text);
  };
  const column = (n) => { let label = ''; for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) label = String.fromCharCode(65 + i % 26) + label; return label; };
  const cell = (value, rowNumber, columnIndex) => {
    const reference = `${column(columnIndex)}${rowNumber}`;
    if (value === '' || value == null) return '';
    return typeof value === 'number' ? `<c r="${reference}"><v>${value}</v></c>`
      : `<c r="${reference}" t="s"><v>${shared(String(value))}</v></c>`;
  };
  const parts = [`<row r="1">${header.map((value, columnIndex) => cell(value, 1, columnIndex)).join('')}</row>`];
  for (let row = 0; row < rows; row += 1) {
    const rowNumber = row + 2;
    parts.push(`<row r="${rowNumber}">${cells(row).map((value, columnIndex) => cell(value, rowNumber, columnIndex)).join('')}</row>`);
  }
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return storedZip({
    'xl/workbook.xml': `<workbook><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${parts.join('')}</sheetData></worksheet>`,
    'xl/sharedStrings.xml': `<sst>${strings.map((text) => `<si><t>${escape(text)}</t></si>`).join('')}</sst>`,
  }, { deflate: true });
}
