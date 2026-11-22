// The dim words beside a suggestion on the card say where a table suggestion
// sits, a layer at a time: a column says what it holds, a value names its
// column and row, a cell of a tabbed value's row names its field.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { DETAIL_CHARACTERS, rowMateDetail, suggestionDetail } from '../src/dependencies/suggestion-detail.js';

const actor = { id: 'human:detail-reader', displayName: 'Detail reader', actorType: 'HUMAN_SELF' };

const PAYABLES = [
  'Supplier,Invoice,Invoice Date,Outstanding CAD',
  'Maple Paper Distribution,BILL-1160,2026-08-18,22000',
  'Harbour Office Furniture,BILL-1174,2026-09-12,18400',
  'North Ridge Technology,BILL-1181,2026-09-20,35000',
  'Cedar Packaging,BILL-1188,2026-09-25,1250',
].join('\n');

async function payables(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-details-'));
  const root = path.join(sandbox, 'Accountant');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Accounts-Payable.csv'), `${PAYABLES}\n`);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const typed = (app, text, links = []) => app.workspace.predict({
  text, cursor: text.length, blockIndex: 0, ...(links.length ? { pendingDependencies: links } : {}),
});
const link = (candidate, start, end) => ({ projectId: candidate.projectId, blockIndex: 0, start, end,
  sourceObjectId: candidate.id, sourceSnapshotId: candidate.snapshotId });
const candidateNamed = (prediction, label) => prediction.claims
  .flatMap(claim => claim.candidates).find(candidate => candidate.label === label);

test('a column of codes shows its first values instead of its inferred profile', () => {
  const column = { objectType: 'VARIABLE', anchor: { kind: 'table-column', column: 'Invoice' },
    metadata: { dictionary: false, samples: ['BILL-1160', 'BILL-1174', 'BILL-1181'] },
    valueText: 'invoice; inferred categorical variable; examples BILL-1160, BILL-1174, BILL-1181' };
  assert.equal(suggestionDetail(column, 'Invoice'), 'Column · BILL-1160, BILL-1174, …');
});

test('a numeric column shows the range it spans', () => {
  const column = { objectType: 'VARIABLE', anchor: { kind: 'table-column', column: 'Outstanding CAD' },
    metadata: { dictionary: false, range: { min: 1250, max: 126400 }, samples: ['22000'] } };
  assert.equal(suggestionDetail(column, 'Outstanding CAD'), 'Column · 1,250 to 126,400');
});

test('a data dictionary definition stays as it is written', () => {
  const variable = { objectType: 'VARIABLE', anchor: { kind: 'table-cell', column: 'Description' },
    metadata: { dictionary: true }, valueText: 'Total sales before deductions.' };
  assert.equal(suggestionDetail(variable, 'Revenue'), null);
});

test('a value shown as its own name says the column and row it came from', () => {
  const cell = { objectType: 'TABLE', valueText: 'BILL-1160',
    anchor: { kind: 'table-cell', rowKey: 'Maple Paper Distribution', column: 'Invoice', columnIndex: 1 },
    metadata: { column: 'Invoice', row: 'Maple Paper Distribution', orientation: 'COLUMN' } };
  assert.equal(suggestionDetail(cell, 'BILL-1160'), 'Invoice column · Maple Paper…');
});

test('a statement value names its row, then its column', () => {
  const cell = { objectType: 'DATASET_VALUE', valueText: '18000',
    anchor: { kind: 'table-cell', rowKey: 'Rent', column: 'September Actual CAD', columnIndex: 1 },
    metadata: { column: 'September Actual CAD', row: 'Rent', orientation: 'ROW' } };
  assert.equal(suggestionDetail(cell, '18000'), 'Rent · September Actual CAD');
});

test('a value whose row is known only by number names just its column', () => {
  const cell = { objectType: 'DATASET_VALUE', valueText: '1500',
    anchor: { kind: 'table-cell', rowKey: '2026', column: 'Amount', columnIndex: 2 },
    metadata: { column: 'Amount', row: '2026', orientation: 'COLUMN' } };
  assert.equal(suggestionDetail(cell, '1500'), 'Amount column');
});

test('a value named by its row keeps showing the value itself', () => {
  const cell = { objectType: 'DATASET_VALUE', valueText: '485000',
    anchor: { kind: 'table-cell', rowKey: 'Revenue', column: 'September Actual CAD' },
    metadata: { column: 'September Actual CAD', orientation: 'ROW' } };
  assert.equal(suggestionDetail(cell, 'Revenue · September Actual CAD'), null);
});

test('a row lists the fields it has past its name', () => {
  const row = { objectType: 'DATASET_ROW', valueText: null, anchor: { kind: 'table-row', rowKey: 'Maple Paper Distribution' },
    metadata: { columns: ['Supplier', 'Invoice', 'Invoice Date', 'Due Date', 'Outstanding CAD'] } };
  assert.equal(suggestionDetail(row, 'Maple Paper Distribution'), 'Row · Invoice, Invoice Date +2');
});

