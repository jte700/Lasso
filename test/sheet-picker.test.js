import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { sheetDocument } from '../src/sharing/sheet-document.js';
import { workbook } from './fixtures/workbook.js';

const ledger = {
  name: 'ledger.csv',
  rows: [
    ['Account', 'Debit', 'Credit'],
    ['Cash', '32000', '0'],
    ['Accrued payroll', '0', '28500'],
    ['Inventory', '18400', '0'],
  ],
};

const cellAt = (document, rowNumber, column) => document.rows.find((row) => row.number === rowNumber)?.cells[column];

test('A CSV opens as a sheet numbered from row 1 with lettered columns and its header row', () => {
  // Arrange, Act
  const document = sheetDocument({ name: 'ledger.csv', table: ledger, anchor: {}, delimited: true });

  // Assert
  assert.deepEqual(document.columns, ['A', 'B', 'C']);
  assert.deepEqual(document.rows.map((row) => row.number), [1, 2, 3, 4]);
  assert.equal(document.headerRow, 1);
  assert.equal(cellAt(document, 3, 0), 'Accrued payroll');
  assert.equal(document.selection, null);
});

test('A cited CSV cell opens highlighted, counted from the header as indexed', () => {
  // Arrange
  const anchor = { kind: 'table-cell', rowKey: 'Accrued payroll', rowIndex: 2, column: 'Credit', columnIndex: 2 };

  // Act
  const document = sheetDocument({ name: 'ledger.csv', table: ledger, anchor, delimited: true });

  // Assert
  assert.deepEqual(document.selection, { top: 3, bottom: 3, left: 2, right: 2 });
  assert.equal(cellAt(document, 3, 2), '28500');
});

test('A worksheet cell opens at its worksheet row and shows numbers as the sheet does', () => {
  // Arrange
  const table = { name: 'Trial Balance', rows: [['Account', 'Balance'], ['Inventory', '18400']],
    rowNumbers: [4, 5], displayRows: [[], ['Inventory', '18,400']] };
  const anchor = { kind: 'table-cell', rowIndex: 5, columnIndex: 1, sheet: 'Trial Balance', rowCoordinate: 'worksheet' };

  // Act
  const document = sheetDocument({ name: 'Close.xlsx', table, anchor, sheets: ['Trial Balance', 'Notes'] });

  // Assert
  assert.equal(document.sheet, 'Trial Balance');
  assert.deepEqual(document.sheets, ['Trial Balance', 'Notes']);
  assert.deepEqual(document.selection, { top: 5, bottom: 5, left: 1, right: 1 });
  assert.equal(cellAt(document, 5, 1), '18,400');
  assert.equal(document.headerRow, 4);
});

test('A cited row opens with the whole row highlighted, and a cited column with its cells below the header', () => {
  // Arrange
  const row = { kind: 'table-row', rowKey: 'Cash', rowIndex: 1 };
  const column = { kind: 'table-column', column: 'Debit', columnIndex: 1 };

  // Act
  const byRow = sheetDocument({ name: 'ledger.csv', table: ledger, anchor: row, delimited: true });
  const byColumn = sheetDocument({ name: 'ledger.csv', table: ledger, anchor: column, delimited: true });

  // Assert
  assert.deepEqual(byRow.selection, { top: 2, bottom: 2, left: 0, right: 2 });
  assert.deepEqual(byColumn.selection, { top: 2, bottom: 4, left: 1, right: 1 });
});

test('Another sheet of the workbook opens with nothing highlighted', () => {
  // Arrange
  const table = { name: 'Notes', rows: [['Note'], ['Reviewed']], rowNumbers: [1, 2] };
  const anchor = { kind: 'table-cell', rowIndex: 2, columnIndex: 0, sheet: 'Trial Balance', rowCoordinate: 'worksheet' };

  // Act
  const document = sheetDocument({ name: 'Close.xlsx', table, anchor, sheets: ['Trial Balance', 'Notes'] });

  // Assert
  assert.equal(document.sheet, 'Notes');
  assert.equal(document.selection, null);
});

