// A table whose row labels sit behind spacer columns (labels in C, A and B
// empty) names each row from column C. That label is the row's name, not one
// of its values, so it is not indexed a second time as a "<row> · Account"
// cell repeating the name. Every other row and value keeps the object key
// that existing links and shares were made against.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const researcher = { id: 'human:researcher', displayName: 'Researcher', actorType: 'HUMAN_SELF' };

const CELL_TYPES = new Set(['DATASET_VALUE', 'TABLE', 'RESULT']);

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
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
function workbook(sheetName, rows) {
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
 * The layout of Finance-Planning.xlsx, "Budget vs Actual": a title, then a
 * table in C6:G9 behind two empty spacer columns. `marks` puts text in
 * column A of the given sheet rows.
 */
function spacerWorkbook({ marks = {} } = {}) {
  const rows = {
    2: ['', '', 'Budget vs Actual'],
    3: ['', '', 'Northstar Office Supply Inc. September 2026 CAD'],
    6: ['', '', 'Account', 'Actual', 'Budget', 'Variance %', 'Department'],
    7: ['', '', 'Revenue', '485000', '500000', '-3.0%', 'Sales'],
    8: ['', '', 'Rent', '18000', '18000', '0.0%', 'Facilities'],
    9: ['', '', 'Operating income', '63050', '75100', '-16.0%', 'Finance'],
  };
  for (const [rowNumber, mark] of Object.entries(marks)) rows[rowNumber] = [mark, ...rows[rowNumber].slice(1)];
  return workbook('Budget vs Actual', rows);
}

/** The same table with its labels in column A, as most sheets have them. */
function firstColumnWorkbook() {
  return workbook('Budget vs Actual', {
    1: ['Account', 'Actual', 'Budget', 'Variance %', 'Department'],
    2: ['Revenue', '485000', '500000', '-3.0%', 'Sales'],
    3: ['Rent', '18000', '18000', '0.0%', 'Facilities'],
    4: ['Operating income', '63050', '75100', '-16.0%', 'Finance'],
  });
}

function workspace(t, files) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-label-column-'));
  const root = path.join(sandbox, 'Finance');
  fs.mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const project = application.timeline.importProject(root, researcher, { watch: false }).project;
  return application.dependencies.objectsAt(project.id);
}

/** An object's key without its file id, which differs from one import to the next. */
const localKey = (object) => object.objectKey.slice(object.objectKey.indexOf(':') + 1);

/** The keys of a table's rows and cells, as earlier builds recorded them. */
const tableKeys = (objects) => objects
  .filter((object) => object.objectType === 'DATASET_ROW' || CELL_TYPES.has(object.objectType))
  .map(localKey).sort();

test('labels behind spacer columns are not indexed again as a cell of their own row', (t) => {
  // Arrange
  const objects = workspace(t, { 'Finance-Planning.xlsx': spacerWorkbook() });

  // Act
  const labelCells = objects.filter((object) => CELL_TYPES.has(object.objectType) && object.anchor.columnIndex === 2);
  const accountCells = objects.filter((object) => object.label.endsWith(' · Account'));

  // Assert
  assert.deepEqual(labelCells.map((object) => `${object.objectType} ${object.label}`), []);
  assert.deepEqual(accountCells.map((object) => `${object.objectType} ${object.label}`), []);
  const rows = objects.filter((object) => object.objectType === 'DATASET_ROW').map((object) => object.label).sort();
  assert.deepEqual(rows, ['Operating income', 'Rent', 'Revenue'], 'the label still names its row');
});

test('rows and value cells behind spacer columns keep their object keys', (t) => {
  // Arrange
  const objects = workspace(t, { 'Finance-Planning.xlsx': spacerWorkbook() });

  // Act
  const keys = tableKeys(objects);

  // Assert: exactly the keys earlier builds recorded, less the three label cells
  // ("cell:3:revenue:Account" and the like).
  const sheet = 'sheet:Budget vs Actual';
  assert.deepEqual(keys, [
    ...['3:revenue', '4:rent', '5:operatingincome'].flatMap((row) => [
      `${sheet}:cell:${row}:Actual`,
      `${sheet}:cell:${row}:Budget`,
      `${sheet}:cell:${row}:Department`,
      `${sheet}:cell:${row}:Variance %`,
    ]),
    `${sheet}:row-count`,
    `${sheet}:row:3:revenue`,
    `${sheet}:row:4:rent`,
    `${sheet}:row:5:operatingincome`,
  ].sort());
});

test('a mark in column A beside labels in column C is not read as a value', (t) => {
  // Arrange: one row flagged in column A, too sparse to name the rows.
  const plain = workspace(t, { 'Finance-Planning.xlsx': spacerWorkbook() });
  const marked = workspace(t, { 'Finance-Planning.xlsx': spacerWorkbook({ marks: { 8: '*' } }) });

  // Act
  const markCells = marked.filter((object) => CELL_TYPES.has(object.objectType) && object.anchor.columnIndex === 0);

  // Assert
  assert.deepEqual(markCells.map((object) => object.label), []);
  assert.deepEqual(tableKeys(marked), tableKeys(plain));
});

test('a table with its labels in column A reads as it did', (t) => {
  // Arrange
  const objects = workspace(t, { 'Finance-Planning.xlsx': firstColumnWorkbook() });

  // Act
  const keys = tableKeys(objects);

  // Assert
  const sheet = 'sheet:Budget vs Actual';
  assert.deepEqual(keys, [
    ...['1:revenue', '2:rent', '3:operatingincome'].flatMap((row) => [
      `${sheet}:cell:${row}:Actual`,
      `${sheet}:cell:${row}:Budget`,
      `${sheet}:cell:${row}:Department`,
      `${sheet}:cell:${row}:Variance %`,
    ]),
    `${sheet}:row-count`,
    `${sheet}:row:1:revenue`,
    `${sheet}:row:2:rent`,
    `${sheet}:row:3:operatingincome`,
  ].sort());
});