test('a cell of a tabbed value\'s row names its field and that value', () => {
  const cell = { anchor: { kind: 'table-cell', column: 'Outstanding CAD' }, metadata: { column: 'Outstanding CAD' } };
  const row = { anchor: { kind: 'table-row' }, metadata: { columns: ['Supplier', 'Invoice'] } };
  assert.equal(rowMateDetail(cell, 'BILL-1160'), 'Outstanding CAD of BILL-1160');
  assert.equal(rowMateDetail(row, 'BILL-1160', 0), 'Supplier of BILL-1160');
});

test('typing a column name, then Tab, then a value reads as layers on the card', async t => {
  // Arrange
  const app = await payables(t);

  // Act: "Inv" offers the Invoice column.
  const named = await typed(app, 'Inv');
  const invoice = candidateNamed(named, 'Invoice');

  // Assert: the column says what it holds, never "inferred categorical variable".
  assert.ok(invoice, 'Inv suggests Invoice');
  assert.equal(invoice.detail, 'Column · BILL-1160, BILL-1174, …');

  // Act: after Tab on Invoice, its values are listed.
  const links = [link(invoice, 0, 'Invoice'.length)];
  const values = await typed(app, 'Invoice was ', links);
  const bill1160 = values.workspaceCompletions.find(item => item.replacementText === 'BILL-1160');

  // Assert: each value names its column and row instead of repeating itself.
  assert.equal(bill1160?.detail, 'Invoice column · Maple Paper…');

  // Act: after Tab on BILL-1160, the rest of its row joins the list.
  const text = 'Invoice was BILL-1160';
  const withRow = await typed(app, `${text} for `, [...links, link(bill1160.dependencyCandidate, 12, text.length)]);
  const mates = Object.fromEntries(withRow.workspaceCompletions.filter(item => item.rowMateOf)
    .map(item => [item.replacementText, item.detail]));

  // Assert: each cell of the row names its field, of the tabbed value.
  assert.deepEqual(mates, {
    'Maple Paper Distribution': 'Supplier of BILL-1160',
    '2026-08-18': 'Invoice Date of BILL-1160',
    22000: 'Outstanding CAD of BILL-1160',
  });
});

test('a row read with its cells shows its first cells past its name, each by its field', () => {
  const row = { objectType: 'DATASET_ROW', valueText: null, anchor: { kind: 'table-row', rowKey: 'Rent' },
    metadata: { columns: ['Account', 'September Actual CAD', 'Classification'] } };
  const rowCells = [{ column: 'Account', value: 'Rent' }, { column: 'Actual', value: '18000' },
    { column: 'Budget', value: '18000' }, { column: 'Classification', value: 'Expense' }];
  assert.equal(suggestionDetail(row, 'Rent', { rowCells }), 'Row · Actual 18000, Budget 18000');
});

test('a row named while typing shows the values in it', async t => {
  // Arrange
  const app = await payables(t);

  // Act
  const maple = candidateNamed(await typed(app, 'Maple Pa'), 'Maple Paper Distribution');

  // Assert
  assert.equal(maple?.detail, 'Row · Invoice BILL-1160');
});

test('no detail grows past what sits beside a name: long parts are cut at a word or left out', () => {
  // Arrange
  const column = { objectType: 'VARIABLE', anchor: { kind: 'table-column', column: 'Status' },
    metadata: { dictionary: false, samples: ['Due within seven days', 'Agrees with trial balance', 'Overdue'] } };
  const cell = { objectType: 'TABLE', valueText: 'Overdue',
    anchor: { kind: 'table-cell', rowKey: 'Harbour Office Furniture and Fixtures', column: 'Status as of 2026-10-11 reporting date' },
    metadata: { column: 'Status as of 2026-10-11 reporting date', orientation: 'COLUMN' } };
  const row = { objectType: 'DATASET_ROW', valueText: null, anchor: { kind: 'table-row', rowKey: 'Rent' }, metadata: {} };
  const rowCells = [{ column: 'September Actual CAD', value: '18000' }, { column: 'September Budget CAD', value: '18000' }];
  const mate = { anchor: { kind: 'table-cell' }, metadata: { column: 'Status as of 2026-10-11' } };

  // Act
  const details = [suggestionDetail(column, 'Status'), suggestionDetail(cell, 'Overdue'),
    suggestionDetail(row, 'Rent', { rowCells }), rowMateDetail(mate, 'BILL-1160')];

  // Assert
  assert.deepEqual(details, ['Column · Due within seven…', 'Status as of 2026-10-11…',
    'Row · September Actual CAD 18000', 'Status as of 2026-10-11']);
  for (const detail of details) assert.ok(detail.length <= DETAIL_CHARACTERS, `${detail} fits`);
});