async function served(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-sheet-'));
  const folder = path.join(root, 'Books');
  fs.mkdirSync(folder);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), content);
  const app = createApplication({ dataDir: path.join(root, 'state'), watchProjects: false });
  const server = await new Promise((resolve) => { const listening = app.server.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(async () => { server.close(); await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.workspace.add([folder], { id: 'system:sheet', displayName: 'Books', actorType: 'SYSTEM' });
  return { app, base: `http://127.0.0.1:${server.address().port}` };
}

async function suggested(app, typed, extension) {
  const prediction = await app.workspace.predict({ text: typed, cursor: typed.length, blockIndex: 0 });
  return (prediction.workspaceCompletions ?? []).map((entry) => entry.dependencyCandidate)
    .find((candidate) => candidate?.path?.endsWith(extension) && candidate.anchor?.kind === 'table-cell');
}

const sheetURL = (base, suggestion, query = '') =>
  `${base}/api/dependency-objects/${encodeURIComponent(suggestion.id)}/sheet?version=${suggestion.versionId}${query}`;

test('The sheet route serves a suggested CSV cell’s sheet with that cell highlighted', async (t) => {
  // Arrange
  const csv = 'Pump,Flow gpm,Head ft\nP-101,18400,120\nP-204,9750,95\nP-305,12200,110\n';
  const { app, base } = await served(t, { 'Pumps.csv': csv });
  const suggestion = await suggested(app, 'The flow of P-204 is ', '.csv');
  assert.ok(suggestion, 'a cell of the CSV is suggested');

  // Act
  const answer = await fetch(sheetURL(base, suggestion));
  const { document } = await answer.json();

  // Assert
  assert.equal(answer.status, 200);
  assert.equal(document.name, 'Pumps.csv');
  assert.equal(document.headerRow, 1);
  const { top, left } = document.selection;
  assert.equal(cellAt(document, top, left), suggestion.valueText ?? suggestion.value);
});

test('The sheet route serves a workbook sheet named in the request, and refuses files that are not tables', async (t) => {
  // Arrange
  const book = workbook('Pumps', { 1: ['Pump', 'Flow gpm'], 2: ['P-101', '18400'], 3: ['P-204', '9750'] });
  const { app, base } = await served(t, { 'Pumps.xlsx': book, 'Notes.md': '# Pump notes\n\nThe pumps were serviced in May.\n' });
  const suggestion = await suggested(app, 'The flow of P-101 is ', '.xlsx');
  assert.ok(suggestion, 'a cell of the workbook is suggested');
  const prediction = await app.workspace.predict({ text: 'The pumps were serv', cursor: 19, blockIndex: 0 });
  const note = [prediction.completion?.dependencyCandidate, ...(prediction.workspaceCompletions ?? []).map((entry) => entry.dependencyCandidate)]
    .find((candidate) => candidate?.path?.endsWith('.md'));

  // Act
  const answer = await fetch(sheetURL(base, suggestion, '&sheet=Pumps'));
  const { document } = await answer.json();
  const refused = note ? await fetch(sheetURL(base, note)) : null;

  // Assert
  assert.equal(answer.status, 200);
  assert.equal(document.sheet, 'Pumps');
  assert.deepEqual(document.sheets, ['Pumps']);
  assert.equal(cellAt(document, document.selection.top, document.selection.left), '18400');
  if (refused) assert.equal(refused.status, 415);
});

test('The sheet route opens a spreadsheet file suggestion with its cells ready to highlight', async (t) => {
  // Arrange
  const csv = 'Invoice,Due Date\nBILL-1160,2026-09-17\nBILL-1174,2026-10-12\n';
  const { app, base } = await served(t, { 'Vendor-Invoices.csv': csv });
  const text = 'We checked vendor invoices';
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  const fileSuggestion = prediction.claims.flatMap((claim) => claim.candidates ?? [])
    .find((candidate) => candidate?.path?.endsWith('.csv') && candidate.fileReference);
  assert.ok(fileSuggestion, 'the CSV file itself is suggested');

  // Act
  const answer = await fetch(sheetURL(base, fileSuggestion));
  const { document } = await answer.json();

  // Assert
  assert.equal(answer.status, 200);
  assert.equal(document.name, 'Vendor-Invoices.csv');
  assert.equal(document.headerRow, 1);
  assert.equal(document.selection, null);
  assert.equal(cellAt(document, 2, 0), 'BILL-1160');
  assert.equal(cellAt(document, 2, 1), '2026-09-17');
});
