// Notes written under a table ("Source: ...", "Blue values = inputs") are not
// rows of that table. They are indexed as text, so they stay searchable
// without claiming the table's headings, while the table's own rows keep the
// object keys that existing links and shares were made against.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const researcher = { id: 'human:researcher', displayName: 'Researcher', actorType: 'HUMAN_SELF' };

const TABLE_TYPES = new Set(['DATASET_ROW', 'DATASET_VALUE', 'TABLE', 'RESULT', 'VALUE']);

const BUDGET_NOTES = [
  'Sources and assumptions',
  'Fictional test data generated for Lasso.',
  'Source: Budget-vs-Actual.csv. Expense totals link to Department Budgets.',
  'Positive expense variance = over budget. Blue values = inputs. Green = worksheet links.',
];

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

const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** One worksheet; `rows` maps a sheet row number to its cells from column A. */
function workbook(sheetName, rows) {
  const rowXml = Object.entries(rows).map(([rowNumber, cells]) => `<row r="${rowNumber}">${cells.map((value, column) => {
    const reference = `${String.fromCharCode(65 + column)}${rowNumber}`;
    return /^-?\d+(?:\.\d+)?$/.test(value)
      ? `<c r="${reference}"><v>${value}</v></c>`
      : `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  return storedZip({
    'xl/workbook.xml': `<workbook><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rowXml}</sheetData></worksheet>`,
  });
}

/**
 * The layout of Finance-Planning.xlsx, "Budget vs Actual": a title, a table in
 * C6:H11 behind two spacer columns, three blank rows, then notes in C15:C18.
 */
function budgetWorkbook({ notes = true } = {}) {
  const rows = {
    2: ['', '', 'Budget vs Actual'],
    3: ['', '', 'Northstar Office Supply Inc. September 2026 CAD'],
    6: ['', '', 'Account', 'Actual', 'Budget', 'Actual - budget', 'Variance %', 'Department'],
    7: ['', '', 'Revenue', '485000', '500000', '-15000', '-3.0%', 'Sales'],
    8: ['', '', 'Cost of goods sold', '292000', '295000', '-3000', '-1.0%', 'Operations'],
    9: ['', '', 'Gross profit', '193000', '205000', '-12000', '-5.9%', 'Finance'],
    10: ['', '', 'Rent', '18000', '18000', '0', '0.0%', 'Facilities'],
    11: ['', '', 'Operating income', '63050', '75100', '-12050', '-16.0%', 'Finance'],
  };
  if (notes) BUDGET_NOTES.forEach((note, index) => { rows[15 + index] = ['', '', note]; });
  return workbook('Budget vs Actual', rows);
}

function workspace(t, files) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-spreadsheet-notes-'));
  const root = path.join(sandbox, 'Finance');
  fs.mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const project = application.timeline.importProject(root, researcher, { watch: false }).project;
  return { application, project, root };
}

const mentions = (object, text) => [object.label, object.valueText].some((value) => String(value ?? '').includes(text));

/** An object's key without its file id, which differs from one import to the next. */
const localKey = (object) => object.objectKey.slice(object.objectKey.indexOf(':') + 1);

test('notes below a spreadsheet table are not indexed as rows, values or cells of that table', (t) => {
  // Arrange
  const { application, project } = workspace(t, { 'Finance-Planning.xlsx': budgetWorkbook() });

  // Act
  const objects = application.dependencies.objectsAt(project.id);

  // Assert
  for (const note of BUDGET_NOTES) {
    const claimed = objects.filter((object) => TABLE_TYPES.has(object.objectType) && mentions(object, note));
    assert.deepEqual(claimed.map((object) => `${object.objectType} ${object.label}`), [], `“${note}” is table data`);
  }
});

test('notes below a spreadsheet table are indexed as text located at their sheet and cell', (t) => {
  // Arrange
  const { application, project } = workspace(t, { 'Finance-Planning.xlsx': budgetWorkbook() });

  // Act
  const notes = application.dependencies.objectsAt(project.id, null, new Set(['DOCUMENT']))
    .filter((object) => object.path === 'Finance-Planning.xlsx')
    .sort((left, right) => left.anchor.rowIndex - right.anchor.rowIndex);

  // Assert
  assert.deepEqual(notes.map((object) => object.valueText), BUDGET_NOTES);
  assert.deepEqual(notes.map((object) => object.anchor.cellId), ['C15', 'C16', 'C17', 'C18']);
  for (const note of notes) {
    assert.equal(note.metadata.componentType, 'TEXT_EXCERPT');
    assert.equal(note.metadata.sheet, 'Budget vs Actual');
    assert.equal(note.anchor.sheet, 'Budget vs Actual');
    assert.equal(note.anchor.columnIndex, 2);
    assert.equal(note.metadata.columns, undefined, 'a note does not claim the table headings');
  }
});

test('notes below a spreadsheet table stay searchable as text', (t) => {
  // Arrange
  const { application, project } = workspace(t, { 'Finance-Planning.xlsx': budgetWorkbook() });

  // Act
  const results = application.dependencies.search(project.id, 'positive expense variance', { enrich: false });

  // Assert
  const note = results.find((object) => object.valueText === BUDGET_NOTES[3]);
  assert.ok(note, 'the note is found by its own words');
  assert.equal(note.objectType, 'DOCUMENT');
});

