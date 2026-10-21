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
import { workbook } from './fixtures/workbook.js';

const researcher = { id: 'human:researcher', displayName: 'Researcher', actorType: 'HUMAN_SELF' };

const CELL_TYPES = new Set(['DATASET_VALUE', 'TABLE', 'RESULT']);

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

  // Assert: exactly the keys a worksheet-row (xlsx-v2) reading records, less
  // the three label cells ("cell:7:revenue:Account" and the like).
  const sheet = 'xlsx-v2:sheet:Budget vs Actual';
  assert.deepEqual(keys, [
    ...['7:revenue', '8:rent', '9:operatingincome'].flatMap((row) => [
      `${sheet}:cell:${row}:Actual`,
      `${sheet}:cell:${row}:Budget`,
      `${sheet}:cell:${row}:Department`,
      `${sheet}:cell:${row}:Variance %`,
    ]),
    `${sheet}:row-count`,
    `${sheet}:row:7:revenue`,
    `${sheet}:row:8:rent`,
    `${sheet}:row:9:operatingincome`,
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
  const sheet = 'xlsx-v2:sheet:Budget vs Actual';
  assert.deepEqual(keys, [
    ...['2:revenue', '3:rent', '4:operatingincome'].flatMap((row) => [
      `${sheet}:cell:${row}:Actual`,
      `${sheet}:cell:${row}:Budget`,
      `${sheet}:cell:${row}:Department`,
      `${sheet}:cell:${row}:Variance %`,
    ]),
    `${sheet}:row-count`,
    `${sheet}:row:2:revenue`,
    `${sheet}:row:3:rent`,
    `${sheet}:row:4:operatingincome`,
  ].sort());
});