test('rows of a table keep their object keys when notes are written below it', (t) => {
  // Arrange: the same table read once without notes and once with them.
  const plain = workspace(t, { 'Finance-Planning.xlsx': budgetWorkbook({ notes: false }) });
  const annotated = workspace(t, { 'Finance-Planning.xlsx': budgetWorkbook() });
  const tableKeys = ({ application, project }) => application.dependencies.objectsAt(project.id)
    .filter((object) => TABLE_TYPES.has(object.objectType) || object.objectType === 'VARIABLE')
    .map(localKey).sort();

  // Act
  const withoutNotes = tableKeys(plain);
  const withNotes = tableKeys(annotated);

  // Assert: the keys are the ones a worksheet-row (xlsx-v2) reading records
  // for these rows.
  assert.deepEqual(withNotes, withoutNotes);
  for (const key of [
    'xlsx-v2:sheet:Budget vs Actual:row:7:revenue',
    'xlsx-v2:sheet:Budget vs Actual:row:11:operatingincome',
    'xlsx-v2:sheet:Budget vs Actual:cell:7:revenue:Actual',
    'xlsx-v2:sheet:Budget vs Actual:cell:11:operatingincome:Variance %',
  ]) assert.ok(withNotes.includes(key), `missing ${key}`);
});

test('the row count of a table with notes below it counts only its rows', (t) => {
  // Arrange
  const { application, project } = workspace(t, { 'Finance-Planning.xlsx': budgetWorkbook() });

  // Act
  const count = application.dependencies.objectsAt(project.id)
    .find((object) => object.metadata.metric === 'row-count');

  // Assert
  assert.equal(count.valueText, 'n = 5');
});

test('section headings inside a table stay rows, including one after a blank row', (t) => {
  // Arrange: "Revenue" sits directly above its rows; "Expenses" follows a
  // blank row but still heads rows of the table. Only the last line is a note.
  const statement = workbook('Statement', {
    1: ['Account', 'Q1', 'Q2'],
    2: ['Revenue'],
    3: ['Product sales', '1200', '1350'],
    4: ['Services', '400', '420'],
    6: ['Expenses'],
    7: ['Salaries', '900', '910'],
    8: ['Rent', '150', '150'],
    10: ['Prepared from the general ledger export of October 2026.'],
  });
  const { application, project } = workspace(t, { 'Statement.xlsx': statement });

  // Act
  const objects = application.dependencies.objectsAt(project.id);
  const rows = objects.filter((object) => object.objectType === 'DATASET_ROW').map((object) => object.label).sort();
  const notes = objects.filter((object) => object.objectType === 'DOCUMENT').map((object) => object.valueText);

  // Assert
  assert.deepEqual(rows, ['Expenses', 'Product sales', 'Rent', 'Revenue', 'Salaries', 'Services']);
  assert.deepEqual(notes, ['Prepared from the general ledger export of October 2026.']);
});

test('line items not yet filled in after a blank row stay rows, not notes', (t) => {
  // Arrange: a template whose last section lists accounts with no figures yet.
  const template = workbook('Budget', {
    1: ['Account', 'Budget', 'Actual'],
    2: ['Revenue', '5000', '4800'],
    4: ['Expenses'],
    5: ['Rent'],
    6: ['Salaries'],
  });
  const { application, project } = workspace(t, { 'Budget-Template.xlsx': template });

  // Act
  const objects = application.dependencies.objectsAt(project.id);
  const rows = objects.filter((object) => object.objectType === 'DATASET_ROW').map((object) => object.label).sort();

  // Assert
  assert.deepEqual(rows, ['Expenses', 'Rent', 'Revenue', 'Salaries']);
  assert.equal(objects.filter((object) => object.objectType === 'DOCUMENT').length, 0);
});

test('notes below a CSV table are indexed as text, not as rows', (t) => {
  // Arrange
  const csv = 'Account,Balance,Cleared\nOperating account,48210,Yes\nPayroll account,9120,No\n\n\n'
    + 'Source: Bank-Reconciliation.csv exported from the bank portal.\n';
  const { application, project } = workspace(t, { 'Bank-Reconciliation.csv': csv });

  // Act
  const objects = application.dependencies.objectsAt(project.id);
  const note = 'Source: Bank-Reconciliation.csv exported from the bank portal.';

  // Assert
  assert.deepEqual(objects.filter((object) => TABLE_TYPES.has(object.objectType) && mentions(object, note))
    .map((object) => object.objectType), []);
  assert.equal(objects.find((object) => object.objectType === 'DOCUMENT' && object.valueText === note)?.anchor.cellId, 'A6');
  assert.deepEqual(objects.filter((object) => object.objectType === 'DATASET_ROW').map((object) => object.label).sort(),
    ['Operating account', 'Payroll account']);
});

test('a one-column list split by blank rows is left as it was', (t) => {
  // Arrange: no row has figures, so nothing marks where a table ends.
  const list = 'Supplier\nNorthwind Traders\nContoso Pharmaceuticals\n\nFabrikam Fiber\n';
  const { application, project } = workspace(t, { 'Suppliers.csv': list });

  // Act
  const objects = application.dependencies.objectsAt(project.id);

  // Assert
  assert.equal(objects.filter((object) => object.objectType === 'DOCUMENT').length, 0);
  assert.ok(objects.some((object) => object.objectType === 'DATASET_ROW' && object.label === 'Fabrikam Fiber'));
});
